import { jest } from '@jest/globals';

describe('Factory-based TTS Command Handlers', () => {
  let mockLogger;
  let mockChatSender;
  let mockTtsState;

  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();

    mockLogger = {
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn()
    };

    mockChatSender = {
      enqueueMessage: jest.fn()
    };

    mockTtsState = {
      getTtsState: jest.fn(),
      setChannelDefaultSpeed: jest.fn(),
      resetChannelDefaultSpeed: jest.fn(),
      getGlobalUserPreferences: jest.fn(),
      setGlobalUserPreference: jest.fn(),
      clearGlobalUserPreference: jest.fn()
    };

    jest.unstable_mockModule('../../src/lib/logger.js', () => ({
      default: mockLogger
    }));

    jest.unstable_mockModule('../../src/lib/chatSender.js', () => mockChatSender);
    jest.unstable_mockModule('../../src/components/tts/ttsState.js', () => mockTtsState);
  });

  describe('defaultSpeed command', () => {
    let defaultSpeedCommand;

    beforeEach(async () => {
      defaultSpeedCommand = await import('../../src/components/commands/tts/defaultSpeed.js');
    });

    test('should show current default speed when no args provided', async () => {
      mockTtsState.getTtsState.mockResolvedValue({ speed: 1.5 });

      const context = {
        channel: '#testchannel',
        args: [],
        replyToId: '123'
      };

      await defaultSpeedCommand.default.execute(context);

      expect(mockTtsState.getTtsState).toHaveBeenCalledWith('testchannel');
      expect(mockChatSender.enqueueMessage).toHaveBeenCalledWith(
        '#testchannel',
        'Current default speed: 1.5. Usage: !tts defaultspeed <value|reset>',
        { replyToId: '123' }
      );
    });

    test('should reset default speed with reset alias', async () => {
      mockTtsState.resetChannelDefaultSpeed.mockResolvedValue(true);

      const context = {
        channel: '#testchannel',
        args: ['reset'],
        replyToId: '123'
      };

      await defaultSpeedCommand.default.execute(context);

      expect(mockTtsState.resetChannelDefaultSpeed).toHaveBeenCalledWith('testchannel');
      expect(mockChatSender.enqueueMessage).toHaveBeenCalledWith(
        '#testchannel',
        'Channel default TTS speed reset to 1.',
        { replyToId: '123' }
      );
      expect(mockLogger.info).toHaveBeenCalledWith('[testchannel] Channel default speed reset to 1.');
    });

    test('should set default speed with valid number', async () => {
      mockTtsState.setChannelDefaultSpeed.mockResolvedValue(true);

      const context = {
        channel: '#testchannel',
        args: ['2.0'],
        replyToId: '123'
      };

      await defaultSpeedCommand.default.execute(context);

      expect(mockTtsState.setChannelDefaultSpeed).toHaveBeenCalledWith('testchannel', 2.0);
      expect(mockChatSender.enqueueMessage).toHaveBeenCalledWith(
        '#testchannel',
        'Channel default TTS speed set to 2.',
        { replyToId: '123' }
      );
      expect(mockLogger.info).toHaveBeenCalledWith('[testchannel] Channel default speed set to 2.');
    });

    test('should reject invalid speed value', async () => {
      const context = {
        channel: '#testchannel',
        args: ['invalid'],
        replyToId: '123'
      };

      await defaultSpeedCommand.default.execute(context);

      expect(mockTtsState.setChannelDefaultSpeed).not.toHaveBeenCalled();
      expect(mockChatSender.enqueueMessage).toHaveBeenCalledWith(
        '#testchannel',
        'Invalid speed. Must be a number between 0.5 and 2.',
        { replyToId: '123' }
      );
    });
  });

  describe('speed preference command', () => {
    let speedCommand;

    beforeEach(async () => {
      speedCommand = await import('../../src/components/commands/tts/speed.js');
    });

    test('should show current speed preference when no args provided', async () => {
      mockTtsState.getGlobalUserPreferences.mockResolvedValue({ speed: 1.2 });

      const context = {
        channel: '#testchannel',
        user: { username: 'testuser', 'user-id': '999' },
        args: [],
        replyToId: '123'
      };

      await speedCommand.default.execute(context);

      expect(mockTtsState.getGlobalUserPreferences).toHaveBeenCalledWith('testuser', '999');
      expect(mockChatSender.enqueueMessage).toHaveBeenCalledWith(
        '#testchannel',
        'Your current speed preference: 1.2. Usage: !tts speed <value|reset>',
        { replyToId: '123' }
      );
    });

    test('should reset speed preference with reset alias', async () => {
      mockTtsState.clearGlobalUserPreference.mockResolvedValue(true);

      const context = {
        channel: '#testchannel',
        user: { username: 'testuser', 'user-id': '999' },
        args: ['reset'],
        replyToId: '123'
      };

      await speedCommand.default.execute(context);

      expect(mockTtsState.clearGlobalUserPreference).toHaveBeenCalledWith('testuser', 'speed', '999');
      expect(mockChatSender.enqueueMessage).toHaveBeenCalledWith(
        '#testchannel',
        'Your TTS speed preference has been reset to the channel default.',
        { replyToId: '123' }
      );
      expect(mockLogger.info).toHaveBeenCalledWith('[testchannel] User testuser reset speed preference.');
    });

    test('should set speed preference with valid number', async () => {
      mockTtsState.setGlobalUserPreference.mockResolvedValue(true);

      const context = {
        channel: '#testchannel',
        user: { username: 'testuser', 'user-id': '999' },
        args: ['1.8'],
        replyToId: '123'
      };

      await speedCommand.default.execute(context);

      expect(mockTtsState.setGlobalUserPreference).toHaveBeenCalledWith('testuser', 'speed', 1.8, '999');
      expect(mockChatSender.enqueueMessage).toHaveBeenCalledWith(
        '#testchannel',
        'Your TTS speed preference set to 1.8.',
        { replyToId: '123' }
      );
      expect(mockLogger.info).toHaveBeenCalledWith('[testchannel] User testuser set speed preference to 1.8.');
    });
  });
});
