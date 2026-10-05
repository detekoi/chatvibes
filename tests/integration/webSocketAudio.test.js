// tests/integration/webSocketAudio.test.js
// Drives a real WebSocketServer over a real socket. The audio delivery path had no
// coverage at all, and it is where the latency win actually lands: audio now travels
// as binary frames on this connection instead of as a link the browser must fetch
// from a CDN in another country.

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

/**
 * Connect a client and wait until the server has registered it.
 * @param {boolean} announceBinary - whether to send the capability hello a current
 *   player sends. Omitting it is how an OBS source on a cached old build behaves.
 */
async function connect({ announceBinary = true } = {}) {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/?channel=${CHANNEL}&token=${TOKEN}`);
    const messages = [];
    ws.on('message', (data, isBinary) => messages.push({ data, isBinary }));

    await new Promise((resolve, reject) => {
        ws.on('open', resolve);
        ws.on('error', reject);
    });

    if (announceBinary) {
        ws.send(JSON.stringify({ type: 'hello', features: ['binaryAudio'] }));
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

const bufferPayload = (bytes = [0x49, 0x44, 0x33, 0xff, 0xfb]) => ({
    kind: 'buffer',
    data: Buffer.from(bytes),
    mime: 'audio/mpeg'
});

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
    test('sends inline audio as a binary frame to a current player', async () => {
        const { ws, messages } = await connect();
        const payload = bufferPayload();

        webSocketModule.sendAudioToChannel(CHANNEL, payload);
        await new Promise(resolve => setTimeout(resolve, 50));

        const binary = messages.filter(m => m.isBinary);
        expect(binary).toHaveLength(1);
        expect(Buffer.from(binary[0].data)).toEqual(payload.data);
        ws.close();
    });

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
        test('does not prefer URL audio when every client announced binary support', async () => {
            const { ws } = await connect({ announceBinary: true });
            expect(webSocketModule.channelPrefersUrlAudio(CHANNEL)).toBe(false);
            ws.close();
        });

        test('prefers URL audio when a client never announced support', async () => {
            const { ws } = await connect({ announceBinary: false });
            expect(webSocketModule.channelPrefersUrlAudio(CHANNEL)).toBe(true);
            ws.close();
        });

        test('prefers URL audio if any one of several clients is outdated', async () => {
            const current = await connect({ announceBinary: true });
            const stale = await connect({ announceBinary: false });

            expect(webSocketModule.channelPrefersUrlAudio(CHANNEL)).toBe(true);

            current.ws.close();
            stale.ws.close();
        });

        test('returns false for a channel with no clients', () => {
            expect(webSocketModule.channelPrefersUrlAudio('nobody-here')).toBe(false);
        });

        test('goes back to binary once the outdated client disconnects', async () => {
            const current = await connect({ announceBinary: true });
            const stale = await connect({ announceBinary: false });
            expect(webSocketModule.channelPrefersUrlAudio(CHANNEL)).toBe(true);

            stale.ws.close();
            await new Promise(resolve => setTimeout(resolve, 100));

            expect(webSocketModule.channelPrefersUrlAudio(CHANNEL)).toBe(false);
            current.ws.close();
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

        test('does not nudge a channel whose clients are all current', async () => {
            const { ws } = await connect({ announceBinary: true });

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
