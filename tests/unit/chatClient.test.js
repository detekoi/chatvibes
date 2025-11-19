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
            username: 'botuser'
        }
    }
}));

// Import the module under test
const { sendMessage, getBotUserId, _resetCache } = await import('../../src/components/twitch/chatClient.js');
const { getUsersByLogin } = await import('../../src/components/twitch/helixClient.js');

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
            // Mock broadcaster ID lookup (it calls getUsersByLogin again for the channel)
            // FIRST call is for channel (broadcaster)
            getUsersByLogin.mockResolvedValueOnce([{ id: 'broadcaster-id-2', login: 'targetchannel' }])
                // SECOND call is for bot ID (inside getBotUserId)
                .mockResolvedValueOnce([{ id: 'bot-id-1', login: 'botuser' }]);

            mockAxios.post.mockResolvedValue({ status: 200 });

            const success = await sendMessage('targetchannel', 'Hello World');

            expect(success).toBe(true);
            expect(mockAxios.post).toHaveBeenCalledWith('/chat/messages', {
                broadcaster_id: 'broadcaster-id-2',
                sender_id: 'bot-id-1',
                message: 'Hello World'
            });
        });

        it('should fail if bot ID cannot be retrieved', async () => {
            getUsersByLogin.mockResolvedValue([]); // No bot user found

            const success = await sendMessage('targetchannel', 'Hello');

            expect(success).toBe(false);
            expect(mockAxios.post).not.toHaveBeenCalled();
        });

        it('should fail if broadcaster ID cannot be retrieved', async () => {
            getUsersByLogin.mockResolvedValueOnce([{ id: 'bot-id-1', login: 'botuser' }])
                .mockResolvedValueOnce([]); // No broadcaster found

            const success = await sendMessage('targetchannel', 'Hello');

            expect(success).toBe(false);
            expect(mockAxios.post).not.toHaveBeenCalled();
        });

        it('should handle API errors gracefully', async () => {
            getUsersByLogin.mockResolvedValueOnce([{ id: 'bot-id-1', login: 'botuser' }])
                .mockResolvedValueOnce([{ id: 'broadcaster-id-2', login: 'targetchannel' }]);

            mockAxios.post.mockRejectedValue(new Error('API Error'));

            const success = await sendMessage('targetchannel', 'Hello');

            expect(success).toBe(false);
            expect(mockLogger.error).toHaveBeenCalled();
        });
    });
});
