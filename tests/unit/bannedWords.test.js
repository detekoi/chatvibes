// tests/unit/bannedWords.test.js
// The one banned-word test every speech path shares. The YouTube copy of it had
// drifted: it lowercased the message but not the word, and an empty entry
// matched every message.

import { containsBannedWord } from '../../src/lib/bannedWords.js';

describe('containsBannedWord', () => {
    it('matches regardless of case on either side', () => {
        expect(containsBannedWord('a BadWord here', ['badword'])).toBe(true);
        expect(containsBannedWord('a badword here', ['BadWord'])).toBe(true);
    });

    it('matches inside a longer word, as before', () => {
        expect(containsBannedWord('spoilers', ['spoiler'])).toBe(true);
    });

    it('ignores empty and missing entries', () => {
        expect(containsBannedWord('hello', ['', null, undefined])).toBe(false);
    });

    it('treats a missing or non-array list as empty', () => {
        expect(containsBannedWord('hello', undefined)).toBe(false);
        expect(containsBannedWord('hello', 'hello')).toBe(false);
        expect(containsBannedWord('hello', [])).toBe(false);
    });

    it('treats missing text as clean', () => {
        expect(containsBannedWord('', ['a'])).toBe(false);
        expect(containsBannedWord(undefined, ['a'])).toBe(false);
    });

    it('accepts a non-string entry', () => {
        expect(containsBannedWord('room 404', [404])).toBe(true);
    });
});
