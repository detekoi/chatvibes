// tests/unit/styleBuilder.test.js
// The stored emotion, speed and pitch become one free-text style for Gemini TTS.
// The tables are STYLE_PRESETS, SPEED_STEPS and PITCH_STEPS in tts-config.json.

import {
    buildStyle,
    speedStep,
    pitchStep,
    stepByWord,
    sanitizeStyle,
    STYLE_MAX_LENGTH,
    STYLE_PRESETS,
    SPEED_STEPS,
    PITCH_STEPS,
} from '../../src/components/tts/styleBuilder.js';
import { VALID_EMOTIONS } from '../../src/components/tts/ttsConstants.js';

describe('the tables', () => {
    test.each([['SPEED_STEPS', SPEED_STEPS], ['PITCH_STEPS', PITCH_STEPS]])('%s rise and end with an open step', (_name, steps) => {
        const limits = steps.slice(0, -1).map(step => step.upTo);

        expect(limits).toEqual([...limits].sort((a, b) => a - b));
        expect(steps.at(-1).upTo).toBeNull();
    });

    test.each([['SPEED_STEPS', SPEED_STEPS, speedStep], ['PITCH_STEPS', PITCH_STEPS, pitchStep]])(
        'the value of each step of %s falls inside that step', (_name, steps, stepOf) => {
            for (const step of steps) expect(stepOf(step.value).key).toBe(step.key);
        });

    test('the normal steps add no words', () => {
        expect(SPEED_STEPS.find(step => step.key === 'normal').style).toBe('');
        expect(PITCH_STEPS.find(step => step.key === 'normal').style).toBe('');
    });

    test('every emotion a user can choose has a preset, apart from auto', () => {
        for (const emotion of VALID_EMOTIONS.filter(name => name !== 'auto')) {
            expect(STYLE_PRESETS).toHaveProperty(emotion);
        }
    });

    test('neutral adds no words', () => {
        expect(STYLE_PRESETS.neutral).toBe('');
    });
});

describe('speedStep', () => {
    test.each([
        [0.5, 'very_slow'],
        [0.65, 'very_slow'],
        [0.66, 'slow'],
        [0.9, 'slow'],
        [0.91, 'normal'],
        [1, 'normal'],
        [1.15, 'normal'],
        [1.2, 'fast'],
        [1.7, 'fast'],
        [1.71, 'very_fast'],
        [2, 'very_fast'],
        [99, 'very_fast'],
        ['1.5', 'fast'],
    ])('%p is %s', (speed, key) => {
        expect(speedStep(speed).key).toBe(key);
    });

    test.each([undefined, null, '', NaN, 'quick', {}])('%p is normal', speed => {
        expect(speedStep(speed).key).toBe('normal');
    });

    // A speed of 0 or less is not a value anyone can store.
    test.each([0, '0', -1, -0.5])('%p is normal', speed => {
        expect(speedStep(speed).key).toBe('normal');
    });

    test('the smallest speeds above zero are very slow', () => {
        expect(speedStep(0.01).key).toBe('very_slow');
    });
});

describe('pitchStep', () => {
    test.each([
        [-12, 'very_low'],
        [-7, 'very_low'],
        [-6, 'low'],
        [-2, 'low'],
        [-1, 'normal'],
        [0, 'normal'],
        [1, 'normal'],
        [2, 'high'],
        [6, 'high'],
        [7, 'very_high'],
        [12, 'very_high'],
        ['-5', 'low'],
    ])('%p is %s', (pitch, key) => {
        expect(pitchStep(pitch).key).toBe(key);
    });

    test.each([undefined, null, '', NaN, 'squeaky'])('%p is normal', pitch => {
        expect(pitchStep(pitch).key).toBe('normal');
    });

    test('a negative pitch is a value, not a missing one', () => {
        expect(pitchStep(-99).key).toBe('very_low');
        expect(pitchStep('0').key).toBe('normal');
    });
});

describe('stepByWord', () => {
    test.each([
        ['slow', 'slow'],
        ['SLOW', 'slow'],
        ['  fast  ', 'fast'],
        ['very-fast', 'very_fast'],
        ['very_fast', 'very_fast'],
        ['very fast', 'very_fast'],
        ['Very  Slow', 'very_slow'],
        ['normal', 'normal'],
    ])('finds the speed step for %p', (word, key) => {
        expect(stepByWord(SPEED_STEPS, word).key).toBe(key);
    });

    test('finds a pitch step, with the number that is stored for it', () => {
        expect(stepByWord(PITCH_STEPS, 'very-low')).toMatchObject({ key: 'very_low', value: -12 });
        expect(stepByWord(PITCH_STEPS, 'high')).toMatchObject({ key: 'high', value: 5 });
    });

    test.each(['', 'quick', '1.5', 'low', null, undefined])('returns null for %p as a speed', word => {
        expect(stepByWord(SPEED_STEPS, word)).toBeNull();
    });
});

