// tests/unit/commandProcessor.test.js
// Unit tests for command processing and permission checks

import { jest } from '@jest/globals';

describe('commandProcessor module', () => {
  let commandProcessor;
  let mockLogger;
  let mockChatSender;

  beforeEach(async () => {
    jest.resetModules();

    // Mock logger
    mockLogger = {
      debug: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn()
    };

    // Mock chat sender
    mockChatSender = {
      enqueueMessage: jest.fn().mockResolvedValue(undefined)
    };

    jest.unstable_mockModule('../../src/lib/logger.js', () => ({
      default: mockLogger
    }));

    jest.unstable_mockModule('../../src/lib/chatSender.js', () => mockChatSender);

    // Mock command handlers - will be customized per test
    jest.unstable_mockModule('../../src/components/commands/handlers/index.js', () => ({
      default: {}
    }));

    commandProcessor = await import('../../src/components/commands/commandProcessor.js');
  });

  describe('hasPermission', () => {
    describe('everyone permission level', () => {
      test('should allow any user when permission is "everyone"', () => {
        const tags = { username: 'regularuser' };
        const result = commandProcessor.hasPermission('everyone', tags, 'somechannel');
        expect(result).toBe(true);
      });

      test('should allow user when permission is undefined (defaults to everyone)', () => {
        const tags = { username: 'regularuser' };
        const result = commandProcessor.hasPermission(undefined, tags, 'somechannel');
        expect(result).toBe(true);
      });

      test('should allow user when permission is null (defaults to everyone)', () => {
        const tags = { username: 'regularuser' };
        const result = commandProcessor.hasPermission(null, tags, 'somechannel');
        expect(result).toBe(true);
      });
    });

    describe('broadcaster permission level', () => {
      test('should allow broadcaster via badge', () => {
        const tags = {
          username: 'someguy',
          badges: { broadcaster: '1' }
        };
        const result = commandProcessor.hasPermission('broadcaster', tags, 'channelname');
        expect(result).toBe(true);
      });

      test('should allow broadcaster via username match', () => {
        const tags = {
          username: 'channelowner',
          badges: {}
        };
        const result = commandProcessor.hasPermission('broadcaster', tags, 'channelowner');
        expect(result).toBe(true);
      });

      test('should allow broadcaster with case-insensitive username match', () => {
        const tags = {
          username: 'ChannelOwner',
          badges: {}
        };
        const result = commandProcessor.hasPermission('broadcaster', tags, 'channelowner');
        expect(result).toBe(true);
      });

      test('should deny moderator when permission requires broadcaster', () => {
        const tags = {
          username: 'moderatoruser',
          mod: true,
          badges: { moderator: '1' }
        };
        const result = commandProcessor.hasPermission('broadcaster', tags, 'channelowner');
        expect(result).toBe(false);
      });

      test('should deny regular user when permission requires broadcaster', () => {
        const tags = {
          username: 'regularuser',
          badges: {}
        };
        const result = commandProcessor.hasPermission('broadcaster', tags, 'channelowner');
        expect(result).toBe(false);
      });
    });

    describe('moderator permission level', () => {
      test('should allow moderator via mod tag (boolean true)', () => {
        const tags = {
          username: 'moderatoruser',
          mod: true
        };
        const result = commandProcessor.hasPermission('moderator', tags, 'somechannel');
        expect(result).toBe(true);
      });

      test('should allow moderator via mod tag (string "1")', () => {
        const tags = {
          username: 'moderatoruser',
          mod: '1'
        };
        const result = commandProcessor.hasPermission('moderator', tags, 'somechannel');
        expect(result).toBe(true);
      });

      test('should allow moderator via badges', () => {
        const tags = {
          username: 'moderatoruser',
          badges: { moderator: '1' }
        };
        const result = commandProcessor.hasPermission('moderator', tags, 'somechannel');
        expect(result).toBe(true);
      });

      test('should allow broadcaster when moderator permission is required', () => {
        const tags = {
          username: 'channelowner',
          badges: { broadcaster: '1' }
        };
        const result = commandProcessor.hasPermission('moderator', tags, 'channelowner');
        expect(result).toBe(true);
      });

      test('should deny regular user when moderator permission is required', () => {
        const tags = {
          username: 'regularuser',
          badges: {}
        };
        const result = commandProcessor.hasPermission('moderator', tags, 'somechannel');
        expect(result).toBe(false);
      });

      test('should handle missing badges object', () => {
        const tags = {
          username: 'regularuser'
        };
        const result = commandProcessor.hasPermission('moderator', tags, 'somechannel');
        expect(result).toBe(false);
      });
    });

    describe('edge cases', () => {
      test('should handle missing username in tags', () => {
        const tags = {
          badges: {}
        };
        const result = commandProcessor.hasPermission('moderator', tags, 'somechannel');
        expect(result).toBe(false);
      });

      test('should handle empty tags object', () => {
        const tags = {};
        const result = commandProcessor.hasPermission('moderator', tags, 'somechannel');
        expect(result).toBe(false);
      });

      test('should handle unknown permission level', () => {
        const tags = {
          username: 'regularuser',
          badges: {}
        };
        const result = commandProcessor.hasPermission('unknownlevel', tags, 'somechannel');
        expect(result).toBe(false);
      });

      test('should handle case sensitivity in channel name', () => {
        const tags = {
          username: 'ChannelOwner',
          badges: {}
        };
        const result = commandProcessor.hasPermission('broadcaster', tags, 'CHANNELOWNER');
        expect(result).toBe(true);
      });
    });

    describe('security edge cases', () => {
      test('should not allow privilege escalation through mod:0', () => {
        const tags = {
          username: 'regularuser',
          mod: '0',
          badges: {}
        };
        const result = commandProcessor.hasPermission('moderator', tags, 'somechannel');
        expect(result).toBe(false);
      });

      test('should not allow privilege escalation through false mod value', () => {
        const tags = {
          username: 'regularuser',
          mod: false,
          badges: {}
        };
        const result = commandProcessor.hasPermission('moderator', tags, 'somechannel');
        expect(result).toBe(false);
      });

      test('should not allow privilege escalation through moderator badge with wrong value', () => {
        const tags = {
          username: 'regularuser',
          badges: { moderator: '0' }
        };
        const result = commandProcessor.hasPermission('moderator', tags, 'somechannel');
        expect(result).toBe(false);
      });

      test('should not allow privilege escalation through broadcaster badge with wrong value', () => {
        const tags = {
          username: 'regularuser',
          badges: { broadcaster: '0' }
        };
        const result = commandProcessor.hasPermission('broadcaster', tags, 'somechannel');
        expect(result).toBe(false);
      });
    });
  });

  describe('parseCommand (via processMessage)', () => {
    beforeEach(async () => {
      // Reset modules for each test to get fresh parseCommand behavior
      jest.resetModules();

      jest.unstable_mockModule('../../src/lib/logger.js', () => ({
        default: mockLogger
      }));

      jest.unstable_mockModule('../../src/lib/chatSender.js', () => mockChatSender);

      jest.unstable_mockModule('../../src/components/commands/handlers/index.js', () => ({
        default: {}
      }));

      commandProcessor = await import('../../src/components/commands/commandProcessor.js');
    });

    test('should return null for message without command prefix', async () => {
      const result = await commandProcessor.processMessage('channel', { username: 'user' }, 'just a message');
      expect(result).toBeNull();
    });

    test('should return null for message with only command prefix', async () => {
      const result = await commandProcessor.processMessage('channel', { username: 'user' }, '!');
      expect(result).toBeNull();
    });

    test('should return null for message with prefix and only spaces', async () => {
      const result = await commandProcessor.processMessage('channel', { username: 'user' }, '!   ');
      expect(result).toBeNull();
    });

    test('should parse command name and convert to lowercase', async () => {
      // Since we're testing parseCommand indirectly, we need to set up a mock handler
      jest.resetModules();

      const mockHandler = {
        execute: jest.fn().mockResolvedValue(undefined),
        permission: 'everyone'
      };

      jest.unstable_mockModule('../../src/lib/logger.js', () => ({
        default: mockLogger
      }));

      jest.unstable_mockModule('../../src/lib/chatSender.js', () => mockChatSender);

      jest.unstable_mockModule('../../src/components/commands/handlers/index.js', () => ({
        default: {
          'test': mockHandler
        }
      }));

      commandProcessor = await import('../../src/components/commands/commandProcessor.js');

      await commandProcessor.processMessage('channel', { username: 'user' }, '!TEST');

      expect(mockHandler.execute).toHaveBeenCalled();
    });

    test('should parse command with arguments', async () => {
      const mockHandler = {
        execute: jest.fn().mockResolvedValue(undefined),
        permission: 'everyone'
      };

      jest.resetModules();

      jest.unstable_mockModule('../../src/lib/logger.js', () => ({
        default: mockLogger
      }));

      jest.unstable_mockModule('../../src/lib/chatSender.js', () => mockChatSender);

      jest.unstable_mockModule('../../src/components/commands/handlers/index.js', () => ({
        default: {
          'test': mockHandler
        }
      }));

      commandProcessor = await import('../../src/components/commands/commandProcessor.js');

      await commandProcessor.processMessage('channel', { username: 'user' }, '!test arg1 arg2 arg3');

      expect(mockHandler.execute).toHaveBeenCalledWith(
        expect.objectContaining({
          args: ['arg1', 'arg2', 'arg3']
        })
      );
    });

    test('should handle multiple spaces between arguments', async () => {
      const mockHandler = {
        execute: jest.fn().mockResolvedValue(undefined),
        permission: 'everyone'
      };

      jest.resetModules();

      jest.unstable_mockModule('../../src/lib/logger.js', () => ({
        default: mockLogger
      }));

      jest.unstable_mockModule('../../src/lib/chatSender.js', () => mockChatSender);

      jest.unstable_mockModule('../../src/components/commands/handlers/index.js', () => ({
        default: {
          'test': mockHandler
        }
      }));

      commandProcessor = await import('../../src/components/commands/commandProcessor.js');

      await commandProcessor.processMessage('channel', { username: 'user' }, '!test   arg1    arg2');

      expect(mockHandler.execute).toHaveBeenCalledWith(
        expect.objectContaining({
          args: ['arg1', 'arg2']
        })
      );
    });

    test('should return null for unregistered command', async () => {
      const result = await commandProcessor.processMessage(
        'channel',
        { username: 'user' },
        '!unknowncommand'
      );

      expect(result).toBeNull();
    });

    test('should not execute command when user lacks permission', async () => {
      const mockHandler = {
        execute: jest.fn().mockResolvedValue(undefined),
        permission: 'moderator'
      };

      jest.resetModules();

      jest.unstable_mockModule('../../src/lib/logger.js', () => ({
        default: mockLogger
      }));

      jest.unstable_mockModule('../../src/lib/chatSender.js', () => mockChatSender);

      jest.unstable_mockModule('../../src/components/commands/handlers/index.js', () => ({
        default: {
          'modonly': mockHandler
        }
      }));

      commandProcessor = await import('../../src/components/commands/commandProcessor.js');

      const result = await commandProcessor.processMessage(
        'channel',
        { username: 'regularuser', badges: {} },
        '!modonly test'
      );

      expect(mockHandler.execute).not.toHaveBeenCalled();
      expect(result).toBeNull();
    });

    test('should execute command when user has permission', async () => {
      const mockHandler = {
        execute: jest.fn().mockResolvedValue(undefined),
        permission: 'moderator'
      };

      jest.resetModules();

      jest.unstable_mockModule('../../src/lib/logger.js', () => ({
        default: mockLogger
      }));

      jest.unstable_mockModule('../../src/lib/chatSender.js', () => mockChatSender);

      jest.unstable_mockModule('../../src/components/commands/handlers/index.js', () => ({
        default: {
          'modonly': mockHandler
        }
      }));

      commandProcessor = await import('../../src/components/commands/commandProcessor.js');

      const result = await commandProcessor.processMessage(
        'channel',
        { username: 'moduser', mod: true },
        '!modonly test'
      );

      expect(mockHandler.execute).toHaveBeenCalled();
      expect(result).toBe('modonly');
    });

    test('should handle command execution error gracefully', async () => {
      const mockHandler = {
        execute: jest.fn().mockRejectedValue(new Error('Test error')),
        permission: 'everyone'
      };

      jest.resetModules();

      jest.unstable_mockModule('../../src/lib/logger.js', () => ({
        default: mockLogger
      }));

      jest.unstable_mockModule('../../src/lib/chatSender.js', () => mockChatSender);

      jest.unstable_mockModule('../../src/components/tts/ttsState.js', () => ({
        getTtsState: jest.fn(() => Promise.resolve({
          botRespondsInChat: true // Enable chat responses so error message can be sent
        }))
      }));

      jest.unstable_mockModule('../../src/components/commands/handlers/index.js', () => ({
        default: {
          'error': mockHandler
        }
      }));

      commandProcessor = await import('../../src/components/commands/commandProcessor.js');

      const result = await commandProcessor.processMessage(
        'channel',
        { username: 'user', id: '123' },
        '!error'
      );

      expect(mockLogger.error).toHaveBeenCalled();
      expect(mockChatSender.enqueueMessage).toHaveBeenCalledWith(
        '#channel',
        'Oops! Something went wrong trying to run !error.'
      );
      expect(result).toBe('error');
    });

    test('should pass context with correct properties to handler', async () => {
      const mockHandler = {
        execute: jest.fn().mockResolvedValue(undefined),
        permission: 'everyone'
      };

      jest.resetModules();

      jest.unstable_mockModule('../../src/lib/logger.js', () => ({
        default: mockLogger
      }));

      jest.unstable_mockModule('../../src/lib/chatSender.js', () => mockChatSender);

      jest.unstable_mockModule('../../src/components/commands/handlers/index.js', () => ({
        default: {
          'test': mockHandler
        }
      }));

      commandProcessor = await import('../../src/components/commands/commandProcessor.js');

      const tags = { username: 'testuser', id: 'msg123' };
      await commandProcessor.processMessage('testchannel', tags, '!test arg1 arg2');

      expect(mockHandler.execute).toHaveBeenCalledWith(
        expect.objectContaining({
          channel: '#testchannel',
          user: tags,
          args: ['arg1', 'arg2'],
          message: '!test arg1 arg2',
          command: 'test',
          replyToId: 'msg123',
          logger: mockLogger
        })
      );
    });
  });

  describe('bot responses in chat setting', () => {
    test('should execute command when botRespondsInChat is false (commands still work)', async () => {
      const mockHandler = {
        execute: jest.fn().mockResolvedValue(undefined),
        permission: 'everyone'
      };

      jest.resetModules();

      jest.unstable_mockModule('../../src/lib/logger.js', () => ({
        default: mockLogger
      }));

      jest.unstable_mockModule('../../src/lib/chatSender.js', () => mockChatSender);

      jest.unstable_mockModule('../../src/components/tts/ttsState.js', () => ({
        getTtsState: jest.fn(() => Promise.resolve({
          botRespondsInChat: false // Bot doesn't respond in chat, but commands still execute
        }))
      }));

      jest.unstable_mockModule('../../src/components/commands/handlers/index.js', () => ({
        default: {
          'tts': mockHandler
        }
      }));

      commandProcessor = await import('../../src/components/commands/commandProcessor.js');

      const result = await commandProcessor.processMessage(
        'testchannel',
        { username: 'user', id: 'msg123' },
        '!tts test'
      );

      expect(mockHandler.execute).toHaveBeenCalled();
      expect(result).toBe('tts');
    });

    test('should execute command when botRespondsInChat is true', async () => {
      const mockHandler = {
        execute: jest.fn().mockResolvedValue(undefined),
        permission: 'everyone'
      };

      jest.resetModules();

      jest.unstable_mockModule('../../src/lib/logger.js', () => ({
        default: mockLogger
      }));

      jest.unstable_mockModule('../../src/lib/chatSender.js', () => mockChatSender);

      jest.unstable_mockModule('../../src/components/tts/ttsState.js', () => ({
        getTtsState: jest.fn(() => Promise.resolve({
          botRespondsInChat: true // Bot responds in chat
        }))
      }));

      jest.unstable_mockModule('../../src/components/commands/handlers/index.js', () => ({
        default: {
          'tts': mockHandler
        }
      }));

      commandProcessor = await import('../../src/components/commands/commandProcessor.js');

      const result = await commandProcessor.processMessage(
        'testchannel',
        { username: 'user', id: 'msg123' },
        '!tts test'
      );

      expect(mockHandler.execute).toHaveBeenCalled();
      expect(result).toBe('tts');
    });

    test('should still execute command if getTtsState fails (defaults to no chat responses)', async () => {
      const mockHandler = {
        execute: jest.fn().mockResolvedValue(undefined),
        permission: 'everyone'
      };

      jest.resetModules();

      jest.unstable_mockModule('../../src/lib/logger.js', () => ({
        default: mockLogger
      }));

      jest.unstable_mockModule('../../src/lib/chatSender.js', () => mockChatSender);

      jest.unstable_mockModule('../../src/components/tts/ttsState.js', () => ({
        getTtsState: jest.fn(() => Promise.reject(new Error('Firestore error')))
      }));

      jest.unstable_mockModule('../../src/components/commands/handlers/index.js', () => ({
        default: {
          'tts': mockHandler
        }
      }));

      commandProcessor = await import('../../src/components/commands/commandProcessor.js');

      const result = await commandProcessor.processMessage(
        'testchannel',
        { username: 'user', id: 'msg123' },
        '!tts test'
      );

      // Should still execute command, but defaults to canReply=false
      expect(mockHandler.execute).toHaveBeenCalled();
      expect(result).toBe('tts');
      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.objectContaining({
          err: expect.any(Error),
          channel: 'testchannel'
        }),
        expect.stringContaining('Error fetching channel settings')
      );
    });

    test('should pass canReply=false to context when botRespondsInChat is false', async () => {
      const mockHandler = {
        execute: jest.fn().mockResolvedValue(undefined),
        permission: 'everyone'
      };

      jest.resetModules();

      jest.unstable_mockModule('../../src/lib/logger.js', () => ({
        default: mockLogger
      }));

      jest.unstable_mockModule('../../src/lib/chatSender.js', () => mockChatSender);

      jest.unstable_mockModule('../../src/components/tts/ttsState.js', () => ({
        getTtsState: jest.fn(() => Promise.resolve({
          botRespondsInChat: false
        }))
      }));

      jest.unstable_mockModule('../../src/components/commands/handlers/index.js', () => ({
        default: {
          'tts': mockHandler
        }
      }));

      commandProcessor = await import('../../src/components/commands/commandProcessor.js');

      const result = await commandProcessor.processMessage(
        'testchannel',
        { username: 'user', id: 'msg123' },
        '!tts test'
      );

      expect(mockHandler.execute).toHaveBeenCalled();
      expect(mockHandler.execute).toHaveBeenCalledWith(
        expect.objectContaining({
          canReply: false
        })
      );
      expect(result).toBe('tts');
    });
  });
});
