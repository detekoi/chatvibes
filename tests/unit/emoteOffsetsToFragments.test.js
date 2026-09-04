// tests/unit/emoteOffsetsToFragments.test.js
import { emoteOffsetsToFragments } from '../../src/lib/emoteOffsetsToFragments.js';

describe('emoteOffsetsToFragments', () => {
    it('returns null when there is no emote data', () => {
        expect(emoteOffsetsToFragments('hello', null)).toBeNull();
        expect(emoteOffsetsToFragments('hello', undefined)).toBeNull();
        expect(emoteOffsetsToFragments('hello', [])).toBeNull();
        expect(emoteOffsetsToFragments(undefined, [{ begin: 0, end: 4, id: '1' }])).toBeNull();
    });

    it('turns an emote-only message into a single emote fragment', () => {
        expect(emoteOffsetsToFragments('DinoDance', [{ begin: 0, end: 8, id: 'emotesv2_abc' }])).toEqual([
            { type: 'emote', text: 'DinoDance', emote: { id: 'emotesv2_abc' } },
        ]);
    });

    it('interleaves text and emote fragments in message order', () => {
        const text = 'gg Kappa well played PogChamp';
        const emotes = [
            { begin: 21, end: 28, id: '305954156' },
            { begin: 3, end: 7, id: '25' },
        ];
        expect(emoteOffsetsToFragments(text, emotes)).toEqual([
            { type: 'text', text: 'gg ' },
            { type: 'emote', text: 'Kappa', emote: { id: '25' } },
            { type: 'text', text: ' well played ' },
            { type: 'emote', text: 'PogChamp', emote: { id: '305954156' } },
        ]);
    });

    it('counts offsets in code points, not UTF-16 units', () => {
        // The emoji is one code point but two UTF-16 units; Twitch offsets count the former.
        const text = '🎉 Kappa';
        expect(emoteOffsetsToFragments(text, [{ begin: 2, end: 6, id: '25' }])).toEqual([
            { type: 'text', text: '🎉 ' },
            { type: 'emote', text: 'Kappa', emote: { id: '25' } },
        ]);
    });

    it('drops out-of-range and overlapping spans instead of throwing', () => {
        const text = 'Kappa';
        expect(emoteOffsetsToFragments(text, [{ begin: 0, end: 9, id: '25' }])).toBeNull();
        expect(emoteOffsetsToFragments(text, [
            { begin: 0, end: 4, id: '25' },
            { begin: 2, end: 4, id: '26' },
        ])).toEqual([{ type: 'emote', text: 'Kappa', emote: { id: '25' } }]);
    });
});
