// tests/unit/geminiEmoteDescriber.test.js
// Unit tests for emote description cache and emote subcommand

import { jest } from '@jest/globals';

describe('Emote Description Firestore Cache', () => {
    let mockLogger;
    let mockFirestoreDoc;
    let mockFirestoreCollection;
    let mockFirestoreInstance;

    beforeEach(() => {
        jest.resetModules();
        jest.clearAllMocks();

        mockLogger = {
            debug: jest.fn(),
            info: jest.fn(),
            warn: jest.fn(),
            error: jest.fn(),
        };

        // Build Firestore mock chain
        mockFirestoreDoc = {
            get: jest.fn(),
            set: jest.fn().mockResolvedValue(undefined),
            delete: jest.fn().mockResolvedValue(undefined),
        };

        mockFirestoreCollection = {
            doc: jest.fn().mockReturnValue(mockFirestoreDoc),
            where: jest.fn().mockReturnValue({
                get: jest.fn().mockResolvedValue({ forEach: jest.fn() }),
            }),
        };

        mockFirestoreInstance = {
            collection: jest.fn().mockReturnValue(mockFirestoreCollection),
        };

        jest.unstable_mockModule('../../src/lib/logger.js', () => ({
            default: mockLogger,
        }));

        jest.unstable_mockModule('@google-cloud/firestore', () => ({
            Firestore: jest.fn().mockImplementation(() => mockFirestoreInstance),
        }));

        jest.unstable_mockModule('@google/genai', () => ({
            GoogleGenAI: jest.fn(),
        }));

        jest.unstable_mockModule('sharp', () => ({
            default: jest.fn(),
        }));

        jest.unstable_mockModule('../../src/components/twitch/helixClient.js', () => ({
            getUsersById: jest.fn().mockResolvedValue([]),
            getUsersByLogin: jest.fn().mockResolvedValue([{ id: '12345', login: 'testchannel', display_name: 'TestChannel' }]),
            getBroadcasterIdByLogin: jest.fn().mockResolvedValue('12345'),
            getChannelEmotes: jest.fn().mockResolvedValue([]),
        }));

        // Mock config to provide emote constants without hitting the real loader
        jest.unstable_mockModule('../../src/config/index.js', () => ({
            default: {
                emote: {
                    geminiModel: 'gemini-test-model',
                    cdnUrl: 'https://static-cdn.jtvnw.net/emoticons/v2',
                    maxGifFrames: 3,
                    timeoutMs: 8000,
                    animatedTimeoutMs: 12000,
                },
            },
        }));
    });

    describe('initEmoteDescriptionStore', () => {
        test('should initialize Firestore client and return true', async () => {
            const { initEmoteDescriptionStore } = await import('../../src/lib/emotes/emoteCache.js');

            const result = initEmoteDescriptionStore();

            expect(result).toBe(true);
            expect(mockLogger.info).toHaveBeenCalledWith(
                expect.stringContaining('Firestore store initialized')
            );
        });
    });

    describe('invalidateEmoteDescription', () => {
        test('should delete from Firestore and return true', async () => {
            const { initEmoteDescriptionStore, invalidateEmoteDescription } = await import('../../src/lib/emotes/emoteCache.js');
            initEmoteDescriptionStore();

            const result = await invalidateEmoteDescription('emote123');

            expect(result).toBe(true);
            expect(mockFirestoreCollection.doc).toHaveBeenCalledWith('emote123');
            expect(mockFirestoreDoc.delete).toHaveBeenCalled();
            expect(mockLogger.info).toHaveBeenCalledWith(
                expect.objectContaining({ emoteId: 'emote123' }),
                expect.stringContaining('invalidated')
            );
        });

        test('should return true when Firestore is not initialized', async () => {
            const { invalidateEmoteDescription } = await import('../../src/lib/emotes/emoteCache.js');

            const result = await invalidateEmoteDescription('emote123');

            expect(result).toBe(true);
        });

        test('should return false when Firestore delete fails', async () => {
            const { initEmoteDescriptionStore, invalidateEmoteDescription } = await import('../../src/lib/emotes/emoteCache.js');
            initEmoteDescriptionStore();
            mockFirestoreDoc.delete.mockRejectedValueOnce(new Error('Firestore error'));

            const result = await invalidateEmoteDescription('emote123');

            expect(result).toBe(false);
            expect(mockLogger.error).toHaveBeenCalled();
        });
    });

    describe('getStoredEmoteDescription', () => {
        test('should return description from Firestore', async () => {
            const { initEmoteDescriptionStore, getStoredEmoteDescription } = await import('../../src/lib/emotes/emoteCache.js');
            initEmoteDescriptionStore();

            mockFirestoreDoc.get.mockResolvedValueOnce({
                exists: true,
                data: () => ({
                    description: 'a waving cat',
                    emoteName: 'catWave',
                    updatedAt: { toDate: () => new Date('2026-03-01') },
                }),
            });

            const result = await getStoredEmoteDescription('emote456');

            expect(result).toEqual({
                description: 'a waving cat',
                emoteName: 'catWave',
                updatedAt: new Date('2026-03-01'),
            });
        });

        test('should return null when document does not exist', async () => {
            const { initEmoteDescriptionStore, getStoredEmoteDescription } = await import('../../src/lib/emotes/emoteCache.js');
            initEmoteDescriptionStore();

            mockFirestoreDoc.get.mockResolvedValueOnce({
                exists: false,
            });

            const result = await getStoredEmoteDescription('nonexistent');

            expect(result).toBeNull();
        });

        test('should return null when Firestore is not initialized', async () => {
            const { getStoredEmoteDescription } = await import('../../src/lib/emotes/emoteCache.js');

            const result = await getStoredEmoteDescription('emote123');

            expect(result).toBeNull();
        });
    });

    describe('findEmoteDescriptionsByName', () => {
        test('should return matching descriptions', async () => {
            const { initEmoteDescriptionStore, findEmoteDescriptionsByName } = await import('../../src/lib/emotes/emoteCache.js');
            initEmoteDescriptionStore();

            const mockSnapshot = {
                forEach: (cb) => {
                    cb({
                        id: 'emote100',
                        data: () => ({ description: 'laughing person', emoteName: 'LUL' }),
                    });
                    cb({
                        id: 'emote200',
                        data: () => ({ description: 'laughing loudly', emoteName: 'LUL' }),
                    });
                },
            };

            mockFirestoreCollection.where.mockReturnValueOnce({
                get: jest.fn().mockResolvedValueOnce(mockSnapshot),
            });

            const results = await findEmoteDescriptionsByName('LUL');

            expect(results).toHaveLength(2);
            expect(results[0]).toEqual({ emoteId: 'emote100', description: 'laughing person', emoteName: 'LUL', ownerId: null });
            expect(results[1]).toEqual({ emoteId: 'emote200', description: 'laughing loudly', emoteName: 'LUL', ownerId: null });
            expect(mockFirestoreCollection.where).toHaveBeenCalledWith('emoteName', '==', 'LUL');
        });

        test('should return empty array when Firestore is not initialized', async () => {
            const { findEmoteDescriptionsByName } = await import('../../src/lib/emotes/emoteCache.js');

            const results = await findEmoteDescriptionsByName('LUL');

            expect(results).toEqual([]);
        });
    });
});

