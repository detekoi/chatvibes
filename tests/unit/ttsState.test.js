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
  TEST_USER_ID,
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

    test('should use userId as primary key when provided', async () => {
      // Set up userId-keyed doc with different prefs than username-keyed doc
      const userIdDoc = mockDb.collection('ttsUserPreferences').doc(TEST_USER_ID);
      await userIdDoc.set({
        voiceId: 'Special_Voice',
        emotion: 'excited'
      });

      const usernameDoc = mockDb.collection('ttsUserPreferences').doc(TEST_USER.toLowerCase());
      await usernameDoc.set({
        voiceId: 'Old_Voice',
        emotion: 'neutral'
      });

      const prefs = await ttsState.getGlobalUserPreferences(TEST_USER, TEST_USER_ID);

      // Should prefer the userId doc
      expect(prefs.voiceId).toBe('Special_Voice');
      expect(prefs.emotion).toBe('excited');
    });

    test('should fall back to username when userId doc does not exist', async () => {
      const usernameDoc = mockDb.collection('ttsUserPreferences').doc(TEST_USER.toLowerCase());
      await usernameDoc.set({
        voiceId: 'Fallback_Voice'
      });

      const prefs = await ttsState.getGlobalUserPreferences(TEST_USER, 'nonexistent_user_id');

      expect(prefs.voiceId).toBe('Fallback_Voice');
    });

    test('should cache results with TTL', async () => {
      const userDoc = mockDb.collection('ttsUserPreferences').doc(TEST_USER.toLowerCase());
      await userDoc.set({ voiceId: 'Cached_Voice' });

      // First call populates cache
      const prefs1 = await ttsState.getGlobalUserPreferences(TEST_USER);
      expect(prefs1.voiceId).toBe('Cached_Voice');

      // Update Firestore directly
      await userDoc.set({ voiceId: 'Updated_Voice' });

      // Second call should return cached value
      const prefs2 = await ttsState.getGlobalUserPreferences(TEST_USER);
      expect(prefs2.voiceId).toBe('Cached_Voice');
    });

    test('should cache empty results to avoid repeated misses', async () => {
      // First call for a non-existent user
      const prefs1 = await ttsState.getGlobalUserPreferences('ghostuser');
      expect(prefs1).toEqual({});

      // Set up the doc after first call
      const userDoc = mockDb.collection('ttsUserPreferences').doc('ghostuser');
      await userDoc.set({ voiceId: 'New_Voice' });

      // Second call should still return cached empty result
      const prefs2 = await ttsState.getGlobalUserPreferences('ghostuser');
      expect(prefs2).toEqual({});
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
  describe('setObsSocketToken', () => {
    test('should save OBS token', async () => {
      const result = await ttsState.setObsSocketToken(TEST_CHANNEL, 'test-token');
      expect(result).toBe(true);

      const state = await ttsState.getTtsState(TEST_CHANNEL);
      expect(state.obsSocketToken).toBe('test-token');
    });
  });

  describe('banned words management', () => {
    beforeEach(async () => {
      const channelDoc = mockDb.collection('ttsChannelConfigs').doc(TEST_CHANNEL);
      await channelDoc.set(mockChannelConfig);
      await ttsState.initializeTtsState();
    });

    test('addBannedWord should add word to config', async () => {
      const result = await ttsState.addBannedWord(TEST_CHANNEL, 'badword');
      expect(result).toBe(true);

      const state = await ttsState.getTtsState(TEST_CHANNEL);
      expect(state.bannedWords).toContain('badword');
    });

    test('addBannedWord should store words lowercase', async () => {
      await ttsState.addBannedWord(TEST_CHANNEL, 'BadWord');

      const state = await ttsState.getTtsState(TEST_CHANNEL);
      expect(state.bannedWords).toContain('badword');
      expect(state.bannedWords).not.toContain('BadWord');
    });

    test('removeBannedWord should remove word from config', async () => {
      await ttsState.addBannedWord(TEST_CHANNEL, 'badword');
      const result = await ttsState.removeBannedWord(TEST_CHANNEL, 'badword');
      expect(result).toBe(true);

      const state = await ttsState.getTtsState(TEST_CHANNEL);
      expect(state.bannedWords || []).not.toContain('badword');
    });

    test('addBannedWord should not duplicate existing words', async () => {
      await ttsState.addBannedWord(TEST_CHANNEL, 'badword');
      await ttsState.addBannedWord(TEST_CHANNEL, 'badword');

      const state = await ttsState.getTtsState(TEST_CHANNEL);
      const count = state.bannedWords.filter(w => w === 'badword').length;
      expect(count).toBe(1);
    });

    test('addBannedWord should reject empty strings', async () => {
      const result = await ttsState.addBannedWord(TEST_CHANNEL, '  ');
      expect(result).toBe(false);
    });
  });

  describe('getUserEmoteModePreference', () => {
    test('should return null when no preference is set', async () => {
      const mode = await ttsState.getUserEmoteModePreference('someuser');
      expect(mode).toBeNull();
    });

    test('should return emoteMode from userId doc', async () => {
      const userIdDoc = mockDb.collection('ttsUserPreferences').doc(TEST_USER_ID);
      await userIdDoc.set({ emoteMode: 'describe' });

      const mode = await ttsState.getUserEmoteModePreference(TEST_USER, TEST_USER_ID);
      expect(mode).toBe('describe');
    });

    test('should fall back to username doc when userId doc has no emoteMode', async () => {
      const usernameDoc = mockDb.collection('ttsUserPreferences').doc(TEST_USER.toLowerCase());
      await usernameDoc.set({ emoteMode: 'skip' });

      const mode = await ttsState.getUserEmoteModePreference(TEST_USER, 'nonexistent_uid');
      expect(mode).toBe('skip');
    });

    test('should cache emoteMode results', async () => {
      const userDoc = mockDb.collection('ttsUserPreferences').doc(TEST_USER.toLowerCase());
      await userDoc.set({ emoteMode: 'read' });

      // First call
      const mode1 = await ttsState.getUserEmoteModePreference(TEST_USER);
      expect(mode1).toBe('read');

      // Update Firestore
      await userDoc.set({ emoteMode: 'describe' });

      // Second call should return cached 'read'
      const mode2 = await ttsState.getUserEmoteModePreference(TEST_USER);
      expect(mode2).toBe('read');
    });

    test('should reject invalid emoteMode values', async () => {
      const userDoc = mockDb.collection('ttsUserPreferences').doc(TEST_USER.toLowerCase());
      await userDoc.set({ emoteMode: 'invalid_mode' });

      const mode = await ttsState.getUserEmoteModePreference(TEST_USER);
      expect(mode).toBeNull();
    });
  });
});