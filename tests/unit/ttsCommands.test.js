// tests/unit/ttsCommands.test.js
// Unit tests for TTS command handlers

import { jest } from '@jest/globals';

describe('TTS Command Handlers', () => {
  let mockLogger;
  let mockIrcSender;
  let mockTtsQueue;
  let mockTtsState;
  let mockTtsService;
  let mockCommandProcessor;

  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();

    mockLogger = {
      debug: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn()
    };

    mockIrcSender = {
      enqueueMessage: jest.fn()
    };

    mockTtsQueue = {
      getOrCreateChannelQueue: jest.fn(),
      stopCurrentSpeech: jest.fn(),
      clearQueue: jest.fn()
    };

    mockTtsState = {
      setGlobalUserPreference: jest.fn(),
      clearGlobalUserPreference: jest.fn(),
      getGlobalUserPreferences: jest.fn()
    };

    mockTtsService = {
      getAvailableVoices: jest.fn()
    };

    mockCommandProcessor = {
      hasPermission: jest.fn()
    };

    jest.unstable_mockModule('../../src/lib/logger.js', () => ({
      default: mockLogger
    }));

    jest.unstable_mockModule('../../src/lib/ircSender.js', () => mockIrcSender);
    jest.unstable_mockModule('../../src/components/tts/ttsQueue.js', () => mockTtsQueue);
    jest.unstable_mockModule('../../src/components/tts/ttsState.js', () => mockTtsState);
    jest.unstable_mockModule('../../src/components/tts/ttsService.js', () => mockTtsService);
    jest.unstable_mockModule('../../src/components/commands/commandProcessor.js', () => mockCommandProcessor);
  });

  describe('stop command', () => {
    let stopCommand;

    beforeEach(async () => {
      stopCommand = await import('../../src/components/commands/tts/stop.js');
    });

    test('should allow user to stop their own message', async () => {
      const mockQueue = {
        currentSpeechUrl: 'http://audio.url',
        currentSpeechController: {},
        currentUserSpeaking: 'testuser'
      };

      mockTtsQueue.getOrCreateChannelQueue.mockReturnValue(mockQueue);
      mockTtsQueue.stopCurrentSpeech.mockResolvedValue(true);

      const context = {
        channel: '#testchannel',
        user: { username: 'testuser' },
        replyToId: '123'
      };

      await stopCommand.default.execute(context);

      expect(mockTtsQueue.stopCurrentSpeech).toHaveBeenCalledWith('testchannel');
      expect(mockIrcSender.enqueueMessage).toHaveBeenCalledWith(
        '#testchannel',
        expect.stringContaining('STOPPED'),
        { replyToId: '123' }
      );
    });

    test('should allow moderator to stop any message', async () => {
      const mockQueue = {
        currentSpeechUrl: 'http://audio.url',
        currentSpeechController: {},
        currentUserSpeaking: 'otheruser'
      };

      mockTtsQueue.getOrCreateChannelQueue.mockReturnValue(mockQueue);
      mockTtsQueue.stopCurrentSpeech.mockResolvedValue(true);
      mockCommandProcessor.hasPermission.mockReturnValue(true);

      const context = {
        channel: '#testchannel',
        user: { username: 'moderator', mod: true },
        replyToId: '123'
      };

      await stopCommand.default.execute(context);

      expect(mockTtsQueue.stopCurrentSpeech).toHaveBeenCalled();
      expect(mockIrcSender.enqueueMessage).toHaveBeenCalledWith(
        '#testchannel',
        expect.stringContaining('STOPPED'),
        { replyToId: '123' }
      );
    });

    test('should deny non-moderator from stopping other user messages', async () => {
      const mockQueue = {
        currentSpeechUrl: 'http://audio.url',
        currentSpeechController: {},
        currentUserSpeaking: 'otheruser'
      };

      mockTtsQueue.getOrCreateChannelQueue.mockReturnValue(mockQueue);
      mockCommandProcessor.hasPermission.mockReturnValue(false);

      const context = {
        channel: '#testchannel',
        user: { username: 'regularuser' },
        replyToId: '123'
      };

      await stopCommand.default.execute(context);

      expect(mockTtsQueue.stopCurrentSpeech).not.toHaveBeenCalled();
      expect(mockIrcSender.enqueueMessage).toHaveBeenCalledWith(
        '#testchannel',
        expect.stringContaining('only stop your own'),
        { replyToId: '123' }
      );
    });

    test('should handle case insensitive username matching', async () => {
      const mockQueue = {
        currentSpeechUrl: 'http://audio.url',
        currentSpeechController: {},
        currentUserSpeaking: 'TestUser'
      };

      mockTtsQueue.getOrCreateChannelQueue.mockReturnValue(mockQueue);
      mockTtsQueue.stopCurrentSpeech.mockResolvedValue(true);

      const context = {
        channel: '#testchannel',
        user: { username: 'testuser' },
        replyToId: '123'
      };

      await stopCommand.default.execute(context);

      expect(mockTtsQueue.stopCurrentSpeech).toHaveBeenCalled();
    });

    test('should allow moderator precautionary stop when nothing is tracked', async () => {
      const mockQueue = {
        currentSpeechUrl: null,
        currentSpeechController: null,
        currentUserSpeaking: null
      };

      mockTtsQueue.getOrCreateChannelQueue.mockReturnValue(mockQueue);
      mockTtsQueue.stopCurrentSpeech.mockResolvedValue(false);
      mockCommandProcessor.hasPermission.mockReturnValue(true);

      const context = {
        channel: '#testchannel',
        user: { username: 'moderator', mod: true },
        replyToId: '123'
      };

      await stopCommand.default.execute(context);

      expect(mockTtsQueue.stopCurrentSpeech).toHaveBeenCalled();
      expect(mockIrcSender.enqueueMessage).toHaveBeenCalledWith(
        '#testchannel',
        expect.stringContaining('stop signal'),
        { replyToId: '123' }
      );
    });

    test('should inform user when nothing is playing', async () => {
      const mockQueue = {
        currentSpeechUrl: null,
        currentSpeechController: null,
        currentUserSpeaking: null
      };

      mockTtsQueue.getOrCreateChannelQueue.mockReturnValue(mockQueue);
      mockCommandProcessor.hasPermission.mockReturnValue(false);

      const context = {
        channel: '#testchannel',
        user: { username: 'regularuser' },
        replyToId: '123'
      };

      await stopCommand.default.execute(context);

      expect(mockTtsQueue.stopCurrentSpeech).not.toHaveBeenCalled();
      expect(mockIrcSender.enqueueMessage).toHaveBeenCalledWith(
        '#testchannel',
        expect.stringContaining('Nothing appears'),
        { replyToId: '123' }
      );
    });
  });

  describe('clear command', () => {
    let clearCommand;

    beforeEach(async () => {
      clearCommand = await import('../../src/components/commands/tts/clear.js');
    });

    test('should clear the TTS queue', async () => {
      mockTtsQueue.clearQueue.mockResolvedValue(undefined);

      const context = {
        channel: '#testchannel',
        user: { username: 'moderator', mod: true },
        replyToId: '123'
      };

      await clearCommand.default.execute(context);

      expect(mockTtsQueue.clearQueue).toHaveBeenCalledWith('testchannel');
      expect(mockIrcSender.enqueueMessage).toHaveBeenCalledWith(
        '#testchannel',
        expect.stringContaining('CLEARED'),
        { replyToId: '123' }
      );
    });

    test('should log the clear action', async () => {
      mockTtsQueue.clearQueue.mockResolvedValue(undefined);

      const context = {
        channel: '#testchannel',
        user: { username: 'moderator' },
        replyToId: '123'
      };

      await clearCommand.default.execute(context);

      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.stringContaining('queue cleared')
      );
    });

    test('should have moderator permission requirement', () => {
      expect(clearCommand.default.permission).toBe('moderator');
    });
  });

  describe('voice command', () => {
    let voiceCommand;
    let mockSayCommand;

    beforeEach(async () => {
      mockSayCommand = {
        execute: jest.fn()
      };

      jest.unstable_mockModule('../../src/components/commands/tts/say.js', () => ({
        default: mockSayCommand
      }));

      voiceCommand = await import('../../src/components/commands/tts/voice.js');
    });

    test('should display current voice when no args provided', async () => {
      mockTtsState.getGlobalUserPreferences.mockResolvedValue({
        voiceId: 'Friendly_Person'
      });

      const context = {
        channel: '#testchannel',
        user: { username: 'testuser' },
        args: [],
        replyToId: '123'
      };

      await voiceCommand.default.execute(context);

      expect(mockIrcSender.enqueueMessage).toHaveBeenCalledWith(
        '#testchannel',
        expect.stringContaining('Friendly_Person'),
        { replyToId: '123' }
      );
    });

    test('should inform user when no voice preference is set', async () => {
      mockTtsState.getGlobalUserPreferences.mockResolvedValue({});

      const context = {
        channel: '#testchannel',
        user: { username: 'testuser' },
        args: [],
        replyToId: '123'
      };

      await voiceCommand.default.execute(context);

      expect(mockIrcSender.enqueueMessage).toHaveBeenCalledWith(
        '#testchannel',
        expect.stringContaining("haven't set"),
        { replyToId: '123' }
      );
    });

    test('should reset voice preference with "reset" keyword', async () => {
      mockTtsState.clearGlobalUserPreference.mockResolvedValue(true);

      const context = {
        channel: '#testchannel',
        user: { username: 'testuser' },
        args: ['reset'],
        replyToId: '123'
      };

      await voiceCommand.default.execute(context);

      expect(mockTtsState.clearGlobalUserPreference).toHaveBeenCalledWith(
        'testuser',
        'voiceId'
      );
      expect(mockIrcSender.enqueueMessage).toHaveBeenCalledWith(
        '#testchannel',
        expect.stringContaining('reset'),
        { replyToId: '123' }
      );
    });

    test('should reset voice preference with "default" keyword', async () => {
      mockTtsState.clearGlobalUserPreference.mockResolvedValue(true);

      const context = {
        channel: '#testchannel',
        user: { username: 'testuser' },
        args: ['default'],
        replyToId: '123'
      };

      await voiceCommand.default.execute(context);

      expect(mockTtsState.clearGlobalUserPreference).toHaveBeenCalledWith(
        'testuser',
        'voiceId'
      );
    });

    test('should reset voice preference with "auto" keyword', async () => {
      mockTtsState.clearGlobalUserPreference.mockResolvedValue(true);

      const context = {
        channel: '#testchannel',
        user: { username: 'testuser' },
        args: ['auto'],
        replyToId: '123'
      };

      await voiceCommand.default.execute(context);

      expect(mockTtsState.clearGlobalUserPreference).toHaveBeenCalledWith(
        'testuser',
        'voiceId'
      );
    });

    test('should set voice with valid voice ID (case insensitive)', async () => {
      mockTtsService.getAvailableVoices.mockResolvedValue([
        { id: 'Friendly_Person', name: 'Friendly Person' },
        { id: 'Wise_Woman', name: 'Wise Woman' }
      ]);

      mockTtsState.setGlobalUserPreference.mockResolvedValue(true);

      const context = {
        channel: '#testchannel',
        user: { username: 'testuser' },
        args: ['friendly_person'],
        replyToId: '123'
      };

      await voiceCommand.default.execute(context);

      expect(mockTtsState.setGlobalUserPreference).toHaveBeenCalledWith(
        'testuser',
        'voiceId',
        'Friendly_Person'
      );
      expect(mockIrcSender.enqueueMessage).toHaveBeenCalledWith(
        '#testchannel',
        expect.stringContaining('Friendly_Person'),
        { replyToId: '123' }
      );
    });

    test('should handle voice IDs with spaces', async () => {
      mockTtsService.getAvailableVoices.mockResolvedValue([
        { id: 'Voice With Spaces', name: 'Voice With Spaces' }
      ]);

      mockTtsState.setGlobalUserPreference.mockResolvedValue(true);

      const context = {
        channel: '#testchannel',
        user: { username: 'testuser' },
        args: ['Voice', 'With', 'Spaces'],
        replyToId: '123'
      };

      await voiceCommand.default.execute(context);

      expect(mockTtsState.setGlobalUserPreference).toHaveBeenCalledWith(
        'testuser',
        'voiceId',
        'Voice With Spaces'
      );
    });

    test('should fallback to say command for invalid voice', async () => {
      mockTtsService.getAvailableVoices.mockResolvedValue([
        { id: 'Friendly_Person', name: 'Friendly Person' }
      ]);

      const context = {
        channel: '#testchannel',
        user: { username: 'testuser' },
        args: ['this', 'is', 'a', 'message'],
        replyToId: '123'
      };

      await voiceCommand.default.execute(context);

      expect(mockSayCommand.execute).toHaveBeenCalledWith(
        expect.objectContaining({
          command: 'say',
          args: ['voice', 'this', 'is', 'a', 'message']
        })
      );
    });

    test('should handle voice preference set failure', async () => {
      mockTtsService.getAvailableVoices.mockResolvedValue([
        { id: 'Friendly_Person', name: 'Friendly Person' }
      ]);

      mockTtsState.setGlobalUserPreference.mockResolvedValue(false);

      const context = {
        channel: '#testchannel',
        user: { username: 'testuser' },
        args: ['Friendly_Person'],
        replyToId: '123'
      };

      await voiceCommand.default.execute(context);

      expect(mockIrcSender.enqueueMessage).toHaveBeenCalledWith(
        '#testchannel',
        expect.stringContaining('Could not set'),
        { replyToId: '123' }
      );
    });

    test('should handle reset failure', async () => {
      mockTtsState.clearGlobalUserPreference.mockResolvedValue(false);

      const context = {
        channel: '#testchannel',
        user: { username: 'testuser' },
        args: ['reset'],
        replyToId: '123'
      };

      await voiceCommand.default.execute(context);

      expect(mockIrcSender.enqueueMessage).toHaveBeenCalledWith(
        '#testchannel',
        expect.stringContaining('Could not reset'),
        { replyToId: '123' }
      );
    });

    test('should have everyone permission', () => {
      expect(voiceCommand.default.permission).toBe('everyone');
    });
  });
});
