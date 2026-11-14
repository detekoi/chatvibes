// tests/integration/webSocketAudio.test.js
// Drives a real WebSocketServer over a real socket. Audio travels as binary frames on
// this connection: a whole clip is one WAV file, and a player that announced `pcmAudio`
// gets the clip slice by slice as raw 16-bit PCM between audioStart and audioEnd.

import { jest } from '@jest/globals';
import http from 'http';
import { WebSocket } from 'ws';

const CHANNEL = 'testchannel';
const TOKEN = 'test-obs-token';

let mockGetTtsState;
let mockSetTtsState;
let mockEnqueueMessage;
let mockIsChannelAllowed;
let webSocketModule;
let server;
let wss;
let port;

beforeEach(async () => {
    jest.resetModules();
    jest.clearAllMocks();

    mockGetTtsState = jest.fn().mockResolvedValue({ obsSocketToken: TOKEN });
    mockSetTtsState = jest.fn().mockResolvedValue(true);
    mockEnqueueMessage = jest.fn().mockResolvedValue(undefined);

    jest.unstable_mockModule('../../src/lib/logger.js', () => ({
        default: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() }
    }));
    mockIsChannelAllowed = jest.fn(() => true);
    jest.unstable_mockModule('../../src/lib/allowList.js', () => ({
        isChannelAllowed: mockIsChannelAllowed,
        resolveToChannelName: jest.fn(id => String(id).toLowerCase())
    }));
    jest.unstable_mockModule('../../src/components/tts/ttsState.js', () => ({
        getTtsState: mockGetTtsState,
        setTtsState: mockSetTtsState
    }));
    jest.unstable_mockModule('../../src/lib/secretManager.js', () => ({
        getSecretValue: jest.fn().mockResolvedValue(null)
    }));
    jest.unstable_mockModule('../../src/lib/clientIp.js', () => ({
        getClientIp: jest.fn(() => '127.0.0.1')
    }));
    jest.unstable_mockModule('../../src/lib/chatSender.js', () => ({
        enqueueMessage: mockEnqueueMessage
    }));

    webSocketModule = await import('../../src/components/web/webSocket.js');

    server = http.createServer();
    await new Promise(resolve => server.listen(0, resolve));
    port = server.address().port;
    wss = webSocketModule.initializeWebSocketServer(server);
});

afterEach(async () => {
    jest.restoreAllMocks();
    wss?.clients?.forEach(c => c.terminate());
    await new Promise(resolve => wss.close(resolve));
    await new Promise(resolve => server.close(resolve));
});

// What the players say in their hello. The one from before the Gemini migration took
// MP3 slices; it still takes a whole clip as one binary frame.
const CURRENT_PLAYER = ['binaryAudio', 'pcmAudio'];
const MP3_ERA_PLAYER = ['binaryAudio', 'chunkedAudio'];

/**
 * Connect a client and wait until the server has registered it.
 * @param {boolean} announceBinary - whether to send a capability hello at all.
 *   Omitting it is how an OBS source on a cached old build behaves.
 * @param {string[]} features - the features the hello names. The default is a player
 *   that takes whole clips only, so whole-clip tests see no slices.
 */
