#!/usr/bin/env node
// Build-time translation of the message catalogs, run by hand and committed.
//
// Runtime translation was deliberately rejected for these strings: they are a
// closed set of templates, so translating them per-message would put a Gemini
// round-trip inside the TTS hot path, cost money per message and produce output
// that varies between renders. Emote descriptions are the one genuinely
// unbounded surface and stay a runtime call; everything else lives here.
//
// The model is gemini-3.7-flash rather than the flash-lite used at runtime:
// this is not latency-sensitive, and translation quality is the whole point.
//
// Nothing is trusted on the way out. Every response is checked by
// src/i18n/validate.js — placeholders preserved, ICU well-formed, and plural
// branches matching exactly the categories the target language actually uses —
// and a failing locale is retried once with the problems fed back before being
// left alone. That check is what makes a machine translation safe to commit.
//
// Hits a paid API and is non-deterministic. Never wire this into CI; CI runs
// the validator over the committed result instead.
//
// Usage:
//   node scripts/translate-catalogs.js                     # only what changed
//   node scripts/translate-catalogs.js --locales es,ja,ru   # a subset
//   node scripts/translate-catalogs.js --force              # re-translate all
//   node scripts/translate-catalogs.js --dry-run            # report, call nothing
//   node scripts/translate-catalogs.js --config ../chatvibes-web-ui/i18n.config.json

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { createHash } from 'crypto';
import path from 'path';
import { GoogleGenAI } from '@google/genai';
import { validateCatalog } from '../src/i18n/validate.js';
import { withTimeout } from '../src/lib/timeUtils.js';

const MODEL = process.env.TRANSLATE_GEMINI_MODEL || 'gemini-3.7-flash';
const TIMEOUT_MS = 120_000;
const CONCURRENCY = 4;
const BATCH_SIZE = 40;
const MAX_RETRIES = 4;
const RETRY_BASE_MS = 2000;

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const opt = (name, fallback) => {
    const i = argv.indexOf(`--${name}`);
    return i !== -1 && argv[i + 1] ? argv[i + 1] : fallback;
};

const CONFIG_PATH = opt('config', 'i18n.config.json');
const FORCE = flag('force');
const DRY_RUN = flag('dry-run');

const root = path.dirname(path.resolve(CONFIG_PATH));
const config = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
const resolve = (p) => path.resolve(root, p);

const source = JSON.parse(readFileSync(resolve(config.source), 'utf8'));
const sidecarPath = resolve(config.sidecar);
const sidecar = existsSync(sidecarPath) ? JSON.parse(readFileSync(sidecarPath, 'utf8')) : {};

const localesMeta = JSON.parse(readFileSync(resolve('src/i18n/locales.json'), 'utf8'));
const allTargets = [...new Set(Object.values(localesMeta.LANGUAGE_BOOSTS).map(v => v.bcp47))]
    .filter(l => l !== config.sourceLocale);

const requested = opt('locales', '')
    ? opt('locales', '').split(',').map(s => s.trim()).filter(Boolean)
    : allTargets;
// The source catalog is hand-authored and is the contract every other locale is
// checked against; round-tripping it through the model would rewrite it silently.
const targets = requested.filter(l => l !== config.sourceLocale);
if (requested.length !== targets.length) {
    console.log(`skipping ${config.sourceLocale}: it is the source catalog, not a translation target`);
}

const hash = (s) => createHash('sha256').update(String(s)).digest('hex').slice(0, 16);

const PROMPT_VERSION = 5;
// Split deliberately. The global hash covers what changes every message — the
// system instruction, the glossary, the do-not-translate list — and invalidates
// everything when it moves. A key's own hash covers its English text and its own
// translator note, so adding a note for one key re-translates that key rather
// than all thirty across all thirty-nine locales.
const promptHash = hash(JSON.stringify({
    v: PROMPT_VERSION,
    context: config.context,
    doNotTranslate: config.doNotTranslate,
    glossary: config.glossary,
}));

const keyHash = (key) => hash(JSON.stringify([source[key], source._notes?.[key] ?? null]));

const displayName = (locale) => {
    const entry = Object.entries(localesMeta.LANGUAGE_BOOSTS).find(([, v]) => v.bcp47 === locale);
    return entry ? `${entry[0]} (${entry[1].endonym})` : locale;
};

function catalogPath(locale) {
    return path.join(resolve(config.outDir), `${locale}.json`);
}

function loadCatalog(locale) {
    const p = catalogPath(locale);
    return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : {};
}

