// tests/unit/redeemsCommand.test.js
// !tts redeems: the reward a moderator names is resolved to Twitch's reward
// ID before it is stored, the reply names the reward actually muted, and the
// TTS reward itself cannot be muted from chat.

import { jest } from '@jest/globals';
import { getTranslator } from '../../src/i18n/index.js';

describe('!tts redeems', () => {
    let enqueueMessage;
    let ttsStateMock;
    let listCustomRewards;
    let pickRewardWithGemini;
    let redeems;

    const reply = () => enqueueMessage.mock.calls.at(-1)?.[1] ?? '';
    const replies = () => enqueueMessage.mock.calls.map(c => c[1]);

    const rewards = [
        { id: 'r-horn', title: 'Air Horn', prompt: 'loud', cost: 100, isEnabled: true },
        { id: 'r-fog', title: 'Fog Horn', prompt: '', cost: 100, isEnabled: true },
        { id: 'r-tts', title: 'Text to Speech', prompt: '', cost: 500, isEnabled: true },
    ];

    const context = (args) => ({
        channel: '#testchannel',
        user: { username: 'somemod', 'user-id': '777' },
        args,
        replyToId: 'msg-1',
        t: getTranslator('en'),
    });

    class RewardListError extends Error {
        constructor(code) { super(code); this.code = code; }
    }

    beforeEach(async () => {
        jest.resetModules();
        enqueueMessage = jest.fn();
        listCustomRewards = jest.fn().mockResolvedValue(rewards);
        pickRewardWithGemini = jest.fn().mockResolvedValue(null);

        ttsStateMock = {
            getTtsState: jest.fn().mockResolvedValue({
                mutedRewardIds: {},
                channelPoints: { rewardId: 'r-tts', enabled: true },
            }),
            muteReward: jest.fn().mockResolvedValue(true),
            unmuteReward: jest.fn().mockResolvedValue(true),
        };

        jest.unstable_mockModule('../../src/lib/chatSender.js', () => ({ enqueueMessage }));
        jest.unstable_mockModule('../../src/components/tts/ttsState.js', () => ttsStateMock);
        jest.unstable_mockModule('../../src/components/twitch/customRewards.js', () => ({ listCustomRewards, RewardListError }));
        jest.unstable_mockModule('../../src/lib/rewardMatcherApi.js', () => ({ pickRewardWithGemini }));
        jest.unstable_mockModule('../../src/components/twitch/helixClient.js', () => ({
            getBroadcasterIdByLogin: jest.fn().mockResolvedValue('111'),
        }));
        jest.unstable_mockModule('../../src/lib/allowList.js', () => ({
            getChannelIdFromName: jest.fn().mockReturnValue('111'),
        }));
        jest.unstable_mockModule('../../src/lib/logger.js', () => ({
            default: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
        }));

        redeems = (await import('../../src/components/commands/tts/redeems.js')).default;
    });

    it('is moderator-only', () => {
        expect(redeems.permission).toBe('moderator');
    });

    it('lists nothing muted by default', async () => {
        await redeems.execute(context([]));
        expect(reply()).toMatch(/Every channel point redeem is announced/);
        expect(listCustomRewards).not.toHaveBeenCalled();
    });

    it('lists the muted rewards by stored title', async () => {
        ttsStateMock.getTtsState.mockResolvedValue({
            mutedRewardIds: { 'r-fog': { title: 'Fog Horn', by: null, at: null }, 'r-horn': 'Air Horn' },
        });
        await redeems.execute(context(['list']));
        expect(reply()).toBe('Redeems not announced: Air Horn, Fog Horn. Everything else is announced.');
    });

    it('lists every reward from Twitch and marks the muted ones', async () => {
        ttsStateMock.getTtsState.mockResolvedValue({ mutedRewardIds: { 'r-horn': 'Air Horn' } });
        await redeems.execute(context(['all']));
        expect(reply()).toBe('Channel point rewards: Air Horn (not announced), Fog Horn, Text to Speech');
    });

    it('mutes an exact title and stores the reward ID with provenance', async () => {
        await redeems.execute(context(['mute', 'air', 'horn']));
        expect(ttsStateMock.muteReward).toHaveBeenCalledWith('testchannel', 'r-horn', expect.objectContaining({
            title: 'Air Horn', by: 'twitch:777',
        }));
        expect(reply()).toBe('Redeems of "Air Horn" will no longer be announced. Undo with "!tts redeems unmute Air Horn".');
        expect(pickRewardWithGemini).not.toHaveBeenCalled();
    });

    it('falls back to the model for a typo and names the reward it picked', async () => {
        pickRewardWithGemini.mockResolvedValue({ rewardId: 'r-horn', confident: true });
        await redeems.execute(context(['mute', 'airhron']));
        expect(pickRewardWithGemini).toHaveBeenCalledWith('airhron', rewards);
        expect(ttsStateMock.muteReward).toHaveBeenCalledWith('testchannel', 'r-horn', expect.anything());
        expect(reply()).toMatch(/"Air Horn" will no longer be announced/);
    });

    it('asks for the full name when several rewards match', async () => {
        await redeems.execute(context(['mute', 'horn']));
        expect(ttsStateMock.muteReward).not.toHaveBeenCalled();
        expect(reply()).toBe('"horn" could be any of: Air Horn, Fog Horn. Please use the full name.');
    });

    it('says so when nothing matches', async () => {
        await redeems.execute(context(['mute', 'lurk']));
        expect(ttsStateMock.muteReward).not.toHaveBeenCalled();
        expect(reply()).toMatch(/No channel point reward matches "lurk"/);
    });

    it('refuses to mute the TTS reward itself', async () => {
        await redeems.execute(context(['mute', 'text', 'to', 'speech']));
        expect(ttsStateMock.muteReward).not.toHaveBeenCalled();
        expect(reply()).toMatch(/is the TTS reward itself/);
    });

    it('reports an already muted reward without writing', async () => {
        ttsStateMock.getTtsState.mockResolvedValue({ mutedRewardIds: { 'r-horn': 'Air Horn' } });
        await redeems.execute(context(['mute', 'Air Horn']));
        expect(ttsStateMock.muteReward).not.toHaveBeenCalled();
        expect(reply()).toMatch(/already not announced/);
    });

    it('unmutes by the stored title without calling Twitch', async () => {
        ttsStateMock.getTtsState.mockResolvedValue({ mutedRewardIds: { 'r-horn': { title: 'Air Horn', by: null, at: null } } });
        await redeems.execute(context(['unmute', 'air horn']));
        expect(listCustomRewards).not.toHaveBeenCalled();
        expect(ttsStateMock.unmuteReward).toHaveBeenCalledWith('testchannel', 'r-horn');
        expect(reply()).toBe('Redeems of "Air Horn" will be announced again.');
    });

    it('reports an unmute of something that is not muted', async () => {
        await redeems.execute(context(['unmute', 'air horn']));
        expect(ttsStateMock.unmuteReward).not.toHaveBeenCalled();
        expect(reply()).toMatch(/is not muted/);
    });

    it('tells the streamer to sign in when the reward list needs their token', async () => {
        listCustomRewards.mockRejectedValue(new RewardListError('no_token'));
        await redeems.execute(context(['mute', 'air horn']));
        expect(reply()).toMatch(/sign in to the dashboard/);
        listCustomRewards.mockRejectedValue(new RewardListError('request_failed'));
        await redeems.execute(context(['mute', 'air horn']));
        expect(reply()).toMatch(/Could not fetch/);
    });

    it('shows usage for an unknown verb or a missing title', async () => {
        await redeems.execute(context(['mute']));
        expect(reply()).toMatch(/^Usage:/);
        await redeems.execute(context(['frobnicate', 'x']));
        expect(reply()).toMatch(/^Usage:/);
        expect(replies()).toHaveLength(2);
    });
});
