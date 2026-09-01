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
        expect(reply()).toMatch(/announces every channel point redeem/);
        expect(listCustomRewards).not.toHaveBeenCalled();
    });

    it('lists the muted rewards by stored title', async () => {
        ttsStateMock.getTtsState.mockResolvedValue({
            mutedRewardIds: { 'r-fog': { title: 'Fog Horn', by: null, at: null }, 'r-horn': 'Air Horn' },
        });
        await redeems.execute(context(['list']));
        expect(reply()).toBe('Muted redeems: Air Horn, Fog Horn. The bot announces all other redeems.');
    });

    it('lists every reward from Twitch and marks the muted ones', async () => {
        ttsStateMock.getTtsState.mockResolvedValue({ mutedRewardIds: { 'r-horn': 'Air Horn' } });
        await redeems.execute(context(['all']));
        expect(reply()).toBe('Channel point rewards: Air Horn (muted), Fog Horn, Text to Speech');
    });

    it('mutes an exact title and stores the reward ID with provenance', async () => {
        await redeems.execute(context(['mute', 'air', 'horn']));
        expect(ttsStateMock.muteReward).toHaveBeenCalledWith('testchannel', 'r-horn', expect.objectContaining({
            title: 'Air Horn', by: 'twitch:777',
        }));
        expect(reply()).toBe('The bot will not announce redeems of "Air Horn". To undo this, use "!tts redeems unmute Air Horn".');
        expect(pickRewardWithGemini).not.toHaveBeenCalled();
    });

    it('falls back to the model for a typo and names the reward it picked', async () => {
        pickRewardWithGemini.mockResolvedValue({ rewardId: 'r-horn', confident: true });
        await redeems.execute(context(['mute', 'airhron']));
        expect(pickRewardWithGemini).toHaveBeenCalledWith('airhron', rewards);
        expect(ttsStateMock.muteReward).toHaveBeenCalledWith('testchannel', 'r-horn', expect.anything());
        expect(reply()).toMatch(/will not announce redeems of "Air Horn"/);
    });

    it('asks for the full name when several rewards match', async () => {
        await redeems.execute(context(['mute', 'horn']));
        expect(ttsStateMock.muteReward).not.toHaveBeenCalled();
        expect(reply()).toBe('"horn" matches more than one reward: Air Horn, Fog Horn. Use the full name.');
    });

    it('says so when nothing matches', async () => {
        await redeems.execute(context(['mute', 'lurk']));
        expect(ttsStateMock.muteReward).not.toHaveBeenCalled();
        expect(reply()).toMatch(/No channel point reward matches "lurk"/);
    });

    it('refuses to mute the TTS reward itself', async () => {
        await redeems.execute(context(['mute', 'text', 'to', 'speech']));
        expect(ttsStateMock.muteReward).not.toHaveBeenCalled();
        expect(reply()).toMatch(/is the TTS reward/);
    });

    it('reports an already muted reward without writing', async () => {
        ttsStateMock.getTtsState.mockResolvedValue({ mutedRewardIds: { 'r-horn': 'Air Horn' } });
        await redeems.execute(context(['mute', 'Air Horn']));
        expect(ttsStateMock.muteReward).not.toHaveBeenCalled();
        expect(reply()).toMatch(/already muted/);
    });

    it('unmutes by the stored title without calling Twitch', async () => {
        ttsStateMock.getTtsState.mockResolvedValue({ mutedRewardIds: { 'r-horn': { title: 'Air Horn', by: null, at: null } } });
        await redeems.execute(context(['unmute', 'air horn']));
        expect(listCustomRewards).not.toHaveBeenCalled();
        expect(ttsStateMock.unmuteReward).toHaveBeenCalledWith('testchannel', 'r-horn');
        expect(reply()).toBe('The bot will announce redeems of "Air Horn" again.');
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
        expect(reply()).toMatch(/could not get the channel point rewards/);
    });

    it('shows usage for an unknown verb or a missing title', async () => {
        await redeems.execute(context(['mute']));
        expect(reply()).toMatch(/^Usage:/);
        await redeems.execute(context(['frobnicate', 'x']));
        expect(reply()).toMatch(/^Usage:/);
        expect(replies()).toHaveLength(2);
    });
});
