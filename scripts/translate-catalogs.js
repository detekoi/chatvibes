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
// Concurrency is the main lever when the API is busy: a 503 here means capacity,
// not a bad request, so backing off in parallelism helps more than retrying
// harder. Overridable for a quiet period.
const CONCURRENCY = Number(process.env.TRANSLATE_CONCURRENCY || 2);
const BATCH_SIZE = 40;
const MAX_RETRIES = 8;
const RETRY_BASE_MS = 3000;

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

/**
 * The catalogs to translate.
 *
 * One repo has a single flat catalog per locale; the other splits its strings
 * across a shared file and one per page, named `<page>-<locale>.json`. Both are
 * a list of (id, source file, output pattern), and `config.source`/`outDir`
 * stays as the one-catalog shorthand.
 */
const catalogs = config.catalogs ?? [{
    id: null,
    source: config.source,
    out: path.join(config.outDir, '{locale}.json'),
}];

/**
 * Catalogs may be nested objects (`{"msg": {"saved": "Saved"}}`) or flat dotted
 * keys. Everything downstream -- hashing, the prompt, the validator -- works on
 * the flat form, so nesting is a serialization detail handled at the edges.
 */
const flatten = (obj, prefix = '') => Object.fromEntries(Object.entries(obj).flatMap(([key, value]) => (
    value !== null && typeof value === 'object' && !Array.isArray(value)
        ? Object.entries(flatten(value, `${prefix}${key}.`))
        : [[prefix + key, value]]
)));

function unflatten(flat) {
    const out = {};
    for (const [key, value] of Object.entries(flat)) {
        const parts = key.split('.');
        let node = out;
        for (const part of parts.slice(0, -1)) {
            if (typeof node[part] !== 'object' || node[part] === null) node[part] = {};
            node = node[part];
        }
        node[parts.at(-1)] = value;
    }
    return out;
}

const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));

/**
 * `_notes` is a map of key -> translator guidance, not message content, so it
 * is lifted out before flattening and put back whole.
 *
 * Flattening it along with everything else turned `_notes` into keys like
 * `_notes.cmd.saved`, which left `source._notes` undefined -- and every read of
 * it is optional-chained, so nothing threw. The two silent results: a note
 * never reached the prompt, and editing one did not change that key's hash, so
 * the key it was written for was never re-translated.
 */
const decode = (obj) => {
    if (!config.nested) return obj;
    const { _notes, ...rest } = obj;
    const flat = flatten(rest);
    if (_notes) flat._notes = _notes;
    return flat;
};

const encode = (obj) => {
    if (!config.nested) return obj;
    const { _notes, ...rest } = obj;
    const nested = unflatten(rest);
    if (_notes) nested._notes = _notes;
    return nested;
};

for (const catalog of catalogs) {
    catalog.source = decode(readJson(resolve(catalog.source)));
}

const sidecarPath = resolve(config.sidecar);
const sidecar = existsSync(sidecarPath) ? JSON.parse(readFileSync(sidecarPath, 'utf8')) : {};

// The 40-language table lives in the bot repo and is copied to the others by
// `npm run sync-constants`, so where it is depends on which config is driving.
const localesMeta = readJson(resolve(config.localesFile || 'src/i18n/locales.json'));
const allTargets = [...new Set(Object.values(localesMeta.LANGUAGE_BOOSTS).map(v => v.bcp47))]
    .filter(l => l !== config.sourceLocale);

// A config may name the locales it ships (`locales: [...]`); a site whose other
// catalogs are hand-translated into eight languages has no use for the other
// thirty-one, and generating them silently adds languages its switcher does not
// offer. Without the key every locale in localesFile is a target.
const configured = Array.isArray(config.locales) ? config.locales.filter(l => l !== config.sourceLocale) : null;
if (configured) {
    const unknown = configured.filter(l => !allTargets.includes(l));
    if (unknown.length) throw new Error(`config.locales names locales not in ${config.localesFile}: ${unknown.join(', ')}`);
}
const requested = opt('locales', '')
    ? opt('locales', '').split(',').map(s => s.trim()).filter(Boolean)
    : (configured ?? allTargets);
