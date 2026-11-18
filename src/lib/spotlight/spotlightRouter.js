// src/lib/spotlight/spotlightRouter.js
// The spotlight router: one Flash-Lite text call that reads a batch of chat and
// returns the few messages worth reading aloud.
//
// The request shape was proven live by scripts/probe-spotlight-router.js. The
// first attempt uses the flex tier, which costs half. Flex is best-effort: if it
// does not answer within flexTimeoutMs, or answers 429, 5xx or something that is
// not the schema, one standard attempt follows. A 4xx other than 429 is a bug in
// the request, so it is not repeated. There is no other retry: a batch that both
// attempts miss is dropped, and nothing is spoken for it.
//
// The raw fetch follows ttsService.js. Every request sends store: false, so the
// API does not keep the chat. Chat text never goes into an info log line.

import config from '../../config/index.js';
import logger from '../logger.js';
import { SPOTLIGHT_SYSTEM_INSTRUCTION, SPOTLIGHT_RESPONSE_SCHEMA, buildRouterInput } from './spotlightPrompt.js';

function requestBody(batch, tier) {
    const body = {
        model: config.spotlight.geminiModel,
        system_instruction: SPOTLIGHT_SYSTEM_INSTRUCTION,
        input: [{ type: 'user_input', content: [{ type: 'text', text: buildRouterInput(batch) }] }],
        response_format: { type: 'text', mime_type: 'application/json', schema: SPOTLIGHT_RESPONSE_SCHEMA },
        generation_config: { thinking_level: 'minimal' },
        // Interactions are stored for weeks unless this is off. Chat text is not ours to keep there.
        store: false,
    };
    if (tier === 'flex') body.service_tier = 'flex';
    return body;
}

function parsePicks(body) {
    const text = (body?.steps || []).filter(s => s?.type === 'model_output').flatMap(s => s.content || [])
        .filter(c => c?.type === 'text').map(c => c.text).join('').trim();
    const parsed = JSON.parse(text);
    if (!parsed || !Array.isArray(parsed.picks)) throw new Error('the answer has no picks array');
    return parsed.picks;
}

/**
 * One request on one tier. Never throws.
 * @returns {Promise<{ok: boolean, retry: boolean, outcome: string, status: number|null, ms: number,
 *   picks?: Array, usage?: object|null, error?: string}>}
 */
async function attempt(batch, tier, timeoutMs) {
    const started = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const done = (fields) => ({ ms: Date.now() - started, status: null, ...fields });
    try {
        const res = await fetch(config.tts.geminiEndpoint, {
            method: 'POST',
            headers: { 'x-goog-api-key': config.tts.geminiApiKey, 'Content-Type': 'application/json' },
            body: JSON.stringify(requestBody(batch, tier)),
            signal: controller.signal,
        });
        const raw = await res.text();
        if (!res.ok) {
            let message = raw.replace(/\s+/g, ' ').slice(0, 300);
            try { message = JSON.parse(raw).error?.message || message; } catch { /* not JSON, keep the text */ }
            const retry = res.status === 429 || res.status >= 500;
            return done({ ok: false, retry, outcome: `http_${res.status}`, status: res.status, error: message });
        }
        let body;
        try {
            body = JSON.parse(raw);
            return done({ ok: true, retry: false, outcome: 'ok', status: res.status, picks: parsePicks(body), usage: body.usage || null });
        } catch (err) {
            return done({ ok: false, retry: true, outcome: 'malformed', status: res.status, usage: body?.usage || null, error: err.message });
        }
    } catch (err) {
        const aborted = controller.signal.aborted;
        return done({ ok: false, retry: true, outcome: aborted ? 'timeout' : 'network', error: err.message });
    } finally {
        clearTimeout(timer);
    }
}

/** The picks restricted to IDs that were sent, each ID once, in the model's order. */
function cleanPicks(picks, sentIds) {
    const seen = new Set();
    const out = [];
    for (const pick of picks) {
        const id = typeof pick?.id === 'string' ? pick.id.trim() : '';
        if (!sentIds.has(id) || seen.has(id)) continue;
        seen.add(id);
        out.push({ id, reason: typeof pick.reason === 'string' ? pick.reason.trim() : '' });
    }
    return out;
}

const tokens = usage => usage ? {
    inputTokens: usage.total_input_tokens ?? null,
    outputTokens: usage.total_output_tokens ?? null,
    thoughtTokens: usage.total_thought_tokens ?? null,
} : { inputTokens: null, outputTokens: null, thoughtTokens: null };

/**
 * Ask the model which candidates are worth reading aloud.
 *
 * @param {object} batch
 * @param {Array<{id: string, user: string, text: string}>} batch.candidates IDs are short batch labels (m1, m2).
 * @param {Array<{user: string, text: string}>} [batch.context] Earlier chat, oldest first.
 * @param {string|null} [batch.guidance] The streamer's preference.
 * @param {string} [batch.language] Language name for the reasons, for example 'Spanish (Español)'.
 * @param {string} [batch.channel] For the log line only.
 * @returns {Promise<Array<{id: string, reason: string}>|null>} The picks (often empty), or null when both attempts failed.
 */
export async function pickNotable({ candidates, context = [], guidance = null, language = 'English', channel = null }) {
    if (!candidates?.length) return [];
    if (!config.tts.geminiApiKey) {
        logger.warn({ logKey: 'SPOTLIGHT_ROUTE', channel }, 'Spotlight router has no Gemini API key; batch dropped');
        return null;
    }
    const batch = { candidates, context, guidance, language };
    const sentIds = new Set(candidates.map(c => c.id));
    const { flexTimeoutMs, standardTimeoutMs } = config.spotlight;

    const flex = await attempt(batch, 'flex', flexTimeoutMs);
    let standard = null;
    if (!flex.ok && flex.retry) {
        standard = await attempt(batch, 'standard', standardTimeoutMs);
    } else if (!flex.ok) {
        logger.warn({ channel, status: flex.status, error: flex.error }, 'Spotlight router request was rejected; not retried');
    }

    const answer = flex.ok ? flex : standard?.ok ? standard : null;
    const picks = answer ? cleanPicks(answer.picks, sentIds) : null;
    if (standard && !standard.ok) {
        logger.warn({ channel, flex: flex.outcome, standard: standard.outcome, error: standard.error }, 'Spotlight router failed on both tiers');
    }

    logger.info({
        logKey: 'SPOTLIGHT_ROUTE',
        channel,
        tier: flex.ok ? 'flex' : standard?.ok ? 'standard' : 'failed',
        fellBack: !!standard,
        flexOutcome: flex.outcome,
        flexMs: flex.ms,
        standardOutcome: standard?.outcome ?? null,
        standardMs: standard?.ms ?? null,
        batchSize: candidates.length,
        contextSize: context.length,
        hasGuidance: !!guidance,
        picks: picks ? picks.length : null,
        droppedIds: answer ? answer.picks.length - picks.length : null,
        ...tokens(answer?.usage),
    }, `Spotlight router: ${picks ? `${picks.length} of ${candidates.length} picked` : 'failed'}`);
    if (picks?.length) logger.debug({ channel, picks }, 'Spotlight router picks');

    return picks;
}
