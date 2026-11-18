// tests/unit/rewardMatcherApi.test.js
// The model half of the reward resolver. These tests check the request that
// reaches the SDK, because the SDK drops a top-level `systemInstruction`
// without any error.

import { jest } from '@jest/globals';

const mockLogger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
jest.unstable_mockModule('../../src/lib/logger.js', () => ({ default: mockLogger }));

const generateContent = jest.fn();
jest.unstable_mockModule('@google/genai', () => ({
    GoogleGenAI: jest.fn(() => ({ models: { generateContent } })),
}));
jest.unstable_mockModule('sharp', () => ({ default: jest.fn() }));
jest.unstable_mockModule('../../src/config/index.js', () => ({
    default: { emote: { geminiModel: 'test-model', cdnUrl: 'https://x', maxGifFrames: 3, timeoutMs: 8000, animatedTimeoutMs: 12000 } },
}));

const describer = await import('../../src/lib/emotes/emoteDescriberApi.js');
const { pickRewardWithGemini } = await import('../../src/lib/rewardMatcherApi.js');

const rewards = [{ id: 'r1', title: 'Hydrate', prompt: 'Drink water' }];

beforeEach(() => {
    jest.clearAllMocks();
    describer.initGeminiClient('test-key');
    generateContent.mockResolvedValue({ text: JSON.stringify({ rewardId: 'r1', confident: true }) });
});

describe('pickRewardWithGemini', () => {
    test('sends the system instruction in config and not at the top level', async () => {
        await pickRewardWithGemini('hydrat', rewards);
        const request = generateContent.mock.calls[0][0];
        expect(request.model).toBe('test-model');
        expect(request.config.systemInstruction).toEqual(expect.any(String));
        expect(request.config.systemInstruction.length).toBeGreaterThan(0);
        expect(request).not.toHaveProperty('systemInstruction');
    });

    test('returns the pick of the model', async () => {
        await expect(pickRewardWithGemini('hydrat', rewards)).resolves.toEqual({ rewardId: 'r1', confident: true });
    });

    test('returns null when the call fails', async () => {
        generateContent.mockRejectedValue(new Error('boom'));
        await expect(pickRewardWithGemini('hydrat', rewards)).resolves.toBeNull();
    });
});
