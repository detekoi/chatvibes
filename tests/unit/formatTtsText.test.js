// tests/unit/formatTtsText.test.js
// Unit tests for the shared TTS text formatting utility

import { jest } from '@jest/globals';

// --- Mocks ---
let mockIsGeminiAvailable;
let mockProcessMessageWithEmoteDescriptions;
let mockProcessMessageUrls;
let mockReplaceEmojisWithText;
let mockStripEmojis;

beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();

    mockIsGeminiAvailable = jest.fn(() => false);
    mockProcessMessageWithEmoteDescriptions = jest.fn();
    mockProcessMessageUrls = jest.fn((text) => text); // passthrough by default
    mockReplaceEmojisWithText = jest.fn((text) => text); // passthrough by default
    mockStripEmojis = jest.fn((text) => text); // passthrough by default

    jest.unstable_mockModule('../../src/lib/logger.js', () => ({
        default: {
            debug: jest.fn(),
            info: jest.fn(),
            warn: jest.fn(),
            error: jest.fn(),
        }
    }));

    jest.unstable_mockModule('../../src/lib/emotes/index.js', () => ({
        isGeminiAvailable: mockIsGeminiAvailable,
        processMessageWithEmoteDescriptions: mockProcessMessageWithEmoteDescriptions,
    }));

    jest.unstable_mockModule('../../src/lib/urlProcessor.js', () => ({
        processMessageUrls: mockProcessMessageUrls,
    }));

    jest.unstable_mockModule('../../src/lib/emojiUtils.js', () => ({
        replaceEmojisWithText: mockReplaceEmojisWithText,
        stripEmojis: mockStripEmojis,
    }));
});

// Helper to import after mocks are set up
async function loadModule() {
    return import('../../src/lib/formatTtsText.js');
}

