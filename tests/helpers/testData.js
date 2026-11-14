// tests/helpers/testData.js
// Test data fixtures for TTS tests. Voice IDs are Gemini IDs from gemini-voices.json,
// so they resolve to themselves in voiceResolver.js.

import { DEFAULT_TTS_SETTINGS } from '../../src/components/tts/ttsConstants.js';

export const TEST_CHANNEL = 'testchannel';
export const TEST_USER = 'testuser';
export const TEST_USER2 = 'testuser2';
export const TEST_USER_ID = '123456789'; // Twitch User ID for TEST_USER
export const TEST_USER2_ID = '223456789'; // Twitch User ID for TEST_USER2

export const mockChannelConfig = {
  ...DEFAULT_TTS_SETTINGS,
  engineEnabled: true,
  mode: 'all',
  voiceId: 'kore',
  emotion: 'auto',
  speed: 1.0,
  pitch: 0,
  languageBoost: 'Automatic',
  allowViewerPreferences: true,
  ignoredUserIds: {},
  userPreferences: {}
};

export const mockChannelConfigNoViewerPrefs = {
  ...mockChannelConfig,
  allowViewerPreferences: false
};

// Per-channel viewer preferences, keyed by account ID like the real data.
export const mockUserPreferences = {
  [TEST_USER_ID]: {
    voiceId: 'aoede',
    emotion: 'happy',
    speed: 1.2,
    pitch: 2,
    languageBoost: 'English'
  },
  [TEST_USER2_ID]: {
    voiceId: 'charon',
    emotion: 'neutral'
  }
};

export const mockGlobalUserPreferences = {
  voiceId: 'zephyr',
  emotion: 'surprised',
  speed: 1.5,
  pitch: -2,
  languageBoost: 'Spanish'
};

export const mockChatMessage = {
  text: 'This is a test message',
  user: TEST_USER,
  type: 'chat'
};

export const mockEventMessage = {
  text: 'TestUser has subscribed!',
  user: 'event_tts',
  type: 'event'
};