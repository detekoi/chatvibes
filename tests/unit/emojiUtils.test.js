import { replaceEmojisWithText } from '../../src/lib/emojiUtils.js';

describe('emojiUtils', () => {
    describe('replaceEmojisWithText', () => {
        it('should return the original string if no emojis are present', () => {
            expect(replaceEmojisWithText('Hello world')).toBe('Hello world');
        });

        it('should replace a single emoji with its text description', () => {
            expect(replaceEmojisWithText('Hello 🔥')).toBe('Hello , fire emoji, ');
        });

        it('should replace multiple and complex emojis', () => {
            expect(replaceEmojisWithText('A 👨‍👩‍👦 family')).toBe('A , family: man, woman, boy emoji,  family');
        });

        it('should handle underscores in emoji names by replacing them with spaces', () => {
            // 🤣 = rolling on the floor laughing (emojibase-data CLDR label)
            expect(replaceEmojisWithText('Haha 🤣')).toBe('Haha , rolling on the floor laughing emoji, ');
        });

        it('should handle edge cases like null or empty strings gracefully', () => {
            expect(replaceEmojisWithText(null)).toBe(null);
            expect(replaceEmojisWithText('')).toBe('');
        });

        it('should collapse consecutive repeated emojis into a count', () => {
            expect(replaceEmojisWithText('🔥🔥🔥')).toBe(', 3 fire emojis, ');
        });

        it('should collapse repeated emojis separated by whitespace', () => {
            expect(replaceEmojisWithText('🔥 🔥 🔥')).toBe(', 3 fire emojis, ');
        });

        it('should not collapse different consecutive emojis', () => {
            expect(replaceEmojisWithText('🔥😂')).toBe(', fire emoji, , face with tears of joy emoji, ');
        });

        it('should handle mixed text and repeated emojis', () => {
            expect(replaceEmojisWithText('wow 🔥🔥🔥 nice')).toBe('wow , 3 fire emojis,  nice');
        });

        it('should handle skin-tone modified emojis by falling back to base emoji', () => {
            // 👴🏽 = old man with medium skin tone (falls back to base 👴 via skin-tone stripping)
            expect(replaceEmojisWithText('hello 👴🏽')).toBe('hello , old man emoji, ');
        });

        it('should collapse consecutive skin-tone modified emojis', () => {
            expect(replaceEmojisWithText('👴🏽👴🏽👴🏽')).toBe(', 3 old man emojis, ');
        });
    });
});
