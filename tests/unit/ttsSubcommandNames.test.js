// tests/unit/ttsSubcommandNames.test.js
// subcommandNames.js is a hand-maintained copy of the keys of the dispatch map
// in handlers/tts.js, kept separate so the YouTube client can consult it
// without importing the command tree. This is what keeps the two in step.

import { jest } from '@jest/globals';

// handlers/tts.js → commandProcessor.js → handlers/index.js → handlers/tts.js
// is a cycle the app only ever enters from commandProcessor; entering it from
// the handler side hits the TDZ, so that one edge is stubbed here.
jest.unstable_mockModule('../../src/components/commands/commandProcessor.js', () => ({ hasPermission: jest.fn() }));

const { ttsSubCommands } = await import('../../src/components/commands/handlers/tts.js');
const { TTS_SUBCOMMAND_NAMES, isTtsSubCommand } = await import('../../src/components/commands/tts/subcommandNames.js');

describe('TTS_SUBCOMMAND_NAMES', () => {
    it('matches the keys of the !tts dispatch map exactly', () => {
        expect([...TTS_SUBCOMMAND_NAMES].sort()).toEqual(Object.keys(ttsSubCommands).sort());
    });

    it('is case-insensitive and tolerates a missing name', () => {
        expect(isTtsSubCommand('STATUS')).toBe(true);
        expect(isTtsSubCommand('hello')).toBe(false);
        expect(isTtsSubCommand(undefined)).toBe(false);
    });
});
