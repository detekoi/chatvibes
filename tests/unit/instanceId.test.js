// tests/unit/instanceId.test.js

import { jest } from '@jest/globals';

describe('instanceId', () => {
    afterEach(() => {
        jest.resetModules();
        delete process.env.K_REVISION;
    });

    test('keeps the revision as a prefix so a log line still names the deploy', async () => {
        process.env.K_REVISION = 'chatvibes-tts-service-00348-pnc';
        const { INSTANCE_ID, REVISION } = await import('../../src/lib/instanceId.js');

        expect(REVISION).toBe('chatvibes-tts-service-00348-pnc');
        expect(INSTANCE_ID.startsWith('chatvibes-tts-service-00348-pnc-')).toBe(true);
    });

    test('is stable for the lifetime of the process', async () => {
        const first = await import('../../src/lib/instanceId.js');
        const second = await import('../../src/lib/instanceId.js');

        expect(first.INSTANCE_ID).toBe(second.INSTANCE_ID);
    });

    test('differs between processes of the same revision', async () => {
        // The whole reason this module exists. K_REVISION is identical across every
        // container of a deploy, so telemetry that asks "did this channel show up under
        // more than one instance?" always answered no — the exact opposite of what the
        // cross-instance audio-loss check needs.
        process.env.K_REVISION = 'same-revision';
        const { INSTANCE_ID: a, REVISION: revA } = await import('../../src/lib/instanceId.js');

        jest.resetModules(); // simulate a second container booting the same revision
        const { INSTANCE_ID: b, REVISION: revB } = await import('../../src/lib/instanceId.js');

        expect(revA).toBe(revB);
        expect(a).not.toBe(b);
    });

    test('falls back to local outside Cloud Run', async () => {
        delete process.env.K_REVISION;
        const { INSTANCE_ID, REVISION } = await import('../../src/lib/instanceId.js');

        expect(REVISION).toBe('local');
        expect(INSTANCE_ID.startsWith('local-')).toBe(true);
    });
});
