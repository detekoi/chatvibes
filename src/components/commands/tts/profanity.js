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
// command backwards, the confirmation is where they find out. Held as catalog
// keys rather than sentences because they are spliced into several replies.

export default {
    name: 'profanity',
    description: 'Block or allow profanity in TTS, or show the filter status.',
    usage: USAGE,
    permission: 'moderator',
    execute: async (context) => {
        const { channel, user, args, replyToId } = context;
        const channelName = channel.replace('#', '').toLowerCase();
        const { t } = context;
        const onEffect = t('cmd.profanity.effect.on');
        const offEffect = t('cmd.profanity.effect.off');
        const reply = msg => enqueueMessage(channel, msg, { replyToId });

        const subAction = (args[0] || 'status').toLowerCase();

        try {
            const ttsConfig = await getTtsState(channelName);
            const info = getProfanityListInfo(ttsConfig.languageBoost);

            if (subAction === 'status') {
                const enabled = Boolean(ttsConfig.profanityFilterEnabled);
                const state = enabled
                    ? t('cmd.profanity.state.on', { effect: onEffect })
                    : t('cmd.profanity.state.off', { effect: offEffect });
                if (info.entries === 0) {
                    reply(t('cmd.profanity.status.noList', { state, language: info.language }));
                    return;
                }
                // "auto" is the default languageBoost and cannot be detected per
                // message, so it quietly uses English. Say so, or this reads as
                // the feature being broken on a non-English channel.
                const note = info.isFallback ? t('cmd.profanity.note.auto') : '';
                const coverage = info.confidence === 'low' ? t('cmd.profanity.coverage.low') : '';
                reply(t('cmd.profanity.status', { state, language: info.language, coverage, entries: info.entries, note }));
                return;
            }

            const enable = ENABLE_WORDS.has(subAction) ? true
                : DISABLE_WORDS.has(subAction) ? false
                : null;
            if (enable === null) {
                reply(t('cmd.profanity.usage', { usage: USAGE }));
                return;
            }

            if (Boolean(ttsConfig.profanityFilterEnabled) === enable) {
                reply(t('cmd.profanity.already', { setting: enable ? 'on' : 'off', effect: enable ? onEffect : offEffect }));
                return;
            }

            const ok = await setTtsState(channelName, 'profanityFilterEnabled', enable);
            if (!ok) {
                reply(t('cmd.profanity.failed'));
                return;
            }

            logger.info({ channel: channelName, enabled: enable, user: user.username }, 'Profanity filter toggled');

            if (!enable) {
                reply(t('cmd.profanity.turnedOff', { effect: offEffect }));
                return;
            }

            if (info.entries === 0) {
                reply(t('cmd.profanity.onNoList', { language: info.language }));
                return;
            }
            const note = info.isFallback ? t('cmd.profanity.note.autoShort') : '';
            reply(t('cmd.profanity.turnedOn', { entries: info.entries, language: info.language, note }));
        } catch (error) {
            logger.error({ err: error, channel: channelName, args }, 'Error in !tts profanity');
            reply(t('cmd.profanity.error'));
        }
    },
};