/**
 * Keys whose English changed since the last run, plus any the target is
 * missing. Without this every run re-translates every locale from scratch.
 */
function staleKeys(locale, existing) {
    const seen = sidecar[locale] || {};
    const promptChanged = seen._prompt !== promptHash;
    return Object.keys(source).filter(key => {
        if (promptChanged) return !key.startsWith('_');
        if (key.startsWith('_')) return false;
        if (FORCE) return true;
        if (!(key in existing)) return true;
        return seen[key] !== keyHash(key);
    });
}

const SYSTEM_INSTRUCTION = `You translate UI and text-to-speech strings for a live-streaming bot.

Reply with ONLY a JSON object mapping each key to its translated string. No preamble, no explanation, no markdown fence.

Absolute rules:
1. Preserve every {placeholder} exactly as written, including its spelling and case. Never translate, rename, reorder into a different placeholder, add one, or drop one.
2. Preserve ICU MessageFormat structure: {name, plural, ...} and {name, select, ...}. The literal # stands for a number and must survive.
3. Translate the TEXT inside plural and select branches, never the branch keywords (one, few, many, other, he, she) and never the argument names.
4. Some values begin or end with a space, or are sentence fragments joined to other strings. Preserve leading and trailing spaces exactly.
5. Return every key you were given, and no others.
6. GRAMMATICAL GENDER. The subject of these messages is a viewer of unknown gender, and the same string is reused for every viewer.
   - If the string contains a {g, select, ...} placeholder, inflect using it. Its values are exactly: he, she, other.
   - If it does NOT contain one, you have no gender information at all. Do not default to the masculine. Rewrite so the sentence does not inflect for gender at all — use the present tense instead of a past participle, a noun phrase instead of a verb, or an impersonal construction. This matters most in Slavic, Semitic and Indic languages, where a masculine past tense is simply wrong for half of all viewers.
7. These strings are READ ALOUD by a speech synthesiser. Never abbreviate. Write every word out in full — no "мес.", no "min.", no "no." — because an abbreviation is spoken as its letters, not as the word it stands for. Do not use digits in place of words that would normally be spelled out, and avoid symbols a synthesiser cannot pronounce.
8. If the target language has only the "other" plural category, that single branch is used for EVERY number including 1. Word it so it reads correctly for one as well as many — do not carry over an English plural marker that would produce "1 bits".`;

function buildPrompt(locale, keys) {
    const categories = new Intl.PluralRules(locale).resolvedOptions().pluralCategories;
    const dnt = (config.doNotTranslate || []).join(', ');
    const glossary = Object.entries(config.glossary || {})
        .map(([term, meaning]) => `  - "${term}": ${meaning}`)
        .join('\n');

    const payload = Object.fromEntries(keys.map(k => [k, source[k]]));
    const notes = Object.entries(source._notes || {})
        .filter(([k]) => keys.includes(k))
        .map(([k, note]) => `  - ${k}: ${note}`)
        .join('\n');

    return `Translate these strings from ${config.sourceLocale} into ${displayName(locale)} [${locale}].

CONTEXT: ${config.context}

PLURAL RULES — this is the most common way these translations go wrong.
${displayName(locale)} uses exactly these plural categories: ${categories.join(', ')}.
Any {n, plural, ...} you return for this language MUST contain a branch for every one of those categories and no others. Do NOT copy the English one/other shape when the target language needs more forms — write the correct grammatical form for each category.

DO NOT TRANSLATE these names; keep them verbatim: ${dnt}

TERMS:
${glossary}
${notes ? `\nNOTES ON SPECIFIC KEYS:\n${notes}\n` : ''}
STRINGS:
${JSON.stringify(payload, null, 2)}`;
}

const genAI = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

async function callModel(prompt, extra = '') {
    // Flash models return 503 UNAVAILABLE under load often enough that a single
    // attempt leaves whole locales unwritten — eight of thirty-nine on one run.
    // The failure is transient and the work is idempotent, so back off and retry
    // rather than making the operator notice and re-run by hand.
    for (let attempt = 0; ; attempt++) {
        try {
            const response = await withTimeout(
                genAI.models.generateContent({
                    model: MODEL,
                    systemInstruction: SYSTEM_INSTRUCTION,
                    contents: [{ text: extra ? `${prompt}\n\n${extra}` : prompt }],
                    config: { responseMimeType: 'application/json' },
                }),
                TIMEOUT_MS,
                'Gemini timeout',
            );
            return JSON.parse(response.text);
        } catch (err) {
            const transient = /50[23]|UNAVAILABLE|high demand|timeout|429|RESOURCE_EXHAUSTED/i.test(err.message);
            if (!transient || attempt >= MAX_RETRIES) throw err;
            const waitMs = RETRY_BASE_MS * 2 ** attempt;
            console.error(`  retrying in ${waitMs}ms after: ${err.message.slice(0, 80)}`);
            await new Promise(resolve => setTimeout(resolve, waitMs));
        }
    }
}

