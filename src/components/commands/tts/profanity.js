// src/components/commands/tts/profanity.js
// Toggle and inspect the per-channel profanity filter.
//
// Off by default. When on, profane words are swapped for mild same-language
// substitutes rather than bleeped or removed, so sentences stay fluent and a
// message made entirely of profanity does not reduce to nothing.
import { enqueueMessage } from '../../../lib/chatSender.js';
import { getTtsState, setTtsState } from '../../tts/ttsState.js';
import { getProfanityListInfo } from '../../../lib/profanity/index.js';
import logger from '../../../lib/logger.js';

const USAGE = '!tts profanity <block|allow|status>';

// The verb has to name the outcome. "!tts profanity on" reads as if it turns
// profanity on, which is the opposite of what it does; block/allow cannot be
// read backwards, since the thing being blocked is right there in the command.
// on/off stay accepted — they are what the docs shipped with and what mods have
// in their muscle memory.
const ENABLE_WORDS = new Set(['block', 'filter', 'censor', 'clean', 'on', 'enable']);
const DISABLE_WORDS = new Set(['allow', 'unfilter', 'raw', 'off', 'disable']);

// Every reply states the effect rather than the setting. If someone did read the
// command backwards, the confirmation is where they find out.
const ON_EFFECT = 'swear words are softened before they are spoken';
const OFF_EFFECT = 'messages are read as written';

export default {
    name: 'profanity',
    description: 'Block or allow profanity in TTS, or show the filter status.',
    usage: USAGE,
    permission: 'moderator',
    execute: async (context) => {
        const { channel, user, args, replyToId } = context;
        const channelName = channel.replace('#', '').toLowerCase();
        const reply = msg => enqueueMessage(channel, msg, { replyToId });

        const subAction = (args[0] || 'status').toLowerCase();

        try {
            const ttsConfig = await getTtsState(channelName);
            const info = getProfanityListInfo(ttsConfig.languageBoost);

            if (subAction === 'status') {
                const enabled = Boolean(ttsConfig.profanityFilterEnabled);
                const state = enabled
                    ? `ON — ${ON_EFFECT}`
                    : `OFF — ${OFF_EFFECT}`;
                if (info.entries === 0) {
                    reply(`Profanity filter: ${state}. No word list exists for "${info.language}", so nothing would be filtered.`);
                    return;
                }
                // "auto" is the default languageBoost and cannot be detected per
                // message, so it quietly uses English. Say so, or this reads as
                // the feature being broken on a non-English channel.
                const note = info.isFallback
                    ? ` Channel language is "auto", so the English list is in use — set a language to filter another one.`
                    : '';
                const coverage = info.confidence === 'low' ? ' (limited coverage)' : '';
                reply(`Profanity filter: ${state}. Language: ${info.language}${coverage}, ${info.entries} words.${note}`);
                return;
            }

            const enable = ENABLE_WORDS.has(subAction) ? true
                : DISABLE_WORDS.has(subAction) ? false
                : null;
            if (enable === null) {
                reply(`Usage: ${USAGE} — "on" and "off" also work.`);
                return;
            }

            if (Boolean(ttsConfig.profanityFilterEnabled) === enable) {
                reply(`Profanity filter is already ${enable ? 'on' : 'off'} — ${enable ? ON_EFFECT : OFF_EFFECT}.`);
                return;
            }

            const ok = await setTtsState(channelName, 'profanityFilterEnabled', enable);
            if (!ok) {
                reply('Could not change that setting. Try again shortly.');
                return;
            }

            logger.info({ channel: channelName, enabled: enable, user: user.username }, 'Profanity filter toggled');

            if (!enable) {
                reply(`Profanity filter off — ${OFF_EFFECT}.`);
                return;
            }

            if (info.entries === 0) {
                reply(`Profanity filter on, but there is no word list for "${info.language}" yet, so nothing will be filtered.`);
                return;
            }
            const note = info.isFallback ? ' Channel language is "auto", so the English list is in use.' : '';
            reply(`Profanity filter on — ${info.entries} ${info.language} words will be softened before they are spoken.${note}`);
        } catch (error) {
            logger.error({ err: error, channel: channelName, args }, 'Error in !tts profanity');
            reply('Something went wrong handling that command.');
        }
    },
};
