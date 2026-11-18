// tests/unit/spotlightBuffer.test.js
// The per-channel spotlight buffer: batching, one call at a time, limits, ownership.
//
// A batch goes to the router windowMs after its first candidate, or at maxBatch.
// One call runs per channel; later candidates wait for the next batch. The buffer
// keeps maxBuffered candidates, skips text with no letter or digit, and speaks the
// picks in chat order with a fresh timing record each. A pick older than maxAgeMs
// is not spoken. Nothing happens on an instance that does not own the channel.

import { jest } from '@jest/globals';

describe('spotlightBuffer', () => {
    let buffer;
    let pickNotable;
    let recordPick;
    let getTtsState;
    let owns;
    let ownershipListener;
    let currentTiming;

    const SPOTLIGHT = { windowMs: 6000, maxBatch: 4, maxBuffered: 6, maxAgeMs: 45000, contextSize: 3 };
    const baseConfig = { mode: 'spotlight', engineEnabled: true, languageBoost: 'auto' };

    const spoken = [];
    const candidate = (text, extra = {}) => ({
        broadcasterId: '100',
        channelName: 'chan',
        id: `id-${text}`,
        user: `user-${text}`,
        userId: `u-${text}`,
        text,
        platform: 'twitch',
        speak: jest.fn(async ({ reason }) => {
            spoken.push({ text, reason, timing: currentTiming() });
            return true;
        }),
        ...extra,
    });
    const sentBatch = (call = 0) => pickNotable.mock.calls[call][0];

    beforeEach(async () => {
        jest.resetModules();
        jest.useFakeTimers();
        spoken.length = 0;
        owns = jest.fn().mockReturnValue(true);
        ownershipListener = null;
        pickNotable = jest.fn().mockResolvedValue([]);
        recordPick = jest.fn().mockResolvedValue(undefined);
        getTtsState = jest.fn().mockResolvedValue({ ...baseConfig });

        jest.unstable_mockModule('../../src/lib/logger.js', () => ({
            default: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
        }));
        jest.unstable_mockModule('../../src/config/index.js', () => ({ default: { spotlight: SPOTLIGHT } }));
        jest.unstable_mockModule('../../src/lib/channelOwnership.js', () => ({
            ownsBroadcaster: owns,
            onOwnershipChange: jest.fn((listener) => { ownershipListener = listener; return () => { ownershipListener = null; }; }),
        }));
        jest.unstable_mockModule('../../src/components/tts/ttsState.js', () => ({ getTtsState }));
        jest.unstable_mockModule('../../src/lib/spotlight/spotlightRouter.js', () => ({ pickNotable }));
        jest.unstable_mockModule('../../src/lib/spotlight/spotlightLog.js', () => ({ recordPick }));

        ({ currentTiming } = await import('../../src/lib/ttsTiming.js'));
        buffer = await import('../../src/lib/spotlight/spotlightBuffer.js');
    });

    afterEach(() => {
        buffer._internals.reset();
        jest.useRealTimers();
    });

    it('sends a batch windowMs after the first candidate, with labels and the channel language', async () => {
        getTtsState.mockResolvedValue({ ...baseConfig, languageBoost: 'Spanish', spotlightGuidance: 'prefer questions' });
        expect(buffer.offerSpotlightCandidate(candidate('hello there'))).toBe(true);
        await jest.advanceTimersByTimeAsync(3000);
        buffer.offerSpotlightCandidate(candidate('second one'));
        await jest.advanceTimersByTimeAsync(2999);
        expect(pickNotable).not.toHaveBeenCalled();

        await jest.advanceTimersByTimeAsync(1);
        expect(pickNotable).toHaveBeenCalledTimes(1);
        expect(sentBatch()).toMatchObject({
            candidates: [
                { id: 'm1', user: 'user-hello there', text: 'hello there' },
                { id: 'm2', user: 'user-second one', text: 'second one' },
            ],
            context: [],
            guidance: 'prefer questions',
            language: 'Spanish (Español)',
            channel: 'chan',
        });
    });

    it('flushes at once when maxBatch candidates are waiting', async () => {
        for (const t of ['a1', 'a2', 'a3']) buffer.offerSpotlightCandidate(candidate(t));
        await jest.advanceTimersByTimeAsync(0);
        expect(pickNotable).not.toHaveBeenCalled();
        buffer.offerSpotlightCandidate(candidate('a4'));
        await jest.advanceTimersByTimeAsync(0);
        expect(pickNotable).toHaveBeenCalledTimes(1);
        expect(sentBatch().candidates).toHaveLength(4);
    });

    it('runs one call at a time; later candidates wait and go out after it returns', async () => {
        let release;
        pickNotable.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
        buffer.offerSpotlightCandidate(candidate('first'));
        await jest.advanceTimersByTimeAsync(6000);
        expect(pickNotable).toHaveBeenCalledTimes(1);

        buffer.offerSpotlightCandidate(candidate('during'));
        await jest.advanceTimersByTimeAsync(10000);
        expect(pickNotable).toHaveBeenCalledTimes(1);

        release([]);
        await jest.advanceTimersByTimeAsync(0);
        // "during" already waited past its window, so it goes out right away.
        expect(pickNotable).toHaveBeenCalledTimes(2);
        expect(sentBatch(1).candidates.map(c => c.text)).toEqual(['during']);
    });

    it('keeps at most maxBuffered candidates and drops the oldest', async () => {
        let release;
        pickNotable.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
        buffer.offerSpotlightCandidate(candidate('x0'));
        await jest.advanceTimersByTimeAsync(6000);
        for (let i = 1; i <= 8; i++) buffer.offerSpotlightCandidate(candidate(`b${i}`));
        release([]);
        await jest.advanceTimersByTimeAsync(0);
        // b1 and b2 were dropped (6 kept); the first batch of maxBatch goes out.
        expect(sentBatch(1).candidates.map(c => c.text)).toEqual(['b3', 'b4', 'b5', 'b6']);
        // The rest arrived just now, so they wait for their own window.
        await jest.advanceTimersByTimeAsync(5999);
        expect(pickNotable).toHaveBeenCalledTimes(2);
        await jest.advanceTimersByTimeAsync(1);
        expect(sentBatch(2).candidates.map(c => c.text)).toEqual(['b7', 'b8']);
    });

    it('skips text with no letter or digit in any script, before it costs a call', async () => {
        expect(buffer.offerSpotlightCandidate(candidate('!!! ??? ...'))).toBe(false);
        expect(buffer.offerSpotlightCandidate(candidate('🔥🔥🔥'))).toBe(false);
        expect(buffer.offerSpotlightCandidate(candidate('   '))).toBe(false);
        await jest.advanceTimersByTimeAsync(10000);
        expect(pickNotable).not.toHaveBeenCalled();
        expect(buffer.offerSpotlightCandidate(candidate('すごい'))).toBe(true);
        expect(buffer.offerSpotlightCandidate(candidate('7'))).toBe(true);
    });

    it('speaks the picks in chat order, each with a fresh spotlight timing record, and logs them', async () => {
        pickNotable.mockResolvedValue([{ id: 'm3', reason: 'question' }, { id: 'm1', reason: 'joke' }]);
        for (const t of ['one', 'two', 'three']) buffer.offerSpotlightCandidate(candidate(t));
        await jest.advanceTimersByTimeAsync(6000);

        expect(spoken.map(s => [s.text, s.reason])).toEqual([['one', 'joke'], ['three', 'question']]);
        for (const s of spoken) {
            expect(s.timing).toMatchObject({ source: 'eventsub', route: 'spotlight' });
            expect(s.timing.receivedMs).toBe(Date.now());
            expect(s.timing.spotlightWaitMs).toBe(6000);
        }
        expect(recordPick).toHaveBeenCalledTimes(2);
        expect(recordPick.mock.calls[0]).toEqual(['100', expect.objectContaining({
            user: 'user-one', userId: 'u-one', text: 'one', reason: 'joke', platform: 'twitch',
        })]);
    });

    it('does not log a pick whose speak dispatched nothing', async () => {
        pickNotable.mockResolvedValue([{ id: 'm1', reason: 'r' }]);
        buffer.offerSpotlightCandidate(candidate('empty', { speak: jest.fn().mockResolvedValue(false) }));
        await jest.advanceTimersByTimeAsync(6000);
        expect(recordPick).not.toHaveBeenCalled();
    });

    it('keeps speaking the other picks when one speak throws', async () => {
        pickNotable.mockResolvedValue([{ id: 'm1', reason: 'a' }, { id: 'm2', reason: 'b' }]);
        buffer.offerSpotlightCandidate(candidate('bad', { speak: jest.fn().mockRejectedValue(new Error('boom')) }));
        buffer.offerSpotlightCandidate(candidate('good'));
        await jest.advanceTimersByTimeAsync(6000);
        expect(spoken.map(s => s.text)).toEqual(['good']);
        expect(recordPick).toHaveBeenCalledTimes(1);
    });

    it('does not speak a pick older than maxAgeMs at decision time', async () => {
        pickNotable.mockImplementation(async () => {
            await new Promise(resolve => setTimeout(resolve, 40000));
            return [{ id: 'm1', reason: 'old' }];
        });
        buffer.offerSpotlightCandidate(candidate('stale'));
        await jest.advanceTimersByTimeAsync(6000 + 40000);
        expect(spoken).toEqual([]);
        expect(recordPick).not.toHaveBeenCalled();
    });

    it('carries the last contextSize sent messages to the next call', async () => {
        for (const t of ['c1', 'c2']) buffer.offerSpotlightCandidate(candidate(t));
        await jest.advanceTimersByTimeAsync(6000);
        for (const t of ['c3', 'c4']) buffer.offerSpotlightCandidate(candidate(t));
        await jest.advanceTimersByTimeAsync(6000);
        expect(sentBatch(1).context).toEqual([{ user: 'user-c1', text: 'c1' }, { user: 'user-c2', text: 'c2' }]);

        buffer.offerSpotlightCandidate(candidate('c5'));
        await jest.advanceTimersByTimeAsync(6000);
        expect(sentBatch(2).context.map(c => c.text)).toEqual(['c2', 'c3', 'c4']);
    });

    it('does nothing on an instance that does not own the channel', async () => {
        owns.mockReturnValue(false);
        expect(buffer.offerSpotlightCandidate(candidate('hello'))).toBe(false);
        await jest.advanceTimersByTimeAsync(10000);
        expect(pickNotable).not.toHaveBeenCalled();
    });

    it('drops the buffer on an ownership "lost" event', async () => {
        buffer.wireSpotlightOwnership();
        buffer.offerSpotlightCandidate(candidate('hello'));
        await ownershipListener({ type: 'lost', broadcasterId: '100', channelName: 'chan' });
        expect(buffer._internals.channels.has('100')).toBe(false);
        await jest.advanceTimersByTimeAsync(10000);
        expect(pickNotable).not.toHaveBeenCalled();
    });

    it('speaks nothing when ownership is lost while the router works', async () => {
        buffer.wireSpotlightOwnership();
        let release;
        pickNotable.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
        buffer.offerSpotlightCandidate(candidate('hello'));
        await jest.advanceTimersByTimeAsync(6000);
        await ownershipListener({ type: 'lost', broadcasterId: '100', channelName: 'chan' });
        release([{ id: 'm1', reason: 'r' }]);
        await jest.advanceTimersByTimeAsync(0);
        expect(spoken).toEqual([]);
    });

    it.each([
        ['the mode changed', { mode: 'all' }],
        ['the engine is off', { engineEnabled: false }],
    ])('discards the batch without a call when %s before the flush', async (_label, change) => {
        buffer.offerSpotlightCandidate(candidate('hello'));
        getTtsState.mockResolvedValue({ ...baseConfig, ...change });
        await jest.advanceTimersByTimeAsync(6000);
        expect(pickNotable).not.toHaveBeenCalled();
        expect(spoken).toEqual([]);
    });

    it('speaks nothing when the router fails', async () => {
        pickNotable.mockResolvedValue(null);
        buffer.offerSpotlightCandidate(candidate('hello'));
        await jest.advanceTimersByTimeAsync(6000);
        expect(spoken).toEqual([]);
    });

    it('deletes an idle channel after a while', async () => {
        buffer.offerSpotlightCandidate(candidate('hello'));
        await jest.advanceTimersByTimeAsync(6000);
        expect(buffer._internals.channels.has('100')).toBe(true);
        await jest.advanceTimersByTimeAsync(5 * 60 * 1000);
        expect(buffer._internals.channels.has('100')).toBe(false);
    });

    it('keeps channels apart', async () => {
        buffer.offerSpotlightCandidate(candidate('one'));
        buffer.offerSpotlightCandidate(candidate('two', { broadcasterId: '200', channelName: 'other' }));
        await jest.advanceTimersByTimeAsync(6000);
        expect(pickNotable).toHaveBeenCalledTimes(2);
        expect(pickNotable.mock.calls.map(c => c[0].channel).sort()).toEqual(['chan', 'other']);
    });
});
