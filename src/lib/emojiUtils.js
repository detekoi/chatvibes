import emojibaseData from 'emojibase-data/en/data.json' with { type: 'json' };

// Build a Map once at module load for O(1) emoji-to-label lookups.
// emojibase-data covers Emoji 17 / Unicode 17 / CLDR 48 (updated Nov 2025).
// Include skin-tone variants (nested under each base emoji's `skins` array) so
// mixed-skin-tone ZWJ sequences like 👩🏻‍🤝‍👩🏿 are covered directly.
const emojiToLabel = new Map();
for (const e of emojibaseData) {
    emojiToLabel.set(e.emoji, e.label);
    if (e.skins) {
        for (const skin of e.skins) {
            emojiToLabel.set(skin.emoji, skin.label);
        }
    }
}
import emojiRegex from 'emoji-regex';

// Reformat emojibase labels like "waving hand: medium skin tone" or
// "women holding hands: light skin tone, dark skin tone" into natural spoken
// form: "medium skin tone waving hand" / "light skin tone and dark skin tone
// women holding hands".
function formatLabel(label) {
    const colonIdx = label.indexOf(': ');
    if (colonIdx === -1) return label;
    const base = label.slice(0, colonIdx);
    const modifier = label.slice(colonIdx + 2);
    if (!modifier.includes('skin tone')) return label;
    const tones = modifier.split(', ');
    return `${tones.join(' and ')} ${base}`;
}

/**
 * Replaces unicode emojis in a string with parenthetical text descriptions.
 * For example: "Hello 🔥" becomes "Hello (fire emoji)".
 *
 * @param {string} text - The input text containing emojis
 * @returns {string} - The text with emojis replaced by descriptions
 */
export function replaceEmojisWithText(text) {
    if (!text || typeof text !== 'string') return text;

    const regex = emojiRegex();

    // Collect all emoji matches with their positions
    const matches = [];
    let m;
    while ((m = regex.exec(text)) !== null) {
        matches.push({ emoji: m[0], index: m.index, length: m[0].length });
    }

    if (matches.length === 0) return text;

    // Build output by walking through the text, collapsing consecutive identical emojis
    let result = '';
    let textCursor = 0;
    let i = 0;

    while (i < matches.length) {
        const match = matches[i];

        // Append any text before this emoji
        result += text.slice(textCursor, match.index);

        // Count consecutive runs of the same emoji (adjacent, no non-whitespace between them)
        let count = 1;
        let lookahead = i + 1;
        let endPos = match.index + match.length;
        while (lookahead < matches.length) {
            const gap = text.slice(endPos, matches[lookahead].index);
            // Allow only whitespace (or nothing) between consecutive identical emojis
            if (gap.trim() === '' && matches[lookahead].emoji === match.emoji) {
                count++;
                endPos = matches[lookahead].index + matches[lookahead].length;
                lookahead++;
            } else {
                break;
            }
        }

        // Try exact match first, then strip skin tone modifiers (U+1F3FB–U+1F3FF)
        // to fall back to the base ZWJ sequence (preserving variation selectors so
        // sequences like 🙅‍♂️ still match their emojibase keys), then as a last
        // resort also strip variation selectors (U+FE0F).
        const skinStripped = match.emoji.replace(/[\u{1F3FB}-\u{1F3FF}]/gu, '');
        const label = emojiToLabel.get(match.emoji)
            || emojiToLabel.get(skinStripped)
            || emojiToLabel.get(skinStripped.replace(/\u{FE0F}/gu, ''));
        if (label) {
            const description = formatLabel(label);
            const pad = result.length > 0 && !result.endsWith(' ') ? ' ' : '';
            if (count > 1) {
                result += `${pad}(${count} ${description} emojis)`;
            } else {
                result += `${pad}(${description} emoji)`;
            }
        } else {
            // No mapping — keep original emoji(s)
            result += text.slice(match.index, endPos);
        }

        textCursor = endPos;
        i = lookahead;
    }

    // Append any remaining text after the last emoji
    result += text.slice(textCursor);

    return result;
}

/**
 * Strips all unicode emojis from a string, collapsing leftover whitespace.
 * Used when emoteMode is 'skip' so emoji aren't read aloud at all.
 *
 * @param {string} text - The input text potentially containing emojis
 * @returns {string} - The text with all emojis removed
 */
export function stripEmojis(text) {
    if (!text || typeof text !== 'string') return text;
    const regex = emojiRegex();
    return text.replace(regex, '').replace(/\s{2,}/g, ' ').trim();
}
