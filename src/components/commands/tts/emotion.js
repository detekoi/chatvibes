// "!tts emotion <name>": the old name of "!tts style". See createEmotionAlias in styleCommand.js.
import { createEmotionAlias } from './styleCommand.js';
import styleCommand from './style.js';

export default createEmotionAlias({
    name: 'emotion',
    description: 'The old name of !tts style. An emotion name sets the matching style.',
    usage: '!tts emotion <emotion_name|auto|reset>',
    target: styleCommand,
    viewer: true,
    hintKey: 'cmd.hint.emotions',
    resetWords: ['reset', 'auto'],
});
