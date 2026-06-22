// tests/unit/lib/permissions.test.js
// Unit tests for mapPermissionLevel and hasPermissionLevel

import { jest } from '@jest/globals';

describe('permissions module', () => {
  let permissions;
  let mockLogger;

  beforeEach(async () => {
    jest.resetModules();

    mockLogger = {
      debug: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn()
    };

    jest.unstable_mockModule('../../../src/lib/logger.js', () => ({
      default: mockLogger
    }));

    permissions = await import('../../../src/lib/permissions.js');
  });

  describe('mapPermissionLevel', () => {
    test('should map "mods" to "moderator"', () => {
      expect(permissions.mapPermissionLevel('mods')).toBe('moderator');
    });

    test('should map "subs" to "subscriber"', () => {
      expect(permissions.mapPermissionLevel('subs')).toBe('subscriber');
    });

    test('should map "vip" to "vip"', () => {
      expect(permissions.mapPermissionLevel('vip')).toBe('vip');
    });

    test('should map "everyone" to "everyone"', () => {
      expect(permissions.mapPermissionLevel('everyone')).toBe('everyone');
    });

    test('should return "everyone" for null/undefined/empty', () => {
      expect(permissions.mapPermissionLevel(null)).toBe('everyone');
      expect(permissions.mapPermissionLevel(undefined)).toBe('everyone');
      expect(permissions.mapPermissionLevel('')).toBe('everyone');
    });

    test('should return null for unrecognized values (fail closed)', () => {
      expect(permissions.mapPermissionLevel('moderator')).toBeNull();
      expect(permissions.mapPermissionLevel('subscriber')).toBeNull();
      expect(permissions.mapPermissionLevel('founder')).toBeNull();
      expect(permissions.mapPermissionLevel('MODS')).toBeNull();
    });

    test('should log a warning for unrecognized values', () => {
      permissions.mapPermissionLevel('moderator');
      expect(mockLogger.warn).toHaveBeenCalledWith(
        { ttsPermissionLevel: 'moderator' },
        'Unrecognized ttsPermissionLevel — denying access'
      );
    });

    test('should not log for valid values', () => {
      permissions.mapPermissionLevel('mods');
      permissions.mapPermissionLevel('subs');
      permissions.mapPermissionLevel('vip');
      permissions.mapPermissionLevel('everyone');
      permissions.mapPermissionLevel(null);
      expect(mockLogger.warn).not.toHaveBeenCalled();
    });
  });

  describe('hasPermissionLevel', () => {
    test('should allow everyone when permission is "everyone"', () => {
      const tags = { username: 'user' };
      expect(permissions.hasPermissionLevel('everyone', tags, 'channel')).toBe(true);
    });

    test('should allow everyone when permission is null/undefined', () => {
      const tags = { username: 'user' };
      expect(permissions.hasPermissionLevel(null, tags, 'channel')).toBe(true);
      expect(permissions.hasPermissionLevel(undefined, tags, 'channel')).toBe(true);
    });

    test('should deny unrecognized permission levels', () => {
      const tags = { username: 'user' };
      expect(permissions.hasPermissionLevel('unknown', tags, 'channel')).toBe(false);
    });

    test('should allow moderator for mod users', () => {
      const tags = { username: 'moduser', mod: true };
      expect(permissions.hasPermissionLevel('moderator', tags, 'channel')).toBe(true);
    });

    test('should allow moderator for broadcaster', () => {
      const tags = { username: 'channel', badges: { broadcaster: '1' } };
      expect(permissions.hasPermissionLevel('moderator', tags, 'channel')).toBe(true);
    });

    test('should deny moderator for regular users', () => {
      const tags = { username: 'user' };
      expect(permissions.hasPermissionLevel('moderator', tags, 'channel')).toBe(false);
    });

    test('should allow subscriber for sub users', () => {
      const tags = { username: 'subuser', subscriber: true };
      expect(permissions.hasPermissionLevel('subscriber', tags, 'channel')).toBe(true);
    });

    test('should allow subscriber for VIP users (hierarchy)', () => {
      const tags = { username: 'vipuser', vip: true };
      expect(permissions.hasPermissionLevel('subscriber', tags, 'channel')).toBe(true);
    });

    test('should allow vip for VIP users', () => {
      const tags = { username: 'vipuser', vip: true };
      expect(permissions.hasPermissionLevel('vip', tags, 'channel')).toBe(true);
    });

    test('should deny vip for subscriber-only users', () => {
      const tags = { username: 'subuser', subscriber: true };
      expect(permissions.hasPermissionLevel('vip', tags, 'channel')).toBe(false);
    });
  });
});
