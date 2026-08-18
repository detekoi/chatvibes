// tests/unit/eventSubPagination.test.js
// Twitch caps /eventsub/subscriptions at 100 per page. A single un-paginated GET
// truncates silently once the app passes that, which is worse than an outright
// failure: deleteChannelEventSubSubscriptions would delete only the subset it saw
// and report success, leaving live subscriptions firing.

import { jest } from '@jest/globals';

const mockHelixClient = jest.fn();
jest.unstable_mockModule('../../src/components/twitch/helixClient.js', () => ({
    getHelixClient: () => mockHelixClient,
    getUsersByLogin: jest.fn(),
}));

const mockLogger = {
    info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
};
jest.unstable_mockModule('../../src/lib/logger.js', () => ({ default: mockLogger }));

jest.unstable_mockModule('../../src/config/index.js', () => ({
    default: { twitch: { publicUrl: 'https://example.test', eventSubSecret: 'secret' } },
}));

jest.unstable_mockModule('@google-cloud/firestore', () => ({
    Firestore: class { collection() { return { doc: () => ({}) }; } },
    FieldPath: class {},
}));

const { getEventSubSubscriptions } = await import('../../src/components/twitch/twitchSubs.js');

/** Build a page of fake subscriptions. */
const page = (ids, cursor) => ({
    data: {
        data: ids.map(id => ({ id: `sub-${id}`, type: 'channel.chat.message', transport: { callback: 'https://example.test/twitch/event' } })),
        total: 250,
        pagination: cursor ? { cursor } : {},
    },
});

beforeEach(() => {
    mockHelixClient.mockReset();
    mockLogger.warn.mockReset();
});

describe('getEventSubSubscriptions pagination', () => {
    test('returns a single page unchanged when there is no cursor', async () => {
        mockHelixClient.mockResolvedValueOnce(page([1, 2, 3]));

        const result = await getEventSubSubscriptions();

        expect(result.success).toBe(true);
        expect(result.data.data).toHaveLength(3);
        expect(mockHelixClient).toHaveBeenCalledTimes(1);
    });

    test('follows the cursor and concatenates every page', async () => {
        mockHelixClient
            .mockResolvedValueOnce(page([1, 2], 'c1'))
            .mockResolvedValueOnce(page([3, 4], 'c2'))
            .mockResolvedValueOnce(page([5]));

        const result = await getEventSubSubscriptions();

        expect(mockHelixClient).toHaveBeenCalledTimes(3);
        expect(result.data.data.map(s => s.id)).toEqual(['sub-1', 'sub-2', 'sub-3', 'sub-4', 'sub-5']);
        // The collapsed result must not advertise a cursor of its own.
        expect(result.data.pagination).toEqual({});
    });

    test('sends the cursor in the URL, since a GET body would be dropped', async () => {
        mockHelixClient
            .mockResolvedValueOnce(page([1], 'cursor with spaces/&'))
            .mockResolvedValueOnce(page([2]));

        await getEventSubSubscriptions();

        const secondCallUrl = mockHelixClient.mock.calls[1][0].url;
        expect(secondCallUrl).toContain('after=');
        expect(secondCallUrl).toContain(encodeURIComponent('cursor with spaces/&'));
        expect(mockHelixClient.mock.calls[1][0].data).toBeFalsy();
    });

    test('stops instead of looping forever when a cursor repeats', async () => {
        mockHelixClient.mockResolvedValue(page([1], 'stuck'));

        const result = await getEventSubSubscriptions();

        expect(result.success).toBe(true);
        expect(mockHelixClient.mock.calls.length).toBeLessThan(5);
        expect(mockLogger.warn).toHaveBeenCalled();
    });

    test('propagates a failure rather than returning a partial list', async () => {
        // A partial list read as complete is what drives wrong deletes.
        mockHelixClient
            .mockResolvedValueOnce(page([1, 2], 'c1'))
            .mockRejectedValueOnce(Object.assign(new Error('boom'), { response: { status: 500 } }));

        const result = await getEventSubSubscriptions();

        expect(result.success).toBe(false);
        expect(result.data).toBeUndefined();
    });
});
