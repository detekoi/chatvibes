// tests/integration/allowViewerPreferences.test.js
// Integration tests for the allowViewerPreferences feature: real ttsState and ttsQueue
// over a mock Firestore. The queue hands the provider a resolved voice and the style,
// language and volume built from the settings, so those are what is asserted.

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
  TEST_USER2_ID,
  mockChannelConfig,
  mockChannelConfigNoViewerPrefs,
  mockUserPreferences,
  mockGlobalUserPreferences,
  mockChatMessage
} from '../helpers/testData.js';

const TEST_CHANNEL_ID = '12345';

describe('allowViewerPreferences Feature', () => {
  let mockDb;
  let ttsState;
  let ttsQueue;
  let mockGenerateSpeech;

  beforeEach(async () => {
    // Reset modules
    jest.resetModules();

    // Create fresh mock Firestore
    mockDb = createMockFirestore();

    // Mock Firestore initialization
    jest.unstable_mockModule('@google-cloud/firestore', () => ({
      Firestore: jest.fn(() => mockDb),
      FieldValue: FieldValue,
      FieldPath: FieldPath
    }));

    // Mock TTS service
    mockGenerateSpeech = jest.fn().mockResolvedValue({
      kind: 'buffer',
      data: Buffer.from([0x52, 0x49, 0x46, 0x46]),
      mime: 'audio/wav'
    });
    jest.unstable_mockModule('../../src/components/tts/ttsService.js', () => ({
      generateSpeech: mockGenerateSpeech,
      getAvailableVoices: jest.fn().mockResolvedValue([
        { id: 'kore', name: 'Kore' },
        { id: 'aoede', name: 'Aoede' },
        { id: 'charon', name: 'Charon' },
        { id: 'zephyr', name: 'Zephyr' }
      ])
    }));

    // Mock WebSocket server
    jest.unstable_mockModule('../../src/components/web/server.js', () => ({
      sendAudioToChannel: jest.fn(),
      hasActiveClients: jest.fn(() => true),
      openClipStream: jest.fn(() => null),
      sendClipMeta: jest.fn(() => new Set()),
      STOP_CURRENT_AUDIO: 'STOP_CURRENT_AUDIO'
    }));

    // Import modules after mocking
    ttsState = await import('../../src/components/tts/ttsState.js');
    ttsQueue = await import('../../src/components/tts/ttsQueue.js');

    const allowList = await import('../../src/lib/allowList.js');
    allowList.addAllowedChannel(TEST_CHANNEL, TEST_CHANNEL_ID);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('when allowViewerPreferences is true (default)', () => {
    beforeEach(async () => {
      // Set up channel config with viewer preferences enabled
      const channelDoc = mockDb.collection('ttsChannelConfigs').doc(TEST_CHANNEL_ID);
      await channelDoc.set({
        ...mockChannelConfig,
        userPreferences: mockUserPreferences
      });

      await ttsState.initializeTtsState();
    });

    test('should use user-specific voice preference from channel userPreferences', async () => {
      await ttsQueue.enqueue(TEST_CHANNEL, {
        text: mockChatMessage.text,
        user: TEST_USER,
        userId: TEST_USER_ID,
        type: 'chat'
      });

      // Wait for processing
      await new Promise(resolve => setTimeout(resolve, 100));

      expect(mockGenerateSpeech).toHaveBeenCalledWith(
        mockChatMessage.text,
        'aoede', // User's preferred voice
        expect.objectContaining({
          // emotion happy, speed 1.2, pitch 2
          style: 'happy and cheerful, speaking quickly, high pitch',
          language: 'en',
          volume: 1
        })
      );
    });

    test('should use global user preferences when available', async () => {
      // Set global preferences for the user
      const userPrefsDoc = mockDb.collection('ttsUserPreferences').doc(TEST_USER_ID);
      await userPrefsDoc.set(mockGlobalUserPreferences);

      await ttsQueue.enqueue(TEST_CHANNEL, {
        text: mockChatMessage.text,
        user: TEST_USER,
        userId: TEST_USER_ID,
        type: 'chat'
      });

      await new Promise(resolve => setTimeout(resolve, 100));

      // Global preferences should take precedence
      expect(mockGenerateSpeech).toHaveBeenCalledWith(
        mockChatMessage.text,
        'zephyr',
        expect.objectContaining({
          // emotion surprised, speed 1.5, pitch -2: none of the channel-level values
          style: 'surprised and astonished, speaking quickly, low pitch',
          language: 'es'
        })
      );
    });

    test('should fall back to channel defaults when user has no preferences', async () => {
      await ttsQueue.enqueue(TEST_CHANNEL, {
        text: mockChatMessage.text,
        user: 'unknownuser',
        userId: '999999999',
        type: 'chat'
      });

      await new Promise(resolve => setTimeout(resolve, 100));

      expect(mockGenerateSpeech).toHaveBeenCalledWith(
        mockChatMessage.text,
        'kore', // Channel default
        expect.objectContaining({
          style: '',
          language: undefined
        })
      );
    });

    test('should use partial user preferences with channel defaults as fallback', async () => {
      await ttsQueue.enqueue(TEST_CHANNEL, {
        text: mockChatMessage.text,
        user: TEST_USER2,
        userId: TEST_USER2_ID, // Only has voiceId and emotion
        type: 'chat'
      });

      await new Promise(resolve => setTimeout(resolve, 100));

      expect(mockGenerateSpeech).toHaveBeenCalledWith(
        mockChatMessage.text,
        'charon', // User preference
        expect.objectContaining({
          // emotion neutral (user), speed 1.0 and pitch 0 (channel): no words needed
          style: '',
          language: undefined
        })
      );
    });
  });

  describe('when allowViewerPreferences is false', () => {
    beforeEach(async () => {
      // Set up channel config with viewer preferences disabled
      const channelDoc = mockDb.collection('ttsChannelConfigs').doc(TEST_CHANNEL_ID);
      await channelDoc.set({
        ...mockChannelConfigNoViewerPrefs,
        userPreferences: mockUserPreferences
      });

      await ttsState.initializeTtsState();
    });

    test('should ignore user voice preferences and use channel defaults', async () => {
      await ttsQueue.enqueue(TEST_CHANNEL, {
        text: mockChatMessage.text,
        user: TEST_USER,
        userId: TEST_USER_ID,
        type: 'chat'
      });

      await new Promise(resolve => setTimeout(resolve, 100));

      // Should use channel default voice, not user preference
      expect(mockGenerateSpeech).toHaveBeenCalledWith(
        mockChatMessage.text,
        'kore', // Channel default, not the user's 'aoede'
        expect.objectContaining({
          style: '',
          language: undefined
        })
      );
    });

    test('should ignore global user preferences when disabled', async () => {
      // Set global preferences for the user
      const userPrefsDoc = mockDb.collection('ttsUserPreferences').doc(TEST_USER_ID);
      await userPrefsDoc.set(mockGlobalUserPreferences);

      await ttsQueue.enqueue(TEST_CHANNEL, {
        text: mockChatMessage.text,
        user: TEST_USER,
        userId: TEST_USER_ID,
        type: 'chat'
      });

      await new Promise(resolve => setTimeout(resolve, 100));

      // Should still use channel defaults
      expect(mockGenerateSpeech).toHaveBeenCalledWith(
        mockChatMessage.text,
        'kore',
        expect.objectContaining({
          style: '',
          language: undefined
        })
      );
    });

    test('should use channel defaults for all users consistently', async () => {
      // Test with multiple users
      await ttsQueue.enqueue(TEST_CHANNEL, {
        text: 'First message',
        user: TEST_USER,
        userId: TEST_USER_ID,
        type: 'chat'
      });

      await ttsQueue.enqueue(TEST_CHANNEL, {
        text: 'Second message',
        user: TEST_USER2,
        userId: TEST_USER2_ID,
        type: 'chat'
      });

      await new Promise(resolve => setTimeout(resolve, 200));

      // Both should use channel defaults
      expect(mockGenerateSpeech).toHaveBeenNthCalledWith(
        1,
        'First message',
        'kore',
        expect.objectContaining({ style: '' })
      );

      expect(mockGenerateSpeech).toHaveBeenNthCalledWith(
        2,
        'Second message',
        'kore',
        expect.objectContaining({ style: '' })
      );
    });
  });

  describe('when allowViewerPreferences is undefined (legacy behavior)', () => {
    beforeEach(async () => {
      // Set up channel config without allowViewerPreferences field
      const channelDoc = mockDb.collection('ttsChannelConfigs').doc(TEST_CHANNEL_ID);
      const configWithoutField = { ...mockChannelConfig };
      delete configWithoutField.allowViewerPreferences;
      await channelDoc.set({
        ...configWithoutField,
        userPreferences: mockUserPreferences
      });

      await ttsState.initializeTtsState();
    });

    test('should default to allowing viewer preferences (backward compatibility)', async () => {
      await ttsQueue.enqueue(TEST_CHANNEL, {
        text: mockChatMessage.text,
        user: TEST_USER,
        userId: TEST_USER_ID,
        type: 'chat'
      });

      await new Promise(resolve => setTimeout(resolve, 100));

      // Should use user preferences (default behavior)
      expect(mockGenerateSpeech).toHaveBeenCalledWith(
        mockChatMessage.text,
        'aoede', // User preference
        expect.objectContaining({
          style: 'happy and cheerful, speaking quickly, high pitch'
        })
      );
    });
  });

  describe('direct voiceOptions override', () => {
    beforeEach(async () => {
      const channelDoc = mockDb.collection('ttsChannelConfigs').doc(TEST_CHANNEL_ID);
      await channelDoc.set({
        ...mockChannelConfigNoViewerPrefs,
        userPreferences: mockUserPreferences
      });

      await ttsState.initializeTtsState();
    });

    test('should respect direct voiceOptions even when viewer preferences disabled', async () => {
      await ttsQueue.enqueue(TEST_CHANNEL, {
        text: mockChatMessage.text,
        user: TEST_USER,
        userId: TEST_USER_ID,
        type: 'chat',
        voiceOptions: {
          voiceId: 'charon',
          emotion: 'angry'
        }
      });

      await new Promise(resolve => setTimeout(resolve, 100));

      // Direct voiceOptions should override everything
      expect(mockGenerateSpeech).toHaveBeenCalledWith(
        mockChatMessage.text,
        'charon',
        expect.objectContaining({
          style: 'angry'
        })
      );
    });
  });

  // Through the real getChannelTtsConfig: the stored voiceLanguage reaches the provider.
  describe('voice language', () => {
    const spokenLanguage = async (user, userId) => {
      await ttsQueue.enqueue(TEST_CHANNEL, { text: mockChatMessage.text, user, userId, type: 'chat' });
      await new Promise(resolve => setTimeout(resolve, 100));
      return mockGenerateSpeech.mock.calls.at(-1)[2].language;
    };

    beforeEach(async () => {
      await mockDb.collection('ttsChannelConfigs').doc(TEST_CHANNEL_ID).set({
        ...mockChannelConfig,
        voiceLanguage: 'th-TH',
        userPreferences: mockUserPreferences
      });
      await ttsState.initializeTtsState();
    });

    test('the language stored beside the channel voice is the hint for a viewer with no voice', async () => {
      expect(await spokenLanguage('unknownuser', '999999999')).toBe('th-TH');
    });

    test('a viewer with a voice and a languageBoost of their own does not get it', async () => {
      // TEST_USER: voice aoede, languageBoost English.
      expect(await spokenLanguage(TEST_USER, TEST_USER_ID)).toBe('en');
    });

    test('a viewer with a voice of their own and no languageBoost gets no hint from the channel voice', async () => {
      // TEST_USER2: voice charon, a studio voice with no language.
      expect(await spokenLanguage(TEST_USER2, TEST_USER2_ID)).toBeUndefined();
    });
  });

  describe('custom style', () => {
    const say = async (user, userId) => {
      await ttsQueue.enqueue(TEST_CHANNEL, { text: mockChatMessage.text, user, userId, type: 'chat' });
      await new Promise(resolve => setTimeout(resolve, 100));
      return mockGenerateSpeech.mock.calls.at(-1)[2].style;
    };

    const setChannel = (config) => mockDb.collection('ttsChannelConfigs').doc(TEST_CHANNEL_ID).set({
      ...config,
      style: 'like a robot',
      userPreferences: mockUserPreferences
    });

    test('the channel style is used for a viewer with neither a style nor an emotion', async () => {
      await setChannel(mockChannelConfig);
      await ttsState.initializeTtsState();

      expect(await say('unknownuser', '999999999')).toBe('like a robot');
    });

    test('a viewer who chose an emotion keeps it over the channel style', async () => {
      await setChannel(mockChannelConfig);
      await ttsState.initializeTtsState();

      expect(await say(TEST_USER, TEST_USER_ID)).toBe('happy and cheerful, speaking quickly, high pitch');
    });

    test('a viewer style replaces the viewer emotion and the channel style', async () => {
      await setChannel(mockChannelConfig);
      await mockDb.collection('ttsUserPreferences').doc(TEST_USER_ID).set({ style: 'like a pirate' });
      await ttsState.initializeTtsState();

      // Speed 1.2 and pitch 2 still come from the viewer's per-channel preferences.
      expect(await say(TEST_USER, TEST_USER_ID)).toBe('like a pirate, speaking quickly, high pitch');
    });

    test('the channel style is used for everyone when viewer preferences are disabled', async () => {
      await setChannel(mockChannelConfigNoViewerPrefs);
      await mockDb.collection('ttsUserPreferences').doc(TEST_USER_ID).set({ style: 'like a pirate' });
      await ttsState.initializeTtsState();

      expect(await say(TEST_USER, TEST_USER_ID)).toBe('like a robot');
    });
  });
});