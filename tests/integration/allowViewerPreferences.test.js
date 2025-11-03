// tests/integration/allowViewerPreferences.test.js
// Integration tests for the allowViewerPreferences feature

import { jest } from '@jest/globals';
import {
  createMockFirestore,
  FieldValue
} from '../helpers/mockFirestore.js';
import {
  TEST_CHANNEL,
  TEST_USER,
  TEST_USER2,
  mockChannelConfig,
  mockChannelConfigNoViewerPrefs,
  mockUserPreferences,
  mockGlobalUserPreferences,
  mockChatMessage
} from '../helpers/testData.js';

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
      FieldValue: FieldValue
    }));

    // Mock TTS service
    mockGenerateSpeech = jest.fn().mockResolvedValue('https://example.com/audio.wav');
    jest.unstable_mockModule('../../src/components/tts/ttsService.js', () => ({
      generateSpeech: mockGenerateSpeech,
      getAvailableVoices: jest.fn().mockResolvedValue([
        { id: 'Friendly_Person', name: 'Friendly Person' },
        { id: 'Wise_Woman', name: 'Wise Woman' },
        { id: 'Calm_Man', name: 'Calm Man' },
        { id: 'Global_Voice', name: 'Global Voice' }
      ])
    }));

    // Mock WebSocket server
    jest.unstable_mockModule('../../src/components/web/server.js', () => ({
      sendAudioToChannel: jest.fn(),
      hasActiveClients: jest.fn(() => true)
    }));

    // Import modules after mocking
    ttsState = await import('../../src/components/tts/ttsState.js');
    ttsQueue = await import('../../src/components/tts/ttsQueue.js');
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('when allowViewerPreferences is true (default)', () => {
    beforeEach(async () => {
      // Set up channel config with viewer preferences enabled
      const channelDoc = mockDb.collection('ttsChannelConfigs').doc(TEST_CHANNEL);
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
        type: 'chat'
      });

      // Wait for processing
      await new Promise(resolve => setTimeout(resolve, 100));

      expect(mockGenerateSpeech).toHaveBeenCalledWith(
        mockChatMessage.text,
        'Wise_Woman', // User's preferred voice
        expect.objectContaining({
          voiceId: 'Wise_Woman',
          emotion: 'happy',
          speed: 1.2,
          pitch: 2,
          languageBoost: 'English'
        })
      );
    });

    test('should use global user preferences when available', async () => {
      // Set global preferences for the user
      const userPrefsDoc = mockDb.collection('ttsUserPreferences').doc(TEST_USER.toLowerCase());
      await userPrefsDoc.set(mockGlobalUserPreferences);

      await ttsQueue.enqueue(TEST_CHANNEL, {
        text: mockChatMessage.text,
        user: TEST_USER,
        type: 'chat'
      });

      await new Promise(resolve => setTimeout(resolve, 100));

      // Global preferences should take precedence
      expect(mockGenerateSpeech).toHaveBeenCalledWith(
        mockChatMessage.text,
        'Global_Voice',
        expect.objectContaining({
          voiceId: 'Global_Voice',
          emotion: 'surprised',
          speed: 1.5,
          pitch: -2,
          languageBoost: 'Spanish',
          englishNormalization: true
        })
      );
    });

    test('should fall back to channel defaults when user has no preferences', async () => {
      await ttsQueue.enqueue(TEST_CHANNEL, {
        text: mockChatMessage.text,
        user: 'unknownuser',
        type: 'chat'
      });

      await new Promise(resolve => setTimeout(resolve, 100));

      expect(mockGenerateSpeech).toHaveBeenCalledWith(
        mockChatMessage.text,
        'Friendly_Person', // Channel default
        expect.objectContaining({
          voiceId: 'Friendly_Person',
          emotion: 'auto',
          speed: 1.0,
          pitch: 0
        })
      );
    });

    test('should use partial user preferences with channel defaults as fallback', async () => {
      await ttsQueue.enqueue(TEST_CHANNEL, {
        text: mockChatMessage.text,
        user: TEST_USER2, // Only has voiceId and emotion
        type: 'chat'
      });

      await new Promise(resolve => setTimeout(resolve, 100));

      expect(mockGenerateSpeech).toHaveBeenCalledWith(
        mockChatMessage.text,
        'Calm_Man',
        expect.objectContaining({
          voiceId: 'Calm_Man', // User preference
          emotion: 'neutral',  // User preference
          speed: 1.0,          // Channel default
          pitch: 0             // Channel default
        })
      );
    });
  });

  describe('when allowViewerPreferences is false', () => {
    beforeEach(async () => {
      // Set up channel config with viewer preferences disabled
      const channelDoc = mockDb.collection('ttsChannelConfigs').doc(TEST_CHANNEL);
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
        type: 'chat'
      });

      await new Promise(resolve => setTimeout(resolve, 100));

      // Should use channel default voice, not user preference
      expect(mockGenerateSpeech).toHaveBeenCalledWith(
        mockChatMessage.text,
        'Friendly_Person', // Channel default, not 'Wise_Woman'
        expect.objectContaining({
          voiceId: 'Friendly_Person',
          emotion: 'auto',
          speed: 1.0,
          pitch: 0,
          languageBoost: 'Automatic'
        })
      );
    });

    test('should ignore global user preferences when disabled', async () => {
      // Set global preferences for the user
      const userPrefsDoc = mockDb.collection('ttsUserPreferences').doc(TEST_USER.toLowerCase());
      await userPrefsDoc.set(mockGlobalUserPreferences);

      await ttsQueue.enqueue(TEST_CHANNEL, {
        text: mockChatMessage.text,
        user: TEST_USER,
        type: 'chat'
      });

      await new Promise(resolve => setTimeout(resolve, 100));

      // Should still use channel defaults
      expect(mockGenerateSpeech).toHaveBeenCalledWith(
        mockChatMessage.text,
        'Friendly_Person',
        expect.objectContaining({
          voiceId: 'Friendly_Person',
          emotion: 'auto',
          speed: 1.0,
          pitch: 0
        })
      );
    });

    test('should use channel defaults for all users consistently', async () => {
      // Test with multiple users
      await ttsQueue.enqueue(TEST_CHANNEL, {
        text: 'First message',
        user: TEST_USER,
        type: 'chat'
      });

      await ttsQueue.enqueue(TEST_CHANNEL, {
        text: 'Second message',
        user: TEST_USER2,
        type: 'chat'
      });

      await new Promise(resolve => setTimeout(resolve, 200));

      // Both should use channel defaults
      expect(mockGenerateSpeech).toHaveBeenNthCalledWith(
        1,
        'First message',
        'Friendly_Person',
        expect.objectContaining({ voiceId: 'Friendly_Person' })
      );

      expect(mockGenerateSpeech).toHaveBeenNthCalledWith(
        2,
        'Second message',
        'Friendly_Person',
        expect.objectContaining({ voiceId: 'Friendly_Person' })
      );
    });
  });

  describe('when allowViewerPreferences is undefined (legacy behavior)', () => {
    beforeEach(async () => {
      // Set up channel config without allowViewerPreferences field
      const channelDoc = mockDb.collection('ttsChannelConfigs').doc(TEST_CHANNEL);
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
        type: 'chat'
      });

      await new Promise(resolve => setTimeout(resolve, 100));

      // Should use user preferences (default behavior)
      expect(mockGenerateSpeech).toHaveBeenCalledWith(
        mockChatMessage.text,
        'Wise_Woman', // User preference
        expect.objectContaining({
          voiceId: 'Wise_Woman'
        })
      );
    });
  });

  describe('direct voiceOptions override', () => {
    beforeEach(async () => {
      const channelDoc = mockDb.collection('ttsChannelConfigs').doc(TEST_CHANNEL);
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
        type: 'chat',
        voiceOptions: {
          voiceId: 'Calm_Man',
          emotion: 'excited'
        }
      });

      await new Promise(resolve => setTimeout(resolve, 100));

      // Direct voiceOptions should override everything
      expect(mockGenerateSpeech).toHaveBeenCalledWith(
        mockChatMessage.text,
        'Calm_Man',
        expect.objectContaining({
          voiceId: 'Calm_Man',
          emotion: 'excited'
        })
      );
    });
  });
});