// tests/unit/ttsQueueChatRemoval.test.js
// A moderator, or a spam filter such as Sery Bot, removes Twitch chat: it deletes
// one message (channel.chat.message_delete) or times out or bans a viewer
// (channel.chat.clear_user_messages). removeChatClips removes the clips made from
// those messages: from the queue, from the generation in progress, and from the
// player (dropClip). It remembers the removal, so a message still on its way to
// enqueue is not spoken. A ban that arrives before its message still covers it.

import { jest } from '@jest/globals';
import { createMockFirestore, FieldValue } from '../helpers/mockFirestore.js';
import { TEST_CHANNEL, mockChannelConfig } from '../helpers/testData.js';

describe('ttsQueue chat removal', () => {
    let ttsQueue;
    let mockWebServer;
    let mockTtsService;
    let streams;

    const flush = () => new Promise(r => setImmediate(() => setImmediate(r)));
    const wav = () => ({ kind: 'buffer', data: Buffer.from('fffb', 'hex'), mime: 'audio/wav', sampleRate: 24000 });
    const queue = () => ttsQueue.getOrCreateChannelQueue(TEST_CHANNEL).queue;
    const chat = (text, extra = {}) => ttsQueue.enqueue(TEST_CHANNEL, {
        text, user: 'viewer', userId: 'u1', type: 'chat', messageId: `m-${text}`, chatAtMs: Date.now(), ...extra,
    });

    beforeEach(async () => {
        jest.resetModules();
        streams = [];
        mockTtsService = { generateSpeech: jest.fn().mockResolvedValue(wav()) };
        mockWebServer = {
            hasActiveClients: jest.fn().mockReturnValue(true),
            sendAudioToChannel: jest.fn(),
            openClipStream: jest.fn((channel, clipId) => {
                const stream = { clipId, recipients: new Set(['pcm-socket']), chunk: jest.fn(), end: jest.fn() };
                streams.push(stream);
                return stream;
            }),
            sendClipMeta: jest.fn(() => new Set()),
            dropClips: jest.fn(() => 1),
            STOP_CURRENT_AUDIO: 'STOP_CURRENT_AUDIO',
        };
        const config = { ...mockChannelConfig, engineEnabled: true };
        jest.unstable_mockModule('@google-cloud/firestore', () => ({ Firestore: jest.fn(() => createMockFirestore()), FieldValue }));
        jest.unstable_mockModule('../../src/lib/logger.js', () => ({
            default: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
        }));
        jest.unstable_mockModule('../../src/components/tts/ttsService.js', () => mockTtsService);
        jest.unstable_mockModule('../../src/components/web/server.js', () => mockWebServer);
        jest.unstable_mockModule('../../src/components/tts/ttsState.js', () => ({
            getTtsState: jest.fn(async () => ({ ...config })),
            getChannelTtsConfig: jest.fn().mockResolvedValue(mockChannelConfig),
            getGlobalUserPreferences: jest.fn().mockResolvedValue({}),
            getChannelUserPreferences: jest.fn().mockResolvedValue({}),
        }));

        ttsQueue = await import('../../src/components/tts/ttsQueue.js');
        const allowList = await import('../../src/lib/allowList.js');
        allowList.addAllowedChannel(TEST_CHANNEL, '12345');
    });

    describe('the queue', () => {
        beforeEach(() => ttsQueue.pauseQueue(TEST_CHANNEL));

        it('keeps the message ID and the arrival time on the item', async () => {
            await chat('hello', { chatAtMs: 1000 });
            expect(queue()[0]).toMatchObject({ messageId: 'm-hello', chatAtMs: 1000 });
        });

        it('adds no message fields to an item without a chat message', async () => {
            await ttsQueue.enqueue(TEST_CHANNEL, { text: 'x subscribed', user: 'x', userId: 'u1', type: 'event' });
            expect(queue()[0]).not.toHaveProperty('messageId');
            expect(queue()[0]).not.toHaveProperty('chatAtMs');
        });

        it('removes a deleted message and keeps the others', async () => {
            await chat('spam');
            await chat('fine');
            const result = ttsQueue.removeChatClips(TEST_CHANNEL, { messageId: 'm-spam', atMs: Date.now() });
            expect(result.queued).toBe(1);
            expect(queue().map(i => i.text)).toEqual(['fine']);
        });

        it('removes every message of a banned viewer, but not their announcements or rewards', async () => {
            await chat('one');
            await chat('two');
            await chat('other viewer', { userId: 'u2' });
            await ttsQueue.enqueue(TEST_CHANNEL, { text: 'viewer subscribed', user: 'viewer', userId: 'u1', type: 'event' });
            await ttsQueue.enqueue(TEST_CHANNEL, { text: 'reward text', user: 'viewer', userId: 'u1', type: 'reward' });
            ttsQueue.removeChatClips(TEST_CHANNEL, { userId: 'u1', atMs: Date.now() });
            expect(queue().map(i => i.text)).toEqual(['other viewer', 'viewer subscribed', 'reward text']);
        });

        it('does not remove a YouTube message, whatever its ID', async () => {
            await chat('yt', { platform: 'youtube', userId: 'u1' });
            ttsQueue.removeChatClips(TEST_CHANNEL, { userId: 'u1', atMs: Date.now() });
            ttsQueue.removeChatClips(TEST_CHANNEL, { messageId: 'm-yt', atMs: Date.now() });
            expect(queue()).toHaveLength(1);
        });

        it('stops the prefetch of a removed item', async () => {
            await chat('first');
            await chat('spam');
            const cq = ttsQueue.getOrCreateChannelQueue(TEST_CHANNEL);
            const controller = new AbortController();
            cq.prefetchResults.set(queue()[1], { promise: Promise.resolve(null), controller });
            ttsQueue.removeChatClips(TEST_CHANNEL, { messageId: 'm-spam', atMs: Date.now() });
            expect(controller.signal.aborted).toBe(true);
            expect(cq.prefetchResults.size).toBe(0);
        });

        it('keeps the message ID through a handoff', async () => {
            await chat('hello');
            const handoff = JSON.parse(JSON.stringify(ttsQueue.takeQueueForHandoff(TEST_CHANNEL)));
            ttsQueue.adoptQueue(TEST_CHANNEL, handoff);
            expect(queue()[0].messageId).toBe('m-hello');
        });
    });

    describe('a message still on its way to enqueue', () => {
        beforeEach(() => ttsQueue.pauseQueue(TEST_CHANNEL));

        it('is not spoken when its message was deleted first', async () => {
            ttsQueue.removeChatClips(TEST_CHANNEL, { messageId: 'm-late', atMs: Date.now() });
            await chat('late');
            expect(queue()).toHaveLength(0);
        });

        it('is not spoken when the ban arrived first, within the grace period', async () => {
            const banAt = Date.now();
            ttsQueue.removeChatClips(TEST_CHANNEL, { userId: 'u1', atMs: banAt });
            await chat('spam link', { chatAtMs: banAt + 800 });
            expect(queue()).toHaveLength(0);
        });

        it('is spoken when the viewer writes again after a timeout ended', async () => {
            const purgeAt = Date.now() - 60_000;
            ttsQueue.removeChatClips(TEST_CHANNEL, { userId: 'u1', atMs: purgeAt });
            await chat('back again', { chatAtMs: Date.now() });
            expect(queue()).toHaveLength(1);
        });

        it('applies a timeout only in its own channel', async () => {
            ttsQueue.removeChatClips('otherchannel', { userId: 'u1', atMs: Date.now() });
            await chat('hello');
            expect(queue()).toHaveLength(1);
        });
    });

    describe('the player', () => {
        it('tells the player to drop a clip it was already sent', async () => {
            await chat('spam');
            await flush();
            const clipId = streams[0].clipId;
            const result = ttsQueue.removeChatClips(TEST_CHANNEL, { messageId: 'm-spam', atMs: Date.now() });
            expect(result.sent).toBe(1);
            expect(mockWebServer.dropClips).toHaveBeenCalledWith(TEST_CHANNEL, [clipId]);
        });

        it('drops the sent clips of a banned viewer only', async () => {
            await chat('one');
            await flush();
            await chat('other', { userId: 'u2' });
            await flush();
            await chat('two');
            await flush();
            ttsQueue.removeChatClips(TEST_CHANNEL, { userId: 'u1', atMs: Date.now() });
            expect(mockWebServer.dropClips).toHaveBeenCalledWith(TEST_CHANNEL, [streams[0].clipId, streams[2].clipId]);
        });

        it('does not name a clip twice', async () => {
            await chat('spam');
            await flush();
            ttsQueue.removeChatClips(TEST_CHANNEL, { messageId: 'm-spam', atMs: Date.now() });
            ttsQueue.removeChatClips(TEST_CHANNEL, { userId: 'u1', atMs: Date.now() });
            expect(mockWebServer.dropClips).toHaveBeenCalledTimes(1);
        });

        it('stops the generation in progress and discards the streamed slices', async () => {
            mockTtsService.generateSpeech.mockImplementation((text, voice, { signal }) => new Promise((resolve, reject) => {
                signal.addEventListener('abort', () => {
                    const err = new Error('aborted');
                    err.name = 'AbortError';
                    reject(err);
                });
            }));
            await chat('spam');
            await flush();
            const result = ttsQueue.removeChatClips(TEST_CHANNEL, { messageId: 'm-spam', atMs: Date.now() });
            expect(result.generating).toBe(true);
            await flush();
            expect(streams[0].end).toHaveBeenCalledWith({ discard: true });
            expect(mockWebServer.sendAudioToChannel).not.toHaveBeenCalled();
        });
    });
});
