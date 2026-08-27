#!/usr/bin/env node
// Finds built-in pronunciation entries that collide with a real word in one of
// the supported languages, so they can be scoped with `except` in tts-config.json.
//
// The problem: PRONUNCIATION_DEFAULTS is a list of English Twitch acronyms, and
// it fires on every channel whatever its language. Matching is whole-word, which
// does not help here — it is exactly why the collisions happen. "ty" is the
// pronoun "you" in Polish, Czech and Slovak, so a Polish viewer typing it heard
// "thank you"; "af" is "off" in Afrikaans and Dutch, and it expands to profanity,
// so an Afrikaans channel with filtering on got a bleep out of ordinary speech.
//
// 72 entries x 40 languages is 2,880 pairs, which is not reviewable by eye. This
// narrows it to a shortlist. It does NOT edit tts-config.json: the output is a
// proposal for a human to check against the language they actually speak, in the
// same spirit as scripts/probe-pronunciation.js, which is how this list was
// seeded in the first place.
//
// Hits a paid API and is non-deterministic. Never wire this into CI.
//
// Usage:
//   node scripts/audit-pronunciation-collisions.js
//   node scripts/audit-pronunciation-collisions.js --languages pl,cs,nl
//   node scripts/audit-pronunciation-collisions.js --out /tmp/collisions.json

import { readFileSync, writeFileSync } from 'fs';
import { GoogleGenAI } from '@google/genai';
import { withTimeout } from '../src/lib/timeUtils.js';

const MODEL = process.env.TRANSLATE_GEMINI_MODEL || 'gemini-3.7-flash';
const TIMEOUT_MS = 120_000;
const CONCURRENCY = 4;

const argv = process.argv.slice(2);
const opt = (name, fallback) => {
    const i = argv.indexOf(`--${name}`);
    return i !== -1 && argv[i + 1] ? argv[i + 1] : fallback;
};

const ttsConfig = JSON.parse(readFileSync('src/components/tts/tts-config.json', 'utf8'));
const locales = JSON.parse(readFileSync('src/i18n/locales.json', 'utf8'));
const defaults = ttsConfig.PRONUNCIATION_DEFAULTS;

const languages = Object.entries(locales.LANGUAGE_BOOSTS)
    .map(([languageBoost, { bcp47, endonym }]) => ({ languageBoost, bcp47, endonym }))
    .filter(l => l.bcp47 !== 'en');

const only = opt('languages', '');
const targets = only
    ? languages.filter(l => only.split(',').map(s => s.trim()).includes(l.bcp47))
    : languages;

const SYSTEM_INSTRUCTION = `You compare English chat acronyms against the vocabulary of another language.

Reply with ONLY a JSON object: {"collisions": [{"token": "...", "meaning": "...", "frequency": "common"|"occasional"|"rare"}]}. No preamble, no markdown fence.

These tokens are matched as whole words ANYWHERE in a message, not only when the message consists of the token alone. So "af" is replaced inside the ordinary Afrikaans sentence "sit dit af", turning it into "sit dit as fuck". A sequence that only ever occurs inside a longer word does not count, because word boundaries already exclude it.

A token counts as a collision when it appears as a native word in normal running text in that language.

Short tokens of two or three letters are the most likely collisions, not the least — pronouns, prepositions, particles and common abbreviations all live at that length. Consider every token on the list individually.

"frequency" is how often a speaker would actually type it standalone in that chat.

"morelikely" is the decisive field. These tokens are read aloud in LIVE-STREAM CHAT on Twitch and YouTube, where English gaming acronyms are used natively by speakers of every language. Weigh ALL the occurrences of this token across that chat — inside sentences as well as alone — and say which reading accounts for more of them:
  - "local" — most occurrences are the native word, so expanding the English acronym would mangle real sentences. Polish "ty" ("you") and Afrikaans "af" ("off") are both clearly local: they are ordinary words that appear constantly inside normal sentences.
  - "english" — most occurrences are the English acronym, even though a local meaning exists somewhere. Dutch "omg" is english: "omgeving" is a classifieds abbreviation nobody types in a stream, while "omg" as an exclamation is everywhere.
Only "local" is a genuine collision. A local word that is a pronoun, preposition, particle, conjunction or everyday verb is almost always "local", because those appear in ordinary sentences far more often than any acronym.`;

const genAI = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

