// tests/setup.js
// Global test setup and configuration

// Set test environment variables
process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'silent'; // Suppress logs during tests

// Mock environment setup
global.mockEnv = {
  TWITCH_CHANNELS: 'testchannel',
  WAVESPEED_API_KEY: 'test_wavespeed_key',
  GOOGLE_APPLICATION_CREDENTIALS: './test-credentials.json'
};