// The source catalog is hand-authored and is the contract every other locale is
// checked against; round-tripping it through the model would rewrite it silently.
const targets = requested.filter(l => l !== config.sourceLocale);
if (requested.length !== targets.length) {
    console.log(`skipping ${config.sourceLocale}: it is the source catalog, not a translation target`);
}

const hash = (s) => createHash('sha256').update(String(s)).digest('hex').slice(0, 16);

// Stands in for the system instruction, which is not hashed directly: bump the
// `promptVersion` in a config after editing the rules and that repo's catalogs
// re-translate. It lives in the config rather than here because the two repos
// share this script but not their catalogs, and a constant would make an edit
// aimed at one of them invalidate both.
const PROMPT_VERSION = config.promptVersion ?? 5;
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

const keyHash = (catalog, key) =>
    hash(JSON.stringify([catalog.source[key], catalog.source._notes?.[key] ?? null]));

/**
 * Where a catalog's bookkeeping lives.
 *
 * A single-catalog config keys straight on the locale, which is the shape the
 * bot's existing sidecar already has -- prefixing it would discard the record of
 * every translation done so far and re-run all thirty-nine locales.
 */
const sidecarKey = (catalog, locale) => (catalog.id ? `${catalog.id}/${locale}` : locale);

const displayName = (locale) => {
    const entry = Object.entries(localesMeta.LANGUAGE_BOOSTS).find(([, v]) => v.bcp47 === locale);
    return entry ? `${entry[0]} (${entry[1].endonym})` : locale;
};

function catalogPath(catalog, locale) {
    return resolve(catalog.out.replace('{locale}', locale));
}

function loadCatalog(catalog, locale) {
    const p = catalogPath(catalog, locale);
    return existsSync(p) ? decode(readJson(p)) : {};
}

/**
 * Keys whose English changed since the last run, plus any the target is
 * missing. Without this every run re-translates every locale from scratch.
 */
function staleKeys(catalog, locale, existing) {
    const seen = sidecar[sidecarKey(catalog, locale)] || {};
    const promptChanged = seen._prompt !== promptHash;
    return Object.keys(catalog.source).filter(key => {
        if (promptChanged) return !key.startsWith('_');
        if (key.startsWith('_')) return false;
        if (FORCE) return true;
        if (!(key in existing)) return true;
        return seen[key] !== keyHash(catalog, key);
    });
}

// Numbered at render time from this list. `spoken` decides whether the
// read-aloud rule is included: it is essential for the bot, whose strings go
// through a speech synthesiser that pronounces "min." as three letters, and
// simply false for the dashboard, whose strings are read off a screen. With
// `spoken: true` the rendered text is byte-identical to the original eight
// rules, so turning this into a list cost no re-translation.
const RULES = (spoken) => [
    'Preserve every {placeholder} exactly as written, including its spelling and case. Never translate, rename, reorder into a different placeholder, add one, or drop one.',
    'Preserve ICU MessageFormat structure: {name, plural, ...} and {name, select, ...}. The literal # stands for a number and must survive.',
    'Translate the TEXT inside plural and select branches, never the branch keywords (one, few, many, other, he, she) and never the argument names.',
    'Some values begin or end with a space, or are sentence fragments joined to other strings. Preserve leading and trailing spaces exactly.',
    'Return every key you were given, and no others.',
    `GRAMMATICAL GENDER. The subject of these messages is a viewer of unknown gender, and the same string is reused for every viewer.
   - If the string contains a {g, select, ...} placeholder, inflect using it. Its values are exactly: he, she, other.
   - If it does NOT contain one, you have no gender information at all. Do not default to the masculine. Rewrite so the sentence does not inflect for gender at all — use the present tense instead of a past participle, a noun phrase instead of a verb, or an impersonal construction. This matters most in Slavic, Semitic and Indic languages, where a masculine past tense is simply wrong for half of all viewers.`,
    ...(spoken ? ['These strings are READ ALOUD by a speech synthesiser. Never abbreviate. Write every word out in full — no "мес.", no "min.", no "no." — because an abbreviation is spoken as its letters, not as the word it stands for. Do not use digits in place of words that would normally be spelled out, and avoid symbols a synthesiser cannot pronounce.'] : []),
    'If the target language has only the "other" plural category, that single branch is used for EVERY number including 1. Word it so it reads correctly for one as well as many — do not carry over an English plural marker that would produce "1 bits".',
    ...(config.extraRules || []),
];

