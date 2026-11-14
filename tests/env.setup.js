// tests/env.setup.js
// Runs before the test framework is installed, so config/loader.js sees these
// values no matter how early a test file imports it. CI has no .env file, so
// without these the required-env-var check in src/config/loader.js throws and
// whole suites fail to run.

process.env.NODE_ENV = 'test';

const testEnvDefaults = {
    TWITCH_BOT_USERNAME: 'test_bot',
    TWITCH_BOT_REFRESH_TOKEN_SECRET_NAME: 'test-refresh-token-secret',
    // generateSpeech refuses to run without a key
    GEMINI_API_KEY: 'test_gemini_key',
    TWITCH_CHANNELS: 'testchannel',
};

for (const [key, value] of Object.entries(testEnvDefaults)) {
    if (!(key in process.env)) {
        process.env[key] = value;
    }
}
