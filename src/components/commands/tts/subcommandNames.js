// src/components/commands/tts/subcommandNames.js
// Every name (and alias) that "!tts <name>" dispatches to a subcommand handler
// rather than treating as text to speak.
//
// Kept apart from handlers/tts.js, which owns the actual name → handler map,
// because the YouTube chat client needs this list and must not import the
// command tree: handlers/tts.js → ignoreUser.js → ytChatClient.js is already a
// dependency chain, so importing handlers/tts.js from ytChatClient.js would
// close it into a cycle. tests/unit/ttsSubcommandNames.test.js asserts this
// list and that map have exactly the same keys, so adding a subcommand to one
// without the other fails CI rather than silently drifting.

export const TTS_SUBCOMMAND_NAMES = new Set([
    'status',
    'voices',
    'defaultvoice',
    'defaultpitch',
    'defaultspeed',
    'defaultemotion',
    'defaultlanguage',
    'language',
    'lang',
    'languageslist',
    'voice',
    'pitch',
    'speed',
    'emotion',
    'pause',
    'resume',
    'clear',
    'stop',
    'mode',
    'commands',
    'help',
    'off',
    'disable',
    'on',
    'enable',
    'ignore',
    'ignored',
    'events',
    'bitsconfig',
    'bits',
    'permission',
    'preferences',
    'prefs',
    'settings',
    'emote',
    'pronounce',
    'pronunciation',
    'pronounciation',
    'profanity',
    'profanityfilter',
]);

/**
 * @param {string} name - First word after "!tts", any case.
 * @returns {boolean} true if "!tts <name>" is a subcommand rather than text to speak.
 */
export function isTtsSubCommand(name) {
    return typeof name === 'string' && TTS_SUBCOMMAND_NAMES.has(name.toLowerCase());
}
