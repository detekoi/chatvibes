// scripts/probe-spotlight-router.js
// Live probe of the spotlight router: one Flash-Lite text call that reads a batch of
// chat and returns the few messages worth reading aloud.
//
// The Gemini documents leave four things open, and this probe answers them:
//   (a) does the Interactions API accept service_tier "flex" with store: false on a
//       plain request (not background, not streamed)?
//   (b) how long does flex take for this small request, next to standard?
//   (c) are the field names right (system_instruction, response_format with a schema,
//       generation_config.thinking_level), does the answer say which tier served it,
//       and what does usage hold?
//   (d) are the picks sensible?
// The calls run one at a time, flex and standard in turn, so both tiers see the same
// conditions. The batches are invented chat in probe-spotlight-batches.json.
//
// Usage:  node scripts/probe-spotlight-router.js [--runs N] [--tier flex|standard|both]
//         [--timeout ms] [--gap ms] [--only name,name] [--no-store] [--api-revision 2026-05-20]
//         [--raw] [--env path] [--module]
//         --runs is the number of calls per tier (default 10). The batches repeat in order.
//         --module calls pickNotable from src/lib/spotlight/spotlightRouter.js instead, once per
//         batch (default: injection and spanish), and prints its picks and its SPOTLIGHT_ROUTE line.
//         --no-store leaves store out of the body, to tell if store: false causes a rejection.
//         --raw prints the first full response of each tier.
//         Needs GEMINI_API_KEY. If it is not set, the key is read from --env, then from
//         SPOTLIGHT_PROBE_ENV, then from /Users/henry/Dev/tts-twitch/.env. The key is never printed.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import {
    SPOTLIGHT_SYSTEM_INSTRUCTION,
    SPOTLIGHT_RESPONSE_SCHEMA,
    buildRouterInput,
} from '../src/lib/spotlight/spotlightPrompt.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const flag = (name, fallback) => {
    const i = args.indexOf(`--${name}`);
    if (i >= 0 && args[i + 1] && !args[i + 1].startsWith('--')) return args[i + 1];
    const eq = args.find(a => a.startsWith(`--${name}=`));
    return eq ? eq.slice(name.length + 3) : fallback;
};
const has = name => args.includes(`--${name}`);

const RUNS = Number(flag('runs', 10));
const TIER = flag('tier', 'both');
const TIMEOUT_MS = Number(flag('timeout', 120000));
const GAP_MS = Number(flag('gap', 1500));
const ONLY = flag('only', '')?.split(',').filter(Boolean);
const SEND_STORE = !has('no-store');
const API_REVISION = flag('api-revision', '');
const RAW = has('raw');
const MODULE = has('module');
const ENV_FILE = flag('env', process.env.SPOTLIGHT_PROBE_ENV || '/Users/henry/Dev/tts-twitch/.env');

// --module loads the bot's config, which needs more of the .env file than the key.
// Variables already set in the environment win.
if ((MODULE || !process.env.GEMINI_API_KEY) && fs.existsSync(ENV_FILE)) dotenv.config({ path: ENV_FILE, quiet: true });
const KEY = process.env.GEMINI_API_KEY;
const URL_ = 'https://generativelanguage.googleapis.com/v1beta/interactions';
const MODEL = process.env.SPOTLIGHT_GEMINI_MODEL || 'gemini-3.5-flash-lite';

// USD per token, standard tier. Thought tokens bill as output. Flex is half.
const PRICE = { input: 0.30e-6, output: 2.50e-6 };
const FLEX_DISCOUNT = 0.5;

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---------- batches ----------

function loadBatches() {
    const { batches } = JSON.parse(fs.readFileSync(path.join(HERE, 'probe-spotlight-batches.json'), 'utf8'));
    const byName = new Map(batches.map(b => [b.name, b]));
    return batches.map(b => {
        const base = b.sameAs ? byName.get(b.sameAs) : b;
        return {
            name: b.name,
            note: b.note,
            guidance: b.guidance ?? base.guidance ?? null,
            language: base.language,
            context: base.context,
            candidates: base.candidates.map((c, i) => ({ id: `m${i + 1}`, ...c })),
            expect: b.expect,
        };
    }).filter(b => !ONLY?.length || ONLY.includes(b.name));
}

