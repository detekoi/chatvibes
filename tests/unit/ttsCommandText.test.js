// tests/unit/ttsCommandText.test.js
// The "!tts" parser shared by the YouTube path and the Twitch fragment stripper.

import { parseTtsCommandText, stripCommandPrefixFromFragments } from '../../src/lib/ttsCommandText.js';

describe('parseTtsCommandText', () => {
    it('returns the words after !tts', () => {
        expect(parseTtsCommandText('!tts hello there')).toEqual({ args: ['hello', 'there'] });
    });

    it('is case-insensitive on the prefix, like commandProcessor', () => {
        expect(parseTtsCommandText('!TTS Hello')).toEqual({ args: ['Hello'] });
    });

    it('collapses runs of whitespace and trims', () => {
        expect(parseTtsCommandText('  !tts   a   b  ')).toEqual({ args: ['a', 'b'] });
    });

    it('returns empty args for a bare !tts', () => {
        expect(parseTtsCommandText('!tts')).toEqual({ args: [] });
        expect(parseTtsCommandText('!tts   ')).toEqual({ args: [] });
    });

    it('requires the prefix to be a whole word', () => {
        expect(parseTtsCommandText('!ttsfoo bar')).toBeNull();
    });

    it('ignores !tts that is not at the start', () => {
        expect(parseTtsCommandText('hey !tts hello')).toBeNull();
        expect(parseTtsCommandText('hello')).toBeNull();
        expect(parseTtsCommandText('')).toBeNull();
        expect(parseTtsCommandText(undefined)).toBeNull();
    });
});

describe('stripCommandPrefixFromFragments', () => {
    it('removes the prefix from the first text fragment', () => {
        const out = stripCommandPrefixFromFragments([
            { type: 'text', text: '!tts hello ' },
            { type: 'emote', text: 'Kappa' },
        ]);
        expect(out).toEqual([{ type: 'text', text: 'hello ' }, { type: 'emote', text: 'Kappa' }]);
    });

    it('matches the prefix case-insensitively', () => {
        const out = stripCommandPrefixFromFragments([{ type: 'text', text: '!TTS hello' }]);
        expect(out).toEqual([{ type: 'text', text: 'hello' }]);
    });

    it('drops the fragment entirely when only the prefix was in it', () => {
        const out = stripCommandPrefixFromFragments([
            { type: 'text', text: '!tts ' },
            { type: 'emote', text: 'Kappa' },
        ]);
        expect(out).toEqual([{ type: 'emote', text: 'Kappa' }]);
    });

    it('passes null and empty arrays through', () => {
        expect(stripCommandPrefixFromFragments(null)).toBeNull();
        expect(stripCommandPrefixFromFragments([])).toEqual([]);
    });
});
