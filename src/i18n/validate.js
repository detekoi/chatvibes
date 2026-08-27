/**
 * Catalog validation, shared by the CI test and the translation script.
 *
 * Machine translation is only safe to commit because these rules run over the
 * result. The interesting one is plural coverage: a model asked to translate
 * an English `one`/`other` message into Russian will often return `one`/`other`
 * again, which silently reads as the wrong grammatical form for 2-4 and 5+.
 */

import { compile } from './format.js';

/** Every argument name referenced anywhere in a pattern, including nested branches. */
export function collectArgs(nodes, out = new Set()) {
    for (const node of nodes) {
        if (node.type === 'arg') out.add(node.name);
        else if (node.type === 'plural' || node.type === 'select') {
            out.add(node.name);
            for (const branch of Object.values(node.branches)) collectArgs(branch, out);
        }
    }
    return out;
}

/** Every plural node in a pattern, as `{ name, categories }` (exact `=N` keys excluded). */
export function collectPlurals(nodes, out = []) {
    for (const node of nodes) {
        if (node.type === 'plural') {
            out.push({
                name: node.name,
                categories: Object.keys(node.branches).filter(k => !k.startsWith('=')),
            });
            for (const branch of Object.values(node.branches)) collectPlurals(branch, out);
        } else if (node.type === 'select') {
            for (const branch of Object.values(node.branches)) collectPlurals(branch, out);
        }
    }
    return out;
}

/**
 * @param {string} locale          BCP-47 tag the catalog is for.
 * @param {object} catalog         The translated catalog.
 * @param {object} source          The English source catalog.
 * @param {object} [opts]
 * @param {number} [opts.maxChatLength] Cap applied to `cmd.*` values.
 * @returns {string[]} Human-readable problems; empty means valid.
 */
export function validateCatalog(locale, catalog, source, { maxChatLength = 0 } = {}) {
    const problems = [];
    const required = new Set(new Intl.PluralRules(locale).resolvedOptions().pluralCategories);

    for (const key of Object.keys(source)) {
        if (key.startsWith('_')) continue;
        if (!(key in catalog)) { problems.push(`${key}: missing`); continue; }
    }
    for (const key of Object.keys(catalog)) {
        if (key.startsWith('_')) continue;
        if (!(key in source)) problems.push(`${key}: orphan (not in the English source)`);
    }

    for (const [key, pattern] of Object.entries(catalog)) {
        if (key.startsWith('_') || !(key in source)) continue;

        if (typeof pattern !== 'string') { problems.push(`${key}: not a string`); continue; }

        let ast;
        let sourceAst;
        try {
            ast = compile(pattern);
        } catch (err) {
            problems.push(`${key}: ${err.message}`);
            continue;
        }
        try {
            sourceAst = compile(source[key]);
        } catch {
            problems.push(`${key}: the ENGLISH source does not parse`);
            continue;
        }

        // Placeholders are the contract with the calling code. A dropped one
        // renders as empty; an invented one renders as the literal key name.
        const want = collectArgs(sourceAst);
        const got = collectArgs(ast);
        const missing = [...want].filter(a => !got.has(a));
        const extra = [...got].filter(a => !want.has(a));
        if (missing.length) problems.push(`${key}: dropped placeholder(s) ${missing.join(', ')}`);
        if (extra.length) problems.push(`${key}: invented placeholder(s) ${extra.join(', ')}`);

        // A plural must cover exactly the categories the locale actually uses:
        // a missing one silently falls back to `other` and reads wrong, and an
        // extra one is unreachable text nobody will ever see or fix.
        for (const { name, categories } of collectPlurals(ast)) {
            const cats = new Set(categories);
            const absent = [...required].filter(c => !cats.has(c));
            const unreachable = categories.filter(c => !required.has(c));
            if (absent.length) {
                problems.push(`${key}: plural {${name}} is missing ${locale} categor${absent.length > 1 ? 'ies' : 'y'} ${absent.join(', ')}`);
            }
            if (unreachable.length) {
                problems.push(`${key}: plural {${name}} has ${unreachable.join(', ')}, unreachable in ${locale}`);
            }
        }

        // Chat replies are truncated at the transport, so an over-long
        // translation is cut mid-sentence rather than rejected.
        if (maxChatLength && key.startsWith('cmd.') && pattern.length > maxChatLength) {
            problems.push(`${key}: ${pattern.length} chars exceeds the ${maxChatLength} chat cap`);
        }
    }

    return problems;
}