// ---------- request ----------

function requestBody(batch, tier) {
    const body = {
        model: MODEL,
        system_instruction: SPOTLIGHT_SYSTEM_INSTRUCTION,
        input: [{ type: 'user_input', content: [{ type: 'text', text: buildRouterInput(batch) }] }],
        response_format: { type: 'text', mime_type: 'application/json', schema: SPOTLIGHT_RESPONSE_SCHEMA },
        generation_config: { thinking_level: 'minimal' },
    };
    if (SEND_STORE) body.store = false;
    if (tier === 'flex') body.service_tier = 'flex';
    return body;
}

async function callRouter(batch, tier) {
    const headers = { 'x-goog-api-key': KEY, 'Content-Type': 'application/json' };
    if (API_REVISION) headers['Api-Revision'] = API_REVISION;
    const started = Date.now();
    let res;
    try {
        res = await fetch(URL_, {
            method: 'POST',
            headers,
            body: JSON.stringify(requestBody(batch, tier)),
            signal: AbortSignal.timeout(TIMEOUT_MS),
        });
    } catch (err) {
        const ms = Date.now() - started;
        const timeout = err.name === 'TimeoutError' || err.name === 'AbortError';
        return { tier, batch: batch.name, ms, http: timeout ? 'timeout' : 'network', error: err.message };
    }
    const raw = await res.text();
    const ms = Date.now() - started;
    const out = { tier, batch: batch.name, ms, http: res.status, headers: Object.fromEntries(res.headers) };
    let body;
    try { body = JSON.parse(raw); } catch { body = null; }
    if (!res.ok || !body) {
        out.error = (body?.error?.message || raw).replace(/\s+/g, ' ').slice(0, 400);
        return out;
    }
    out.body = body;
    out.status = body.status;
    out.servedTier = body.service_tier ?? null;
    out.usage = body.usage || null;
    out.stepTypes = (body.steps || []).map(s => s.type);
    out.text = (body.steps || []).filter(s => s.type === 'model_output').flatMap(s => s.content || [])
        .filter(c => c.type === 'text').map(c => c.text).join('').trim();
    try {
        out.picks = JSON.parse(out.text).picks;
        if (!Array.isArray(out.picks)) throw new Error('picks is not an array');
    } catch (err) {
        out.error = `answer is not the schema: ${err.message}: ${out.text.slice(0, 200)}`;
    }
    return out;
}

// ---------- scoring and cost ----------

function score(batch, picks) {
    const want = new Set(batch.expect.pick);
    const ok = new Set([...batch.expect.pick, ...batch.expect.allow]);
    const got = picks.map(p => p.id);
    const known = new Set(batch.candidates.map(c => c.id));
    return {
        missed: [...want].filter(id => !got.includes(id)),
        wrong: got.filter(id => !ok.has(id)),
        unknown: got.filter(id => !known.has(id)),
    };
}

function cost(usage, tier) {
    if (!usage) return null;
    const output = (usage.total_output_tokens || 0) + (usage.total_thought_tokens || 0);
    const usd = (usage.total_input_tokens || 0) * PRICE.input + output * PRICE.output;
    return tier === 'flex' ? usd * FLEX_DISCOUNT : usd;
}

function stats(values) {
    if (!values.length) return null;
    const s = [...values].sort((a, b) => a - b);
    const at = q => s[Math.min(s.length - 1, Math.ceil(q * s.length) - 1)];
    const median = s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
    return { n: s.length, min: s[0], median: Math.round(median), p90: at(0.9), max: s[s.length - 1] };
}

// ---------- output ----------

