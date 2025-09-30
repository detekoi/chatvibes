// tests/helpers/testData.js
// Test data fixtures for TTS tests

import { DEFAULT_TTS_SETTINGS } from '../../src/components/tts/ttsConstants.js';

export const TEST_CHANNEL = 'testchannel';
export const TEST_USER = 'testuser';
export const TEST_USER2 = 'testuser2';

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
  ignoredUsers: [],
  userPreferences: {}
};

export const mockChannelConfigNoViewerPrefs = {
  ...mockChannelConfig,
  allowViewerPreferences: false
};

export const mockUserPreferences = {
  [TEST_USER]: {
    voiceId: 'Wise_Woman',
    emotion: 'happy',
    speed: 1.2,
    pitch: 2,
    languageBoost: 'English'
  },
  [TEST_USER2]: {
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