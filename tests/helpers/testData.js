// tests/helpers/testData.js
// Test data fixtures for TTS tests

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
  voiceId: 'Friendly_Person',
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
    voiceId: 'Wise_Woman',
    emotion: 'happy',
    speed: 1.2,
    pitch: 2,
    languageBoost: 'English'
  },
  [TEST_USER2_ID]: {
    voiceId: 'Calm_Man',
    emotion: 'neutral'
  }
};

export const mockGlobalUserPreferences = {
  voiceId: 'Global_Voice',
  emotion: 'surprised',
  speed: 1.5,
  pitch: -2,
  languageBoost: 'Spanish',
  englishNormalization: true
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