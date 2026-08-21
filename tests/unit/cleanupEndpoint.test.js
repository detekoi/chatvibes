// tests/unit/cleanupEndpoint.test.js
import { jest } from '@jest/globals';

const AUDIENCE = 'https://chatvibes-tts-service-906125386407.us-central1.run.app';
const INVOKER_SA = 'chatvibestts@appspot.gserviceaccount.com';

const mockClient = {
    listSecrets: jest.fn(),
    listSecretVersions: jest.fn(),
    disableSecretVersion: jest.fn(),
};
const mockVerifyIdToken = jest.fn();
const mockLogger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };

jest.unstable_mockModule('@google-cloud/secret-manager', () => ({
    SecretManagerServiceClient: jest.fn(() => mockClient),
}));
jest.unstable_mockModule('google-auth-library', () => ({
    OAuth2Client: jest.fn(() => ({ verifyIdToken: mockVerifyIdToken })),
}));
jest.unstable_mockModule('../../src/lib/logger.js', () => ({ default: mockLogger }));
jest.unstable_mockModule('../../src/lib/authUtils.js', () => ({
    extractBearerToken: jest.fn((header) => (header || '').replace(/^Bearer /, '') || null),
}));

/**
 * The audience and invoker are read into module-level consts at import time, so
 * each env permutation needs a fresh module registry rather than a mutated env.
 */
async function loadWithEnv(env = {}) {
    jest.resetModules();
    for (const key of ['CLEANUP_OIDC_AUDIENCE', 'CLEANUP_INVOKER_SA', 'PUBLIC_URL']) {
        delete process.env[key];
    }
    Object.assign(process.env, env);
    return import('../../src/components/web/cleanupEndpoint.js');
}

/** Minimal node http res double capturing status and parsed body. */
function makeRes() {
    const res = {
        statusCode: undefined,
        body: undefined,
        writeHead: jest.fn((code) => { res.statusCode = code; }),
        end: jest.fn((payload) => { res.body = payload ? JSON.parse(payload) : undefined; }),
    };
    return res;
}

const makeReq = (token = 'valid-token') => ({
    headers: { authorization: `Bearer ${token}` },
    ip: '10.0.0.1',
});

/** Wire the Secret Manager mock for a single secret with the given version ids. */
function stubSecret(name, versionIds) {
    mockClient.listSecrets.mockResolvedValue([[{ name: `projects/p/secrets/${name}` }]]);
    mockClient.listSecretVersions.mockResolvedValue([
        versionIds.map((id) => ({ name: `projects/p/secrets/${name}/versions/${id}` })),
    ]);
}

const acceptToken = () =>
    mockVerifyIdToken.mockResolvedValue({
        getPayload: () => ({ email_verified: true, email: INVOKER_SA }),
    });

