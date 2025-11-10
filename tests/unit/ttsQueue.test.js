// tests/unit/ttsQueue.test.js
// Unit tests for TTS queue management

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

describe('ttsQueue module', () => {
  let mockDb;
  let mockLogger;
  let mockTtsService;
  let mockWebServer;
  let mockTtsState;
  let ttsQueue;

  beforeEach(async () => {
    jest.resetModules();
    jest.clearAllMocks();

    // Create fresh mocks
    mockDb = createMockFirestore();

    mockLogger = {
      debug: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn()
    };

    mockTtsService = {
      generateSpeech: jest.fn()
    };

    mockWebServer = {
      sendAudioToChannel: jest.fn(),
      hasActiveClients: jest.fn().mockReturnValue(true)
    };

    mockTtsState = {
      getTtsState: jest.fn(),
      getChannelTtsConfig: jest.fn(),
      getGlobalUserPreferences: jest.fn().mockResolvedValue({}),
      getUserEmotionPreference: jest.fn().mockResolvedValue(null),
      getUserVoicePreference: jest.fn().mockResolvedValue(null),
      getUserPitchPreference: jest.fn().mockResolvedValue(null),
      getUserSpeedPreference: jest.fn().mockResolvedValue(null),
      getUserLanguagePreference: jest.fn().mockResolvedValue(null),
      getUserEnglishNormalizationPreference: jest.fn().mockResolvedValue(null)
    };

    // Set up default mock responses
    mockTtsState.getTtsState.mockResolvedValue({
      ...mockChannelConfig,
      engineEnabled: true,
      allowViewerPreferences: true
    });

    mockTtsState.getChannelTtsConfig.mockResolvedValue(mockChannelConfig);

    // Mock modules
    jest.unstable_mockModule('@google-cloud/firestore', () => ({
      Firestore: jest.fn(() => mockDb),
      FieldValue: FieldValue
    }));

    jest.unstable_mockModule('../../src/lib/logger.js', () => ({
      default: mockLogger
    }));

    jest.unstable_mockModule('../../src/components/tts/ttsService.js', () => mockTtsService);
    jest.unstable_mockModule('../../src/components/web/server.js', () => mockWebServer);
    jest.unstable_mockModule('../../src/components/tts/ttsState.js', () => mockTtsState);

    jest.unstable_mockModule('../../src/components/tts/ttsConstants.js', () => ({
      DEFAULT_TTS_SETTINGS: {
        voiceId: 'Default_Voice',
        speed: 1.0,
        pitch: 0,
        emotion: 'neutral',
        languageBoost: 'Automatic',
        volume: 1.0,
        englishNormalization: true,
        sampleRate: 24000,
        bitrate: 128,
        channel: 'mono'
      }
    }));

    ttsQueue = await import('../../src/components/tts/ttsQueue.js');
  });

  describe('getOrCreateChannelQueue', () => {
    test('should create new queue for channel', () => {
      const queue = ttsQueue.getOrCreateChannelQueue(TEST_CHANNEL);

      expect(queue).toBeDefined();
      expect(queue.queue).toEqual([]);
      expect(queue.isPaused).toBe(false);
      expect(queue.isProcessing).toBe(false);
      expect(queue.currentSpeechUrl).toBeNull();
      expect(queue.currentUserSpeaking).toBeNull();
    });

    test('should return existing queue for channel', () => {
      const queue1 = ttsQueue.getOrCreateChannelQueue(TEST_CHANNEL);
      queue1.isPaused = true;

      const queue2 = ttsQueue.getOrCreateChannelQueue(TEST_CHANNEL);

      expect(queue2).toBe(queue1);
      expect(queue2.isPaused).toBe(true);
    });

    test('should maintain separate queues for different channels', () => {
      const queue1 = ttsQueue.getOrCreateChannelQueue('channel1');
      const queue2 = ttsQueue.getOrCreateChannelQueue('channel2');

      expect(queue1).not.toBe(queue2);
    });
  });

  describe('enqueue', () => {
    test('should enqueue message with default settings', async () => {
      // Pause queue to prevent immediate processing
      await ttsQueue.pauseQueue(TEST_CHANNEL);
      
      const eventData = {
        text: 'Test message',
        user: TEST_USER,
        type: 'chat'
      };

      await ttsQueue.enqueue(TEST_CHANNEL, eventData);

      const queue = ttsQueue.getOrCreateChannelQueue(TEST_CHANNEL);
      expect(queue.queue).toHaveLength(1);
      expect(queue.queue[0].text).toBe('Test message');
      expect(queue.queue[0].user).toBe(TEST_USER);
      expect(queue.queue[0].type).toBe('chat');
    });

    test('should not enqueue when TTS engine is disabled', async () => {
      mockTtsState.getTtsState.mockResolvedValue({
        engineEnabled: false
      });

      const eventData = {
        text: 'Test message',
        user: TEST_USER
      };

      await ttsQueue.enqueue(TEST_CHANNEL, eventData);

      const queue = ttsQueue.getOrCreateChannelQueue(TEST_CHANNEL);
      expect(queue.queue).toHaveLength(0);
    });

    test('should not enqueue when queue is full', async () => {
      const queue = ttsQueue.getOrCreateChannelQueue(TEST_CHANNEL);

      // Fill queue to max
      for (let i = 0; i < 50; i++) {
        queue.queue.push({ text: `Message ${i}`, user: TEST_USER, voiceConfig: {} });
      }

      const eventData = {
        text: 'This should be dropped',
        user: TEST_USER
      };

      await ttsQueue.enqueue(TEST_CHANNEL, eventData);

      expect(queue.queue).toHaveLength(50);
      expect(queue.queue.find(item => item.text === 'This should be dropped')).toBeUndefined();
    });

    test('should apply viewer preferences when allowed', async () => {
      // Pause queue to prevent immediate processing
      await ttsQueue.pauseQueue(TEST_CHANNEL);
      
      mockTtsState.getGlobalUserPreferences.mockResolvedValue({
        voiceId: 'Custom_Voice',
        emotion: 'happy',
        speed: 1.5
      });

      const eventData = {
        text: 'Test message',
        user: TEST_USER,
        type: 'chat'
      };

      await ttsQueue.enqueue(TEST_CHANNEL, eventData);

      const queue = ttsQueue.getOrCreateChannelQueue(TEST_CHANNEL);
      expect(queue.queue[0].voiceConfig.voiceId).toBe('Custom_Voice');
      expect(queue.queue[0].voiceConfig.emotion).toBe('happy');
      expect(queue.queue[0].voiceConfig.speed).toBe(1.5);
    });

    test('should not apply viewer preferences when disallowed', async () => {
      // Pause queue to prevent immediate processing
      await ttsQueue.pauseQueue(TEST_CHANNEL);
      
      mockTtsState.getTtsState.mockResolvedValue({
        ...mockChannelConfig,
        engineEnabled: true,
        allowViewerPreferences: false
      });

      mockTtsState.getGlobalUserPreferences.mockResolvedValue({
        voiceId: 'Custom_Voice',
        emotion: 'happy'
      });

      const eventData = {
        text: 'Test message',
        user: TEST_USER,
        type: 'chat'
      };

      await ttsQueue.enqueue(TEST_CHANNEL, eventData);

      const queue = ttsQueue.getOrCreateChannelQueue(TEST_CHANNEL);
      // Should use channel defaults, not user preferences
      expect(queue.queue[0].voiceConfig.voiceId).toBe(mockChannelConfig.voiceId);
    });

    test('should handle event messages without user', async () => {
      // Pause queue to prevent immediate processing
      await ttsQueue.pauseQueue(TEST_CHANNEL);
      
      const eventData = {
        text: 'User subscribed!',
        type: 'event'
      };

      await ttsQueue.enqueue(TEST_CHANNEL, eventData);

      const queue = ttsQueue.getOrCreateChannelQueue(TEST_CHANNEL);
      expect(queue.queue).toHaveLength(1);
      expect(queue.queue[0].user).toBeUndefined();
      expect(queue.queue[0].type).toBe('event');
    });

    test('should handle shared session info', async () => {
      // Pause queue to prevent immediate processing
      await ttsQueue.pauseQueue(TEST_CHANNEL);
      
      const sharedSessionInfo = {
        sessionId: 'test-session',
        channels: ['channel1', 'channel2']
      };

      const eventData = {
        text: 'Shared message',
        user: TEST_USER,
        type: 'chat'
      };

      await ttsQueue.enqueue(TEST_CHANNEL, eventData, sharedSessionInfo);

      const queue = ttsQueue.getOrCreateChannelQueue(TEST_CHANNEL);
      expect(queue.queue[0].sharedSessionInfo).toEqual(sharedSessionInfo);
    });
  });

  describe('pauseQueue', () => {
    test('should pause queue', async () => {
      await ttsQueue.pauseQueue(TEST_CHANNEL);

      const queue = ttsQueue.getOrCreateChannelQueue(TEST_CHANNEL);
      expect(queue.isPaused).toBe(true);
    });

    test('should prevent processing when paused', async () => {
      mockTtsService.generateSpeech.mockResolvedValue('http://example.com/audio.mp3');

      await ttsQueue.pauseQueue(TEST_CHANNEL);

      const eventData = {
        text: 'Test message',
        user: TEST_USER
      };

      await ttsQueue.enqueue(TEST_CHANNEL, eventData);

      // Wait a bit to ensure processQueue doesn't trigger
      await new Promise(resolve => setTimeout(resolve, 100));

      expect(mockTtsService.generateSpeech).not.toHaveBeenCalled();
    });
  });

  describe('resumeQueue', () => {
    test('should resume queue and start processing', async () => {
      mockTtsService.generateSpeech.mockResolvedValue('http://example.com/audio.mp3');

      await ttsQueue.pauseQueue(TEST_CHANNEL);

      const eventData = {
        text: 'Test message',
        user: TEST_USER
      };
      await ttsQueue.enqueue(TEST_CHANNEL, eventData);

      await ttsQueue.resumeQueue(TEST_CHANNEL);

      const queue = ttsQueue.getOrCreateChannelQueue(TEST_CHANNEL);
      expect(queue.isPaused).toBe(false);
    });
  });

  describe('clearQueue', () => {
    test('should clear all pending messages', async () => {
      // Pause queue to prevent immediate processing
      await ttsQueue.pauseQueue(TEST_CHANNEL);
      
      const queue = ttsQueue.getOrCreateChannelQueue(TEST_CHANNEL);

      // Add multiple messages
      for (let i = 0; i < 5; i++) {
        await ttsQueue.enqueue(TEST_CHANNEL, {
          text: `Message ${i}`,
          user: TEST_USER
        });
      }

      expect(queue.queue.length).toBeGreaterThan(0);

      await ttsQueue.clearQueue(TEST_CHANNEL);

      expect(queue.queue).toHaveLength(0);
    });

    test('should not affect current speech', async () => {
      const queue = ttsQueue.getOrCreateChannelQueue(TEST_CHANNEL);
      queue.currentSpeechUrl = 'http://example.com/audio.mp3';
      queue.currentUserSpeaking = TEST_USER;

      await ttsQueue.clearQueue(TEST_CHANNEL);

      expect(queue.currentSpeechUrl).toBe('http://example.com/audio.mp3');
      expect(queue.currentUserSpeaking).toBe(TEST_USER);
    });
  });

  describe('stopCurrentSpeech', () => {
    test('should stop current audio playback', async () => {
      const queue = ttsQueue.getOrCreateChannelQueue(TEST_CHANNEL);
      queue.currentSpeechUrl = 'http://example.com/audio.mp3';
      queue.currentUserSpeaking = TEST_USER;

      const result = await ttsQueue.stopCurrentSpeech(TEST_CHANNEL);

      expect(result).toBe(true);
      expect(mockWebServer.sendAudioToChannel).toHaveBeenCalledWith(
        TEST_CHANNEL,
        'STOP_CURRENT_AUDIO'
      );
      expect(queue.currentSpeechUrl).toBeNull();
      expect(queue.currentUserSpeaking).toBeNull();
    });

    test('should abort active speech generation', async () => {
      const queue = ttsQueue.getOrCreateChannelQueue(TEST_CHANNEL);
      const mockController = {
        abort: jest.fn()
      };
      queue.currentSpeechController = mockController;
      queue.currentUserSpeaking = TEST_USER;

      const result = await ttsQueue.stopCurrentSpeech(TEST_CHANNEL);

      expect(result).toBe(true);
      expect(mockController.abort).toHaveBeenCalled();
      expect(queue.currentSpeechController).toBeNull();
    });

    test('should send precautionary stop when nothing is playing', async () => {
      const result = await ttsQueue.stopCurrentSpeech(TEST_CHANNEL);

      expect(result).toBe(false);
      expect(mockWebServer.sendAudioToChannel).toHaveBeenCalledWith(
        TEST_CHANNEL,
        'STOP_CURRENT_AUDIO'
      );
    });
  });

  describe('processQueue', () => {
    test('should not process when queue is empty', async () => {
      await ttsQueue.processQueue(TEST_CHANNEL);

      expect(mockTtsService.generateSpeech).not.toHaveBeenCalled();
    });

    test('should not process when paused', async () => {
      const queue = ttsQueue.getOrCreateChannelQueue(TEST_CHANNEL);
      queue.isPaused = true;
      queue.queue.push({
        text: 'Test',
        user: TEST_USER,
        voiceConfig: { voiceId: 'Test_Voice' }
      });

      await ttsQueue.processQueue(TEST_CHANNEL);

      expect(mockTtsService.generateSpeech).not.toHaveBeenCalled();
    });

    test('should not process when already processing', async () => {
      const queue = ttsQueue.getOrCreateChannelQueue(TEST_CHANNEL);
      queue.isProcessing = true;
      queue.queue.push({
        text: 'Test',
        user: TEST_USER,
        voiceConfig: { voiceId: 'Test_Voice' }
      });

      await ttsQueue.processQueue(TEST_CHANNEL);

      expect(mockTtsService.generateSpeech).not.toHaveBeenCalled();
    });

    test('should skip processing when no active WebSocket clients', async () => {
      mockWebServer.hasActiveClients.mockReturnValue(false);

      await ttsQueue.enqueue(TEST_CHANNEL, {
        text: 'Test message',
        user: TEST_USER
      });

      await new Promise(resolve => setTimeout(resolve, 100));

      expect(mockTtsService.generateSpeech).not.toHaveBeenCalled();
    });

    test('should generate speech and send to client', async () => {
      const audioUrl = 'http://example.com/audio.mp3';
      mockTtsService.generateSpeech.mockResolvedValue(audioUrl);

      await ttsQueue.enqueue(TEST_CHANNEL, {
        text: 'Test message',
        user: TEST_USER
      });

      // Wait for async processing
      await new Promise(resolve => setTimeout(resolve, 100));

      expect(mockTtsService.generateSpeech).toHaveBeenCalled();
      expect(mockWebServer.sendAudioToChannel).toHaveBeenCalledWith(
        TEST_CHANNEL,
        audioUrl
      );
    });

    test('should handle speech generation errors gracefully', async () => {
      mockTtsService.generateSpeech.mockRejectedValue(new Error('API Error'));

      await ttsQueue.enqueue(TEST_CHANNEL, {
        text: 'Test message',
        user: TEST_USER
      });

      // Wait for async processing
      await new Promise(resolve => setTimeout(resolve, 100));

      expect(mockLogger.error).toHaveBeenCalled();

      const queue = ttsQueue.getOrCreateChannelQueue(TEST_CHANNEL);
      expect(queue.currentSpeechUrl).toBeNull();
    });

    test('should process multiple items sequentially', async () => {
      const audioUrl1 = 'http://example.com/audio1.mp3';
      const audioUrl2 = 'http://example.com/audio2.mp3';

      mockTtsService.generateSpeech
        .mockResolvedValueOnce(audioUrl1)
        .mockResolvedValueOnce(audioUrl2);

      await ttsQueue.enqueue(TEST_CHANNEL, {
        text: 'First message',
        user: TEST_USER
      });

      await ttsQueue.enqueue(TEST_CHANNEL, {
        text: 'Second message',
        user: TEST_USER
      });

      // Wait for processing
      await new Promise(resolve => setTimeout(resolve, 1500));

      expect(mockTtsService.generateSpeech).toHaveBeenCalledTimes(2);
    });

    test('should send audio to multiple channels in shared session', async () => {
      const audioUrl = 'http://example.com/audio.mp3';
      mockTtsService.generateSpeech.mockResolvedValue(audioUrl);

      const sharedSessionInfo = {
        sessionId: 'test-session',
        channels: ['channel1', 'channel2', 'channel3']
      };

      mockWebServer.hasActiveClients.mockReturnValue(true);

      await ttsQueue.enqueue(TEST_CHANNEL, {
        text: 'Shared message',
        user: TEST_USER
      }, sharedSessionInfo);

      // Wait for processing
      await new Promise(resolve => setTimeout(resolve, 100));

      // Should send to all channels in session
      expect(mockWebServer.sendAudioToChannel).toHaveBeenCalledTimes(3);
      expect(mockWebServer.sendAudioToChannel).toHaveBeenCalledWith('channel1', audioUrl);
      expect(mockWebServer.sendAudioToChannel).toHaveBeenCalledWith('channel2', audioUrl);
      expect(mockWebServer.sendAudioToChannel).toHaveBeenCalledWith('channel3', audioUrl);
    });
  });

  describe('persistAllQueues', () => {
    test('should persist non-empty queues to Firestore', async () => {
      const queue = ttsQueue.getOrCreateChannelQueue(TEST_CHANNEL);
      queue.queue.push({
        text: 'Pending message',
        user: TEST_USER,
        voiceConfig: { voiceId: 'Test_Voice' },
        timestamp: new Date()
      });

      await ttsQueue.persistAllQueues();

      // Check if Firestore doc was created
      const doc = mockDb.collection('ttsQueuePersistence').doc(TEST_CHANNEL);
      const snapshot = await doc.get();

      expect(snapshot.exists).toBe(true);
      const data = snapshot.data();
      expect(data.queueLength).toBe(1);
      expect(data.channelName).toBe(TEST_CHANNEL);
    });

    test('should delete persistence doc for empty queues', async () => {
      const doc = mockDb.collection('ttsQueuePersistence').doc(TEST_CHANNEL);
      await doc.set({ channelName: TEST_CHANNEL, queue: [] });

      // Create empty queue
      ttsQueue.getOrCreateChannelQueue(TEST_CHANNEL);

      await ttsQueue.persistAllQueues();

      const snapshot = await doc.get();
      expect(snapshot.exists).toBe(false);
    });

    test('should serialize Date objects to ISO strings', async () => {
      const queue = ttsQueue.getOrCreateChannelQueue(TEST_CHANNEL);
      const timestamp = new Date('2024-01-01T12:00:00Z');

      queue.queue.push({
        text: 'Test',
        user: TEST_USER,
        voiceConfig: { voiceId: 'Test_Voice' },
        timestamp: timestamp
      });

      await ttsQueue.persistAllQueues();

      const doc = mockDb.collection('ttsQueuePersistence').doc(TEST_CHANNEL);
      const snapshot = await doc.get();
      const data = snapshot.data();

      expect(typeof data.queue[0].timestamp).toBe('string');
      expect(data.queue[0].timestamp).toBe(timestamp.toISOString());
    });
  });

  describe('restoreAllQueues', () => {
    test('should restore queues from Firestore', async () => {
      const doc = mockDb.collection('ttsQueuePersistence').doc(TEST_CHANNEL);
      await doc.set({
        channelName: TEST_CHANNEL,
        queue: [
          {
            text: 'Restored message',
            user: TEST_USER,
            voiceConfig: { voiceId: 'Test_Voice' },
            timestamp: '2024-01-01T12:00:00Z'
          }
        ],
        queueLength: 1,
        isPaused: false
      });

      await ttsQueue.restoreAllQueues();

      const queue = ttsQueue.getOrCreateChannelQueue(TEST_CHANNEL);
      expect(queue.queue).toHaveLength(1);
      expect(queue.queue[0].text).toBe('Restored message');
      expect(queue.queue[0].timestamp).toBeInstanceOf(Date);
    });

    test('should restore paused state', async () => {
      const doc = mockDb.collection('ttsQueuePersistence').doc(TEST_CHANNEL);
      await doc.set({
        channelName: TEST_CHANNEL,
        queue: [{ text: 'Test', user: TEST_USER, voiceConfig: {} }],
        queueLength: 1,
        isPaused: true
      });

      await ttsQueue.restoreAllQueues();

      const queue = ttsQueue.getOrCreateChannelQueue(TEST_CHANNEL);
      expect(queue.isPaused).toBe(true);
    });

    test('should delete persistence docs after restore', async () => {
      const doc = mockDb.collection('ttsQueuePersistence').doc(TEST_CHANNEL);
      await doc.set({
        channelName: TEST_CHANNEL,
        queue: [{ text: 'Test', user: TEST_USER, voiceConfig: {} }],
        queueLength: 1
      });

      await ttsQueue.restoreAllQueues();

      const snapshot = await doc.get();
      expect(snapshot.exists).toBe(false);
    });

    test('should handle empty persistence collection', async () => {
      await expect(ttsQueue.restoreAllQueues()).resolves.not.toThrow();
    });

    test('should skip empty persisted queues', async () => {
      const doc = mockDb.collection('ttsQueuePersistence').doc(TEST_CHANNEL);
      await doc.set({
        channelName: TEST_CHANNEL,
        queue: [],
        queueLength: 0
      });

      await ttsQueue.restoreAllQueues();

      const queue = ttsQueue.getOrCreateChannelQueue(TEST_CHANNEL);
      expect(queue.queue).toHaveLength(0);
    });
  });
});