async function translateLocale(locale) {
    const existing = loadCatalog(locale);
    const keys = staleKeys(locale, existing);
    if (!keys.length) return { locale, skipped: true };

    if (DRY_RUN) return { locale, dryRun: keys.length };

    const merged = { ...existing };
    for (let i = 0; i < keys.length; i += BATCH_SIZE) {
        const batch = keys.slice(i, i + BATCH_SIZE);
        const prompt = buildPrompt(locale, batch);

        const t0 = Date.now();
        let out = await callModel(prompt);
        console.log(`  ${locale}: ${batch.length} key(s) in ${Date.now() - t0}ms`);
        Object.assign(merged, out);

        // Feed the validator's complaints back once. A model that dropped a
        // placeholder or flattened Arabic to one/other usually fixes it when
        // told precisely what is wrong.
        let problems = validateCatalog(locale, { ...source, ...merged }, source, { maxChatLength: config.maxChatLength })
            .filter(p => batch.some(k => p.startsWith(`${k}:`)));
        if (problems.length) {
            console.log(`  ${locale}: retrying ${problems.length} problem(s)`);
            const retryKeys = [...new Set(problems.map(p => p.split(':')[0]))].filter(k => batch.includes(k));
            out = await callModel(
                buildPrompt(locale, retryKeys),
                `Your previous attempt had these problems. Fix them exactly:\n${problems.map(p => `  - ${p}`).join('\n')}`
            );
            Object.assign(merged, out);
        }
    }

    // Never write a catalog that would fail CI.
    const problems = validateCatalog(locale, merged, source, { maxChatLength: config.maxChatLength });
    if (problems.length) {
        return { locale, failed: problems };
    }

    const ordered = Object.fromEntries(Object.keys(source).map(k => [k, merged[k]]));
    mkdirSync(path.dirname(catalogPath(locale)), { recursive: true });
    writeFileSync(catalogPath(locale), JSON.stringify(ordered, null, 2) + '\n');

    sidecar[locale] = {
        _prompt: promptHash,
        ...Object.fromEntries(Object.keys(source).filter(k => !k.startsWith('_')).map(k => [k, keyHash(k)])),
    };
    return { locale, translated: keys.length };
}

/** Bounded worker pool — a 40-locale fan-out would otherwise hit rate limits. */
async function runPool(items, worker, limit) {
    const results = [];
    let cursor = 0;
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
        while (cursor < items.length) {
            const item = items[cursor++];
            try {
                results.push(await worker(item));
            } catch (err) {
                results.push({ locale: item, error: err.message });
            }
        }
    }));
    return results;
}

async function main() {
    if (!DRY_RUN && !process.env.GEMINI_API_KEY) {
        console.error('GEMINI_API_KEY is not set.');
        process.exit(1);
    }
    console.log(`${DRY_RUN ? '[dry run] ' : ''}${MODEL} -> ${targets.length} locale(s) from ${config.source}\n`);

    const results = await runPool(targets, translateLocale, CONCURRENCY);

    if (!DRY_RUN) {
        writeFileSync(sidecarPath, JSON.stringify(sidecar, null, 2) + '\n');
    }

    const done = results.filter(r => r.translated);
    const skipped = results.filter(r => r.skipped);
    const dry = results.filter(r => r.dryRun);
    const bad = results.filter(r => r.failed || r.error);

    for (const r of dry) console.log(`  ${r.locale}: ${r.dryRun} key(s) would be translated`);
    for (const r of done) console.log(`  ${r.locale}: ${r.translated} key(s)`);
    if (skipped.length) console.log(`  up to date: ${skipped.map(r => r.locale).join(', ')}`);

    for (const r of bad) {
        console.error(`\n  ${r.locale} NOT WRITTEN:`);
        for (const p of r.failed || [r.error]) console.error(`    - ${p}`);
    }
    console.log(`\n${done.length} written, ${skipped.length} unchanged, ${bad.length} failed`);
    if (bad.length) process.exit(1);
}

main().catch(err => { console.error(err); process.exit(1); });