describe('formatTtsText', () => {
    // --- Emote Mode: 'read' ---
    describe('emoteMode: read', () => {
        test('should pass through raw text when emoteMode is read', async () => {
            const { formatTtsText } = await loadModule();

            const fragments = [
                { type: 'text', text: 'hello ' },
                { type: 'emote', text: 'Kappa', emote: { id: '25' } },
            ];

            const result = await formatTtsText('hello Kappa', fragments, {
                emoteMode: 'read',
                channelEmoteMode: 'read',
            });

            expect(result).toBe('hello Kappa');
            expect(mockProcessMessageWithEmoteDescriptions).not.toHaveBeenCalled();
        });

        test('should pass through raw text when fragments are null', async () => {
            const { formatTtsText } = await loadModule();

            const result = await formatTtsText('hello Kappa', null, {
                emoteMode: 'describe',
                channelEmoteMode: 'describe',
            });

            // No fragments → falls back to raw text (like 'read')
            expect(result).toBe('hello Kappa');
        });
    });

    // --- Emote Mode: 'skip' ---
    describe('emoteMode: skip', () => {
        test('should filter out emote fragments', async () => {
            const { formatTtsText } = await loadModule();

            const fragments = [
                { type: 'text', text: 'hello ' },
                { type: 'emote', text: 'Kappa', emote: { id: '25' } },
                { type: 'text', text: ' world' },
            ];

            const result = await formatTtsText('hello Kappa world', fragments, {
                emoteMode: 'skip',
                channelEmoteMode: 'skip',
            });

            expect(result).toBe('hello  world');
            expect(mockStripEmojis).toHaveBeenCalled();
            expect(mockReplaceEmojisWithText).not.toHaveBeenCalled();
        });

        test('should keep mention fragments', async () => {
            const { formatTtsText } = await loadModule();

            const fragments = [
                { type: 'emote', text: 'LUL', emote: { id: '123' } },
                { type: 'text', text: ' ' },
                { type: 'mention', text: '@someone' },
                { type: 'text', text: ' hi' },
            ];

            const result = await formatTtsText('LUL @someone hi', fragments, {
                emoteMode: 'skip',
                channelEmoteMode: 'skip',
            });

            expect(result).toBe('@someone hi');
        });

        test('should return empty string when message is all emotes', async () => {
            const { formatTtsText } = await loadModule();

            const fragments = [
                { type: 'emote', text: 'Kappa', emote: { id: '25' } },
                { type: 'text', text: ' ' },
                { type: 'emote', text: 'LUL', emote: { id: '123' } },
            ];

            const result = await formatTtsText('Kappa LUL', fragments, {
                emoteMode: 'skip',
                channelEmoteMode: 'skip',
            });

            expect(result).toBe('');
        });

        test('should use stripEmojis for emoji processing', async () => {
            const { formatTtsText } = await loadModule();

            const fragments = [{ type: 'text', text: 'hello' }];

            await formatTtsText('hello', fragments, {
                emoteMode: 'skip',
                channelEmoteMode: 'skip',
            });

            expect(mockStripEmojis).toHaveBeenCalled();
            expect(mockReplaceEmojisWithText).not.toHaveBeenCalled();
        });
    });

    // --- Emote Mode: 'describe' ---
    describe('emoteMode: describe', () => {
        test('should use Gemini descriptions when available', async () => {
            mockIsGeminiAvailable.mockReturnValue(true);
            mockProcessMessageWithEmoteDescriptions.mockResolvedValue('hello (laughing face emote)');

            const { formatTtsText } = await loadModule();

            const fragments = [
                { type: 'text', text: 'hello ' },
                { type: 'emote', text: 'Kappa', emote: { id: '25' } },
            ];

            const result = await formatTtsText('hello Kappa', fragments, {
                emoteMode: 'describe',
                channelEmoteMode: 'describe',
            });

            expect(result).toBe('hello (laughing face emote)');
            expect(mockProcessMessageWithEmoteDescriptions).toHaveBeenCalledWith(fragments);
        });

        test('should fall back to read when Gemini unavailable and channel default is describe', async () => {
            mockIsGeminiAvailable.mockReturnValue(false);

            const { formatTtsText } = await loadModule();

            const fragments = [
                { type: 'text', text: 'hello ' },
                { type: 'emote', text: 'Kappa', emote: { id: '25' } },
            ];

            const result = await formatTtsText('hello Kappa', fragments, {
                emoteMode: 'describe',
                channelEmoteMode: 'describe',
            });

            // channelEmoteMode is 'describe' → fallback to 'read'
            expect(result).toBe('hello Kappa');
        });

        test('should fall back to skip when Gemini unavailable and channel default is skip', async () => {
            mockIsGeminiAvailable.mockReturnValue(false);

            const { formatTtsText } = await loadModule();

            const fragments = [
                { type: 'text', text: 'hello ' },
                { type: 'emote', text: 'Kappa', emote: { id: '25' } },
            ];

            const result = await formatTtsText('hello Kappa', fragments, {
                emoteMode: 'describe',
                channelEmoteMode: 'skip',
            });

            // channelEmoteMode is 'skip' → fallback to skip behavior
            expect(result).toBe('hello');
        });

        test('should fall back when Gemini description returns null', async () => {
            mockIsGeminiAvailable.mockReturnValue(true);
            mockProcessMessageWithEmoteDescriptions.mockResolvedValue(null);

            const { formatTtsText } = await loadModule();

            const fragments = [
                { type: 'text', text: 'hello ' },
                { type: 'emote', text: 'Kappa', emote: { id: '25' } },
            ];

            const result = await formatTtsText('hello Kappa', fragments, {
                emoteMode: 'describe',
                channelEmoteMode: 'describe',
            });

            // Gemini returned null → fallback to 'read'
            expect(result).toBe('hello Kappa');
        });

        test('should fall back when Gemini throws an error', async () => {
            mockIsGeminiAvailable.mockReturnValue(true);
            mockProcessMessageWithEmoteDescriptions.mockRejectedValue(new Error('API error'));

            const { formatTtsText } = await loadModule();

            const fragments = [
                { type: 'text', text: 'hello ' },
                { type: 'emote', text: 'Kappa', emote: { id: '25' } },
            ];

            const result = await formatTtsText('hello Kappa', fragments, {
                emoteMode: 'describe',
                channelEmoteMode: 'read',
            });

            // channelEmoteMode is 'read' → fallback to raw text
            expect(result).toBe('hello Kappa');
        });

        test('should use replaceEmojisWithText for emoji processing', async () => {
            mockIsGeminiAvailable.mockReturnValue(false);

            const { formatTtsText } = await loadModule();

            const fragments = [{ type: 'text', text: 'hello' }];

            await formatTtsText('hello', fragments, {
                emoteMode: 'describe',
                channelEmoteMode: 'describe',
            });

            expect(mockReplaceEmojisWithText).toHaveBeenCalled();
            expect(mockStripEmojis).not.toHaveBeenCalled();
        });
    });

    // --- URL Processing ---
    describe('URL processing', () => {
        test('should pass readFullUrls to processMessageUrls', async () => {
            const { formatTtsText } = await loadModule();

            await formatTtsText('check https://example.com', null, {
                emoteMode: 'read',
                readFullUrls: true,
            });

            expect(mockProcessMessageUrls).toHaveBeenCalledWith('check https://example.com', true);
        });

        test('should default readFullUrls to false', async () => {
            const { formatTtsText } = await loadModule();

            await formatTtsText('hello', null, { emoteMode: 'read' });

            expect(mockProcessMessageUrls).toHaveBeenCalledWith('hello', false);
        });
    });

    // --- Defaults ---
    describe('defaults', () => {
        test('should default to read mode when no options provided', async () => {
            const { formatTtsText } = await loadModule();

            const result = await formatTtsText('hello Kappa', null);

            expect(result).toBe('hello Kappa');
        });

        test('should handle empty options object', async () => {
            const { formatTtsText } = await loadModule();

            const result = await formatTtsText('hello', null, {});

            expect(result).toBe('hello');
        });
    });
});