describe('groupFragments helper', () => {
    beforeEach(() => {
        jest.resetModules();
        jest.clearAllMocks();

        // Mock config for emoteProcessor's transitive imports
        jest.unstable_mockModule('../../src/config/index.js', () => ({
            default: {
                emote: {
                    geminiModel: 'gemini-test-model',
                    cdnUrl: 'https://static-cdn.jtvnw.net/emoticons/v2',
                    maxGifFrames: 3,
                    timeoutMs: 8000,
                    animatedTimeoutMs: 12000,
                },
            },
        }));

        jest.unstable_mockModule('../../src/lib/logger.js', () => ({
            default: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
        }));

        jest.unstable_mockModule('../../src/components/twitch/helixClient.js', () => ({
            getUsersById: jest.fn().mockResolvedValue([]),
        }));

        jest.unstable_mockModule('@google/genai', () => ({ GoogleGenAI: jest.fn() }));
        jest.unstable_mockModule('sharp', () => ({ default: jest.fn() }));
        jest.unstable_mockModule('@google-cloud/firestore', () => ({ Firestore: jest.fn() }));
    });

    test('groups consecutive identical emotes', async () => {
        const { groupFragments } = await import('../../src/lib/emotes/emoteProcessor.js');
        const fragments = [
            { type: 'emote', text: 'LUL', emote: { id: 'e1' }, count: 1 },
            { type: 'emote', text: 'LUL', emote: { id: 'e1' }, count: 1 },
            { type: 'emote', text: 'LUL', emote: { id: 'e1' }, count: 1 },
        ];
        const result = groupFragments(fragments);
        expect(result).toHaveLength(1);
        expect(result[0].count).toBe(3);
    });

    test('skips whitespace-only text fragments between same emotes', async () => {
        const { groupFragments } = await import('../../src/lib/emotes/emoteProcessor.js');
        const fragments = [
            { type: 'emote', text: 'LUL', emote: { id: 'e1' }, count: 1 },
            { type: 'text', text: ' ', emote: null },
            { type: 'emote', text: 'LUL', emote: { id: 'e1' }, count: 1 },
        ];
        const result = groupFragments(fragments);
        expect(result).toHaveLength(1);
        expect(result[0].count).toBe(2);
    });

    test('keeps different emotes separate', async () => {
        const { groupFragments } = await import('../../src/lib/emotes/emoteProcessor.js');
        const fragments = [
            { type: 'emote', text: 'LUL', emote: { id: 'e1' }, count: 1 },
            { type: 'emote', text: 'Kappa', emote: { id: 'e2' }, count: 1 },
        ];
        const result = groupFragments(fragments);
        expect(result).toHaveLength(2);
        expect(result[0].count).toBe(1);
        expect(result[1].count).toBe(1);
    });

    test('preserves non-whitespace text fragments in position', async () => {
        const { groupFragments } = await import('../../src/lib/emotes/emoteProcessor.js');
        const fragments = [
            { type: 'emote', text: 'LUL', emote: { id: 'e1' }, count: 1 },
            { type: 'text', text: 'hello', emote: null },
            { type: 'emote', text: 'LUL', emote: { id: 'e1' }, count: 1 },
        ];
        const result = groupFragments(fragments);
        expect(result).toHaveLength(3);
        expect(result[0].count).toBe(1);
        expect(result[1].type).toBe('text');
        expect(result[2].count).toBe(1);
    });
});

