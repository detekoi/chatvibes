// tests/unit/ignoreCommand.test.js
// Unit tests for !tts ignore and !tts ignored.
//
// The ignore list keys on immutable account IDs, so adding an entry has to
// resolve the name a moderator typed into an ID first. These tests pin that
// resolution: Twitch through Helix, YouTube through the recent-chatter window,
// and a clear refusal when the name is neither.

import { jest } from '@jest/globals';

describe('TTS ignore commands', () => {
    let enqueueMessage;
    let ttsStateMock;
    let getUsersByLogin;
    let findRecentYouTubeChatter;
    let isPrivilegedUser;
    let ignore;
    let listIgnored;

    /** Last message the command sent back to chat. */
    const reply = () => enqueueMessage.mock.calls.at(-1)?.[1] ?? '';
    /** Every message the command sent back to chat. */
    const replies = () => enqueueMessage.mock.calls.map(c => c[1]);

    const context = (args, user = { username: 'somemod', 'user-id': '777' }) => ({
        channel: '#testchannel',
        user,
        args,
        replyToId: 'msg-1',
    });

    beforeEach(async () => {
        jest.resetModules();
        enqueueMessage = jest.fn();
        getUsersByLogin = jest.fn().mockResolvedValue([]);
        findRecentYouTubeChatter = jest.fn().mockReturnValue(null);
        isPrivilegedUser = jest.fn().mockReturnValue(true);

        ttsStateMock = {
            getTtsState: jest.fn().mockResolvedValue({ ignoredUserIds: {} }),
            addIgnoredUser: jest.fn().mockResolvedValue(true),
            removeIgnoredUser: jest.fn().mockResolvedValue(true),
        };

        jest.unstable_mockModule('../../src/lib/chatSender.js', () => ({ enqueueMessage }));
        jest.unstable_mockModule('../../src/components/tts/ttsState.js', () => ttsStateMock);
        jest.unstable_mockModule('../../src/components/twitch/helixClient.js', () => ({ getUsersByLogin }));
        jest.unstable_mockModule('../../src/components/youtube/ytChatClient.js', () => ({ findRecentYouTubeChatter }));
        jest.unstable_mockModule('../../src/lib/allowList.js', () => ({
            getChannelIdFromName: jest.fn().mockReturnValue('chan-1'),
        }));
        jest.unstable_mockModule('../../src/lib/permissions.js', () => ({ isPrivilegedUser }));
        jest.unstable_mockModule('../../src/lib/logger.js', () => ({
            default: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
        }));

        ignore = (await import('../../src/components/commands/tts/ignoreUser.js')).default;
        listIgnored = (await import('../../src/components/commands/tts/listIgnored.js')).default;
    });

    describe('!tts ignore <user>', () => {
        it('shows usage with no arguments', async () => {
            await ignore.execute(context([]));
            expect(reply()).toMatch(/ignore/i);
            expect(ttsStateMock.addIgnoredUser).not.toHaveBeenCalled();
        });

        it('stores the resolved Twitch ID, not the name typed', async () => {
            getUsersByLogin.mockResolvedValue([{ id: '52343457', login: 'spammer', display_name: 'Spammer' }]);

            await ignore.execute(context(['spammer']));

            expect(getUsersByLogin).toHaveBeenCalledWith(['spammer']);
            expect(ttsStateMock.addIgnoredUser).toHaveBeenCalledWith(
                'testchannel', 'twitch:52343457', 'Spammer', { source: 'moderator', by: 'twitch:777' });
        });

        it('strips a leading @ before resolving', async () => {
            getUsersByLogin.mockResolvedValue([{ id: '1', login: 'spammer', display_name: 'Spammer' }]);

            await ignore.execute(context(['@Spammer']));

            expect(getUsersByLogin).toHaveBeenCalledWith(['spammer']);
        });

        it('accepts the explicit add form', async () => {
            getUsersByLogin.mockResolvedValue([{ id: '1', login: 'spammer', display_name: 'Spammer' }]);

            await ignore.execute(context(['add', 'spammer']));

            expect(ttsStateMock.addIgnoredUser).toHaveBeenCalledWith(
                'testchannel', 'twitch:1', 'Spammer', { source: 'moderator', by: 'twitch:777' });
        });

        it('joins a multi-word name, since YouTube display names contain spaces', async () => {
            findRecentYouTubeChatter.mockReturnValue({ authorChannelId: 'UCabc', displayName: 'A YouTube Viewer' });

            await ignore.execute(context(['A', 'YouTube', 'Viewer']));

            expect(findRecentYouTubeChatter).toHaveBeenCalledWith('chan-1', 'A YouTube Viewer');
            expect(ttsStateMock.addIgnoredUser).toHaveBeenCalledWith(
                'testchannel', 'youtube:UCabc', 'A YouTube Viewer', { source: 'moderator', by: 'twitch:777' });
        });

        it('joins a multi-word name after an explicit verb too', async () => {
            findRecentYouTubeChatter.mockReturnValue({ authorChannelId: 'UCabc', displayName: 'A YouTube Viewer' });

            await ignore.execute(context(['add', 'A', 'YouTube', 'Viewer']));

            expect(findRecentYouTubeChatter).toHaveBeenCalledWith('chan-1', 'A YouTube Viewer');
        });

        it('treats a viewer named like an Object property as a name, not a verb', async () => {
            getUsersByLogin.mockResolvedValue([{ id: '8', login: 'constructor', display_name: 'constructor' }]);

            await ignore.execute(context(['constructor']));

            expect(getUsersByLogin).toHaveBeenCalledWith(['constructor']);
            expect(ttsStateMock.addIgnoredUser).toHaveBeenCalledWith(
                'testchannel', 'twitch:8', 'constructor', { source: 'moderator', by: 'twitch:777' });
        });

        it('falls back to a recently seen YouTube chatter', async () => {
            getUsersByLogin.mockResolvedValue([]);
            findRecentYouTubeChatter.mockReturnValue({
                authorChannelId: 'UCX6OQ3DkcsbYNE6H8uQQuVA',
                displayName: 'A YouTube Viewer',
            });

            await ignore.execute(context(['a youtube viewer']));

            expect(ttsStateMock.addIgnoredUser).toHaveBeenCalledWith(
                'testchannel', 'youtube:UCX6OQ3DkcsbYNE6H8uQQuVA', 'A YouTube Viewer', { source: 'moderator', by: 'twitch:777' });
        });

        it('prefers Twitch when a name exists on both platforms', async () => {
            getUsersByLogin.mockResolvedValue([{ id: '1', login: 'both', display_name: 'Both' }]);
            findRecentYouTubeChatter.mockReturnValue({ authorChannelId: 'UCabc', displayName: 'Both' });

            await ignore.execute(context(['both']));

            expect(ttsStateMock.addIgnoredUser).toHaveBeenCalledWith(
                'testchannel', 'twitch:1', 'Both', { source: 'moderator', by: 'twitch:777' });
        });

        it('refuses a name that resolves to nothing, rather than storing it', async () => {
            // A stored name that matches no account would sit in the list looking
            // effective forever.
            await ignore.execute(context(['nosuchperson']));

            expect(ttsStateMock.addIgnoredUser).not.toHaveBeenCalled();
            expect(reply()).toMatch(/No Twitch account named "nosuchperson"/);
        });

        it('reports a failed write rather than claiming success', async () => {
            getUsersByLogin.mockResolvedValue([{ id: '1', login: 'spammer', display_name: 'Spammer' }]);
            ttsStateMock.addIgnoredUser.mockResolvedValue(false);

            await ignore.execute(context(['spammer']));

            expect(reply()).toMatch(/Could not add/);
        });

        it('survives a Helix outage without throwing', async () => {
            getUsersByLogin.mockRejectedValue(new Error('helix down'));

            await ignore.execute(context(['spammer']));

            expect(reply()).toMatch(/Could not update the ignore list/);
        });
    });

    describe('self-ignore', () => {
        it('uses the invoker own ID without calling Helix', async () => {
            const self = { username: 'viewer', 'user-id': '4242', 'display-name': 'Viewer' };

            await ignore.execute(context(['viewer'], self));

            expect(getUsersByLogin).not.toHaveBeenCalled();
            expect(ttsStateMock.addIgnoredUser).toHaveBeenCalledWith(
                'testchannel', 'twitch:4242', 'Viewer', { source: 'self', by: 'twitch:4242' });
            expect(reply()).toMatch(/You will now be ignored/);
        });

        it('lets a non-mod ignore only themselves', async () => {
            isPrivilegedUser.mockReturnValue(false);
            const viewer = { username: 'viewer', 'user-id': '4242' };

            await ignore.execute(context(['someoneelse'], viewer));

            expect(ttsStateMock.addIgnoredUser).not.toHaveBeenCalled();
            expect(reply()).toMatch(/only add yourself/i);
        });
    });

    describe('!tts ignore del <user>', () => {
        it('is refused for non-mods', async () => {
            isPrivilegedUser.mockReturnValue(false);

            await ignore.execute(context(['del', 'spammer'], { username: 'viewer', 'user-id': '1' }));

            expect(ttsStateMock.removeIgnoredUser).not.toHaveBeenCalled();
            expect(reply()).toMatch(/Only moderators/);
        });

        it('removes by the label shown in the list, even after a rename', async () => {
            // The stored label goes stale when someone renames. Resolving the typed
            // name afresh would return their new ID and miss the entry entirely.
            ttsStateMock.getTtsState.mockResolvedValue({
                ignoredUserIds: { 'twitch:52343457': 'OldName' },
            });

            await ignore.execute(context(['del', 'oldname']));

            expect(ttsStateMock.removeIgnoredUser).toHaveBeenCalledWith('testchannel', 'twitch:52343457');
            expect(getUsersByLogin).not.toHaveBeenCalled();
        });

        it('falls back to resolving when no label matches', async () => {
            getUsersByLogin.mockResolvedValue([{ id: '99', login: 'spammer', display_name: 'Spammer' }]);

            await ignore.execute(context(['del', 'spammer']));

            expect(ttsStateMock.removeIgnoredUser).toHaveBeenCalledWith('testchannel', 'twitch:99');
        });

        it('reports a name that is on neither the list nor Twitch', async () => {
            await ignore.execute(context(['del', 'ghost']));

            expect(ttsStateMock.removeIgnoredUser).not.toHaveBeenCalled();
            expect(reply()).toMatch(/was not on the ignore list/);
        });

        it('lets a moderator remove any entry whatever its source', async () => {
            ttsStateMock.getTtsState.mockResolvedValue({
                ignoredUserIds: { 'twitch:52343457': { label: 'OptedOut', source: 'self', by: 'twitch:52343457' } },
            });

            await ignore.execute(context(['del', 'optedout']));

            expect(ttsStateMock.removeIgnoredUser).toHaveBeenCalledWith('testchannel', 'twitch:52343457');
        });

        it('does not claim to have removed a moderator who was never listed', async () => {
            // removeIgnoredUser swallows NOT_FOUND and returns true, so deleting a
            // key that is not there looks identical to a real removal. Only the
            // membership check upstream can tell the difference.
            ttsStateMock.getTtsState.mockResolvedValue({ ignoredUserIds: {} });

            await ignore.execute(context(['del']));

            expect(ttsStateMock.removeIgnoredUser).not.toHaveBeenCalled();
            expect(reply()).toMatch(/not on the TTS ignore list/i);
        });

        it('lets a moderator lift their own entry with the bare form', async () => {
            ttsStateMock.getTtsState.mockResolvedValue({
                ignoredUserIds: { 'twitch:777': { label: 'SomeMod', source: 'self', by: 'twitch:777' } },
            });

            await ignore.execute(context(['del']));

            expect(ttsStateMock.removeIgnoredUser).toHaveBeenCalledWith('testchannel', 'twitch:777');
            expect(reply()).toMatch(/no longer be ignored/i);
        });

        it('matches a moderator naming themselves by key, not by label', async () => {
            // Their own stale label must not be able to hide their entry from them.
            ttsStateMock.getTtsState.mockResolvedValue({
                ignoredUserIds: { 'twitch:777': { label: 'TheirOldName', source: 'moderator', by: 'twitch:1' } },
            });

            await ignore.execute(context(['del', 'somemod']));

            expect(ttsStateMock.removeIgnoredUser).toHaveBeenCalledWith('testchannel', 'twitch:777');
            expect(getUsersByLogin).not.toHaveBeenCalled();
        });

        it('accepts the remove and rem aliases', async () => {
            ttsStateMock.getTtsState.mockResolvedValue({ ignoredUserIds: { 'twitch:5': 'Spammer' } });

            await ignore.execute(context(['remove', 'spammer']));
            expect(ttsStateMock.removeIgnoredUser).toHaveBeenCalledWith('testchannel', 'twitch:5');

            ttsStateMock.removeIgnoredUser.mockClear();
            await ignore.execute(context(['rem', 'spammer']));
            expect(ttsStateMock.removeIgnoredUser).toHaveBeenCalledWith('testchannel', 'twitch:5');
        });
    });

    describe('self-undo', () => {
        // The opt-out used to be a one-way door: a viewer could put themselves on
        // the list but only a moderator could take them off. These pin the way back
        // out, and pin that it does not double as a way out of a moderator's mute.
        const viewer = { username: 'viewer', 'user-id': '4242', 'display-name': 'Viewer' };
        const selfEntry = { label: 'Viewer', source: 'self', by: 'twitch:4242' };

        beforeEach(() => {
            isPrivilegedUser.mockReturnValue(false);
        });

        it('a bare del removes the viewer own self-imposed entry', async () => {
            ttsStateMock.getTtsState.mockResolvedValue({ ignoredUserIds: { 'twitch:4242': selfEntry } });

            await ignore.execute(context(['del'], viewer));

            expect(ttsStateMock.removeIgnoredUser).toHaveBeenCalledWith('testchannel', 'twitch:4242');
            expect(reply()).toMatch(/no longer be ignored/i);
        });

        it('naming yourself works the same as the bare form', async () => {
            ttsStateMock.getTtsState.mockResolvedValue({ ignoredUserIds: { 'twitch:4242': selfEntry } });

            await ignore.execute(context(['del', 'viewer'], viewer));

            expect(ttsStateMock.removeIgnoredUser).toHaveBeenCalledWith('testchannel', 'twitch:4242');
        });

        it('matches the viewer own entry by ID, so a rename cannot hide it', async () => {
            // Removal for everyone else goes by the stored label, which goes stale.
            // The invoker ID is on the message, so their own entry never can.
            ttsStateMock.getTtsState.mockResolvedValue({
                ignoredUserIds: { 'twitch:4242': { label: 'TheirOldName', source: 'self', by: 'twitch:4242' } },
            });

            await ignore.execute(context(['del'], viewer));

            expect(ttsStateMock.removeIgnoredUser).toHaveBeenCalledWith('testchannel', 'twitch:4242');
            expect(getUsersByLogin).not.toHaveBeenCalled();
        });

        it('refuses to lift a moderator-imposed entry', async () => {
            ttsStateMock.getTtsState.mockResolvedValue({
                ignoredUserIds: { 'twitch:4242': { label: 'Viewer', source: 'moderator', by: 'twitch:99' } },
            });

            await ignore.execute(context(['del'], viewer));

            expect(ttsStateMock.removeIgnoredUser).not.toHaveBeenCalled();
            expect(reply()).toMatch(/moderator/i);
        });

        it('refuses to lift a legacy entry, whose provenance is unknown', async () => {
            // A bare string predates provenance. Reading it as self-imposed would
            // unlock every mute placed before this change.
            ttsStateMock.getTtsState.mockResolvedValue({ ignoredUserIds: { 'twitch:4242': 'Viewer' } });

            await ignore.execute(context(['del'], viewer));

            expect(ttsStateMock.removeIgnoredUser).not.toHaveBeenCalled();
            expect(reply()).toMatch(/moderator/i);
        });

        it('says so when the viewer is not on the list at all', async () => {
            ttsStateMock.getTtsState.mockResolvedValue({ ignoredUserIds: {} });

            await ignore.execute(context(['del'], viewer));

            expect(ttsStateMock.removeIgnoredUser).not.toHaveBeenCalled();
            expect(reply()).toMatch(/not on the TTS ignore list/i);
        });

        it('still refuses to remove anyone else', async () => {
            await ignore.execute(context(['del', 'someoneelse'], viewer));

            expect(ttsStateMock.removeIgnoredUser).not.toHaveBeenCalled();
            expect(reply()).toMatch(/Only moderators/);
        });

        it('re-adding self over a moderator entry does not downgrade it', async () => {
            // Otherwise the refusal above is one !tts ignore away from irrelevant.
            ttsStateMock.getTtsState.mockResolvedValue({
                ignoredUserIds: { 'twitch:4242': { label: 'Viewer', source: 'moderator', by: 'twitch:99' } },
            });

            await ignore.execute(context(['viewer'], viewer));

            expect(ttsStateMock.addIgnoredUser).not.toHaveBeenCalled();
            expect(reply()).toMatch(/moderator/i);
        });

        it('a bare ignore with no verb still shows usage rather than muting', async () => {
            // Guessing "me" here would mute someone who typed the command to read
            // its help, in the one direction that is awkward to undo.
            await ignore.execute(context([], viewer));

            expect(ttsStateMock.addIgnoredUser).not.toHaveBeenCalled();
            expect(reply()).toMatch(/ignore del/);
        });
    });

    describe('!tts ignored', () => {
        it('says so when the list is empty', async () => {
            await listIgnored.execute(context([]));
            expect(reply()).toMatch(/No users are currently/);
        });

        it('prints the display labels, not the account IDs', async () => {
            ttsStateMock.getTtsState.mockResolvedValue({
                ignoredUserIds: { 'twitch:52343457': 'Spammer', 'twitch:1': 'Troll' },
            });

            await listIgnored.execute(context([]));

            expect(reply()).toBe('Ignored users: Spammer, Troll');
            expect(reply()).not.toMatch(/twitch:/);
        });

        it('marks YouTube entries, since a name can exist on both platforms', async () => {
            ttsStateMock.getTtsState.mockResolvedValue({
                ignoredUserIds: { 'youtube:UCabc': 'Viewer' },
            });

            await listIgnored.execute(context([]));

            expect(reply()).toBe('Ignored users: Viewer (YouTube)');
        });

        it('paginates past 15 entries', async () => {
            const entries = {};
            for (let i = 0; i < 16; i++) entries[`twitch:${i}`] = `user${String(i).padStart(2, '0')}`;
            ttsStateMock.getTtsState.mockResolvedValue({ ignoredUserIds: entries });

            await listIgnored.execute(context([]));

            expect(replies()).toHaveLength(2);
            expect(replies()[0]).toMatch(/^Ignored users: /);
            expect(replies()[1]).toMatch(/^More ignored: user15$/);
        });
    });
});
