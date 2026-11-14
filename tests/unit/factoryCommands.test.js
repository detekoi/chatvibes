import { jest } from '@jest/globals';
import { getTranslator } from '../../src/i18n/index.js';

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
      setTtsState: jest.fn(),
      setChannelDefaultSpeed: jest.fn(),
      setChannelDefaultPitch: jest.fn(),
      resetChannelDefaultPitch: jest.fn(),
      setChannelDefaultEmotion: jest.fn(),
      resetChannelDefaultEmotion: jest.fn(),
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
        replyToId: '123',
        t: getTranslator('en')
      };

      await defaultSpeedCommand.default.execute(context);

      expect(mockTtsState.getTtsState).toHaveBeenCalledWith('testchannel');
      expect(mockChatSender.enqueueMessage).toHaveBeenCalledWith(
        '#testchannel',
        'Current default speed: 1.5. Usage: !tts defaultspeed <number|word|reset>',
        { replyToId: '123' }
      );
    });

    test('should reset default speed with reset alias', async () => {
      mockTtsState.resetChannelDefaultSpeed.mockResolvedValue(true);

      const context = {
        channel: '#testchannel',
        args: ['reset'],
        replyToId: '123',
        t: getTranslator('en')
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
        replyToId: '123',
        t: getTranslator('en')
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
        replyToId: '123',
        t: getTranslator('en')
      };

      await defaultSpeedCommand.default.execute(context);

      expect(mockTtsState.setChannelDefaultSpeed).not.toHaveBeenCalled();
      expect(mockChatSender.enqueueMessage).toHaveBeenCalledWith(
        '#testchannel',
        'Invalid speed. Use a number between 0.5 and 2, or one of these words: very-slow, slow, normal, fast, very-fast.',
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
        replyToId: '123',
        t: getTranslator('en')
      };

      await speedCommand.default.execute(context);

      expect(mockTtsState.getGlobalUserPreferences).toHaveBeenCalledWith('999');
      expect(mockChatSender.enqueueMessage).toHaveBeenCalledWith(
        '#testchannel',
        'Your current speed preference: 1.2. Usage: !tts speed <number|word|reset>',
        { replyToId: '123' }
      );
    });

    test('should reset speed preference with reset alias', async () => {
      mockTtsState.clearGlobalUserPreference.mockResolvedValue(true);

      const context = {
        channel: '#testchannel',
        user: { username: 'testuser', 'user-id': '999' },
        args: ['reset'],
        replyToId: '123',
        t: getTranslator('en')
      };

      await speedCommand.default.execute(context);

      expect(mockTtsState.clearGlobalUserPreference).toHaveBeenCalledWith('999', 'speed');
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
        replyToId: '123',
        t: getTranslator('en')
      };

      await speedCommand.default.execute(context);

      expect(mockTtsState.setGlobalUserPreference).toHaveBeenCalledWith('999', 'speed', 1.8, 'testuser');
      expect(mockChatSender.enqueueMessage).toHaveBeenCalledWith(
        '#testchannel',
        'Your TTS speed preference set to 1.8.',
        { replyToId: '123' }
      );
      expect(mockLogger.info).toHaveBeenCalledWith('[testchannel] User testuser set speed preference to 1.8.');
    });
  });

  // A step word is stored as the number of its step in tts-config.json.
  describe('step words', () => {
    const userContext = args => ({
      channel: '#testchannel',
      user: { username: 'testuser', 'user-id': '999' },
      args,
      replyToId: '123',
      t: getTranslator('en')
    });
    const lastReply = () => mockChatSender.enqueueMessage.mock.calls.at(-1)[1];

    test.each([
      ['very-slow', 0.5],
      ['slow', 0.75],
      ['normal', 1],
      ['FAST', 1.5],
      ['very_fast', 2]
    ])('!tts speed %s stores %p', async (word, value) => {
      mockTtsState.setGlobalUserPreference.mockResolvedValue(true);
      const speed = await import('../../src/components/commands/tts/speed.js');

      await speed.default.execute(userContext([word]));

      expect(mockTtsState.setGlobalUserPreference).toHaveBeenCalledWith('999', 'speed', value, 'testuser');
    });

    test.each([
      ['very-low', -12],
      ['low', -5],
      ['normal', 0],
      ['high', 5],
      ['very-high', 12]
    ])('!tts pitch %s stores %p', async (word, value) => {
      mockTtsState.setGlobalUserPreference.mockResolvedValue(true);
      const pitch = await import('../../src/components/commands/tts/pitch.js');

      await pitch.default.execute(userContext([word]));

      expect(mockTtsState.setGlobalUserPreference).toHaveBeenCalledWith('999', 'pitch', value, 'testuser');
    });

    test('!tts pitch still takes a number', async () => {
      mockTtsState.setGlobalUserPreference.mockResolvedValue(true);
      const pitch = await import('../../src/components/commands/tts/pitch.js');

      await pitch.default.execute(userContext(['-3']));

      expect(mockTtsState.setGlobalUserPreference).toHaveBeenCalledWith('999', 'pitch', -3, 'testuser');
    });

    test('!tts pitch names the words when the value is not usable', async () => {
      const pitch = await import('../../src/components/commands/tts/pitch.js');

      await pitch.default.execute(userContext(['squeaky']));

      expect(mockTtsState.setGlobalUserPreference).not.toHaveBeenCalled();
      expect(lastReply()).toBe('Invalid pitch preference. Use a whole number between -12 and 12, or one of these words: very-low, low, normal, high, very-high.');
    });

    test('the channel commands take the same words', async () => {
      mockTtsState.setChannelDefaultSpeed.mockResolvedValue(true);
      mockTtsState.setChannelDefaultPitch.mockResolvedValue(true);
      const defaultSpeed = await import('../../src/components/commands/tts/defaultSpeed.js');
      const defaultPitch = await import('../../src/components/commands/tts/defaultPitch.js');

      await defaultSpeed.default.execute(userContext(['slow']));
      await defaultPitch.default.execute(userContext(['high']));

      expect(mockTtsState.setChannelDefaultSpeed).toHaveBeenCalledWith('testchannel', 0.75);
      expect(mockTtsState.setChannelDefaultPitch).toHaveBeenCalledWith('testchannel', 5);
    });
  });

  // A custom style replaces the emotion preset, so choosing an emotion removes the style.
  describe('emotion and the custom style', () => {
    const context = args => ({
      channel: '#testchannel',
      user: { username: 'testuser', 'user-id': '999' },
      args,
      replyToId: '123',
      t: getTranslator('en')
    });

    test('!tts emotion clears the viewer\'s style once the emotion is saved', async () => {
      mockTtsState.setGlobalUserPreference.mockResolvedValue(true);
      const emotion = await import('../../src/components/commands/tts/emotion.js');

      await emotion.default.execute(context(['happy']));

      expect(mockTtsState.setGlobalUserPreference).toHaveBeenCalledWith('999', 'emotion', 'happy', 'testuser');
      expect(mockTtsState.clearGlobalUserPreference).toHaveBeenCalledWith('999', 'style');
    });

    test('!tts emotion keeps the style when the emotion was not saved', async () => {
      mockTtsState.setGlobalUserPreference.mockResolvedValue(false);
      const emotion = await import('../../src/components/commands/tts/emotion.js');

      await emotion.default.execute(context(['happy']));

      expect(mockTtsState.clearGlobalUserPreference).not.toHaveBeenCalled();
    });

    test('!tts defaultemotion clears the channel\'s style once the emotion is saved', async () => {
      mockTtsState.setChannelDefaultEmotion.mockResolvedValue(true);
      const defaultEmotion = await import('../../src/components/commands/tts/defaultEmotion.js');

      await defaultEmotion.default.execute(context(['calm']));

      expect(mockTtsState.setChannelDefaultEmotion).toHaveBeenCalledWith('testchannel', 'calm');
      expect(mockTtsState.setTtsState).toHaveBeenCalledWith('testchannel', 'style', '');
    });

    test('!tts defaultemotion keeps the style when the emotion was not saved', async () => {
      mockTtsState.setChannelDefaultEmotion.mockResolvedValue(false);
      const defaultEmotion = await import('../../src/components/commands/tts/defaultEmotion.js');

      await defaultEmotion.default.execute(context(['calm']));

      expect(mockTtsState.setTtsState).not.toHaveBeenCalled();
    });
  });
});
