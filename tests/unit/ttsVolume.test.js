
// tests/unit/ttsVolume.test.js
// Unit tests for per-voice volume support in ttsState module

import { jest } from '@jest/globals';
import {
    createMockFirestore,
    FieldValue
} from '../helpers/mockFirestore.js';
import {
    TEST_CHANNEL,
    mockChannelConfig
} from '../helpers/testData.js';

describe('ttsState module - Volume Support', () => {
    let mockDb;
    let ttsState;

    beforeEach(async () => {
        jest.resetModules();

        mockDb = createMockFirestore();

        jest.unstable_mockModule('@google-cloud/firestore', () => ({
            Firestore: jest.fn(() => mockDb),
            FieldValue: FieldValue
        }));

        jest.unstable_mockModule('../../src/components/tts/ttsService.js', () => ({
            getAvailableVoices: jest.fn().mockResolvedValue([])
        }));

        ttsState = await import('../../src/components/tts/ttsState.js');
    });

    describe('setVoiceVolume', () => {
        beforeEach(async () => {
            const channelDoc = mockDb.collection('ttsChannelConfigs').doc(TEST_CHANNEL);
            await channelDoc.set(mockChannelConfig);
            await ttsState.initializeTtsState();
        });

        test('should set valid volume for a voice', async () => {
            const voiceId = 'Friendly_Person';
            const volume = 1.5;
            const result = await ttsState.setVoiceVolume(TEST_CHANNEL, voiceId, volume);

            expect(result).toBe(true);

            // Verify Firestore update
            const state = await ttsState.getTtsState(TEST_CHANNEL);
            expect(state.voiceVolumes).toBeDefined();
            expect(state.voiceVolumes[voiceId]).toBe(1.5);
        });

        test('should reject invalid volumes (too high)', async () => {
            const result = await ttsState.setVoiceVolume(TEST_CHANNEL, 'Voice', 11);
            expect(result).toBe(false);
        });

        test('should reject invalid volumes (too low/zero)', async () => {
            // Minimax range is (0, 10]
            const result = await ttsState.setVoiceVolume(TEST_CHANNEL, 'Voice', 0);
            expect(result).toBe(false);
        });

        test('should reject non-numeric volumes', async () => {
            const result = await ttsState.setVoiceVolume(TEST_CHANNEL, 'Voice', 'loud');
            expect(result).toBe(false);
        });
    });

    describe('getVoiceVolumes', () => {
        test('should return empty object when no volumes set', async () => {
            const channelDoc = mockDb.collection('ttsChannelConfigs').doc(TEST_CHANNEL);
            await channelDoc.set(mockChannelConfig);
            await ttsState.initializeTtsState();

            const volumes = await ttsState.getVoiceVolumes(TEST_CHANNEL);
            expect(volumes).toEqual({});
        });

        test('should return configured volumes', async () => {
            const channelDoc = mockDb.collection('ttsChannelConfigs').doc(TEST_CHANNEL);
            await channelDoc.set({
                ...mockChannelConfig,
                voiceVolumes: {
                    'Voice_A': 0.8,
                    'Voice_B': 1.2
                }
            });
            await ttsState.initializeTtsState();

            const volumes = await ttsState.getVoiceVolumes(TEST_CHANNEL);
            expect(volumes).toEqual({
                'Voice_A': 0.8,
                'Voice_B': 1.2
            });
        });
    });

    describe('getChannelTtsConfig', () => {
        test('should include voiceVolumes in simplified config', async () => {
            const channelDoc = mockDb.collection('ttsChannelConfigs').doc(TEST_CHANNEL);
            await channelDoc.set({
                ...mockChannelConfig,
                voiceVolumes: { 'Test_Voice': 2.0 }
            });
            await ttsState.initializeTtsState();

            const config = await ttsState.getChannelTtsConfig(TEST_CHANNEL);
            expect(config.voiceVolumes).toEqual({ 'Test_Voice': 2.0 });
        });
    });
});