describe('cleanupEndpoint.js', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        mockClient.disableSecretVersion.mockResolvedValue([{}]);
    });

    describe('caller authentication', () => {
        it('fails closed with 403 when no audience is configured', async () => {
            const { handleSecretCleanup } = await loadWithEnv();
            const res = makeRes();

            await handleSecretCleanup(makeReq(), res);

            expect(res.statusCode).toBe(403);
            expect(mockVerifyIdToken).not.toHaveBeenCalled();
            expect(mockClient.listSecrets).not.toHaveBeenCalled();
        });

        it('falls back to PUBLIC_URL as the audience', async () => {
            // Regression: the workflow sets PUBLIC_URL but not CLEANUP_OIDC_AUDIENCE.
            // Without this fallback every scheduled run 403s.
            const { handleSecretCleanup } = await loadWithEnv({ PUBLIC_URL: AUDIENCE });
            acceptToken();
            stubSecret('302_KEY', [1, 2]);

            await handleSecretCleanup(makeReq(), makeRes());

            expect(mockVerifyIdToken).toHaveBeenCalledWith(
                expect.objectContaining({ audience: AUDIENCE })
            );
        });

        it('prefers an explicit CLEANUP_OIDC_AUDIENCE over PUBLIC_URL', async () => {
            const { handleSecretCleanup } = await loadWithEnv({
                CLEANUP_OIDC_AUDIENCE: 'https://explicit.example',
                PUBLIC_URL: AUDIENCE,
            });
            acceptToken();
            stubSecret('302_KEY', [1, 2]);

            await handleSecretCleanup(makeReq(), makeRes());

            expect(mockVerifyIdToken).toHaveBeenCalledWith(
                expect.objectContaining({ audience: 'https://explicit.example' })
            );
        });

        it('rejects a token minted for a different service account', async () => {
            const { handleSecretCleanup } = await loadWithEnv({ PUBLIC_URL: AUDIENCE });
            mockVerifyIdToken.mockResolvedValue({
                getPayload: () => ({ email_verified: true, email: 'attacker@evil.example' }),
            });
            const res = makeRes();

            await handleSecretCleanup(makeReq(), res);

            expect(res.statusCode).toBe(403);
            expect(mockClient.listSecrets).not.toHaveBeenCalled();
        });

        it('rejects a token whose email is unverified', async () => {
            const { handleSecretCleanup } = await loadWithEnv({ PUBLIC_URL: AUDIENCE });
            mockVerifyIdToken.mockResolvedValue({
                getPayload: () => ({ email_verified: false, email: INVOKER_SA }),
            });
            const res = makeRes();

            await handleSecretCleanup(makeReq(), res);

            expect(res.statusCode).toBe(403);
        });

        it('rejects a request with no bearer token', async () => {
            const { handleSecretCleanup } = await loadWithEnv({ PUBLIC_URL: AUDIENCE });
            const res = makeRes();

            await handleSecretCleanup({ headers: {}, ip: '10.0.0.1' }, res);

            expect(res.statusCode).toBe(403);
            expect(mockVerifyIdToken).not.toHaveBeenCalled();
        });

        it('returns a retryable 503 when Google certs cannot be fetched', async () => {
            const { handleSecretCleanup } = await loadWithEnv({ PUBLIC_URL: AUDIENCE });
            mockVerifyIdToken.mockRejectedValue(
                new Error('Failed to retrieve verification certificates: ETIMEDOUT')
            );
            const res = makeRes();

            await handleSecretCleanup(makeReq(), res);

            // 503 so Cloud Scheduler retries; a bad token must stay a flat 403.
            expect(res.statusCode).toBe(503);
        });

        it('treats an invalid token as a non-retryable 403', async () => {
            const { handleSecretCleanup } = await loadWithEnv({ PUBLIC_URL: AUDIENCE });
            mockVerifyIdToken.mockRejectedValue(new Error('Token used too late'));
            const res = makeRes();

            await handleSecretCleanup(makeReq(), res);

            expect(res.statusCode).toBe(403);
        });
    });

    describe('version cleanup', () => {
        beforeEach(acceptToken);

        it('keeps the two newest versions and sorts numerically, not lexicographically', async () => {
            const { handleSecretCleanup } = await loadWithEnv({ PUBLIC_URL: AUDIENCE });
            stubSecret('302_KEY', [1, 2, 10]);
            const res = makeRes();

            await handleSecretCleanup(makeReq(), res);

            // Lexicographic sorting would rank "2" above "10" and disable the newest key.
            expect(mockClient.disableSecretVersion).toHaveBeenCalledTimes(1);
            expect(mockClient.disableSecretVersion).toHaveBeenCalledWith({
                name: 'projects/p/secrets/302_KEY/versions/1',
            });
            expect(res.body).toMatchObject({ versionsDisabled: 1 });
        });

        it('disables nothing when a secret has only the versions it keeps', async () => {
            const { handleSecretCleanup } = await loadWithEnv({ PUBLIC_URL: AUDIENCE });
            stubSecret('302_KEY', [3, 4]);
            const res = makeRes();

            await handleSecretCleanup(makeReq(), res);

            expect(mockClient.disableSecretVersion).not.toHaveBeenCalled();
            expect(res.body).toMatchObject({ versionsDisabled: 0 });
        });

        it('continues past a version that fails to disable', async () => {
            // Regression: a bare await here threw past the remaining versions into
            // the outer catch, abandoning them and reporting disabled: 0.
            const { handleSecretCleanup } = await loadWithEnv({ PUBLIC_URL: AUDIENCE });
            stubSecret('302_KEY', [1, 2, 3, 4]);
            mockClient.disableSecretVersion
                .mockRejectedValueOnce(new Error('version already destroyed'))
                .mockResolvedValueOnce([{}]);
            const res = makeRes();

            await handleSecretCleanup(makeReq(), res);

            expect(mockClient.disableSecretVersion).toHaveBeenCalledTimes(2);
            expect(res.statusCode).toBe(200);
            expect(res.body).toMatchObject({ versionsDisabled: 1, versionsKept: 3 });
        });

        it('reports a per-secret listing failure without aborting the run', async () => {
            const { handleSecretCleanup } = await loadWithEnv({ PUBLIC_URL: AUDIENCE });
            mockClient.listSecrets.mockResolvedValue([
                [{ name: 'projects/p/secrets/broken' }, { name: 'projects/p/secrets/fine' }],
            ]);
            mockClient.listSecretVersions
                .mockRejectedValueOnce(new Error('permission denied'))
                .mockResolvedValueOnce([
                    [1, 2, 3].map((id) => ({ name: `projects/p/secrets/fine/versions/${id}` })),
                ]);
            const res = makeRes();

            await handleSecretCleanup(makeReq(), res);

            expect(res.statusCode).toBe(200);
            expect(res.body).toMatchObject({ secretsProcessed: 2, versionsDisabled: 1 });
        });
    });

    describe('response contract', () => {
        beforeEach(acceptToken);

        it('waits for the cleanup before responding 200', async () => {
            // The endpoint used to answer 202 and run the work afterwards, where
            // Cloud Run throttles CPU to near zero once the response is written.
            const { handleSecretCleanup } = await loadWithEnv({ PUBLIC_URL: AUDIENCE });
            stubSecret('302_KEY', [1, 2, 3]);
            let disableSettled = false;
            mockClient.disableSecretVersion.mockImplementation(async () => {
                await new Promise((resolve) => setImmediate(resolve));
                disableSettled = true;
                return [{}];
            });
            const res = makeRes();

            await handleSecretCleanup(makeReq(), res);

            expect(disableSettled).toBe(true);
            expect(res.statusCode).toBe(200);
            expect(res.body).toMatchObject({ success: true, versionsDisabled: 1 });
        });

        it('returns 500 so the scheduler retries when the run fails outright', async () => {
            const { handleSecretCleanup } = await loadWithEnv({ PUBLIC_URL: AUDIENCE });
            mockClient.listSecrets.mockRejectedValue(new Error('Secret Manager unavailable'));
            const res = makeRes();

            await handleSecretCleanup(makeReq(), res);

            expect(res.statusCode).toBe(500);
            expect(res.body).not.toMatchObject({ success: true });
        });
    });
});
