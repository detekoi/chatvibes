// tests/unit/chatSender.test.js
import { jest } from '@jest/globals';

// Mock dependencies
const mockChatClient = {
    sendMessage: jest.fn(),
};
jest.unstable_mockModule('../../src/components/twitch/chatClient.js', () => mockChatClient);

const mockLogger = {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
};
jest.unstable_mockModule('../../src/lib/logger.js', () => ({
    default: mockLogger,
}));

// Mock timeUtils to avoid waiting real time
const mockTimeUtils = {
    sleep: jest.fn().mockResolvedValue(),
};
jest.unstable_mockModule('../../src/lib/timeUtils.js', () => mockTimeUtils);

// Import module under test
const { enqueueMessage, clearMessageQueue, initializeChatSender } = await import('../../src/lib/chatSender.js');

describe('chatSender.js', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        clearMessageQueue();
    });

    it('should queue and send a message', async () => {
        mockChatClient.sendMessage.mockResolvedValue(true);

        await enqueueMessage('#testchannel', 'Hello World');

        // Since processing is async and we mocked sleep, we might need to wait a tick
        await new Promise(resolve => setTimeout(resolve, 10));

        expect(mockChatClient.sendMessage).toHaveBeenCalledWith('#testchannel', 'Hello World');
    });

    it('should truncate long messages', async () => {
        mockChatClient.sendMessage.mockResolvedValue(true);
        const longMessage = 'a'.repeat(600);

        await enqueueMessage('#testchannel', longMessage);
        await new Promise(resolve => setTimeout(resolve, 10));

        const expectedMessage = 'a'.repeat(497) + '...';
        expect(mockChatClient.sendMessage).toHaveBeenCalledWith('#testchannel', expectedMessage);
    });

    it('should handle send failures gracefully', async () => {
        mockChatClient.sendMessage.mockResolvedValue(false);

        await enqueueMessage('#testchannel', 'Fail me');
        await new Promise(resolve => setTimeout(resolve, 10));

        expect(mockChatClient.sendMessage).toHaveBeenCalled();
        expect(mockLogger.warn).toHaveBeenCalled(); // Should warn on failure
    });

    it('should process multiple messages in order', async () => {
        mockChatClient.sendMessage.mockResolvedValue(true);

        await enqueueMessage('#testchannel', 'Msg 1');
        await enqueueMessage('#testchannel', 'Msg 2');

        await new Promise(resolve => setTimeout(resolve, 10));

        expect(mockChatClient.sendMessage).toHaveBeenCalledTimes(2);
        expect(mockChatClient.sendMessage).toHaveBeenNthCalledWith(1, '#testchannel', 'Msg 1');
        expect(mockChatClient.sendMessage).toHaveBeenNthCalledWith(2, '#testchannel', 'Msg 2');
    });
});
