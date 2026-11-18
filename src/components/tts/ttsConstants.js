// src/components/tts/ttsConstants.js
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import config from '../../config/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ttsConfig = JSON.parse(readFileSync(join(__dirname, 'tts-config.json'), 'utf8'));

export const DEFAULT_TTS_SETTINGS = {
    engineEnabled: true,
    mode: 'command', // A channel that never chose one starts in command mode; the dashboard writes this at first sign-in
    ttsPermissionLevel: 'everyone',
    voiceId: config.tts?.defaultVoiceId || 'puck', // A Gemini voice ID; see voiceResolver.js
    speed: config.tts?.defaultSpeed || ttsConfig.SPEED.DEFAULT,
    volume: 1.0,
    pitch: config.tts?.defaultPitch || ttsConfig.PITCH.DEFAULT,
    emotion: config.tts?.defaultEmotion || 'neutral',
    allowViewerPreferences: true,
    readFullUrls: false, // Default to reading only domain names for better listening experience
    languageBoost: config.tts?.defaultLanguageBoost || 'auto',
    speakEvents: true,
    // Speak the message attached to a cheer. bits_points_only always does;
    // this switch is for every other mode. A cheer is paid for, so it is
    // never subject to ttsPermissionLevel.
    readCheerMessages: true,
    // Read a chat message that starts with "!" in all mode. Off skips other
    // bots' commands (!lurk, !so, !sr) that were being spoken as chat. "!tts"
    // is never affected: it is dispatched as a command before this is consulted.
    readCommandMessages: true,
    bitsMinimumAmount: 1, // Cheers below this are not read. 1 means every cheer that carries a message.
    // A reward that does not skip Twitch's request queue is redeemed as
    // .add + unfulfilled, and waiting for the streamer to accept it means a
    // channel that never works its queue hears nothing from that reward at all.
    // Announcing on .add is the default because that silence is indistinguishable
    // from the bot being broken; a channel that would rather be able to reject a
    // redemption before it is spoken switches this off.
    announceUnfulfilledRedemptions: true,
    botRespondsInChat: true, // Whether the bot sends chat responses (default: true = interactive mode)
    // Channel overrides for the built-in acronym dictionary, keyed by the
    // lowercased match. An empty value switches off the built-in of that name.
    // Like ignoredUserIds this has a default, so hydration always yields an
    // object and callers never have to guard before reading it.
    pronunciations: {},
    pronunciationEnabled: true,
    profanityFilterEnabled: false, // Opt-in: off unless a channel turns it on
    // Sound tags (<laugh>, <scream>, ...) that the channel turned off, by canonical
    // name. Every tag works unless it is listed here. See src/lib/textRewrite/soundTags.js.
    disabledSoundTags: [],
    // TTS ignore list, keyed by immutable platform account ID. See src/lib/ignoreList.js
    // for the key format and why login names are not used.
    ignoredUserIds: {},
    // Channel point rewards whose redemptions are not announced, keyed by
    // Twitch reward ID. See src/lib/rewardMuteList.js.
    mutedRewardIds: {},
    // Spotlight mode (mode: 'spotlight'): a model reads chat in batches and picks the
    // few messages worth reading aloud (src/lib/spotlight/). spotlightGuidance is
    // unset by default: free text from the streamer that steers the picks, at most
    // SPOTLIGHT.GUIDANCE_MAX characters, cleared by writing ''. It is a preference
    // and cannot unlock a kind of message the router rejects.
    // spotlightCard shows the spotlight card in the browser source. Dashboard only.
    spotlightCard: false,
    // It's good practice to initialize userPreferences in default settings
    // userPreferences: {}, // Will be handled by ttsState.js if it needs to be part of base default
};

// All valid emotions (speech-2.8-turbo full set + "neutral" as user-facing auto-detect alias)
export const VALID_EMOTIONS = ttsConfig.VALID_EMOTIONS;

export const TTS_PITCH_MIN = ttsConfig.PITCH.MIN;
export const TTS_PITCH_MAX = ttsConfig.PITCH.MAX;
export const TTS_PITCH_DEFAULT = ttsConfig.PITCH.DEFAULT;

export const TTS_SPEED_MIN = ttsConfig.SPEED.MIN;
export const TTS_SPEED_MAX = ttsConfig.SPEED.MAX;
export const TTS_SPEED_DEFAULT = ttsConfig.SPEED.DEFAULT;

// The longest spotlight guidance a channel can store, after trimming.
export const SPOTLIGHT_GUIDANCE_MAX = ttsConfig.SPOTLIGHT.GUIDANCE_MAX;

// The languages a channel or viewer can choose (40). The value gives the speech model a
// hint, sets the default announcement language and selects the profanity list.
export const VALID_LANGUAGE_BOOSTS = ttsConfig.VALID_LANGUAGE_BOOSTS;

export const DOC_LINKS = {
    voices: 'https://docs.wildcat.chat/tts-voices.html#voices',
    languageBoost: 'https://docs.wildcat.chat/tts-voices.html#language-boost',
};
