// src/lib/ttsCommandText.js
// Recognises "!tts <text>" in a raw chat message, for entry points that do not
// go through commandProcessor. Twitch does: the prefix is parsed there and the
// handler in commands/handlers/tts.js decides what to do with it. YouTube does
// not — the bot cannot reply in a YouTube chat, so there is nothing for the
// subcommands to say — but "!tts <text>" is the one command that answers with
// audio rather than a chat message, and a viewer on YouTube can hear that.

const TTS_PREFIX = '!tts';

/**
 * Parse a "!tts ..." message the same way commandProcessor.parseCommand would:
 * the prefix is case-insensitive and must be a whole word, so "!ttsfoo" is not
 * a tts command, and the remainder is split on runs of spaces.
 *
 * @param {string} text - Raw message text.
 * @returns {{ args: string[] } | null} The words after "!tts", or null when the
 *     message is not a tts command at all.
 */
export function parseTtsCommandText(text) {
    if (typeof text !== 'string') return null;
    const trimmed = text.trim();
    if (!/^!tts(?:\s|$)/i.test(trimmed)) return null;
    const rest = trimmed.slice(TTS_PREFIX.length).trim();
    return { args: rest ? rest.split(/\s+/) : [] };
}

/**
 * Strip the command prefix (e.g. "!tts") from the beginning of a fragment array,
 * so the fragments line up with the text that will actually be spoken. The first
 * text fragment typically contains "!tts " or "!tts" — the prefix is removed and
 * the fragment dropped entirely if nothing remains.
 *
 * @param {Array<{type: string, text: string}>} fragments - Original fragments (cheermotes already filtered).
 * @param {string} [prefix='!tts'] - The command prefix to strip.
 * @returns {Array<{type: string, text: string}>} A new array with the prefix removed from the first text fragment.
 */
export function stripCommandPrefixFromFragments(fragments, prefix = TTS_PREFIX) {
    if (!fragments || fragments.length === 0) return fragments;

    const result = [];
    let prefixStripped = false;

    for (const frag of fragments) {
        if (!prefixStripped && frag.type === 'text') {
            const trimmed = frag.text.trimStart();
            if (trimmed.toLowerCase().startsWith(prefix.toLowerCase())) {
                // Remove the prefix and any trailing whitespace after it
                const remaining = trimmed.slice(prefix.length).replace(/^\s+/, '');
                prefixStripped = true;
                if (remaining) {
                    result.push({ ...frag, text: remaining });
                }
                // If nothing remains after stripping, skip this fragment entirely
            } else {
                result.push(frag);
            }
        } else {
            result.push(frag);
        }
    }

    return result;
}
