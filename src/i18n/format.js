/**
 * A deliberately small ICU MessageFormat subset: `{arg}`, `{n, plural, ...}`
 * and `{g, select, ...}`, with `#` inside a plural branch standing for the
 * locale-formatted count.
 *
 * Why a subset rather than `intl-messageformat`: the web dashboard builds with
 * `esbuild bundle: false` and has no bundler entry point, so a runtime npm
 * dependency there means restructuring its build. These three constructs cover
 * every message in the catalogs, and the parser is small enough to test
 * exhaustively.
 *
 * Plural categories come from `Intl.PluralRules`, which is what makes this
 * correct for the languages the English source cannot express: Arabic has six
 * categories, Russian, Polish, Czech and Croatian have four, and the original
 * `count === 1 ? 'sub' : 'subs'` ternaries could only ever produce two.
 *
 * Not supported, on purpose: ICU apostrophe escaping, `selectordinal`, and
 * date/number skeletons. A literal `{` or `}` cannot appear in a message.
 */

const cache = new Map();
const pluralRules = new Map();
const numberFormats = new Map();

function getPluralRules(locale) {
    let r = pluralRules.get(locale);
    if (!r) {
        r = new Intl.PluralRules(locale);
        pluralRules.set(locale, r);
    }
    return r;
}

function getNumberFormat(locale) {
    let f = numberFormats.get(locale);
    if (!f) {
        f = new Intl.NumberFormat(locale);
        numberFormats.set(locale, f);
    }
    return f;
}

/** Index of the `}` matching the `{` at `open`, or -1. */
function matchBrace(str, open) {
    let depth = 0;
    for (let i = open; i < str.length; i++) {
        if (str[i] === '{') depth++;
        else if (str[i] === '}' && --depth === 0) return i;
    }
    return -1;
}

/**
 * Split the body of a plural/select into its `key {branch}` pairs. Keys are
 * bare words (`one`, `other`, `he`) or exact matches (`=0`, `=1`).
 */
function parseBranches(body, kind) {
    const branches = Object.create(null);
    let i = 0;
    while (i < body.length) {
        while (i < body.length && /\s/.test(body[i])) i++;
        if (i >= body.length) break;

        const keyStart = i;
        while (i < body.length && !/[\s{]/.test(body[i])) i++;
        const key = body.slice(keyStart, i);
        if (!key) break;

        while (i < body.length && /\s/.test(body[i])) i++;
        if (body[i] !== '{') {
            throw new Error(`i18n: ${kind} branch "${key}" is missing its {body}`);
        }
        const close = matchBrace(body, i);
        if (close === -1) throw new Error(`i18n: unbalanced braces in ${kind} branch "${key}"`);

        branches[key] = parse(body.slice(i + 1, close));
        i = close + 1;
    }
    if (!branches.other) throw new Error(`i18n: ${kind} is missing an "other" branch`);
    return branches;
}

/** Pattern string -> AST node list. */
function parse(pattern) {
    const nodes = [];
    let i = 0;
    let text = '';

    while (i < pattern.length) {
        const ch = pattern[i];

        if (ch === '#') {
            if (text) { nodes.push({ type: 'text', value: text }); text = ''; }
            nodes.push({ type: 'pound' });
            i++;
            continue;
        }
        if (ch !== '{') { text += ch; i++; continue; }

        const close = matchBrace(pattern, i);
        if (close === -1) throw new Error(`i18n: unbalanced { in "${pattern}"`);
        if (text) { nodes.push({ type: 'text', value: text }); text = ''; }

        const inner = pattern.slice(i + 1, close);
        const comma = inner.indexOf(',');

        if (comma === -1) {
            const name = inner.trim();
            if (!name) throw new Error(`i18n: empty {} in "${pattern}"`);
            nodes.push({ type: 'arg', name });
        } else {
            const name = inner.slice(0, comma).trim();
            const rest = inner.slice(comma + 1);
            const comma2 = rest.indexOf(',');
            if (comma2 === -1) throw new Error(`i18n: {${name}, ...} needs a body in "${pattern}"`);
            const kind = rest.slice(0, comma2).trim();
            let body = rest.slice(comma2 + 1);

            if (kind === 'plural') {
                let offset = 0;
                const m = body.match(/^\s*offset:\s*(-?\d+)/);
                if (m) { offset = Number(m[1]); body = body.slice(m[0].length); }
                nodes.push({ type: 'plural', name, offset, branches: parseBranches(body, 'plural') });
            } else if (kind === 'select') {
                nodes.push({ type: 'select', name, branches: parseBranches(body, 'select') });
            } else {
                throw new Error(`i18n: unsupported argument type "${kind}" in "${pattern}"`);
            }
        }
        i = close + 1;
    }
    if (text) nodes.push({ type: 'text', value: text });
    return nodes;
}

function render(nodes, params, locale, pound) {
    let out = '';
    for (const node of nodes) {
        switch (node.type) {
            case 'text':
                out += node.value;
                break;
            case 'pound':
                out += pound === null ? '#' : getNumberFormat(locale).format(pound);
                break;
            case 'arg': {
                const v = params[node.name];
                if (v === undefined || v === null) break;
                out += typeof v === 'number' ? getNumberFormat(locale).format(v) : String(v);
                break;
            }
            case 'plural': {
                const raw = Number(params[node.name]);
                const n = Number.isFinite(raw) ? raw : 0;
                const offset = n - node.offset;
                const branch = node.branches[`=${n}`]
                    || node.branches[getPluralRules(locale).select(offset)]
                    || node.branches.other;
                out += render(branch, params, locale, offset);
                break;
            }
            case 'select': {
                const key = params[node.name];
                const branch = node.branches[key] || node.branches.other;
                // A nested select keeps the enclosing plural's `#`.
                out += render(branch, params, locale, pound);
                break;
            }
        }
    }
    return out;
}

/** Parse and memoize a pattern. Exported so the catalog validator can reuse it. */
export function compile(pattern) {
    let ast = cache.get(pattern);
    if (!ast) {
        ast = parse(pattern);
        cache.set(pattern, ast);
    }
    return ast;
}

/**
 * @param {string} pattern An ICU-subset message.
 * @param {object} params  Named arguments.
 * @param {string} locale  BCP-47 tag driving plural selection and number format.
 * @returns {string}
 */
export function formatMessage(pattern, params = {}, locale = 'en') {
    return render(compile(pattern), params, locale, null);
}

export const _internals = { parse, matchBrace };