const SYSTEM_INSTRUCTION = `${config.role || 'You translate UI and text-to-speech strings for a live-streaming bot.'}

Reply with ONLY a JSON object mapping each key to its translated string. No preamble, no explanation, no markdown fence.

Absolute rules:
${RULES(config.spoken !== false).map((rule, i) => `${i + 1}. ${rule}`).join('\n')}`;

function buildPrompt(catalog, locale, keys) {
    const categories = new Intl.PluralRules(locale).resolvedOptions().pluralCategories;
    const dnt = (config.doNotTranslate || []).join(', ');
    const glossary = Object.entries(config.glossary || {})
        .map(([term, meaning]) => `  - "${term}": ${meaning}`)
        .join('\n');

    const payload = Object.fromEntries(keys.map(k => [k, catalog.source[k]]));
    const notes = Object.entries(catalog.source._notes || {})
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
            const waitMs = Math.min(RETRY_BASE_MS * 2 ** attempt, 60_000);
            console.error(`  retrying in ${waitMs}ms after: ${err.message.slice(0, 80)}`);
            await new Promise(resolve => setTimeout(resolve, waitMs));
        }
    }
}

async function translateLocale({ catalog, locale }) {
    const label = catalog.id ? `${catalog.id}/${locale}` : locale;
    const source = catalog.source;
    const existing = loadCatalog(catalog, locale);
    const keys = staleKeys(catalog, locale, existing);

    // Keys the target still carries that the English source has dropped. They
    // are not "stale" in the sense staleKeys means -- nothing needs translating
    // -- but skipping on `!keys.length` alone left them in the file forever,
    // and the validator rejects an orphan. That deadlocked the pipeline:
    // deleting one English key put the repo in a state CI refused and this
    // script reported as "unchanged". Falling through rewrites the catalog from
    // the source's key list, which drops them, and costs no API calls.
    const orphans = Object.keys(existing).filter(k => !k.startsWith('_') && !(k in source));
    if (!keys.length && !orphans.length) return { locale: label, skipped: true };

    if (DRY_RUN) return { locale: label, dryRun: keys.length, pruned: orphans.length };

    const merged = { ...existing };
    for (let i = 0; i < keys.length; i += BATCH_SIZE) {
        const batch = keys.slice(i, i + BATCH_SIZE);
        const prompt = buildPrompt(catalog, locale, batch);

        const t0 = Date.now();
        let out = await callModel(prompt);
        console.log(`  ${label}: ${batch.length} key(s) in ${Date.now() - t0}ms`);
        Object.assign(merged, out);

        // Feed the validator's complaints back once. A model that dropped a
        // placeholder or flattened Arabic to one/other usually fixes it when
        // told precisely what is wrong.
        let problems = validateCatalog(locale, { ...source, ...merged }, source, { maxChatLength: config.maxChatLength })
            .filter(p => batch.some(k => p.startsWith(`${k}:`)));
        if (problems.length) {
            console.log(`  ${label}: retrying ${problems.length} problem(s)`);
            const retryKeys = [...new Set(problems.map(p => p.split(':')[0]))].filter(k => batch.includes(k));
            out = await callModel(
                buildPrompt(catalog, locale, retryKeys),
                `Your previous attempt had these problems. Fix them exactly:\n${problems.map(p => `  - ${p}`).join('\n')}`
            );
            Object.assign(merged, out);
        }
    }

    // Reduced to exactly the keys the source still has, which is what gets
    // written. Validating `merged` instead checked a superset that includes
    // whatever the previous catalog held, so a key removed from the English —
    // 51 dead <option> labels, in the run that found this — came back as an
    // orphan complaint and the whole catalog was refused. Orphans could
    // therefore never be pruned: every run failed on the leftovers of the last.
    const ordered = Object.fromEntries(Object.keys(source).map(k => [k, merged[k]]));

    // Never write a catalog that would fail CI.
    const problems = validateCatalog(locale, ordered, source, { maxChatLength: config.maxChatLength });
    if (problems.length) {
        return { locale: label, failed: problems };
    }

    mkdirSync(path.dirname(catalogPath(catalog, locale)), { recursive: true });
    writeFileSync(catalogPath(catalog, locale), JSON.stringify(encode(ordered), null, 2) + '\n');

    sidecar[sidecarKey(catalog, locale)] = {
        _prompt: promptHash,
        ...Object.fromEntries(Object.keys(source).filter(k => !k.startsWith('_')).map(k => [k, keyHash(catalog, k)])),
    };
    // Flushed per locale rather than once at the end. This talks to a flaky API
    // for many minutes, and a run killed partway through would otherwise leave
    // every catalog it had already written unrecorded — so the next run redoes
    // work that is sitting correct on disk.
    flushSidecar();
    return { locale: label, translated: keys.length, pruned: orphans.length };
}

