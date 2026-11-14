// src/components/commands/tts/tags.js
// "!tts tags": turn single sound tags off or on for the channel.
//
// The speech model turns <laugh>, <scream>, <moan> and similar tags into the real
// sound. Every tag works unless the channel turned it off. A tag that is off is
// removed from the text before synthesis (src/lib/textRewrite/soundTags.js).
import { getTtsState, setTtsState } from '../../tts/ttsState.js';
import { enqueueMessage } from '../../../lib/chatSender.js';
import logger from '../../../lib/logger.js';
import { SOUND_TAG_NAMES, canonicalSoundTag } from '../../../lib/textRewrite/soundTags.js';

const USAGE = '!tts tags <off|on> <tag|all>';

export default {
    name: 'tags',
    description: 'Turns sound tags such as <laugh> or <scream> off or on for the channel.',
    usage: USAGE,
    permission: 'moderator',
    execute: async (context) => {
        const { channel, user, args, replyToId, t } = context;
        const channelName = channel.substring(1).toLowerCase();
        const reply = msg => enqueueMessage(channel, msg, { replyToId });

        const config = await getTtsState(channelName);
        const disabled = new Set((Array.isArray(config.disabledSoundTags) ? config.disabledSoundTags : [])
            .filter(tag => SOUND_TAG_NAMES.includes(tag)));

        const action = (args[0] || 'list').toLowerCase();
        if (action === 'list' || args.length < 2 || (action !== 'off' && action !== 'on')) {
            reply(disabled.size
                ? t('cmd.tags.list', { list: [...disabled].join(', '), usage: USAGE })
                : t('cmd.tags.listNone', { usage: USAGE }));
            return;
        }

        const typed = args.slice(1).join(' ');
        const all = typed.toLowerCase() === 'all';
        const tag = all ? null : canonicalSoundTag(typed);
        if (!all && !tag) {
            reply(t('cmd.tags.unknown', { tag: typed, list: SOUND_TAG_NAMES.join(', ') }));
            return;
        }

        if (all) {
            disabled.clear();
            if (action === 'off') SOUND_TAG_NAMES.forEach(name => disabled.add(name));
        } else if (action === 'off') {
            disabled.add(tag);
        } else {
            disabled.delete(tag);
        }

        // Stored in the order of the tag list, so the same choice always writes the same value.
        const next = SOUND_TAG_NAMES.filter(name => disabled.has(name));
        if (!(await setTtsState(channelName, 'disabledSoundTags', next))) {
            reply(t('cmd.tags.failed'));
            return;
        }
        logger.info({ channel: channelName, user: user?.username, action, tag: tag ?? 'all' }, 'Sound tags changed');
        if (all) reply(t(action === 'off' ? 'cmd.tags.allOff' : 'cmd.tags.allOn'));
        else reply(t(action === 'off' ? 'cmd.tags.off' : 'cmd.tags.on', { tag }));
    },
};