describe('Emote TTS Subcommand', () => {
    let mockChatSender;
    let mockLogger;
    let mockEmoteDescriber;

    beforeEach(() => {
        jest.resetModules();
        jest.clearAllMocks();

        mockLogger = {
            debug: jest.fn(),
            info: jest.fn(),
            warn: jest.fn(),
            error: jest.fn(),
        };

        mockChatSender = {
            enqueueMessage: jest.fn(),
        };

        mockEmoteDescriber = {
            findEmoteDescriptionsByName: jest.fn().mockResolvedValue([]),
            invalidateEmoteDescription: jest.fn().mockResolvedValue(true),
            setEmoteDescription: jest.fn().mockResolvedValue(true),
        };

        jest.unstable_mockModule('../../src/lib/logger.js', () => ({
            default: mockLogger,
        }));

        jest.unstable_mockModule('../../src/lib/chatSender.js', () => mockChatSender);

        // Mock the barrel — emote.js imports from here
        jest.unstable_mockModule('../../src/lib/emotes/index.js', () => mockEmoteDescriber);

        // emote.js also imports directly from helixClient for ownership checks
        jest.unstable_mockModule('../../src/components/twitch/helixClient.js', () => ({
            getBroadcasterIdByLogin: jest.fn().mockResolvedValue('12345'),
            getChannelEmotes: jest.fn().mockResolvedValue([]),
        }));
    });

    test('should show usage when no args', async () => {
        const emoteCmd = await import('../../src/components/commands/tts/emote.js');

        await emoteCmd.default.execute({
            channel: '#testchannel',
            user: { username: 'mod' },
            args: [],
            replyToId: '123',
        });

        expect(mockChatSender.enqueueMessage).toHaveBeenCalledWith(
            '#testchannel',
            expect.stringContaining('Usage'),
            { replyToId: '123' }
        );
    });

    test('should view cached description', async () => {
        mockEmoteDescriber.findEmoteDescriptionsByName.mockResolvedValueOnce([
            { emoteId: 'e1', description: 'laughing person', emoteName: 'LUL' },
        ]);

        const emoteCmd = await import('../../src/components/commands/tts/emote.js');

        await emoteCmd.default.execute({
            channel: '#testchannel',
            user: { username: 'mod' },
            args: ['LUL'],
            replyToId: '123',
        });

        expect(mockChatSender.enqueueMessage).toHaveBeenCalledWith(
            '#testchannel',
            expect.stringContaining('laughing person'),
            { replyToId: '123' }
        );
    });

    test('should report when no cached description found', async () => {
        const emoteCmd = await import('../../src/components/commands/tts/emote.js');

        await emoteCmd.default.execute({
            channel: '#testchannel',
            user: { username: 'mod' },
            args: ['UnknownEmote'],
            replyToId: '123',
        });

        expect(mockChatSender.enqueueMessage).toHaveBeenCalledWith(
            '#testchannel',
            expect.stringContaining('No cached description'),
            { replyToId: '123' }
        );
    });

    test('should regenerate (invalidate) emote descriptions', async () => {
        mockEmoteDescriber.findEmoteDescriptionsByName.mockResolvedValueOnce([
            { emoteId: 'e1', description: 'laughing person', emoteName: 'LUL', ownerId: '12345' },
        ]);

        const emoteCmd = await import('../../src/components/commands/tts/emote.js');

        await emoteCmd.default.execute({
            channel: '#testchannel',
            user: { username: 'mod' },
            args: ['regenerate', 'LUL'],
            replyToId: '123',
        });

        expect(mockEmoteDescriber.invalidateEmoteDescription).toHaveBeenCalledWith('e1');
        expect(mockChatSender.enqueueMessage).toHaveBeenCalledWith(
            '#testchannel',
            expect.stringContaining('Cleared 1'),
            { replyToId: '123' }
        );
    });

    test('should report when regenerate finds no matching emote', async () => {
        const emoteCmd = await import('../../src/components/commands/tts/emote.js');

        await emoteCmd.default.execute({
            channel: '#testchannel',
            user: { username: 'mod' },
            args: ['regenerate', 'UnknownEmote'],
            replyToId: '123',
        });

        expect(mockEmoteDescriber.invalidateEmoteDescription).not.toHaveBeenCalled();
        expect(mockChatSender.enqueueMessage).toHaveBeenCalledWith(
            '#testchannel',
            expect.stringContaining('No cached description'),
            { replyToId: '123' }
        );
    });

    test('should require emote name for regenerate', async () => {
        const emoteCmd = await import('../../src/components/commands/tts/emote.js');

        await emoteCmd.default.execute({
            channel: '#testchannel',
            user: { username: 'mod' },
            args: ['regenerate'],
            replyToId: '123',
        });

        expect(mockChatSender.enqueueMessage).toHaveBeenCalledWith(
            '#testchannel',
            expect.stringContaining('specify an emote name'),
            { replyToId: '123' }
        );
    });

    test('should manually set emote description', async () => {
        mockEmoteDescriber.findEmoteDescriptionsByName.mockResolvedValueOnce([
            { emoteId: 'e1', description: 'old description', emoteName: 'LUL', ownerId: '12345' },
        ]);

        const emoteCmd = await import('../../src/components/commands/tts/emote.js');

        await emoteCmd.default.execute({
            channel: '#testchannel',
            user: { username: 'mod' },
            args: ['set', 'LUL', '=', 'laughing face'],
            replyToId: '123',
        });

        expect(mockEmoteDescriber.setEmoteDescription).toHaveBeenCalledWith('e1', 'LUL', 'laughing face', '12345');
        expect(mockChatSender.enqueueMessage).toHaveBeenCalledWith(
            '#testchannel',
            expect.stringContaining('Updated 1'),
            { replyToId: '123' }
        );
    });

    test('should report when set finds no existing emote', async () => {
        const emoteCmd = await import('../../src/components/commands/tts/emote.js');

        await emoteCmd.default.execute({
            channel: '#testchannel',
            user: { username: 'mod' },
            args: ['set', 'UnknownEmote', '=', 'some description'],
            replyToId: '123',
        });

        expect(mockEmoteDescriber.setEmoteDescription).not.toHaveBeenCalled();
        expect(mockChatSender.enqueueMessage).toHaveBeenCalledWith(
            '#testchannel',
            expect.stringContaining('is not a channel emote'),
            { replyToId: '123' }
        );
    });

    test('should show usage when set is missing equals sign', async () => {
        const emoteCmd = await import('../../src/components/commands/tts/emote.js');

        await emoteCmd.default.execute({
            channel: '#testchannel',
            user: { username: 'mod' },
            args: ['set', 'LUL', 'laughing', 'face'],
            replyToId: '123',
        });

        expect(mockChatSender.enqueueMessage).toHaveBeenCalledWith(
            '#testchannel',
            expect.stringContaining('Usage'),
            { replyToId: '123' }
        );
    });

    test('should have moderator permission', async () => {
        const emoteCmd = await import('../../src/components/commands/tts/emote.js');
        expect(emoteCmd.default.permission).toBe('moderator');
    });
});