async function connect({ announceBinary = true, features = ['binaryAudio'] } = {}) {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/?channel=${CHANNEL}&token=${TOKEN}`);
    const messages = [];
    ws.on('message', (data, isBinary) => messages.push({ data, isBinary }));

    await new Promise((resolve, reject) => {
        ws.on('open', resolve);
        ws.on('error', reject);
    });

    if (announceBinary) {
        ws.send(JSON.stringify({ type: 'hello', features }));
    }
    // Let the server process registration and the hello before asserting on state.
    await new Promise(resolve => setTimeout(resolve, 50));
    return { ws, messages };
}

/**
 * Move the clock forward. A client that has not said hello is only treated as an
 * outdated player once the hello grace period has passed, and held clips expire.
 */
function advanceClock(ms) {
    const now = Date.now() + ms;
    jest.spyOn(Date, 'now').mockReturnValue(now);
}

const PAST_HELLO_GRACE_MS = 5000;

// A whole clip as generateSpeech returns it: a WAV file. The server does not look
// inside it, so a RIFF tag and a few bytes are enough.
const bufferPayload = (bytes = [0x52, 0x49, 0x46, 0x46, 0x01, 0x02]) => ({
    kind: 'buffer',
    data: Buffer.from(bytes),
    mime: 'audio/wav',
    sampleRate: 24000
});

// Control messages, without the `registered` greeting every client gets on connect.
const jsonFrames = messages => messages
    .filter(m => !m.isBinary)
    .map(m => JSON.parse(m.data.toString()))
    .filter(m => m.type !== 'registered');
/** The order of everything on the wire after the greeting: a message type, or 'slice'. */
const wireOrder = messages => messages
    .map(m => (m.isBinary ? 'slice' : JSON.parse(m.data.toString()).type))
    .filter(type => type !== 'registered');
const audioFrames = messages => messages.filter(m => m.isBinary).map(m => Buffer.from(m.data));
const settle = (ms = 50) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Connect and resolve with how the handshake ended: 'open' when the upgrade
 * completed, or the HTTP status the server answered with when it refused.
 */
function attemptConnect(query) {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/${query}`);
    return new Promise(resolve => {
        ws.on('open', () => resolve({ outcome: 'open', ws }));
        ws.on('unexpected-response', (_req, res) => {
            ws.terminate();
            resolve({ outcome: 'rejected', status: res.statusCode });
        });
        ws.on('error', err => resolve({ outcome: 'error', err }));
    });
}

