// src/components/commands/tts/spotlight.js
// "!tts spotlight <text|off>": the streamer's guidance for the spotlight router.
//
// The guidance is free text that steers which chat messages the router picks in
// spotlight mode, for example "prefer questions about the game". It goes to the model
// as a preference and is never spoken. It cannot unlock a kind of message the router
// rejects (src/lib/spotlight/spotlightPrompt.js). "off" stores an empty string, the
// way "!tts defaultstyle off" does.
import { enqueueMessage } from '../../../lib/chatSender.js';
import logger from '../../../lib/logger.js';
import { getTtsState, setTtsStateFields } from '../../tts/ttsState.js';
import { SPOTLIGHT_GUIDANCE_MAX } from '../../tts/ttsConstants.js';

const CLEAR_WORDS = new Set(['off', 'reset', 'none', 'clear']);
const USAGE = '!tts spotlight <text|off>';

export default {
    name: 'spotlight',
    description: 'Sets guidance for spotlight mode: which chat messages to prefer. Use off to remove it.',
    usage: USAGE,
    permission: 'moderator',
    execute: async (context) => {
        const { channel, args, replyToId, t, user } = context;
        const channelName = channel.substring(1).toLowerCase();
        const reply = msg => enqueueMessage(channel, msg, { replyToId });

        if (args.length === 0) {
            const { spotlightGuidance } = await getTtsState(channelName);
            reply(spotlightGuidance
                ? t('cmd.spotlight.current', { value: spotlightGuidance, usage: USAGE })
                : t('cmd.spotlight.none', { usage: USAGE }));
            return;
        }

        if (args.length === 1 && CLEAR_WORDS.has(args[0].toLowerCase())) {
            const cleared = await setTtsStateFields(channelName, { spotlightGuidance: '' });
            reply(t(cleared ? 'cmd.spotlight.off' : 'cmd.spotlight.failed'));
            return;
        }

        const guidance = args.join(' ').replace(/\s+/g, ' ').trim();
        if (!guidance) {
            reply(t('cmd.spotlight.none', { usage: USAGE }));
            return;
        }
        if (guidance.length > SPOTLIGHT_GUIDANCE_MAX) {
            reply(t('cmd.spotlight.tooLong', { max: SPOTLIGHT_GUIDANCE_MAX }));
            return;
        }

        if (await setTtsStateFields(channelName, { spotlightGuidance: guidance })) {
            logger.info({ channel: channelName, user: user?.username }, 'Spotlight guidance set');
            reply(t('cmd.spotlight.set', { value: guidance }));
        } else {
            reply(t('cmd.spotlight.failed'));
        }
    },
};
