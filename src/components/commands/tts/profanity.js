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

const USAGE = '!tts profanity <on|off|status>';

export default {
    name: 'profanity',
    description: 'Turn the TTS profanity filter on or off, or show its status.',
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
                const state = ttsConfig.profanityFilterEnabled ? 'ON' : 'OFF';
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

            if (subAction !== 'on' && subAction !== 'off') {
                reply(`Usage: ${USAGE}`);
                return;
            }

            const enable = subAction === 'on';
            if (ttsConfig.profanityFilterEnabled === enable) {
                reply(`Profanity filter is already ${enable ? 'on' : 'off'}.`);
                return;
            }

            const ok = await setTtsState(channelName, 'profanityFilterEnabled', enable);
            if (!ok) {
                reply('Could not change that setting. Try again shortly.');
                return;
            }

            logger.info({ channel: channelName, enabled: enable, user: user.username }, 'Profanity filter toggled');

            if (!enable) {
                reply('Profanity filter off. Messages will be read as written.');
                return;
            }

            if (info.entries === 0) {
                reply(`Profanity filter on, but there is no word list for "${info.language}" yet, so nothing will be filtered.`);
                return;
            }
            const note = info.isFallback ? ' Channel language is "auto", so the English list is in use.' : '';
            reply(`Profanity filter on. ${info.entries} ${info.language} words will be softened.${note}`);
        } catch (error) {
            logger.error({ err: error, channel: channelName, args }, 'Error in !tts profanity');
            reply('Something went wrong handling that command.');
        }
    },
};