describe('upgrade gate', () => {
    // A rejection that arrives after the handshake succeeds is what turned a
    // stale OBS browser source into a reconnect storm: the player counts the
    // upgrade as a success, resets its backoff, and retries forever.
    test('refuses a channel outside the allow-list before upgrading', async () => {
        mockIsChannelAllowed.mockReturnValue(false);

        const result = await attemptConnect(`?channel=notallowed&token=${TOKEN}`);

        expect(result.outcome).toBe('rejected');
        expect(result.status).toBe(403);
    });

    test('refuses a connection with no channel or token before upgrading', async () => {
        const result = await attemptConnect('?channel=only');

        expect(result.outcome).toBe('rejected');
        expect(result.status).toBe(400);
    });

    test('upgrades an allow-listed channel', async () => {
        const result = await attemptConnect(`?channel=${CHANNEL}&token=${TOKEN}`);

        expect(result.outcome).toBe('open');
        result.ws.close();
    });

    test('closes with 1008 rather than refusing when only the token is wrong', async () => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}/?channel=${CHANNEL}&token=wrong-token`);
        const closeCode = await new Promise(resolve => {
            ws.on('close', code => resolve(code));
            ws.on('error', () => {});
        });

        expect(closeCode).toBe(1008);
    });
});

describe('WebSocket audio delivery', () => {
    test('sends a whole clip as one binary WAV frame', async () => {
        const { ws, messages } = await connect();
        const payload = bufferPayload();

        webSocketModule.sendAudioToChannel(CHANNEL, payload);
        await new Promise(resolve => setTimeout(resolve, 50));

        const binary = messages.filter(m => m.isBinary);
        expect(binary).toHaveLength(1);
        expect(Buffer.from(binary[0].data)).toEqual(payload.data);
        ws.close();
    });

    // The Gemini provider never returns a URL, but sendAudioToChannel still takes one.
    test('sends a URL payload as JSON, to current and outdated players alike', async () => {
        const { ws, messages } = await connect();

        webSocketModule.sendAudioToChannel(CHANNEL, { kind: 'url', url: 'https://cdn.example/a.mp3' });
        await new Promise(resolve => setTimeout(resolve, 50));

        const parsed = messages.filter(m => !m.isBinary).map(m => JSON.parse(m.data.toString()));
        expect(parsed).toContainEqual({ type: 'playAudio', url: 'https://cdn.example/a.mp3' });
        ws.close();
    });

    test('sends the stop sentinel as JSON', async () => {
        const { ws, messages } = await connect();

        webSocketModule.sendAudioToChannel(CHANNEL, webSocketModule.STOP_CURRENT_AUDIO);
        await new Promise(resolve => setTimeout(resolve, 50));

        const parsed = messages.filter(m => !m.isBinary).map(m => JSON.parse(m.data.toString()));
        expect(parsed).toContainEqual({ type: 'stopAudio' });
        ws.close();
    });

    describe('capability negotiation', () => {
        test('has no URL preference to ask about any more', async () => {
            const server = await import('../../src/components/web/server.js');

            expect(webSocketModule.channelPrefersUrlAudio).toBeUndefined();
            expect(server.channelPrefersUrlAudio).toBeUndefined();
        });

        test.each([
            ['a current player', CURRENT_PLAYER],
            ['a player from before the Gemini migration', MP3_ERA_PLAYER],
            ['a player that announced binary audio only', ['binaryAudio']],
        ])('sends a whole clip to %s', async (_label, features) => {
            const { ws, messages } = await connect({ features });
            const payload = bufferPayload();

            webSocketModule.sendAudioToChannel(CHANNEL, payload);
            await settle();

            expect(audioFrames(messages)).toEqual([payload.data]);
            expect(mockEnqueueMessage).not.toHaveBeenCalled();
            ws.close();
        });

        test('sends no binary frame to a player whose hello did not name binaryAudio', async () => {
            const { ws, messages } = await connect({ features: ['pcmAudio'] });

            webSocketModule.sendAudioToChannel(CHANNEL, bufferPayload());
            await settle();

            expect(audioFrames(messages)).toHaveLength(0);
            ws.close();
        });
    });

    describe('sliced clip delivery', () => {
        test('returns null for a channel with no clients', () => {
            expect(webSocketModule.openClipStream('nobody-here', 'clip-1')).toBeNull();
        });

        test.each([
            ['announced binary audio only', { features: ['binaryAudio'] }],
            ['announced the MP3 slices of the old player', { features: MP3_ERA_PLAYER }],
            ['announced pcmAudio without binaryAudio', { features: ['pcmAudio'] }],
            ['has not said hello', { announceBinary: false }],
        ])('returns null and sends nothing when the only player %s', async (_label, options) => {
            const { ws, messages } = await connect(options);

            expect(webSocketModule.openClipStream(CHANNEL, 'clip-1')).toBeNull();
            await settle();

            expect(wireOrder(messages)).toEqual([]);
            ws.close();
        });

        test('opens with an audioStart that names the PCM format and the default sample rate', async () => {
            const { ws, messages } = await connect({ features: CURRENT_PLAYER });

            const stream = webSocketModule.openClipStream(CHANNEL, 'clip-1');
            await settle();

            expect(stream.recipients.size).toBe(1);
            expect(jsonFrames(messages)).toEqual([{ type: 'audioStart', clipId: 'clip-1', format: 'pcm_s16le', sampleRate: 24000 }]);
            ws.close();
        });

        test('names the sample rate it is given', async () => {
            const { ws, messages } = await connect({ features: CURRENT_PLAYER });

            webSocketModule.openClipStream(CHANNEL, 'clip-1', { sampleRate: 48000 });
            await settle();

            expect(jsonFrames(messages)).toEqual([{ type: 'audioStart', clipId: 'clip-1', format: 'pcm_s16le', sampleRate: 48000 }]);
            ws.close();
        });

        test('sends the slices as binary frames in order, then audioEnd', async () => {
            const { ws, messages } = await connect({ features: CURRENT_PLAYER });
            const slices = [Buffer.from([1, 0, 2, 0]), Buffer.from([3, 0]), Buffer.from([4, 0, 5, 0])];

            const stream = webSocketModule.openClipStream(CHANNEL, 'clip-1');
            slices.forEach(slice => stream.chunk(slice));
            stream.end();
            await settle();

            expect(audioFrames(messages)).toEqual(slices);
            // On the wire: the start, every slice, then the end.
            expect(wireOrder(messages)).toEqual(['audioStart', 'slice', 'slice', 'slice', 'audioEnd']);
            expect(jsonFrames(messages).at(-1)).toEqual({ type: 'audioEnd', clipId: 'clip-1', discard: false });
            ws.close();
        });

        test('tells the player to drop the clip when it ends with discard', async () => {
            const { ws, messages } = await connect({ features: CURRENT_PLAYER });

            const stream = webSocketModule.openClipStream(CHANNEL, 'clip-1');
            stream.chunk(Buffer.from([1, 0]));
            stream.end({ discard: true });
            await settle();

            expect(jsonFrames(messages).at(-1)).toEqual({ type: 'audioEnd', clipId: 'clip-1', discard: true });
            ws.close();
        });

        test('slices go to the PCM player; the old player gets the same clip whole, as WAV', async () => {
            const current = await connect({ features: CURRENT_PLAYER });
            const old = await connect({ features: MP3_ERA_PLAYER });
            const slice = Buffer.from([1, 0, 2, 0]);
            const whole = bufferPayload();

            // What the queue does with a finished clip.
            const stream = webSocketModule.openClipStream(CHANNEL, 'clip-1');
            stream.chunk(slice);
            stream.end();
            webSocketModule.sendAudioToChannel(CHANNEL, whole, { exclude: stream.recipients });
            await settle();

            expect(stream.recipients.size).toBe(1);
            expect(audioFrames(current.messages)).toEqual([slice]);
            expect(jsonFrames(current.messages).map(m => m.type)).toEqual(['audioStart', 'audioEnd']);
            expect(audioFrames(old.messages)).toEqual([whole.data]);
            expect(jsonFrames(old.messages)).toEqual([]);
            current.ws.close();
            old.ws.close();
        });

        test('a player that connects in the middle of a clip gets none of it', async () => {
            const first = await connect({ features: CURRENT_PLAYER });

            const stream = webSocketModule.openClipStream(CHANNEL, 'clip-1');
            stream.chunk(Buffer.from([1, 0]));
            const late = await connect({ features: CURRENT_PLAYER });
            stream.chunk(Buffer.from([2, 0]));
            stream.end();
            await settle();

            expect(audioFrames(first.messages)).toHaveLength(2);
            expect(wireOrder(late.messages)).toEqual([]);
            first.ws.close();
            late.ws.close();
        });

        test('skips a recipient that disconnected and keeps sending to the rest', async () => {
            const staying = await connect({ features: CURRENT_PLAYER });
            const leaving = await connect({ features: CURRENT_PLAYER });

            const stream = webSocketModule.openClipStream(CHANNEL, 'clip-1');
            leaving.ws.close();
            await settle(100);
            expect(() => {
                stream.chunk(Buffer.from([1, 0]));
                stream.end();
            }).not.toThrow();
            await settle();

            expect(audioFrames(staying.messages)).toEqual([Buffer.from([1, 0])]);
            staying.ws.close();
        });
    });

    describe('outdated-player chat notice', () => {
        test('nudges the channel when a buffer cannot be delivered', async () => {
            const { ws } = await connect({ announceBinary: false });
            advanceClock(PAST_HELLO_GRACE_MS);

            webSocketModule.sendAudioToChannel(CHANNEL, bufferPayload());
            await new Promise(resolve => setTimeout(resolve, 50));

            expect(mockEnqueueMessage).toHaveBeenCalledTimes(1);
            expect(mockEnqueueMessage.mock.calls[0][1]).toMatch(/refresh/i);
            // Recorded so a reconnect, instance swap or redeploy does not re-nag.
            expect(mockSetTtsState).toHaveBeenCalledWith(CHANNEL, 'stalePlayerNoticeAt', expect.any(Number));
            ws.close();
        });

        test('does not nudge again while the notice is recent', async () => {
            mockGetTtsState.mockResolvedValue({ obsSocketToken: TOKEN, stalePlayerNoticeAt: Date.now() });
            const { ws } = await connect({ announceBinary: false });
            advanceClock(PAST_HELLO_GRACE_MS);

            webSocketModule.sendAudioToChannel(CHANNEL, bufferPayload());
            await new Promise(resolve => setTimeout(resolve, 50));

            expect(mockEnqueueMessage).not.toHaveBeenCalled();
            ws.close();
        });

        test('nudges again once the interval has elapsed', async () => {
            const eightDaysAgo = Date.now() - 8 * 24 * 60 * 60 * 1000;
            mockGetTtsState.mockResolvedValue({ obsSocketToken: TOKEN, stalePlayerNoticeAt: eightDaysAgo });
            const { ws } = await connect({ announceBinary: false });
            advanceClock(PAST_HELLO_GRACE_MS);

            webSocketModule.sendAudioToChannel(CHANNEL, bufferPayload());
            await new Promise(resolve => setTimeout(resolve, 50));

            expect(mockEnqueueMessage).toHaveBeenCalledTimes(1);
            ws.close();
        });

        test('does not nudge a player from before the Gemini migration: it still takes whole clips', async () => {
            const { ws } = await connect({ features: MP3_ERA_PLAYER });
            advanceClock(PAST_HELLO_GRACE_MS);

            webSocketModule.sendAudioToChannel(CHANNEL, bufferPayload());
            await new Promise(resolve => setTimeout(resolve, 50));

            expect(mockEnqueueMessage).not.toHaveBeenCalled();
            ws.close();
        });

        test('does not nudge a channel whose clients are all current', async () => {
            const { ws } = await connect({ features: CURRENT_PLAYER });

            webSocketModule.sendAudioToChannel(CHANNEL, bufferPayload());
            await new Promise(resolve => setTimeout(resolve, 50));

            expect(mockEnqueueMessage).not.toHaveBeenCalled();
            ws.close();
        });
    });

    describe('clips that reach no player', () => {
        const binaryFrames = messages => messages.filter(m => m.isBinary).map(m => Buffer.from(m.data));
        const tick = (ms = 50) => new Promise(resolve => setTimeout(resolve, ms));

        test('replays a clip sent while no player was connected once one says hello', async () => {
            const payload = bufferPayload();
            webSocketModule.sendAudioToChannel(CHANNEL, payload);

            const { ws, messages } = await connect();

            expect(binaryFrames(messages)).toEqual([payload.data]);
            ws.close();
        });

        test('replays a held clip only once', async () => {
            webSocketModule.sendAudioToChannel(CHANNEL, bufferPayload());
            const first = await connect();
            const second = await connect();

            expect(binaryFrames(first.messages)).toHaveLength(1);
            expect(binaryFrames(second.messages)).toHaveLength(0);
            first.ws.close();
            second.ws.close();
        });

        test('replays a held URL clip as JSON', async () => {
            webSocketModule.sendAudioToChannel(CHANNEL, { kind: 'url', url: 'https://cdn.example/a.mp3' });

            const { ws, messages } = await connect();

            const parsed = messages.filter(m => !m.isBinary).map(m => JSON.parse(m.data.toString()));
            expect(parsed).toContainEqual({ type: 'playAudio', url: 'https://cdn.example/a.mp3' });
            ws.close();
        });

        test('keeps a held buffer for the next player when one without binary support says hello', async () => {
            const payload = bufferPayload();
            webSocketModule.sendAudioToChannel(CHANNEL, payload);

            const urlOnly = await connect({ announceBinary: false });
            urlOnly.ws.send(JSON.stringify({ type: 'hello', features: [] }));
            await tick();
            const current = await connect();

            expect(binaryFrames(urlOnly.messages)).toHaveLength(0);
            expect(binaryFrames(current.messages)).toEqual([payload.data]);
            urlOnly.ws.close();
            current.ws.close();
        });

        test('a stop drops the held clip', async () => {
            webSocketModule.sendAudioToChannel(CHANNEL, bufferPayload());
            webSocketModule.sendAudioToChannel(CHANNEL, webSocketModule.STOP_CURRENT_AUDIO);

            const { ws, messages } = await connect();

            expect(binaryFrames(messages)).toHaveLength(0);
            ws.close();
        });

        test('does not replay a clip held past its expiry', async () => {
            webSocketModule.sendAudioToChannel(CHANNEL, bufferPayload());
            advanceClock(60_000);

            const { ws, messages } = await connect();

            expect(binaryFrames(messages)).toHaveLength(0);
            ws.close();
        });

        test('holds a buffer for a player that has not said hello yet, without calling it outdated', async () => {
            const { ws, messages } = await connect({ announceBinary: false });
            const payload = bufferPayload();

            webSocketModule.sendAudioToChannel(CHANNEL, payload);
            await tick();
            expect(binaryFrames(messages)).toHaveLength(0);
            expect(mockEnqueueMessage).not.toHaveBeenCalled();

            ws.send(JSON.stringify({ type: 'hello', features: ['binaryAudio'] }));
            await tick();

            expect(binaryFrames(messages)).toEqual([payload.data]);
            ws.close();
        });

        test('does not hold a clip a chunked player already received', async () => {
            const chunked = await connect();
            const payload = bufferPayload();

            webSocketModule.sendAudioToChannel(CHANNEL, payload, { exclude: new Set(wss.clients) });
            const later = await connect();

            expect(binaryFrames(chunked.messages)).toHaveLength(0);
            expect(binaryFrames(later.messages)).toHaveLength(0);
            chunked.ws.close();
            later.ws.close();
        });
    });
});