const results = [];
const rawShown = new Set();

function print(batch, r) {
    const u = r.usage;
    const tokens = u ? `in=${u.total_input_tokens} out=${u.total_output_tokens} thought=${u.total_thought_tokens ?? 0} cached=${u.total_cached_tokens ?? 0}` : '';
    const usd = cost(u, r.tier);
    console.log(`[${r.tier.padEnd(8)}] ${batch.name.padEnd(20)} ${String(r.http).padEnd(7)} ${String(r.ms).padStart(6)} ms  tier=${r.servedTier ?? '-'}  ${tokens}${usd != null ? `  $${usd.toFixed(6)}` : ''}`);
    if (r.error) console.log(`    error: ${r.error}`);
    if (r.picks) {
        if (!r.picks.length) console.log('    picks: none');
        for (const p of r.picks) {
            const msg = batch.candidates.find(c => c.id === p.id);
            console.log(`    pick ${p.id} ${msg ? `<${msg.user}> ${msg.text.slice(0, 90)}` : '(unknown id)'}`);
            console.log(`         reason: ${p.reason}`);
        }
        const s = score(batch, r.picks);
        const verdict = !s.missed.length && !s.wrong.length ? 'as expected' :
            [s.missed.length && `missed ${s.missed}`, s.wrong.length && `unexpected ${s.wrong}`].filter(Boolean).join(', ');
        console.log(`    expected ${JSON.stringify(batch.expect.pick)}: ${verdict}${s.unknown.length ? `, unknown ids ${s.unknown}` : ''}`);
    }
    if (RAW && !rawShown.has(r.tier) && r.body) {
        rawShown.add(r.tier);
        console.log(`    response headers: ${JSON.stringify(r.headers)}`);
        console.log(`    response body: ${JSON.stringify(r.body, null, 2).replace(/\n/g, '\n    ')}`);
    }
}

function summary(tiers) {
    console.log('\n=== Latency per tier (ms, HTTP 200 only) ===');
    console.log('tier      n    min  median    p90    max  under10s  errors');
    for (const tier of tiers) {
        const rows = results.filter(r => r.tier === tier);
        const ok = rows.filter(r => r.http === 200);
        const st = stats(ok.map(r => r.ms));
        const under = ok.filter(r => r.ms <= 10000).length;
        const errors = Object.entries(rows.filter(r => r.http !== 200).reduce((m, r) => ({ ...m, [r.http]: (m[r.http] || 0) + 1 }), {}))
            .map(([k, v]) => `${k}x${v}`).join(' ') || '-';
        console.log(st
            ? `${tier.padEnd(8)} ${String(st.n).padStart(2)} ${String(st.min).padStart(6)} ${String(st.median).padStart(7)} ${String(st.p90).padStart(6)} ${String(st.max).padStart(6)}  ${under}/${rows.length}`.padEnd(54) + `  ${errors}`
            : `${tier.padEnd(8)}  0      -       -      -      -  0/${rows.length}`.padEnd(54) + `  ${errors}`);
    }

    console.log('\n=== Tokens and cost per batch ===');
    for (const tier of tiers) {
        const ok = results.filter(r => r.tier === tier && r.usage);
        if (!ok.length) continue;
        const avg = key => Math.round(ok.reduce((s, r) => s + (r.usage[key] || 0), 0) / ok.length);
        const usd = ok.reduce((s, r) => s + cost(r.usage, tier), 0) / ok.length;
        console.log(`${tier.padEnd(8)} avg in=${avg('total_input_tokens')} out=${avg('total_output_tokens')} thought=${avg('total_thought_tokens')} cached=${avg('total_cached_tokens')}  $${usd.toFixed(6)} per batch, $${(usd * 1000).toFixed(3)} per 1000 batches`);
    }
    const served = [...new Set(results.filter(r => r.http === 200).map(r => `${r.tier}->${r.servedTier}`))];
    console.log(`Tier in the response: ${served.join(', ') || 'none'}`);

    console.log('\n=== Pick quality ===');
    const scored = results.filter(r => r.picks);
    const exact = scored.filter(r => {
        const s = score(loadBatches().find(b => b.name === r.batch), r.picks);
        return !s.missed.length && !s.wrong.length && !s.unknown.length;
    });
    console.log(`${exact.length}/${scored.length} answers matched the expected picks.`);

    console.log('\n=== Verdict ===');
    const flex = results.filter(r => r.tier === 'flex');
    const flexOk = flex.filter(r => r.http === 200);
    if (tiers.includes('flex')) {
        const rejected = flex.filter(r => r.http === 400);
        console.log(`(a) flex${SEND_STORE ? ' + store:false' : ' without store'}: ${flexOk.length ? `accepted (${flexOk.length}/${flex.length} HTTP 200)` : rejected.length ? `REJECTED: ${rejected[0].error}` : 'no answer to judge'}`);
        const st = stats(flexOk.map(r => r.ms));
        if (st) console.log(`(b) flex median ${st.median} ms, p90 ${st.p90} ms, max ${st.max} ms; ${flexOk.filter(r => r.ms <= 10000).length}/${flex.length} calls under 10 s`);
    }
    const all200 = results.filter(r => r.http === 200);
    const parsed = all200.filter(r => r.picks);
    const bad = results.find(r => r.http === 400);
    console.log(`(c) field names: ${bad ? `a 400 says: ${bad.error}` : `accepted; ${parsed.length}/${all200.length} answers parse as the schema`}; tier reported as body.service_tier: ${all200.some(r => r.servedTier) ? 'yes' : 'no'}`);
}

