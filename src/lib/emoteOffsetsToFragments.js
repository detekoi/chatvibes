// src/lib/emoteOffsetsToFragments.js
// Rebuilds chat-style fragments from the offset form of emote data.
//
// channel.chat.message and channel.chat.notification deliver `message.fragments`, which
// the emote pipeline (formatTtsText -> processEmoteFragments) consumes directly. The
// older subscription payloads — channel.subscription.message in particular — carry
// `message.emotes` instead: a list of { begin, end, id } offsets into `message.text`.
// Handing that text to formatTtsText with null fragments silently disables every emote
// mode, so a resub message that is just "DinoDance" was read as the word regardless of
// whether the channel chose describe, read or skip.
//
// Offsets count Unicode code points, not UTF-16 units (the same convention as the IRC
// `emotes=` tag), and `end` is inclusive.

/**
 * @param {string} text - The message text the offsets index into.
 * @param {Array<{begin: number, end: number, id: string}>|null|undefined} emotes
 * @returns {Array<{type: 'text'|'emote', text: string, emote?: {id: string}}>|null}
 *     Fragments in message order, or null when there is no emote data — the caller's
 *     existing "no fragments" fallback (read the text as-is) is the right behaviour then.
 */
export function emoteOffsetsToFragments(text, emotes) {
    if (typeof text !== 'string' || !Array.isArray(emotes) || emotes.length === 0) {
        return null;
    }

    const chars = Array.from(text);
    const spans = emotes
        .filter(e => e && Number.isInteger(e.begin) && Number.isInteger(e.end) && e.id != null
            && e.begin >= 0 && e.end >= e.begin && e.end < chars.length)
        .sort((a, b) => a.begin - b.begin);

    if (spans.length === 0) return null;

    const fragments = [];
    let cursor = 0;
    for (const span of spans) {
        if (span.begin < cursor) continue; // overlapping span — keep the first
        if (span.begin > cursor) {
            fragments.push({ type: 'text', text: chars.slice(cursor, span.begin).join('') });
        }
        fragments.push({
            type: 'emote',
            text: chars.slice(span.begin, span.end + 1).join(''),
            emote: { id: String(span.id) },
        });
        cursor = span.end + 1;
    }
    if (cursor < chars.length) {
        fragments.push({ type: 'text', text: chars.slice(cursor).join('') });
    }
    return fragments;
}
