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
  TEST_USER2,
  TEST_USER_ID,
  mockChannelConfig
} from '../helpers/testData.js';

// Channel config documents are keyed by broadcaster ID, resolved from the login
// through the allow-list.
const TEST_CHANNEL_ID = '12345';

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

    ttsState = await import('../../src/components/tts/ttsState.js');

    const allowList = await import('../../src/lib/allowList.js');
    allowList.addAllowedChannel(TEST_CHANNEL, TEST_CHANNEL_ID);
    allowList.addAllowedChannel('latecomer', '55555');
    allowList.addAllowedChannel('nobody-here', '66666');
  });

  describe('getStoredLanguageBoost', () => {
    // This exists only because getTtsState cannot answer the question its
    // callers actually have: "has this channel chosen a language?" On a failed
    // read it returns DEFAULT_TTS_SETTINGS, whose languageBoost is 'auto', so a
    // caller that writes when nothing is set would overwrite a real preference
    // during an outage. channelLanguageSync is exactly such a caller.
    test('returns the stored value when the channel has one', async () => {
      await mockDb.collection('ttsChannelConfigs').doc(TEST_CHANNEL_ID).set({ languageBoost: 'Spanish' });
      await expect(ttsState.getStoredLanguageBoost(TEST_CHANNEL)).resolves.toBe('Spanish');
    });

    test('returns null when the channel document has no language', async () => {
      await mockDb.collection('ttsChannelConfigs').doc(TEST_CHANNEL_ID).set({ engineEnabled: true });
      await expect(ttsState.getStoredLanguageBoost(TEST_CHANNEL)).resolves.toBeNull();
    });

    test('returns null when the channel document does not exist', async () => {
      await expect(ttsState.getStoredLanguageBoost('nobody-here')).resolves.toBeNull();
    });

    test('throws for a channel with no known ID rather than answering "no language set"', async () => {
      await expect(ttsState.getStoredLanguageBoost('unregistered')).rejects.toThrow('No Twitch user ID known');
    });

    test('propagates a read failure instead of reporting "no language set"', async () => {
      const boom = new Error('firestore unavailable');
      jest.spyOn(mockDb.collection('ttsChannelConfigs').doc(TEST_CHANNEL_ID), 'get')
        .mockRejectedValueOnce(boom);

      await expect(ttsState.getStoredLanguageBoost(TEST_CHANNEL)).rejects.toThrow('firestore unavailable');
    });

    test('getTtsState, by contrast, reports auto on a failed read — which is why this function exists', async () => {
      jest.spyOn(mockDb.collection('ttsChannelConfigs').doc(TEST_CHANNEL_ID), 'get')
        .mockRejectedValueOnce(new Error('firestore unavailable'));

      const state = await ttsState.getTtsState(TEST_CHANNEL);
      expect(state.languageBoost).toBe('auto');
    });
  });

  describe('getTtsState', () => {
    test('should return config with allowViewerPreferences when set to true', async () => {
      const channelDoc = mockDb.collection('ttsChannelConfigs').doc(TEST_CHANNEL_ID);
      await channelDoc.set({
        ...mockChannelConfig,
        allowViewerPreferences: true
      });

      await ttsState.initializeTtsState();
      const state = await ttsState.getTtsState(TEST_CHANNEL);

      expect(state.allowViewerPreferences).toBe(true);
    });

    test('should return config with allowViewerPreferences when set to false', async () => {
      const channelDoc = mockDb.collection('ttsChannelConfigs').doc(TEST_CHANNEL_ID);
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

    test('never reads or caches a document keyed by login name', async () => {
      await mockDb.collection('ttsChannelConfigs').doc('unregistered').set({ ...mockChannelConfig, voiceId: 'Wise_Woman' });
      await ttsState.initializeTtsState();

      const state = await ttsState.getTtsState('unregistered');
      expect(state.voiceId).not.toBe('Wise_Woman');
    });

    // A failed read used to take the same path as a missing document, caching
    // defaults for a channel that has real settings. The channel then stayed on
    // them — with the profanity filter off — until the listener happened to
    // deliver the doc.
    test('does not cache defaults when the Firestore read fails', async () => {
      await ttsState.initializeTtsState();

      // Created after startup, so it is not in the cache the listener warmed.
      const channelDoc = mockDb.collection('ttsChannelConfigs').doc('55555');
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
      const channelDoc = mockDb.collection('ttsChannelConfigs').doc(TEST_CHANNEL_ID);
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

    test('refuses to write for a channel with no known ID', async () => {
      expect(await ttsState.setTtsState('unregistered', 'engineEnabled', false)).toBe(false);
      expect((await mockDb.collection('ttsChannelConfigs').doc('unregistered').get()).exists).toBe(false);
    });
  });

  describe('getGlobalUserPreferences', () => {
    test('should return user preferences when they exist', async () => {
      await mockDb.collection('ttsUserPreferences').doc(TEST_USER_ID).set({
        voiceId: 'Wise_Woman',
        emotion: 'happy',
        speed: 1.2
      });

      const prefs = await ttsState.getGlobalUserPreferences(TEST_USER_ID);

      expect(prefs).toEqual({
        voiceId: 'Wise_Woman',
        emotion: 'happy',
        speed: 1.2
      });
    });

    test('should return empty object when no preferences exist', async () => {
      expect(await ttsState.getGlobalUserPreferences('987654321')).toEqual({});
    });

    test('should return empty object without a user ID', async () => {
      expect(await ttsState.getGlobalUserPreferences(null)).toEqual({});
    });

    test('should never read a document keyed by login name', async () => {
      await mockDb.collection('ttsUserPreferences').doc(TEST_USER.toLowerCase()).set({ voiceId: 'Old_Voice' });

      expect(await ttsState.getGlobalUserPreferences(TEST_USER_ID)).toEqual({});
    });

    test('should cache results with TTL', async () => {
      const userDoc = mockDb.collection('ttsUserPreferences').doc(TEST_USER_ID);
      await userDoc.set({ voiceId: 'Cached_Voice' });

      // First call populates cache
      const prefs1 = await ttsState.getGlobalUserPreferences(TEST_USER_ID);
      expect(prefs1.voiceId).toBe('Cached_Voice');

      // Update Firestore directly
      await userDoc.set({ voiceId: 'Updated_Voice' });

      // Second call should return cached value
      const prefs2 = await ttsState.getGlobalUserPreferences(TEST_USER_ID);
      expect(prefs2.voiceId).toBe('Cached_Voice');
    });

    test('should cache empty results to avoid repeated misses', async () => {
      // First call for a user with no document
      const prefs1 = await ttsState.getGlobalUserPreferences('555');
      expect(prefs1).toEqual({});

      // Set up the doc after first call
      await mockDb.collection('ttsUserPreferences').doc('555').set({ voiceId: 'New_Voice' });

      // Second call should still return cached empty result
      const prefs2 = await ttsState.getGlobalUserPreferences('555');
      expect(prefs2).toEqual({});
    });
  });

  describe('setGlobalUserPreference', () => {
    test('should save user preference under the user ID', async () => {
      const result = await ttsState.setGlobalUserPreference(TEST_USER_ID, 'voiceId', 'Wise_Woman', TEST_USER);
      expect(result).toBe(true);

      const stored = (await mockDb.collection('ttsUserPreferences').doc(TEST_USER_ID).get()).data();
      expect(stored.voiceId).toBe('Wise_Woman');
      expect(stored.username).toBe(TEST_USER);
    });

    test('should merge preferences without overwriting', async () => {
      await ttsState.setGlobalUserPreference(TEST_USER_ID, 'voiceId', 'Wise_Woman');
      await ttsState.setGlobalUserPreference(TEST_USER_ID, 'emotion', 'happy');

      const prefs = await ttsState.getGlobalUserPreferences(TEST_USER_ID);
      expect(prefs.voiceId).toBe('Wise_Woman');
      expect(prefs.emotion).toBe('happy');
    });

    test('should refuse to write without a user ID', async () => {
      expect(await ttsState.setGlobalUserPreference(null, 'voiceId', 'Wise_Woman', TEST_USER)).toBe(false);
      expect((await mockDb.collection('ttsUserPreferences').doc(TEST_USER).get()).exists).toBe(false);
    });
  });

  describe('clearGlobalUserPreference', () => {
    test('should remove just that field', async () => {
      await ttsState.setGlobalUserPreference(TEST_USER_ID, 'voiceId', 'Wise_Woman');
      await ttsState.setGlobalUserPreference(TEST_USER_ID, 'emotion', 'happy');

      expect(await ttsState.clearGlobalUserPreference(TEST_USER_ID, 'voiceId')).toBe(true);

      const prefs = await ttsState.getGlobalUserPreferences(TEST_USER_ID);
      expect(prefs.voiceId).toBeUndefined();
      expect(prefs.emotion).toBe('happy');
    });

    test('should refuse to write without a user ID', async () => {
      expect(await ttsState.clearGlobalUserPreference(null, 'voiceId')).toBe(false);
    });
  });

  describe('getChannelUserPreferences', () => {
    beforeEach(async () => {
      await mockDb.collection('ttsChannelConfigs').doc(TEST_CHANNEL_ID).set({
        ...mockChannelConfig,
        userPreferences: {
          [TEST_USER_ID]: { voiceId: 'Calm_Man', emotion: 'neutral' },
          // Legacy login-keyed entry: must not be matched
          [TEST_USER2]: { voiceId: 'Wise_Woman' }
        }
      });
      await ttsState.initializeTtsState();
    });

    test('should return the entry keyed by user ID', async () => {
      const prefs = await ttsState.getChannelUserPreferences(TEST_CHANNEL, TEST_USER_ID);
      expect(prefs).toEqual({ voiceId: 'Calm_Man', emotion: 'neutral' });
    });

    test('should return an empty object when the user has no entry', async () => {
      expect(await ttsState.getChannelUserPreferences(TEST_CHANNEL, '987654321')).toEqual({});
    });

    test('should return an empty object without a user ID', async () => {
      expect(await ttsState.getChannelUserPreferences(TEST_CHANNEL, null)).toEqual({});
    });
  });

  describe('getUserEmoteModePreference', () => {
    test('should return null when no preference is set', async () => {
      expect(await ttsState.getUserEmoteModePreference('987654321')).toBeNull();
    });

    test('should return null without a user ID', async () => {
      expect(await ttsState.getUserEmoteModePreference(null)).toBeNull();
    });

    test('should return emoteMode from the user ID doc', async () => {
      await mockDb.collection('ttsUserPreferences').doc(TEST_USER_ID).set({ emoteMode: 'describe' });

      expect(await ttsState.getUserEmoteModePreference(TEST_USER_ID)).toBe('describe');
    });

    test('should reject invalid emoteMode values', async () => {
      await mockDb.collection('ttsUserPreferences').doc(TEST_USER_ID).set({ emoteMode: 'invalid_mode' });

      expect(await ttsState.getUserEmoteModePreference(TEST_USER_ID)).toBeNull();
    });

    test('should share one cached document read with getGlobalUserPreferences', async () => {
      // emoteMode is a field on the same ttsUserPreferences document as every other
      // global preference, so one read serves both lookups.
      const userDoc = mockDb.collection('ttsUserPreferences').doc(TEST_USER_ID);
      await userDoc.set({ emoteMode: 'skip', voiceId: 'Wise_Woman' });

      const getSpy = jest.spyOn(userDoc, 'get');

      const mode = await ttsState.getUserEmoteModePreference(TEST_USER_ID);
      const prefs = await ttsState.getGlobalUserPreferences(TEST_USER_ID);

      expect(mode).toBe('skip');
      expect(prefs.voiceId).toBe('Wise_Woman');
      expect(getSpy).toHaveBeenCalledTimes(1);
    });

    test('should observe an emoteMode change written through setGlobalUserPreference', async () => {
      await mockDb.collection('ttsUserPreferences').doc(TEST_USER_ID).set({ emoteMode: 'read' });

      expect(await ttsState.getUserEmoteModePreference(TEST_USER_ID)).toBe('read');

      await ttsState.setGlobalUserPreference(TEST_USER_ID, 'emoteMode', 'describe', TEST_USER);

      expect(await ttsState.getUserEmoteModePreference(TEST_USER_ID)).toBe('describe');
    });
  });

  describe('pronunciations', () => {
    const doc = () => mockDb.collection('ttsChannelConfigs').doc(TEST_CHANNEL_ID);

    beforeEach(async () => {
      await doc().set({ ...mockChannelConfig });
      await ttsState.initializeTtsState();
    });

    test('hydrates a fresh channel with an empty map, never undefined', async () => {
      // Both map fields carry a default, so callers never have to guard before
      // reading them. ignoredUsers used to lack one, and its add path threw on a
      // fresh channel as a result.
      const state = await ttsState.getTtsState('a-channel-that-does-not-exist');
      expect(state.pronunciations).toEqual({});
      expect(state.ignoredUserIds).toEqual({});
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

  describe('ignore list', () => {
    const doc = () => mockDb.collection('ttsChannelConfigs').doc(TEST_CHANNEL_ID);

    beforeEach(async () => {
      await doc().set({ ...mockChannelConfig });
      await ttsState.initializeTtsState();
    });

    test('addIgnoredUser stores the account ID keyed entry with its display label', async () => {
      expect(await ttsState.addIgnoredUser(TEST_CHANNEL, 'twitch:52343457', 'SpamBot')).toBe(true);

      const stored = (await doc().get()).data();
      expect(stored.ignoredUserIds['twitch:52343457']).toMatchObject({ label: 'SpamBot' });
    });

    test('addIgnoredUser defaults to moderator when no provenance is given', async () => {
      // The permissive default would be the dangerous one: an entry nobody can
      // attribute must not be one its subject can lift.
      await ttsState.addIgnoredUser(TEST_CHANNEL, 'twitch:111', 'One');

      const stored = (await doc().get()).data();
      expect(stored.ignoredUserIds['twitch:111'].source).toBe('moderator');
    });

    test('addIgnoredUser records the source and the acting account', async () => {
      await ttsState.addIgnoredUser(TEST_CHANNEL, 'twitch:111', 'One',
        { source: 'self', by: 'twitch:111' });

      const stored = (await doc().get()).data();
      expect(stored.ignoredUserIds['twitch:111']).toMatchObject({
        label: 'One', source: 'self', by: 'twitch:111',
      });
      expect(Date.parse(stored.ignoredUserIds['twitch:111'].at)).not.toBeNaN();
    });

    test('a moderator re-adding a self entry takes it out of the viewer hands', async () => {
      // merge:true merges into the entry object as well as the map, so a write
      // that omitted `source` would leave this entry marked self — and the muted
      // viewer could clear it themselves a moment later.
      await ttsState.addIgnoredUser(TEST_CHANNEL, 'twitch:111', 'One',
        { source: 'self', by: 'twitch:111' });
      await ttsState.addIgnoredUser(TEST_CHANNEL, 'twitch:111', 'One',
        { source: 'moderator', by: 'twitch:99' });

      const stored = (await doc().get()).data();
      expect(stored.ignoredUserIds['twitch:111']).toMatchObject({
        source: 'moderator', by: 'twitch:99',
      });
    });

    test('addIgnoredUser leaves sibling entries alone', async () => {
      await ttsState.addIgnoredUser(TEST_CHANNEL, 'twitch:111', 'One');
      await ttsState.addIgnoredUser(TEST_CHANNEL, 'youtube:UCabc', 'Two');

      const stored = (await doc().get()).data();
      expect(Object.keys(stored.ignoredUserIds).sort()).toEqual(['twitch:111', 'youtube:UCabc']);
      expect(stored.ignoredUserIds['twitch:111'].label).toBe('One');
      expect(stored.ignoredUserIds['youtube:UCabc'].label).toBe('Two');
    });

    test('re-adding an account refreshes the stale display label', async () => {
      await ttsState.addIgnoredUser(TEST_CHANNEL, 'twitch:111', 'OldName');
      await ttsState.addIgnoredUser(TEST_CHANNEL, 'twitch:111', 'NewName');

      const stored = (await doc().get()).data();
      expect(stored.ignoredUserIds['twitch:111'].label).toBe('NewName');
    });

    test('addIgnoredUser updates the cache immediately', async () => {
      await ttsState.addIgnoredUser(TEST_CHANNEL, 'twitch:111', 'One');

      const state = await ttsState.getTtsState(TEST_CHANNEL);
      expect(state.ignoredUserIds['twitch:111']).toMatchObject({ label: 'One' });
    });

    test('removeIgnoredUser deletes just that key', async () => {
      // The colon in the key would be read as nothing special by a dotted path,
      // but FieldPath segments are literal — this is the case that proves it.
      await ttsState.addIgnoredUser(TEST_CHANNEL, 'twitch:111', 'One');
      await ttsState.addIgnoredUser(TEST_CHANNEL, 'youtube:UCabc', 'Two');

      expect(await ttsState.removeIgnoredUser(TEST_CHANNEL, 'twitch:111')).toBe(true);

      const stored = (await doc().get()).data();
      expect(Object.keys(stored.ignoredUserIds)).toEqual(['youtube:UCabc']);
    });

    test('removeIgnoredUser deletes a legacy string entry too', async () => {
      // Deletion is by FieldPath and never looks at the value, so entries stored
      // before provenance existed are removed by exactly the same path.
      await doc().set({ ...mockChannelConfig, ignoredUserIds: { 'twitch:111': 'Legacy' } });

      expect(await ttsState.removeIgnoredUser(TEST_CHANNEL, 'twitch:111')).toBe(true);
      expect((await doc().get()).data().ignoredUserIds['twitch:111']).toBeUndefined();
    });

    test('removeIgnoredUser updates the cache immediately', async () => {
      await ttsState.addIgnoredUser(TEST_CHANNEL, 'twitch:111', 'One');
      await ttsState.removeIgnoredUser(TEST_CHANNEL, 'twitch:111');

      const state = await ttsState.getTtsState(TEST_CHANNEL);
      expect(state.ignoredUserIds['twitch:111']).toBeUndefined();
    });

    test('removing an entry that is not there reports success', async () => {
      // NOT_FOUND means the desired end state already holds.
      expect(await ttsState.removeIgnoredUser(TEST_CHANNEL, 'twitch:nobody')).toBe(true);
    });
  });
});