async function auditLanguage(lang) {
    const tokens = defaults.map(e => e.match);
    const prompt = `Context: these tokens are expanded to speech in a Twitch/YouTube live-stream chat whose language is ${lang.languageBoost} (${lang.endonym}).

Which of them are also ordinary standalone words, particles or common abbreviations in ${lang.languageBoost}?

For each, give what it means in ${lang.languageBoost}, how often a speaker types it standalone in that chat, and whether the English or the local reading is more likely there.

${JSON.stringify(tokens)}
`;

    const response = await withTimeout(
        genAI.models.generateContent({
            model: MODEL,
            systemInstruction: SYSTEM_INSTRUCTION,
            contents: [{ text: prompt }],
            config: {
                responseMimeType: 'application/json',
                // Without a schema the model answers with a bare array and its
                // own key names ("polish_meaning"), which a `parsed.collisions`
                // read turns into silence rather than an error. Pinning the
                // shape is what makes an empty result mean "no collisions".
                responseJsonSchema: {
                    type: 'object',
                    properties: {
                        collisions: {
                            type: 'array',
                            items: {
                                type: 'object',
                                properties: {
                                    token: { type: 'string', description: 'The token exactly as given in the input list.' },
                                    meaning: { type: 'string', description: 'What it means in the target language.' },
                                    frequency: { type: 'string', enum: ['common', 'occasional', 'rare'] },
                                    morelikely: { type: 'string', enum: ['english', 'local'], description: 'Which reading a viewer in a live-stream chat in this language most likely intended.' },
                                },
                                required: ['token', 'meaning', 'frequency', 'morelikely'],
                            },
                        },
                    },
                    required: ['collisions'],
                },
            },
        }),
        TIMEOUT_MS,
        'Gemini timeout',
    );
    const parsed = JSON.parse(response.text);
    if (!parsed || !Array.isArray(parsed.collisions)) {
        throw new Error(`unexpected response shape: ${JSON.stringify(parsed).slice(0, 120)}`);
    }
    const known = new Set(tokens);
    // A model that invents a token would otherwise produce an `except` entry for
    // a rule that does not exist, which is invisible until someone goes looking.
    const collisions = (parsed?.collisions || []).filter(c => known.has(c.token));
    return { ...lang, collisions };
}

async function runPool(items, worker, limit) {
    const results = [];
    let cursor = 0;
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
        while (cursor < items.length) {
            const item = items[cursor++];
            try {
                results.push(await worker(item));
            } catch (err) {
                results.push({ ...item, error: err.message });
            }
        }
    }));
    return results;
}

async function main() {
    if (!process.env.GEMINI_API_KEY) {
        console.error('GEMINI_API_KEY is not set.');
        process.exit(1);
    }
    console.error(`${MODEL}: auditing ${defaults.length} entries against ${targets.length} language(s)\n`);

    const results = await runPool(targets, auditLanguage, CONCURRENCY);
    results.sort((a, b) => a.bcp47.localeCompare(b.bcp47));

    // token -> languages, which is the shape tts-config.json needs.
    const byToken = {};
    for (const r of results) {
        for (const c of r.collisions || []) {
            (byToken[c.token] ??= []).push({ bcp47: r.bcp47, meaning: c.meaning, frequency: c.frequency, morelikely: c.morelikely });
        }
    }

    const existing = Object.fromEntries(defaults.filter(e => e.except || e.only).map(e => [e.match, e.except || e.only]));

    console.log('# Pronunciation collision audit\n');
    console.log(`${Object.keys(byToken).length} token(s) flagged in at least one language.`);
    console.log('Review each against the language before editing tts-config.json — a false positive');
    console.log('silently disables a useful expansion for every channel in that language.\n');

    for (const [token, hits] of Object.entries(byToken).sort((a, b) => b[1].length - a[1].length)) {
        const say = defaults.find(e => e.match === token)?.say;
        const already = existing[token] || [];
        console.log(`## ${token} -> "${say}"`);
        if (already.length) console.log(`   already scoped: ${already.join(', ')}`);
        for (const h of hits.sort((a, b) => a.bcp47.localeCompare(b.bcp47))) {
            const isNew = already.includes(h.bcp47) ? '' : ' NEW';
            console.log(`   ${h.bcp47.padEnd(4)} ${String(h.morelikely).padEnd(8)} ${String(h.frequency).padEnd(11)} ${h.meaning}${isNew}`);
        }
        // Only a token whose local reading wins in stream chat, and which is
        // actually typed there, is worth disabling an expansion over.
        const proposed = [...new Set([
            ...already,
            ...hits.filter(h => h.morelikely === 'local' && h.frequency !== 'rare').map(h => h.bcp47),
        ])].sort();
        console.log(`   proposed: "except": ${JSON.stringify(proposed)}\n`);
    }

    const failed = results.filter(r => r.error);
    for (const r of failed) console.error(`  ${r.bcp47} FAILED: ${r.error}`);

    const outPath = opt('out', '');
    if (outPath) {
        writeFileSync(outPath, JSON.stringify({ byToken, results }, null, 2) + '\n');
        console.error(`\nwrote ${outPath}`);
    }
}

main().catch(err => { console.error(err); process.exit(1); });