// The real router module, end to end: config, fetch, fallback, id cleaning and the log line.
async function runModule() {
    const { pickNotable } = await import('../src/lib/spotlight/spotlightRouter.js');
    const names = ONLY?.length ? ONLY : ['injection', 'spanish'];
    for (const batch of loadBatchesNamed(names)) {
        console.log(`\n--- ${batch.name} (guidance: ${batch.guidance ?? 'none'}) ---`);
        const picks = await pickNotable({
            candidates: batch.candidates.map(({ id, user, text }) => ({ id, user, text })),
            context: batch.context,
            guidance: batch.guidance,
            language: batch.language,
            channel: `probe-${batch.name}`,
        });
        console.log(`picks: ${JSON.stringify(picks)}`);
        if (picks) console.log(`expected ${JSON.stringify(batch.expect.pick)}: ${JSON.stringify(score(batch, picks))}`);
    }
}

function loadBatchesNamed(names) {
    const all = loadBatches();
    return names.map(n => all.find(b => b.name === n)).filter(Boolean);
}

async function main() {
    if (!KEY) throw new Error(`GEMINI_API_KEY is missing (looked in the environment and ${ENV_FILE})`);
    if (MODULE) return runModule();
    const tiers = TIER === 'both' ? ['flex', 'standard'] : [TIER];
    if (!tiers.every(t => t === 'flex' || t === 'standard')) throw new Error(`--tier must be flex, standard or both, not ${TIER}`);
    const batches = loadBatches();
    if (!batches.length) throw new Error('no batch matches --only');

    console.log(`Model ${MODEL}, ${RUNS} calls per tier (${tiers.join(', ')}), timeout ${TIMEOUT_MS} ms, gap ${GAP_MS} ms, store ${SEND_STORE ? 'false' : 'not sent'}${API_REVISION ? `, Api-Revision ${API_REVISION}` : ''}\n`);
    for (let i = 0; i < RUNS; i++) {
        const batch = batches[i % batches.length];
        for (const tier of tiers) {
            const r = await callRouter(batch, tier);
            results.push(r);
            print(batch, r);
            await sleep(GAP_MS);
        }
    }
    summary(tiers);
}

main().catch(err => {
    console.error(err);
    process.exit(1);
});
