import { emojiToName } from 'gemoji';
import emojiRegex from 'emoji-regex';

/**
 * Replaces unicode emojis in a string with their comma-delimited text descriptions.
 * For example: "Hello 🔥" becomes "Hello , fire emoji, ".
 * 
 * @param {string} text - The input text containing emojis
 * @returns {string} - The text with emojis replaced by descriptions
 */
export function replaceEmojisWithText(text) {
    if (!text || typeof text !== 'string') return text;

    const regex = emojiRegex();

    return text.replace(regex, (match) => {
        const name = emojiToName[match];
        if (name) {
            // Replace underscores with spaces for better TTS pronunciation
            const spokenName = name.replace(/_/g, ' ');
            return `, ${spokenName} emoji, `;
        }
        return match; // If no mapping found, return original
    });
}