describe('sanitizeStyle', () => {
    test('trims and collapses whitespace', () => {
        expect(sanitizeStyle('  like   a \t pirate  ')).toBe('like a pirate');
    });

    test('puts a style on one line', () => {
        expect(sanitizeStyle('whispering\nand\r\nslow')).toBe('whispering and slow');
    });

    test('removes control characters, angle brackets and braces', () => {
        expect(sanitizeStyle('a\u0000b <laugh> {x}\u007f')).toBe('a b laugh x');
    });

    test('keeps other punctuation and letters of any script', () => {
        expect(sanitizeStyle("bored, slow & señor's 海賊!")).toBe("bored, slow & señor's 海賊!");
    });

    test('cuts at the maximum length and leaves no space at the end', () => {
        expect(sanitizeStyle('x'.repeat(STYLE_MAX_LENGTH + 30))).toHaveLength(STYLE_MAX_LENGTH);
        expect(sanitizeStyle(`${'x'.repeat(STYLE_MAX_LENGTH - 1)} tail`)).toBe('x'.repeat(STYLE_MAX_LENGTH - 1));
    });

    test.each([undefined, null, 42, {}, '', '   ', '<>{}'])('returns an empty string for %p', value => {
        expect(sanitizeStyle(value)).toBe('');
    });
});

describe('buildStyle', () => {
    test('is empty for default settings', () => {
        expect(buildStyle()).toBe('');
        expect(buildStyle({})).toBe('');
        expect(buildStyle({ emotion: 'neutral', speed: 1, pitch: 0 })).toBe('');
    });

    test('uses the preset of the emotion', () => {
        expect(buildStyle({ emotion: 'happy' })).toBe(STYLE_PRESETS.happy);
        expect(buildStyle({ emotion: 'sad' })).toBe('sad and downcast');
    });

    test.each(['auto', 'excited', '', undefined])('adds nothing for the emotion %p', emotion => {
        expect(buildStyle({ emotion })).toBe('');
    });

    // Only the presets of the table count, not what Object.prototype has under the name.
    test.each(['constructor', 'toString', '__proto__', 'hasOwnProperty'])('adds nothing for the emotion %p', emotion => {
        expect(buildStyle({ emotion })).toBe('');
    });

    test('a custom style replaces the emotion preset', () => {
        expect(buildStyle({ style: 'like a pirate', emotion: 'happy' })).toBe('like a pirate');
    });

    test('an empty custom style leaves the emotion preset', () => {
        expect(buildStyle({ style: '', emotion: 'happy' })).toBe(STYLE_PRESETS.happy);
        expect(buildStyle({ style: '   ', emotion: 'happy' })).toBe(STYLE_PRESETS.happy);
    });

    test('adds the words of the speed and pitch steps', () => {
        expect(buildStyle({ speed: 0.5 })).toBe('speaking very slowly');
        expect(buildStyle({ pitch: 12 })).toBe('very high pitch');
        expect(buildStyle({ speed: 1.5, pitch: -5 })).toBe('speaking quickly, low pitch');
    });

    test('puts the voice manner first, then the style, then pace and pitch', () => {
        expect(buildStyle({ voiceStyle: 'gruff old sailor', emotion: 'angry', speed: 2, pitch: -12 }))
            .toBe('gruff old sailor, angry, speaking very rapidly, very low pitch, deep voice');
        expect(buildStyle({ voiceStyle: 'gruff old sailor', style: 'whispering', emotion: 'angry', speed: 0.75 }))
            .toBe('gruff old sailor, whispering, speaking slowly');
    });

    test('adds no pace or pitch words for settings that hold nothing', () => {
        expect(buildStyle({ speed: null, pitch: null })).toBe('');
        expect(buildStyle({ speed: '', pitch: '' })).toBe('');
        expect(buildStyle({ speed: 0, emotion: 'happy' })).toBe(STYLE_PRESETS.happy);
    });

    test('keeps the voice manner when there is nothing else', () => {
        expect(buildStyle({ voiceStyle: 'gruff old sailor', emotion: 'neutral', speed: 1, pitch: 0 })).toBe('gruff old sailor');
    });

    test('cleans the custom style and the voice manner', () => {
        expect(buildStyle({ voiceStyle: ' deep\nvoice ', style: '<shout>  loud  ' })).toBe('deep voice, shout loud');
    });

    test('ignores the other fields of a queue item', () => {
        expect(buildStyle({ voiceId: 'puck', languageBoost: 'English', volume: 2, emotion: 'calm' })).toBe(STYLE_PRESETS.calm);
    });
});
