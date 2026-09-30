// tests/unit/allowListListener.test.js
// Every instance keeps its allow-list current, not only the leader. A non-leader
// used to keep the list it loaded at startup, so a channel switched on later was
// "inactive" there (webhooks dropped, browser source refused) and one switched
// off kept speaking.

import { jest } from '@jest/globals';
import { createFakeFirestore, flush } from '../helpers/fakeFirestore.js';

const db = createFakeFirestore();

jest.unstable_mockModule('../../src/lib/logger.js', () => ({
    default: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn(), fatal: jest.fn() },
}));
jest.unstable_mockModule('@google-cloud/firestore', () => ({ Firestore: jest.fn(() => db) }));

const channelManager = await import('../../src/components/twitch/channelManager.js');
const allowList = await import('../../src/lib/allowList.js');

test('a non-leader instance sees channels switched on, switched off and removed after startup', async () => {
    db._seed('managedChannels/111', { channelName: 'parfaitfair', twitchUserId: '111', isActive: true });
    await channelManager.initializeChannelManager();
    await channelManager.getActiveManagedChannels();
    const unsubscribe = channelManager.listenForAllowListChanges();
    await flush();
    expect(allowList.isChannelActive('111')).toBe(true);

    db._seed('managedChannels/222', { channelName: 'newchan', twitchUserId: '222', isActive: true });
    await flush();
    expect(allowList.isChannelActive('222')).toBe(true);
    expect(allowList.getChannelNameFromId('222')).toBe('newchan');
    expect(allowList.isChannelAllowed('newchan')).toBe(true);

    db._seed('managedChannels/111', { channelName: 'parfaitfair', twitchUserId: '111', isActive: false });
    await flush();
    expect(allowList.isChannelActive('111')).toBe(false);
    expect(allowList.isChannelAllowed('111')).toBe(true);

    await db.collection('managedChannels').doc('222').delete();
    await flush();
    expect(allowList.isChannelAllowed('222')).toBe(false);

    unsubscribe();
});
