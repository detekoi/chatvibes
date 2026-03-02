// tests/unit/lib/allowList.test.js
import { jest } from '@jest/globals';

// Mock the config module
const mockConfig = {
    security: {
        allowedBroadcasterIds: [],
    },
    secrets: {
        allowedChannelsSecretName: null,
    },
};

jest.unstable_mockModule('../../../src/config/index.js', () => ({
    default: mockConfig,
}));

jest.unstable_mockModule('../../../src/lib/secretManager.js', () => ({
    getSecretValue: jest.fn(),
}));

// Import after mocking
const {
    isChannelAllowed,
    getAllowedBroadcasterIds,
    setChannelIdMapping,
    initializeAllowList,
} = await import('../../../src/lib/allowList.js');

const { getSecretValue } = await import('../../../src/lib/secretManager.js');

describe('allowList', () => {
    beforeEach(() => {
        // Reset config before each test
        mockConfig.security.allowedBroadcasterIds = [];
        mockConfig.secrets.allowedChannelsSecretName = null;
        delete process.env.ALLOWED_CHANNELS_SECRET_NAME;
    });

    describe('isChannelAllowed', () => {
        it('returns true when no allow-list is configured (empty array)', () => {
            mockConfig.security.allowedBroadcasterIds = [];
            expect(isChannelAllowed('anything')).toBe(true);
        });

        it('returns false for null/undefined/empty identifier', () => {
            expect(isChannelAllowed(null)).toBe(false);
            expect(isChannelAllowed(undefined)).toBe(false);
            expect(isChannelAllowed('')).toBe(false);
        });

        it('returns true when a broadcaster ID is in the allow-list', () => {
            mockConfig.security.allowedBroadcasterIds = ['12345', '67890'];
            expect(isChannelAllowed('12345')).toBe(true);
            expect(isChannelAllowed('67890')).toBe(true);
        });

        it('returns false when a broadcaster ID is NOT in the allow-list', () => {
            mockConfig.security.allowedBroadcasterIds = ['12345', '67890'];
            expect(isChannelAllowed('99999')).toBe(false);
        });

        it('resolves a channel login name to broadcaster ID via mapping cache', () => {
            mockConfig.security.allowedBroadcasterIds = ['12345'];
            setChannelIdMapping('somechannel', '12345');
            expect(isChannelAllowed('somechannel')).toBe(true);
        });

        it('is case-insensitive for channel login name lookups', () => {
            mockConfig.security.allowedBroadcasterIds = ['12345'];
            setChannelIdMapping('somechannel', '12345');
            expect(isChannelAllowed('SomeChannel')).toBe(true);
        });

        it('returns false for an unmapped channel name when allow-list is active', () => {
            mockConfig.security.allowedBroadcasterIds = ['12345'];
            expect(isChannelAllowed('unknownchannel')).toBe(false);
        });
    });

    describe('getAllowedBroadcasterIds', () => {
        it('returns the configured list of broadcaster IDs', () => {
            mockConfig.security.allowedBroadcasterIds = ['111', '222'];
            expect(getAllowedBroadcasterIds()).toEqual(['111', '222']);
        });

        it('returns an empty array when not configured', () => {
            mockConfig.security.allowedBroadcasterIds = undefined;
            expect(getAllowedBroadcasterIds()).toEqual([]);
        });
    });

    describe('setChannelIdMapping', () => {
        it('maps a channel name to a broadcaster ID', () => {
            mockConfig.security.allowedBroadcasterIds = ['42'];
            setChannelIdMapping('testchannel', '42');
            expect(isChannelAllowed('testchannel')).toBe(true);
        });

        it('ignores null/empty inputs gracefully', () => {
            // Should not throw
            setChannelIdMapping(null, '42');
            setChannelIdMapping('test', null);
            setChannelIdMapping(null, null);
        });

        it('converts userId to string', () => {
            mockConfig.security.allowedBroadcasterIds = ['42'];
            setChannelIdMapping('numchannel', 42); // number, not string
            expect(isChannelAllowed('numchannel')).toBe(true);
        });
    });

    describe('initializeAllowList', () => {
        it('loads broadcaster IDs from secret', async () => {
            process.env.ALLOWED_CHANNELS_SECRET_NAME = 'test-secret';
            getSecretValue.mockResolvedValue('111,222,333');

            await initializeAllowList();

            expect(mockConfig.security.allowedBroadcasterIds).toEqual(['111', '222', '333']);
        });

        it('trims whitespace from secret values', async () => {
            process.env.ALLOWED_CHANNELS_SECRET_NAME = 'test-secret';
            getSecretValue.mockResolvedValue(' 111 , 222 , 333 ');

            await initializeAllowList();

            expect(mockConfig.security.allowedBroadcasterIds).toEqual(['111', '222', '333']);
        });

        it('does nothing if no secret is configured', async () => {
            mockConfig.security.allowedBroadcasterIds = ['existing'];
            await initializeAllowList();
            expect(mockConfig.security.allowedBroadcasterIds).toEqual(['existing']);
        });

        it('does nothing if secret returns empty/null', async () => {
            process.env.ALLOWED_CHANNELS_SECRET_NAME = 'test-secret';
            getSecretValue.mockResolvedValue(null);
            mockConfig.security.allowedBroadcasterIds = ['existing'];

            await initializeAllowList();

            expect(mockConfig.security.allowedBroadcasterIds).toEqual(['existing']);
        });
    });
});
