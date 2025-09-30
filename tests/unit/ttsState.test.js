// tests/unit/ttsState.test.js
// Unit tests for ttsState module

import { jest } from '@jest/globals';
import {
  createMockFirestore,
  FieldValue
} from '../helpers/mockFirestore.js';
import {
  TEST_CHANNEL,
  TEST_USER,
  mockChannelConfig
} from '../helpers/testData.js';

describe('ttsState module', () => {
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
      getAvailableVoices: jest.fn().mockResolvedValue([
        { id: 'Friendly_Person', name: 'Friendly Person' },
        { id: 'Wise_Woman', name: 'Wise Woman' }
      ])
    }));

    ttsState = await import('../../src/components/tts/ttsState.js');
  });

  describe('getTtsState', () => {
    test('should return config with allowViewerPreferences when set to true', async () => {
      const channelDoc = mockDb.collection('ttsChannelConfigs').doc(TEST_CHANNEL);
      await channelDoc.set({
        ...mockChannelConfig,
        allowViewerPreferences: true
      });

      await ttsState.initializeTtsState();
      const state = await ttsState.getTtsState(TEST_CHANNEL);

      expect(state.allowViewerPreferences).toBe(true);
    });

    test('should return config with allowViewerPreferences when set to false', async () => {
      const channelDoc = mockDb.collection('ttsChannelConfigs').doc(TEST_CHANNEL);
      await channelDoc.set({
        ...mockChannelConfig,
        allowViewerPreferences: false
      });

      await ttsState.initializeTtsState();
      const state = await ttsState.getTtsState(TEST_CHANNEL);

      expect(state.allowViewerPreferences).toBe(false);
    });

    test('should return default config when channel not found', async () => {
      await ttsState.initializeTtsState();
      const state = await ttsState.getTtsState('nonexistentchannel');

      expect(state).toBeDefined();
      expect(state.voiceId).toBeDefined();
      expect(state.userPreferences).toEqual({});
    });
  });

  describe('setTtsState', () => {
    beforeEach(async () => {
      const channelDoc = mockDb.collection('ttsChannelConfigs').doc(TEST_CHANNEL);
      await channelDoc.set(mockChannelConfig);
      await ttsState.initializeTtsState();
    });

    test('should update allowViewerPreferences setting', async () => {
      const result = await ttsState.setTtsState(TEST_CHANNEL, 'allowViewerPreferences', false);
      expect(result).toBe(true);

      const state = await ttsState.getTtsState(TEST_CHANNEL);
      expect(state.allowViewerPreferences).toBe(false);
    });

    test('should update cache immediately', async () => {
      await ttsState.setTtsState(TEST_CHANNEL, 'allowViewerPreferences', false);

      // Should be in cache immediately
      const state = await ttsState.getTtsState(TEST_CHANNEL);
      expect(state.allowViewerPreferences).toBe(false);
    });
  });

  describe('getGlobalUserPreferences', () => {
    test('should return user preferences when they exist', async () => {
      const userDoc = mockDb.collection('ttsUserPreferences').doc(TEST_USER.toLowerCase());
      await userDoc.set({
        voiceId: 'Wise_Woman',
        emotion: 'happy',
        speed: 1.2
      });

      const prefs = await ttsState.getGlobalUserPreferences(TEST_USER);

      expect(prefs).toEqual({
        voiceId: 'Wise_Woman',
        emotion: 'happy',
        speed: 1.2
      });
    });

    test('should return empty object when no preferences exist', async () => {
      const prefs = await ttsState.getGlobalUserPreferences('newuser');
      expect(prefs).toEqual({});
    });

    test('should handle username case insensitivity', async () => {
      const userDoc = mockDb.collection('ttsUserPreferences').doc('testuser');
      await userDoc.set({
        voiceId: 'Wise_Woman'
      });

      const prefs = await ttsState.getGlobalUserPreferences('TestUser');
      expect(prefs.voiceId).toBe('Wise_Woman');
    });
  });

  describe('setGlobalUserPreference', () => {
    test('should save user preference', async () => {
      const result = await ttsState.setGlobalUserPreference(TEST_USER, 'voiceId', 'Wise_Woman');
      expect(result).toBe(true);

      const prefs = await ttsState.getGlobalUserPreferences(TEST_USER);
      expect(prefs.voiceId).toBe('Wise_Woman');
    });

    test('should merge preferences without overwriting', async () => {
      await ttsState.setGlobalUserPreference(TEST_USER, 'voiceId', 'Wise_Woman');
      await ttsState.setGlobalUserPreference(TEST_USER, 'emotion', 'happy');

      const prefs = await ttsState.getGlobalUserPreferences(TEST_USER);
      expect(prefs.voiceId).toBe('Wise_Woman');
      expect(prefs.emotion).toBe('happy');
    });
  });

  describe('getUserVoicePreference (channel-specific)', () => {
    beforeEach(async () => {
      const channelDoc = mockDb.collection('ttsChannelConfigs').doc(TEST_CHANNEL);
      await channelDoc.set({
        ...mockChannelConfig,
        userPreferences: {
          [TEST_USER.toLowerCase()]: {
            voiceId: 'Calm_Man',
            emotion: 'neutral'
          }
        }
      });
      await ttsState.initializeTtsState();
    });

    test('should return user voice preference from channel config', async () => {
      const voiceId = await ttsState.getUserVoicePreference(TEST_CHANNEL, TEST_USER);
      expect(voiceId).toBe('Calm_Man');
    });

    test('should return null when user has no voice preference', async () => {
      const voiceId = await ttsState.getUserVoicePreference(TEST_CHANNEL, 'unknownuser');
      expect(voiceId).toBeNull();
    });
  });
});