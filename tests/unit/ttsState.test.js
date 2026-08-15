// tests/unit/ttsState.test.js
// Unit tests for ttsState module

import { jest } from '@jest/globals';
import {
  createMockFirestore,
  FieldValue,
  FieldPath
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
      FieldValue: FieldValue,
      FieldPath: FieldPath
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

    // A failed read used to take the same path as a missing document, caching
    // defaults for a channel that has real settings. The channel then stayed on
    // them — with the profanity filter off — until the listener happened to
    // deliver the doc.
    test('does not cache defaults when the Firestore read fails', async () => {
      await ttsState.initializeTtsState();

      // Created after startup, so it is not in the cache the listener warmed.
      const channelDoc = mockDb.collection('ttsChannelConfigs').doc('latecomer');
      await channelDoc.set({ ...mockChannelConfig, profanityFilterEnabled: true });

      const realGet = channelDoc.get.bind(channelDoc);
      channelDoc.get = jest.fn().mockRejectedValue(new Error('firestore unavailable'));

      const duringOutage = await ttsState.getTtsState('latecomer');
      expect(duringOutage.profanityFilterEnabled).toBe(false);

      channelDoc.get = realGet;
      const afterRecovery = await ttsState.getTtsState('latecomer');
      expect(afterRecovery.profanityFilterEnabled).toBe(true);
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

  describe('pronunciations', () => {
    const doc = () => mockDb.collection('ttsChannelConfigs').doc(TEST_CHANNEL);

    beforeEach(async () => {
      await doc().set({ ...mockChannelConfig });
      await ttsState.initializeTtsState();
    });

    test('hydrates a fresh channel with an empty map, never undefined', async () => {
      // ignoredUsers has no default and its add path throws on a fresh channel
      // as a result; pronunciations must not repeat that.
      const state = await ttsState.getTtsState('a-channel-that-does-not-exist');
      expect(state.pronunciations).toEqual({});
    });

    test('setPronunciation stores the entry', async () => {
      expect(await ttsState.setPronunciation(TEST_CHANNEL, 'wcat', 'wildcat')).toBe(true);

      const stored = (await doc().get()).data();
      expect(stored.pronunciations).toEqual({ wcat: 'wildcat' });
    });

    test('setPronunciation leaves sibling entries alone', async () => {
      await ttsState.setPronunciation(TEST_CHANNEL, 'wcat', 'wildcat');
      await ttsState.setPronunciation(TEST_CHANNEL, 'lfg', 'lets go');

      const stored = (await doc().get()).data();
      expect(stored.pronunciations).toEqual({ wcat: 'wildcat', lfg: 'lets go' });
    });

    test('setPronunciation updates the cache immediately', async () => {
      await ttsState.setPronunciation(TEST_CHANNEL, 'wcat', 'wildcat');

      const state = await ttsState.getTtsState(TEST_CHANNEL);
      expect(state.pronunciations.wcat).toBe('wildcat');
    });

    test('setPronunciation swaps in a new map object so memoized rules recompile', async () => {
      const before = (await ttsState.getTtsState(TEST_CHANNEL)).pronunciations;
      await ttsState.setPronunciation(TEST_CHANNEL, 'wcat', 'wildcat');
      const after = (await ttsState.getTtsState(TEST_CHANNEL)).pronunciations;

      expect(after).not.toBe(before);
    });

    test('an empty value is stored, which is how a built-in is switched off', async () => {
      await ttsState.setPronunciation(TEST_CHANNEL, 'lfg', '');

      const stored = (await doc().get()).data();
      expect(stored.pronunciations.lfg).toBe('');
    });

    test('removePronunciation deletes just that key', async () => {
      await ttsState.setPronunciation(TEST_CHANNEL, 'wcat', 'wildcat');
      await ttsState.setPronunciation(TEST_CHANNEL, 'lfg', 'lets go');

      expect(await ttsState.removePronunciation(TEST_CHANNEL, 'wcat')).toBe(true);

      const stored = (await doc().get()).data();
      expect(stored.pronunciations).toEqual({ lfg: 'lets go' });
    });

    test('removePronunciation handles keys with spaces and hyphens', async () => {
      // A dotted string field path would need backtick quoting for these.
      await ttsState.setPronunciation(TEST_CHANNEL, 'e-girl', 'ee girl');
      await ttsState.setPronunciation(TEST_CHANNEL, 'good game', 'gg');

      expect(await ttsState.removePronunciation(TEST_CHANNEL, 'e-girl')).toBe(true);

      const stored = (await doc().get()).data();
      expect(stored.pronunciations).toEqual({ 'good game': 'gg' });
    });

    test('removing an entry that is not there reports success', async () => {
      // NOT_FOUND means the desired end state already holds.
      expect(await ttsState.removePronunciation(TEST_CHANNEL, 'nothing-here')).toBe(true);
    });

    test('clearPronunciations empties the map without touching other settings', async () => {
      await ttsState.setPronunciation(TEST_CHANNEL, 'wcat', 'wildcat');

      expect(await ttsState.clearPronunciations(TEST_CHANNEL)).toBe(true);

      const stored = (await doc().get()).data();
      expect(stored.pronunciations).toEqual({});
      expect(stored.voiceId).toBe(mockChannelConfig.voiceId);
    });
  });
});