function flushSidecar() {
    if (DRY_RUN) return;
    writeFileSync(sidecarPath, JSON.stringify(sidecar, null, 2) + '\n');
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
                const label = item.catalog?.id ? `${item.catalog.id}/${item.locale}` : item.locale;
                results.push({ locale: label, error: err.message });
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
    const jobs = catalogs.flatMap(catalog => targets.map(locale => ({ catalog, locale })));
    console.log(`${DRY_RUN ? '[dry run] ' : ''}${MODEL} -> ${targets.length} locale(s) x ${catalogs.length} catalog(s) = ${jobs.length} job(s)\n`);

    const results = await runPool(jobs, translateLocale, CONCURRENCY);

    // A prune-only result has `translated: 0`, which is falsy — bucketing on
    // that alone reported "0 written" while 39 catalogs were rewritten.
    const done = results.filter(r => r.translated || r.pruned);
    const skipped = results.filter(r => r.skipped);
    const dry = results.filter(r => r.dryRun);
    const bad = results.filter(r => r.failed || r.error);

    const describe = (r, n, verb) => {
        const parts = [];
        if (n) parts.push(`${n} key(s)${verb}`);
        // Named separately so a run that only tidies up is not mistaken for one
        // that spent money.
        if (r.pruned) parts.push(`${r.pruned} orphan(s) pruned`);
        return parts.join(', ');
    };
    for (const r of dry) console.log(`  ${r.locale}: ${describe(r, r.dryRun, ' would be translated')}`);
    for (const r of done) console.log(`  ${r.locale}: ${describe(r, r.translated, '')}`);
    if (skipped.length) console.log(`  up to date: ${skipped.map(r => r.locale).join(', ')}`);

    for (const r of bad) {
        console.error(`\n  ${r.locale} NOT WRITTEN:`);
        for (const p of r.failed || [r.error]) console.error(`    - ${p}`);
    }
    console.log(`\n${done.length} written, ${skipped.length} unchanged, ${bad.length} failed`);
    if (bad.length) process.exit(1);
}

main().catch(err => { console.error(err); process.exit(1); });
