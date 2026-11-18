// tests/unit/spotlightRouter.test.js
// The spotlight router: one flex call, then at most one standard call.
//
// Flex is best-effort. A timeout, a network error, a 429, a 5xx or an answer that
// is not the schema gets one standard attempt without service_tier. A 400 is a
// bug in the request and is not repeated. Two failures return null. The picks are
// restricted to the IDs that were sent, each once.

import { jest } from '@jest/globals';

describe('spotlightRouter.pickNotable', () => {
    let pickNotable;
    let logger;
    const realFetch = global.fetch;

    const candidates = [
        { id: 'm1', user: 'alpha', text: 'hi' },
        { id: 'm2', user: 'beta', text: 'that boss should pay rent' },
        { id: 'm3', user: 'gamma', text: 'how did you get the gold can?' },
    ];

    const answer = (picks, usage = { total_input_tokens: 800, total_output_tokens: 20, total_thought_tokens: 0 }) => ({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
            status: 'completed',
            usage,
            service_tier: 'flex',
            steps: [
                { type: 'thought', signature: 'x' },
                { type: 'model_output', content: [{ type: 'text', text: JSON.stringify({ picks }) }] },
            ],
        }),
    });
    const httpError = (status) => ({
        ok: false,
        status,
        text: async () => JSON.stringify({ error: { message: `error ${status}`, code: 'x' } }),
    });
    const body = (call) => JSON.parse(global.fetch.mock.calls[call][1].body);
    const routeLog = () => logger.info.mock.calls.find(c => c[0]?.logKey === 'SPOTLIGHT_ROUTE')?.[0];

    beforeEach(async () => {
        jest.resetModules();
        logger = { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() };
        jest.unstable_mockModule('../../src/lib/logger.js', () => ({ default: logger }));
        jest.unstable_mockModule('../../src/config/index.js', () => ({
            default: {
                tts: { geminiApiKey: 'test-key', geminiEndpoint: 'https://example.test/v1beta/interactions' },
                spotlight: { geminiModel: 'gemini-3.5-flash-lite', flexTimeoutMs: 50, standardTimeoutMs: 50 },
            },
        }));
        global.fetch = jest.fn();
        ({ pickNotable } = await import('../../src/lib/spotlight/spotlightRouter.js'));
    });

    afterEach(() => {
        global.fetch = realFetch;
    });

    it('sends one flex request with store false and the proven fields', async () => {
        global.fetch.mockResolvedValueOnce(answer([{ id: 'm2', reason: 'funny' }]));
        const picks = await pickNotable({ candidates, context: [{ user: 'x', text: 'earlier' }], guidance: 'prefer questions', language: 'English', channel: 'chan' });

        expect(picks).toEqual([{ id: 'm2', reason: 'funny' }]);
        expect(global.fetch).toHaveBeenCalledTimes(1);
        const [url, init] = global.fetch.mock.calls[0];
        expect(url).toBe('https://example.test/v1beta/interactions');
        expect(init.headers).toEqual({ 'x-goog-api-key': 'test-key', 'Content-Type': 'application/json' });
        const sent = body(0);
        expect(sent).toMatchObject({
            model: 'gemini-3.5-flash-lite',
            store: false,
            service_tier: 'flex',
            generation_config: { thinking_level: 'minimal' },
            response_format: { type: 'text', mime_type: 'application/json' },
        });
        expect(typeof sent.system_instruction).toBe('string');
        expect(sent).not.toHaveProperty('temperature');
        const input = JSON.parse(sent.input[0].content[0].text);
        expect(input).toEqual({
            guidance: 'prefer questions',
            language: 'English',
            context: [{ user: 'x', text: 'earlier' }],
            candidates,
        });
    });

    it('never puts chat text in the info log line', async () => {
        global.fetch.mockResolvedValueOnce(answer([{ id: 'm2', reason: 'funny' }]));
        await pickNotable({ candidates, channel: 'chan' });
        const line = JSON.stringify(logger.info.mock.calls);
        expect(line).not.toMatch(/pay rent|funny/);
        expect(routeLog()).toMatchObject({ channel: 'chan', tier: 'flex', fellBack: false, batchSize: 3, picks: 1, inputTokens: 800, outputTokens: 20 });
    });

    it.each([
        ['a 429', () => httpError(429)],
        ['a 503', () => httpError(503)],
        ['a 500', () => httpError(500)],
        ['a network error', () => { throw new TypeError('fetch failed'); }],
        ['an answer that is not JSON', () => ({ ok: true, status: 200, text: async () => 'not json' })],
        ['an answer with the wrong shape', () => ({
            ok: true, status: 200,
            text: async () => JSON.stringify({ steps: [{ type: 'model_output', content: [{ type: 'text', text: '{"choices":[]}' }] }] }),
        })],
    ])('makes exactly one standard call without service_tier after %s on flex', async (_label, flexResult) => {
        global.fetch
            .mockImplementationOnce(async () => flexResult())
            .mockResolvedValueOnce(answer([{ id: 'm3', reason: 'question' }]));
        const picks = await pickNotable({ candidates, channel: 'chan' });

        expect(picks).toEqual([{ id: 'm3', reason: 'question' }]);
        expect(global.fetch).toHaveBeenCalledTimes(2);
        expect(body(0).service_tier).toBe('flex');
        expect(body(1)).not.toHaveProperty('service_tier');
        expect(body(1).store).toBe(false);
        expect(routeLog()).toMatchObject({ tier: 'standard', fellBack: true });
    });

    it('aborts a slow flex call after flexTimeoutMs and asks standard once', async () => {
        global.fetch
            .mockImplementationOnce((_url, init) => new Promise((_resolve, reject) => {
                init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
            }))
            .mockResolvedValueOnce(answer([]));
        const picks = await pickNotable({ candidates, channel: 'chan' });

        expect(picks).toEqual([]);
        expect(global.fetch).toHaveBeenCalledTimes(2);
        expect(routeLog()).toMatchObject({ tier: 'standard', fellBack: true, flexOutcome: 'timeout' });
    });

    it('returns null when the standard call fails too', async () => {
        global.fetch.mockResolvedValueOnce(httpError(503)).mockResolvedValueOnce(httpError(503));
        await expect(pickNotable({ candidates, channel: 'chan' })).resolves.toBeNull();
        expect(global.fetch).toHaveBeenCalledTimes(2);
        expect(routeLog()).toMatchObject({ tier: 'failed', fellBack: true, picks: null });
    });

    it('does not repeat a flex 400, and logs it as a warning', async () => {
        global.fetch.mockResolvedValueOnce(httpError(400));
        await expect(pickNotable({ candidates, channel: 'chan' })).resolves.toBeNull();
        expect(global.fetch).toHaveBeenCalledTimes(1);
        expect(logger.warn).toHaveBeenCalled();
        expect(routeLog()).toMatchObject({ tier: 'failed', fellBack: false, flexOutcome: 'http_400' });
    });

    it('ignores unknown and repeated ids', async () => {
        global.fetch.mockResolvedValueOnce(answer([
            { id: 'm9', reason: 'not sent' },
            { id: 'm2', reason: 'first' },
            { id: 'm2', reason: 'again' },
            { id: 'xx_m1', reason: 'not a label' },
            { id: 'm1', reason: 'ok' },
        ]));
        const picks = await pickNotable({ candidates, channel: 'chan' });
        expect(picks).toEqual([{ id: 'm2', reason: 'first' }, { id: 'm1', reason: 'ok' }]);
        expect(routeLog()).toMatchObject({ picks: 2, droppedIds: 3 });
    });

    it('makes no call for an empty batch', async () => {
        await expect(pickNotable({ candidates: [] })).resolves.toEqual([]);
        expect(global.fetch).not.toHaveBeenCalled();
    });
});
