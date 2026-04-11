import emojibaseData from 'emojibase-data/en/data.json' with { type: 'json' };

// Build a Map once at module load for O(1) emoji-to-label lookups.
// emojibase-data covers Emoji 17 / Unicode 17 / CLDR 48 (updated Nov 2025).
const emojiToLabel = new Map(emojibaseData.map(e => [e.emoji, e.label]));
import emojiRegex from 'emoji-regex';

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
        // and variation selectors (U+FE0F) to fall back to the base emoji
        const label = emojiToLabel.get(match.emoji)
            || emojiToLabel.get(match.emoji.replace(/[\u{1F3FB}-\u{1F3FF}\u{FE0F}]/gu, ''));
        if (label) {
            const pad = result.length > 0 && !result.endsWith(' ') ? ' ' : '';
            if (count > 1) {
                result += `${pad}(${count} ${label} emojis)`;
            } else {
                result += `${pad}(${label} emoji)`;
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
