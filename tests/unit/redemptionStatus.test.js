// tests/unit/redemptionStatus.test.js
// The Twitch calls that settle a TTS reward redemption. Helix lets an app
// change a redemption only while it is UNFULFILLED, and CANCELED is what
// refunds the viewer.

import { jest } from '@jest/globals';

describe('redemptionStatus', () => {
    let setRedemptionStatus;
    let stopRewardSkippingQueue;
    let patch;
    let getBroadcasterAccessToken;

    const settle = { broadcasterId: '111', channelLogin: 'chan', rewardId: 'rw', redemptionId: 'rd' };

    beforeEach(async () => {
        jest.resetModules();
        patch = jest.fn().mockResolvedValue({ data: {} });
        getBroadcasterAccessToken = jest.fn().mockResolvedValue('user-token');

        jest.unstable_mockModule('axios', () => ({ default: { patch } }));
        jest.unstable_mockModule('../../src/components/twitch/broadcasterToken.js', () => ({ getBroadcasterAccessToken }));
        jest.unstable_mockModule('../../src/components/twitch/tokenManager.js', () => ({ getClientId: jest.fn().mockResolvedValue('client-id') }));
        jest.unstable_mockModule('../../src/lib/logger.js', () => ({
            default: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
        }));

        ({ setRedemptionStatus, stopRewardSkippingQueue } = await import('../../src/components/twitch/redemptionStatus.js'));
    });

    it('cancels a redemption with the broadcaster token, which refunds it', async () => {
        await expect(setRedemptionStatus({ ...settle, status: 'CANCELED', reason: 'x' })).resolves.toBe(true);

        const [url, body, options] = patch.mock.calls[0];
        expect(url).toBe('https://api.twitch.tv/helix/channel_points/custom_rewards/redemptions?broadcaster_id=111&reward_id=rw&id=rd');
        expect(body).toEqual({ status: 'CANCELED' });
        expect(options.headers).toMatchObject({ 'Authorization': 'Bearer user-token', 'Client-ID': 'client-id' });
    });

    it('reports false without a broadcaster token, and calls nothing', async () => {
        getBroadcasterAccessToken.mockResolvedValue(null);

        await expect(setRedemptionStatus({ ...settle, status: 'FULFILLED', reason: 'x' })).resolves.toBe(false);
        expect(patch).not.toHaveBeenCalled();
    });

    it('reports false when Twitch refuses, for example on a fulfilled redemption', async () => {
        patch.mockRejectedValue(Object.assign(new Error('Bad Request'), { response: { status: 400 } }));

        await expect(setRedemptionStatus({ ...settle, status: 'CANCELED', reason: 'x' })).resolves.toBe(false);
    });

    it('turns off skip-queue on a reward once per process', async () => {
        await expect(stopRewardSkippingQueue(settle)).resolves.toBe(true);
        await expect(stopRewardSkippingQueue(settle)).resolves.toBe(false);

        expect(patch).toHaveBeenCalledTimes(1);
        const [url, body] = patch.mock.calls[0];
        expect(url).toBe('https://api.twitch.tv/helix/channel_points/custom_rewards?broadcaster_id=111&id=rw');
        expect(body).toEqual({ should_redemptions_skip_request_queue: false });
    });
});
