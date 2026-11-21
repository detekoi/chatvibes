// tests/unit/cardParts.test.js
// The emotes on the spotlight card: parts from Twitch and YouTube fragments, the
// host check of each image, and the clean and cut of the parts in the queue.

import { isEmoteSrc, cardPartsFromTwitch, cardPartsFromYouTube, cleanCardParts } from '../../src/components/tts/cardParts.js';

const KAPPA = 'https://static-cdn.jtvnw.net/emoticons/v2/25/default/dark/2.0';
const YT = 'https://yt3.ggpht.com/abc=w24-h24-c-k-nd';
const same = text => text;

describe('isEmoteSrc', () => {
    it.each([
        [KAPPA, true],
        [YT, true],
        ['https://lh3.googleusercontent.com/x', true],
        ['http://static-cdn.jtvnw.net/emoticons/v2/25/default/dark/2.0', false],
        ['https://static-cdn.jtvnw.net.evil.example/x.png', false],
        ['https://evilggpht.com/x.png', false],
        ['https://user:pw@static-cdn.jtvnw.net/x', false],
        ['javascript:alert(1)', false],
        ['not a url', false],
        [undefined, false],
    ])('%s -> %s', (src, ok) => {
        expect(isEmoteSrc(src)).toBe(ok);
    });
});

describe('cardPartsFromTwitch', () => {
    it('turns emote fragments into images and keeps the rest as text', () => {
        const parts = cardPartsFromTwitch([
            { type: 'text', text: 'nice one ' },
            { type: 'emote', text: 'Kappa', emote: { id: '25' } },
            { type: 'text', text: ' ' },
            { type: 'mention', text: '@someone', mention: {} },
        ]);
        expect(parts).toEqual([
            { type: 'text', text: 'nice one ' },
            { type: 'emote', name: 'Kappa', src: KAPPA },
            { type: 'text', text: ' ' },
            { type: 'text', text: '@someone' },
        ]);
    });

    it('accepts an emotesv2 ID', () => {
        const [part] = cardPartsFromTwitch([{ type: 'emote', text: 'catJAM', emote: { id: 'emotesv2_0123abcd' } }]);
        expect(part.src).toBe('https://static-cdn.jtvnw.net/emoticons/v2/emotesv2_0123abcd/default/dark/2.0');
    });

    it('returns undefined when there is no emote', () => {
        expect(cardPartsFromTwitch([{ type: 'text', text: 'hello' }])).toBeUndefined();
        expect(cardPartsFromTwitch(undefined)).toBeUndefined();
    });

    it('reads an emote with an ID that is not safe in a path as text', () => {
        expect(cardPartsFromTwitch([{ type: 'emote', text: 'Bad', emote: { id: '../x' } }])).toBeUndefined();
    });
});

describe('cardPartsFromYouTube', () => {
    it('uses the shortcut as the name and the label when there is no shortcut', () => {
        const parts = cardPartsFromYouTube([
            { type: 'text', text: 'hi ' },
            { type: 'yt_emote', text: ':wave:', imageUrl: YT, label: 'waving hand' },
            { type: 'yt_emote', text: '', imageUrl: YT, label: 'waving hand' },
        ]);
        expect(parts).toEqual([
            { type: 'text', text: 'hi ' },
            { type: 'emote', name: ':wave:', src: YT },
            { type: 'emote', name: 'waving hand', src: YT },
        ]);
    });

    it('reads an emote from another host as its name', () => {
        expect(cardPartsFromYouTube([{ type: 'yt_emote', text: ':x:', imageUrl: 'https://example.com/x.png' }])).toBeUndefined();
    });
});

describe('cleanCardParts', () => {
    const emote = (name = 'Kappa') => ({ type: 'emote', name, src: KAPPA });
    const text = t => ({ type: 'text', text: t });

    it('returns null without an emote', () => {
        expect(cleanCardParts([text('hello')], same, 200)).toBeNull();
        expect(cleanCardParts(undefined, same, 200)).toBeNull();
    });

    it('runs the filter on text and on emote names, and makes the plain text from the parts', () => {
        const filter = t => t.replace(/bad/g, '***');
        const out = cleanCardParts([text('a bad day '), emote('badEmote')], filter, 200);
        expect(out.parts).toEqual([text('a *** day '), { type: 'emote', name: '***Emote', src: KAPPA }]);
        expect(out.text).toBe('a *** day ***Emote');
    });

    it('collapses whitespace and trims the ends', () => {
        const out = cleanCardParts([text('  two\n\nlines  '), emote(), text('  end  ')], same, 200);
        expect(out.parts).toEqual([text('two lines '), emote(), text(' end')]);
    });

    it('joins text that the filter leaves next to text', () => {
        const out = cleanCardParts([text('a '), { type: 'emote', name: 'X', src: 'https://example.com/x' }, text(' b'), emote()], same, 200);
        expect(out.parts).toEqual([text('a X b'), emote()]);
    });

    it('drops parts that are empty after the filter', () => {
        const strip = t => t.replace('<moan>', '');
        const out = cleanCardParts([text('<moan>'), emote()], strip, 200);
        expect(out.parts).toEqual([emote()]);
        expect(out.text).toBe('Kappa');
    });

    it('cuts to the limit with an ellipsis, an emote counting as its name', () => {
        const out = cleanCardParts([text('abcd '), emote('Kappa'), text(' efghij')], same, 12);
        expect(out.parts).toEqual([text('abcd '), emote('Kappa'), text('…')]);
        expect(Array.from(out.text).length).toBeLessThanOrEqual(12);
    });

    it('cuts inside a text part', () => {
        const out = cleanCardParts([emote('Kappa'), text(' abcdefgh')], same, 10);
        expect(out.parts).toEqual([emote('Kappa'), text(' abc…')]);
        expect(Array.from(out.text)).toHaveLength(10);
    });

    it('gives plain text when the cut removes every emote', () => {
        const out = cleanCardParts([text('abcdefghij '), emote()], same, 8);
        expect(out.parts).toBeUndefined();
        expect(out.text).toBe('abcdefg…');
    });
});
