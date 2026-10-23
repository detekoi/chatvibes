// src/lib/bannedWords.js
//
// The one banned-word test, shared by every path that can speak a viewer's
// text. It was copied by hand into seven places, and the YouTube copy drifted:
// it lowercased the message but not the word, so a word with a capital never
// matched there, and an empty entry matched every message.

/**
 * Whether the text contains any banned word, ignoring case. Empty and missing
 * entries match nothing.
 * @param {string|null|undefined} text
 * @param {unknown} bannedWords Usually `ttsConfig.bannedWords`; anything that is
 *   not an array counts as an empty list
 * @returns {boolean}
 */
export function containsBannedWord(text, bannedWords) {
    if (!text || !Array.isArray(bannedWords) || bannedWords.length === 0) return false;
    const lowered = String(text).toLowerCase();
    return bannedWords.some(w => w && lowered.includes(String(w).toLowerCase()));
}
