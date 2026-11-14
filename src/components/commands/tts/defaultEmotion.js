// "!tts defaultemotion <name>": the old name of "!tts defaultstyle". See createEmotionAlias
// in styleCommand.js.
import { createEmotionAlias } from './styleCommand.js';
import defaultStyleCommand from './defaultStyle.js';

export default createEmotionAlias({
    name: 'defaultemotion',
    description: 'The old name of !tts defaultstyle. An emotion name sets the matching style.',
    usage: '!tts defaultemotion <emotion|reset>',
    target: defaultStyleCommand,
    viewer: false,
    hintKey: 'cmd.hint.emotionsDefault',
    resetWords: ['reset'],
});
