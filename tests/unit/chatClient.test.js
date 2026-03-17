// tests/unit/chatClient.test.js
import { jest } from '@jest/globals';

// Mock dependencies
const mockAxios = {
    post: jest.fn(),
    get: jest.fn(),
    interceptors: {
        request: { use: jest.fn() },
        response: { use: jest.fn() }
    }
};

// Mock helixClient to return our mockAxios
jest.unstable_mockModule('../../src/components/twitch/helixClient.js', () => ({
    helixClient: mockAxios,
    getUsersByLogin: jest.fn(),
    getBroadcasterIdByLogin: jest.fn(),
}));

// Mock logger
const mockLogger = {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
};
jest.unstable_mockModule('../../src/lib/logger.js', () => ({
    default: mockLogger,
}));

// Mock config
jest.unstable_mockModule('../../src/config/index.js', () => ({
    default: {
        twitch: {
            username: 'botuser',
            accessToken: 'oauth:test-token'
        }
    }
}));

// Mock auth
jest.unstable_mockModule('../../src/components/twitch/tokenManager.js', () => ({
    getClientId: jest.fn(() => Promise.resolve('test-client-id'))
}));

// Mock axios directly for API calls
jest.unstable_mockModule('axios', () => ({
    default: {
        post: jest.fn(),
        get: jest.fn()
    }
}));

// Import the module under test
const { sendMessage, getBotUserId, _resetCache } = await import('../../src/components/twitch/chatClient.js');
const { getUsersByLogin, getBroadcasterIdByLogin } = await import('../../src/components/twitch/helixClient.js');
const axios = await import('axios');

describe('chatClient.js', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        _resetCache();
    });

    describe('getBotUserId', () => {
        it('should fetch bot user ID from Helix if not cached', async () => {
            getUsersByLogin.mockResolvedValue([{ id: '12345', login: 'botuser' }]);

            const userId = await getBotUserId();

            expect(userId).toBe('12345');
            expect(getUsersByLogin).toHaveBeenCalledTimes(1);
        });

        it('should return cached ID on subsequent calls', async () => {
            getUsersByLogin.mockResolvedValue([{ id: '12345', login: 'botuser' }]);

            await getBotUserId(); // First call
            const userId = await getBotUserId(); // Second call

            expect(userId).toBe('12345');
            expect(getUsersByLogin).toHaveBeenCalledTimes(1); // Should still be 1
        });

        it('should return null if user not found', async () => {
            getUsersByLogin.mockResolvedValue([]);

            const userId = await getBotUserId();

            expect(userId).toBeNull();
        });
    });

    describe('sendMessage', () => {
        it('should send a message successfully', async () => {
            // Mock broadcaster ID lookup (now via getBroadcasterIdByLogin)
            getBroadcasterIdByLogin.mockResolvedValueOnce('broadcaster-id-2');

            // Mock bot ID lookup (inside getBotUserId via getUsersByLogin)
            getUsersByLogin.mockResolvedValueOnce([{ id: 'bot-id-1', login: 'botuser' }]);

            // Mock successful API response
            axios.default.post.mockResolvedValue({
                status: 200,
                data: {
                    data: [{
                        is_sent: true
                    }]
                }
            });

            const success = await sendMessage('targetchannel', 'Hello World');

            expect(success).toBe(true);
            expect(axios.default.post).toHaveBeenCalledWith(
                'https://api.twitch.tv/helix/chat/messages',
                {
                    broadcaster_id: 'broadcaster-id-2',
                    sender_id: 'bot-id-1',
                    message: 'Hello World'
                },
                {
                    headers: {
                        'Authorization': 'Bearer test-token',
                        'Client-Id': 'test-client-id',
                        'Content-Type': 'application/json'
                    }
                }
            );
        });

        it('should fail if bot ID cannot be retrieved', async () => {
            // Broadcaster lookup succeeds
            getBroadcasterIdByLogin.mockResolvedValueOnce('broadcaster-id-2');
            // Bot ID lookup fails
            getUsersByLogin.mockResolvedValueOnce([]);

            const success = await sendMessage('targetchannel', 'Hello');

            expect(success).toBe(false);
            expect(axios.default.post).not.toHaveBeenCalled();
        });

        it('should fail if broadcaster ID cannot be retrieved', async () => {
            // Broadcaster lookup returns null
            getBroadcasterIdByLogin.mockResolvedValueOnce(null);

            const success = await sendMessage('targetchannel', 'Hello');

            expect(success).toBe(false);
            expect(axios.default.post).not.toHaveBeenCalled();
        });

        it('should handle API errors gracefully', async () => {
            // Mock broadcaster ID lookup
            getBroadcasterIdByLogin.mockResolvedValueOnce('broadcaster-id-2');
            // Mock bot ID lookup
            getUsersByLogin.mockResolvedValueOnce([{ id: 'bot-id-1', login: 'botuser' }]);

            axios.default.post.mockRejectedValue(new Error('API Error'));

            const success = await sendMessage('targetchannel', 'Hello');

            expect(success).toBe(false);
            expect(mockLogger.error).toHaveBeenCalled();
        });
    });
});
