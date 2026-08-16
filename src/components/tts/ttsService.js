// src/components/tts/ttsService.js
import axios from 'axios';
import logger from '../../lib/logger.js';
import config from '../../config/index.js';
import { TTS_SPEED_DEFAULT, TTS_PITCH_DEFAULT, LEGACY_SAFE_EMOTIONS, LEGACY_SAFE_LANGUAGE_BOOSTS } from './ttsConstants.js';
import { getAllVoices, getVoicesByLanguage } from './wavespeedVoices.js';
import { getProviderForVoice } from './voiceMigration.js';

const WAVESPEED_API_KEY = config.tts.wavespeedApiKey;
const WAVESPEED_ENDPOINT = config.tts.wavespeedEndpoint;

const T302_API_KEY = config.tts.t302ApiKey;
const T302_ENDPOINT = config.tts.t302Endpoint;

let cachedVoiceList = null;
let lastVoiceListFetchTime = 0;
const VOICE_LIST_CACHE_DURATION = 60 * 60 * 1000; // 1 hour

/**
 * Map emotion for the MiniMax API.
 * "neutral" is a user-facing alias meaning "auto-detect" — we omit it from the API call.
 * For the Wavespeed/speech-02-turbo fallback, calm and fluent are not supported.
 * @param {string} emotion - The emotion value
 * @param {'302'|'wavespeed'} provider - The target provider
 * @returns {string|undefined} - Mapped emotion value, or undefined to omit
 */
function mapEmotionForApi(emotion, provider = '302') {
  if (!emotion || emotion === 'auto' || emotion === 'neutral') {
    return undefined; // Omit from API call → auto-detect
  }
  // For Wavespeed fallback (speech-02-turbo), strip emotions it doesn't support
  if (provider === 'wavespeed' && !LEGACY_SAFE_EMOTIONS.includes(emotion)) {
    logger.debug({ emotion, provider }, 'Emotion not supported by legacy provider, omitting');
    return undefined;
  }
  return emotion;
}

/**
 * Map legacy language boost values to API-compatible values
 * @param {string} languageBoost - The language boost value
 * @returns {string} - Mapped language boost value
 */
function mapLanguageBoost(languageBoost) {
  // Map legacy values to MiniMax format
  if (languageBoost === 'None' || languageBoost === 'Automatic') {
    return 'auto';
  }
  return languageBoost;
}

/**
 * Internal function to attempt TTS generation (used by retry logic)
 */
async function attemptGeneration(text, voiceId, input, options) {
  // Add timeout to prevent hanging indefinitely
  // Most requests complete in 2-5 seconds
  const WAVESPEED_TIMEOUT_MS = 10000; // 10 seconds
  let timeoutId;
  const timeoutPromise = new Promise((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error('Wavespeed AI API request timed out')), WAVESPEED_TIMEOUT_MS);
  });

  // Sanitize language_boost for Wavespeed (speech-02-turbo supports fewer languages)
  if (input.language_boost && !LEGACY_SAFE_LANGUAGE_BOOSTS.includes(input.language_boost)) {
    logger.warn({
      original: input.language_boost,
      voiceId
    }, 'Language boost not supported by Wavespeed, falling back to auto');
    input.language_boost = 'auto';
  }

  // Sanitize emotion for Wavespeed (speech-02-turbo doesn't support calm/fluent)
  if (input.emotion) {
    input.emotion = mapEmotionForApi(input.emotion, 'wavespeed');
  }

  const requestConfig = {
    method: 'POST',
    url: WAVESPEED_ENDPOINT,
    headers: {
      'Authorization': `Bearer ${WAVESPEED_API_KEY}`,
      'Content-Type': 'application/json'
    },
    data: input
  };

  // Add abort signal support if provided
  if (options.signal) {
    requestConfig.signal = options.signal;
  }

  let response;
  try {
    response = await Promise.race([
      axios(requestConfig),
      timeoutPromise
    ]);
  } finally {
    clearTimeout(timeoutId);
  }

  // Check if the request was aborted during the API call
  if (options.signal && options.signal.aborted) {
    logger.info({ endpoint: WAVESPEED_ENDPOINT, text }, 'Wavespeed AI request was aborted while awaiting.');
    throw new DOMException('Aborted by user', 'AbortError');
  }

  const result = response.data;

  // Wavespeed API wraps the response in a data object
  const data = result.data || result;

  // Handle sync mode response - the output should be available immediately
  if (data.status === 'completed' && data.outputs && data.outputs.length > 0) {
    const audioUrl = data.outputs[0];
    logger.info({ outputUrl: audioUrl, predictionId: data.id }, 'TTS audio generated successfully via Wavespeed AI');
    // Wavespeed only ever hands back a URL — it has no inline-bytes mode. Its CDN
    // is CloudFront (~200ms), not the China bucket 302.ai uses, so this stays on
    // the URL path rather than being downloaded server-side onto the hot path.
    return { kind: 'url', url: audioUrl };
  } else if (data.status === 'failed') {
    logger.error({ result, endpoint: WAVESPEED_ENDPOINT }, 'Wavespeed AI returned failed status.');

    // Provide specific error messages based on the failure reason
    if (data.error?.includes("you don't have access to this voice_id")) {
      throw new Error(`Voice access denied: The voice "${voiceId}" requires special access permissions. Please try a different voice.`);
    }

    if (data.error?.includes("voice_id")) {
      throw new Error(`Invalid voice: "${voiceId}" is not available. Please check the voice ID and try again.`);
    }

    throw new Error(`TTS generation failed: ${data.error || 'Unknown error'}`);
  } else {
    // In sync mode, we should always get completed or failed status
    logger.error({ result, endpoint: WAVESPEED_ENDPOINT }, 'Wavespeed AI returned unexpected status or missing outputs.');
    throw new Error(`Wavespeed AI API returned unexpected response format. Status: ${data.status || 'unknown'}`);
  }
}

// Interjections MiniMax renders as non-verbal sound rather than speech. Only
// speech-2.8-hd and speech-2.8-turbo support them; we send speech-2.8-turbo.
// NOTE: the Wavespeed fallback runs speech-02-turbo, which does not — a message that
// falls back will not produce these sounds.
const INTERJECTION_TAGS = [
  'laughs', 'chuckle', 'coughs', 'clear-throat', 'groans', 'breath', 'pant',
  'inhale', 'exhale', 'gasps', 'sniffs', 'sighs', 'snorts', 'burps',
  'lip-smacking', 'humming', 'hissing', 'emm', 'sneezes',
];
const INTERJECTION_RE = new RegExp(`\\((?:${INTERJECTION_TAGS.join('|')})\\)`, 'gi');

// Measured against the live API (3 samples per case, speech-2.8-turbo, 128kbps mono):
//
//   input            audio out   duration
//   plain 10ch        1.31s      1991-2494ms
//   plain 50ch        4.86s      2190-2344ms
//   plain 150ch       9.06s      2346-2944ms
//   plain 400ch      26.34s      3626-4082ms
//   (groans) x1       1.04s      1694-2355ms
//   (groans) x6       3.76s      1723-1960ms
//   (groans) x12     12.00s      2625-3599ms
//
// Two things fall out. Audio length is predictable from the text — ~0.064s per plain
// character, and ~1.0s per interjection, which is why tags broke a character-count
// model: a tag is 8 characters that speak for a second, roughly double the audio
// density of prose. But duration is only weakly driven by it: ~1900ms of fixed
// overhead plus ~70ms per second of audio, so a 25x range in audio output produces
// less than a 3x range in duration.
//
// So the budget is mostly floor. The floor is set above the slowest legitimate call
// seen in production (3297ms, itself censored since slower ones were being killed),
// because under-shooting it fails healthy requests — the bug this replaces. The
// scaling only earns its keep at the long end, where it grants more than a flat
// budget could afford to give everyone.
const T302_AUDIO_SEC_BASE = 0.67;          // fixed audio overhead per utterance
const T302_AUDIO_SEC_PER_CHAR = 0.064;     // seconds of speech per plain character
const T302_AUDIO_SEC_PER_TAG = 1.0;        // seconds of sound per interjection
// Fitted to the *slowest* sample at each size, then given a wide margin on top —
// roughly 2.4s at the short end and 0.7s at the long end. The margin is not padding:
// run-to-run variance dwarfs the content signal. The same 500-character message
// measured 4478ms median and 6241ms worst across sessions, and identical payloads in
// production came back 450ms apart. A budget fitted tightly to the mean would fail
// healthy requests every time the provider had a bad minute, which is the failure this
// whole model exists to stop happening again.
const T302_TIMEOUT_FIXED_MS = 4200;        // network + queue + model start-up + margin
const T302_TIMEOUT_PER_AUDIO_SEC_MS = 85;  // synthesis cost per second produced
const T302_TIMEOUT_MIN_MS = 4500;
const T302_TIMEOUT_MAX_MS = 8000;

/**
 * Per-request timeout, predicted from how much audio the text will produce.
 * @param {string} text
 * @returns {number} milliseconds
 */
export function t302TimeoutFor(text) {
  if (typeof text !== 'string') return T302_TIMEOUT_MIN_MS;

  const tagCount = (text.match(INTERJECTION_RE) || []).length;
  // Tags are counted as sounds, so their characters must not also be counted as speech.
  const plainChars = text.replace(INTERJECTION_RE, '').length;

  const audioSec = T302_AUDIO_SEC_BASE
    + T302_AUDIO_SEC_PER_CHAR * plainChars
    + T302_AUDIO_SEC_PER_TAG * tagCount;

  const predicted = T302_TIMEOUT_FIXED_MS + T302_TIMEOUT_PER_AUDIO_SEC_MS * audioSec;
  return Math.min(T302_TIMEOUT_MAX_MS, Math.max(T302_TIMEOUT_MIN_MS, Math.round(predicted)));
}

// A generous timeout is right for one slow request and wrong for a provider outage:
// during one, every message would burn the full 8s before failing over to a Wavespeed
// call that was always going to be needed. Observed live — 302.ai answering HTTP 500
// after 10.7s on every request while Wavespeed stayed healthy — so the breaker is what
// makes the timeout above safe to raise.
//
// After enough consecutive failures 302 is skipped outright for a cooldown, turning an
// outage from "every message pays the timeout" into "one message does, then we route
// around it". When the cooldown lapses the next request tries 302 again: if it works
// the breaker resets, if not the cooldown restarts.
const T302_CIRCUIT_FAILURE_THRESHOLD = 3;
const T302_CIRCUIT_COOLDOWN_MS = 60 * 1000;

let t302ConsecutiveFailures = 0;
let t302CircuitOpenUntil = 0;

function is302CircuitOpen() {
  return Date.now() < t302CircuitOpenUntil;
}

function record302Success() {
  if (t302ConsecutiveFailures > 0 || t302CircuitOpenUntil > 0) {
    logger.info({ afterFailures: t302ConsecutiveFailures }, '302.ai recovered; resuming normal routing');
  }
  t302ConsecutiveFailures = 0;
  t302CircuitOpenUntil = 0;
}

function record302Failure() {
  t302ConsecutiveFailures++;
  if (t302ConsecutiveFailures >= T302_CIRCUIT_FAILURE_THRESHOLD) {
    t302CircuitOpenUntil = Date.now() + T302_CIRCUIT_COOLDOWN_MS;
    logger.error({
      consecutiveFailures: t302ConsecutiveFailures,
      cooldownMs: T302_CIRCUIT_COOLDOWN_MS,
    }, '302.ai circuit opened — routing straight to Wavespeed until the cooldown lapses');
  }
}

/** Test seam: reset breaker state between cases. */
export function _resetT302Circuit() {
  t302ConsecutiveFailures = 0;
  t302CircuitOpenUntil = 0;
}

/**
 * Internal function to attempt TTS generation via 302.ai
 */
async function attemptGeneration302(text, voiceId, options = {}) {
  const apiKey = config.tts.t302ApiKey;
  if (!apiKey) {
    throw new Error('302.ai API key is missing');
  }

  const startTime = Date.now();

  const input = {
    model: 'speech-2.8-turbo',
    text,
    stream: false,
    voice_setting: {
      voice_id: voiceId,
      speed: options.speed ?? TTS_SPEED_DEFAULT,
      vol: options.volume ?? 1.0,
      pitch: options.pitch ?? TTS_PITCH_DEFAULT,
      emotion: mapEmotionForApi(options.emotion ?? config.tts?.defaultEmotion ?? 'neutral', '302'),
      // t2a_v2 spells this text_normalization and expects it inside voice_setting.
      // The flat english_normalization the Wavespeed wrapper takes is accepted
      // here but silently ignored — this API ignores unknown keys rather than
      // erroring — so it has to be sent under this name to have any effect.
      text_normalization: options.englishNormalization ?? false,
    },
    audio_setting: {
      sample_rate: options.sampleRate ?? 32000,
      bitrate: options.bitrate ?? 128000,
      format: options.format ?? 'mp3',
      channel: options.channel === 'mono' ? 1 : options.channel === 'stereo' ? 2 : 1,
    },
    language_boost: mapLanguageBoost(options.languageBoost ?? config.tts?.defaultLanguageBoost ?? 'auto'),
    // 'hex' returns the audio inline in this same response. 'url' hands back an
    // Alibaba OSS link in Wulanchabu, China, which the OBS browser source then had
    // to fetch itself — measured at 866-1090ms on every single clip. Taking the
    // bytes here and pushing them down the already-open WebSocket deletes that hop.
    // Only a channel with an outdated player still connected asks for 'url'.
    output_format: options.preferUrlOutput ? 'url' : 'hex'
  };

  // Log request details for debugging
  logger.info({
    logKey: '302_API_REQUEST',
    endpoint: T302_ENDPOINT,
    voiceId,
    textLength: text.length,
    textPreview: text.substring(0, 50),
    requestParams: {
      model: input.model,
      voice_setting: input.voice_setting,
      audio_setting: input.audio_setting,
      language_boost: input.language_boost
    }
  }, `302.ai API request starting for voice ${voiceId}`);

  const requestConfig = {
    method: 'POST',
    url: T302_ENDPOINT,
    headers: {
      'Authorization': `Bearer ${T302_API_KEY}`,
      'Content-Type': 'application/json'
    },
    data: input,
    timeout: t302TimeoutFor(text)
  };

  if (options.signal) {
    requestConfig.signal = options.signal;
  }

  try {
    const response = await axios(requestConfig);
    const durationMs = Date.now() - startTime;

    if (options.signal && options.signal.aborted) {
      logger.info({ endpoint: T302_ENDPOINT, text, durationMs }, '302.ai request was aborted while awaiting.');
      throw new DOMException('Aborted by user', 'AbortError');
    }

    const result = response.data;

    // MiniMax reports failures as HTTP 200 with a non-zero base_resp code
    // (1002 rate limit, 1004 auth, 1039 TPM, 1042 invalid characters, 2013 bad
    // params), so the status has to be read out of the body.
    if (result.base_resp?.status_code !== undefined && result.base_resp.status_code !== 0) {
      const { status_code: code, status_msg: msg } = result.base_resp;
      logger.error({ code, msg, endpoint: T302_ENDPOINT, voiceId, durationMs }, '302.ai returned an API-level error');
      throw new Error(`302.ai API error ${code}: ${msg}`);
    }

    // MiniMax returns the payload in data.audio for BOTH output formats — a URL
    // string under output_format 'url', hex-encoded bytes under 'hex'. There is no
    // data.url field; the branch that used to test for one never matched, and every
    // request had been falling through to a branch commented as a fallback. Since
    // the two formats are indistinguishable by shape, dispatch on what we asked for.
    const audio = result.data?.audio;
    if (typeof audio !== 'string' || audio.length === 0) {
      logger.error({ result, endpoint: T302_ENDPOINT, durationMs }, '302.ai returned no audio payload.');
      throw new Error(`302.ai API returned unexpected response format: ${JSON.stringify(result)}`);
    }

    if (input.output_format === 'url') {
      logger.info({ outputUrl: audio, durationMs, voiceId }, 'TTS audio generated successfully via 302.ai (url output)');
      return { kind: 'url', url: audio };
    }

    const data = Buffer.from(audio, 'hex');
    if (data.length === 0) {
      logger.error({ endpoint: T302_ENDPOINT, durationMs, hexLength: audio.length }, '302.ai audio payload did not decode as hex.');
      throw new Error('302.ai API returned an undecodable audio payload');
    }

    logger.info({ bytes: data.length, durationMs, voiceId }, 'TTS audio generated successfully via 302.ai');
    return { kind: 'buffer', data, mime: 'audio/mpeg' };
  } catch (error) {
    const durationMs = Date.now() - startTime;
    const isTimeout = error.code === 'ECONNABORTED' || (error.message && error.message.includes('timeout'));

    logger.error({
      logKey: '302_API_ERROR',
      endpoint: T302_ENDPOINT,
      voiceId,
      textLength: text.length,
      durationMs,
      isTimeout,
      errorCode: error.code,
      errorMessage: error.message,
      responseStatus: error.response?.status,
      responseData: error.response?.data
    }, `302.ai API error after ${durationMs}ms: ${error.message}`);

    if (isTimeout) {
      throw new Error('302.ai API request timed out');
    }
    throw error;
  }
}

/**
 * Generate speech audio for a piece of text.
 *
 * Returns a discriminated payload rather than a bare URL, because the two providers
 * deliver audio differently: 302.ai hands back the bytes inline, Wavespeed a CDN link.
 * Callers must branch on `kind` — see sendAudioToChannel in components/web/webSocket.js.
 *
 * @returns {Promise<{kind: 'buffer', data: Buffer, mime: string} | {kind: 'url', url: string}>}
 */
export async function generateSpeech(text, voiceId = config.tts?.defaultVoiceId || 'Friendly_Person', options = {}) {
  logger.info({
    logKey: "TTS_GENERATE_SPEECH_CALLED",
    textToGenerate: text,
    voiceIdForTTS: voiceId,
    optionsSummary: {
      speed: options.speed,
      pitch: options.pitch,
      emotion: options.emotion,
      languageBoost: options.languageBoost
    },
    timestamp_ms: Date.now()
  }, `TTS_GENERATE_SPEECH_CALLED for text: "${text.substring(0, 30)}...", Voice: ${voiceId}`);

  const input = {
    text,
    voice_id: voiceId,
    speed: options.speed ?? TTS_SPEED_DEFAULT,
    vol: options.volume ?? 1.0,
    volume: options.volume ?? 1.0,
    pitch: options.pitch ?? TTS_PITCH_DEFAULT,
    emotion: mapEmotionForApi(options.emotion ?? config.tts?.defaultEmotion ?? 'neutral', '302'),
    language_boost: mapLanguageBoost(options.languageBoost ?? config.tts?.defaultLanguageBoost ?? 'auto'),
    english_normalization: options.englishNormalization !== undefined
      ? options.englishNormalization
      : false,
    sample_rate: options.sampleRate ?? 32000,
    bitrate: options.bitrate ?? 128000,
    channel: options.channel === 'mono' ? '1' : options.channel === 'stereo' ? '2' : '1',
    format: options.format ?? 'mp3',
    enable_sync_mode: true, // Enable sync mode for lowest latency
  };

  const provider = getProviderForVoice(voiceId);
  const is302 = provider === '302';
  const endpoint = is302 ? T302_ENDPOINT : WAVESPEED_ENDPOINT;

  logger.debug({ input: is302 ? '302.ai input hidden' : input, endpoint, provider }, `Sending TTS request to ${provider}`);

  // Retry logic: try once, retry on timeout or fallback to Wavespeed
  const MAX_RETRIES = 1;
  let lastError = null;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    // Whether this attempt actually reached 302, so the catch below only holds 302
    // responsible for its own failures — with the breaker open, attempt 0 is Wavespeed.
    let calledT302 = false;
    try {
      let audio;
      if (is302) {
        // If this is a retry and the provider is 302, we might want to fallback to Wavespeed
        // But only if the voice is actually supported by Wavespeed (which they all are currently)
        if (attempt > 0) {
          logger.warn({ text: text.substring(0, 30) }, 'Falling back to Wavespeed API after 302.ai failure');
          audio = await attemptGeneration(text, voiceId, input, options);
        } else if (is302CircuitOpen()) {
          // 302 is known-bad right now; skip it rather than paying the timeout again.
          logger.debug({ text: text.substring(0, 30) }, '302.ai circuit open — using Wavespeed directly');
          audio = await attemptGeneration(text, voiceId, input, options);
        } else {
          calledT302 = true;
          audio = await attemptGeneration302(text, voiceId, options);
          record302Success();
        }
      } else {
        audio = await attemptGeneration(text, voiceId, input, options);
      }

      // Log successful retry
      if (attempt > 0) {
        logger.info({ attempt, text: text.substring(0, 30), provider: is302 && attempt > 0 ? 'wavespeed (fallback)' : provider }, 'TTS generation succeeded after retry');
      }

      return audio;
    } catch (error) {
      lastError = error;

      // Don't retry on abort. Nor count it against the breaker: a stop command or a
      // cleared queue says nothing about whether the provider is healthy, and letting
      // those trip it would route a channel to the slower provider for a minute every
      // time a moderator used !tts stop a few times.
      if (error.name === 'AbortError' || error.name === 'CanceledError') {
        logger.info({ text, endpoint }, `${provider} API call aborted in generateSpeech.`);
        throw error;
      }

      if (calledT302) {
        record302Failure();
      }

      // Determine if we should retry/fallback
      // For 302.ai, we always try to fallback to Wavespeed on error (timeout or otherwise)
      // For Wavespeed, we retry only on timeout
      const isTimeout = error.message && error.message.includes('timed out');
      const shouldRetry = (is302 && attempt < MAX_RETRIES) || (isTimeout && attempt < MAX_RETRIES);

      if (shouldRetry) {
        logger.warn({
          attempt: attempt + 1,
          maxRetries: MAX_RETRIES + 1,
          text: text.substring(0, 30),
          error: error.message
        }, `${provider} API error/timeout - retrying/falling back (attempt ${attempt + 1}/${MAX_RETRIES + 1})`);
        continue;
      }

      // No more retries or non-retryable error - handle the error
      const logError = {
        message: error.message,
        name: error.name,
        stack: error.stack,
        response: error.response?.data
      };
      logger.error({ err: logError, text, endpoint, attempts: attempt + 1 }, `${provider} API error in generateSpeech`);

      // Provide specific error messages based on Wavespeed API response
      if (error.response?.data) {
        const apiError = error.response.data;

        // Check for specific Wavespeed error messages
        if (apiError.message && apiError.message.includes("you don't have access to this voice_id")) {
          throw new Error(`Voice access denied: The voice "${voiceId}" requires special access permissions. Please try a different voice.`);
        }

        if (apiError.message && apiError.message.includes("voice_id")) {
          throw new Error(`Invalid voice: "${voiceId}" is not available. Please check the voice ID and try again.`);
        }

        if (apiError.message) {
          throw new Error(`TTS generation failed: ${apiError.message}`);
        }
      }

      // Fallback to generic error
      throw new Error(`Failed to generate speech via ${provider} API: ${error.message}`);
    }
  }

  // This should never be reached, but just in case
  throw lastError || new Error('TTS generation failed for unknown reason');
}

/**
 * Get available voices from the hardcoded voice list
 * @param {boolean} forceRefresh - If true, forces a refresh from the schema API
 * @returns {Array} - Array of voice objects
 */
export async function getAvailableVoices(forceRefresh = false) {
  const now = Date.now();

  // If force refresh is requested and cache is stale, try to fetch from schema API
  if (forceRefresh && (now - lastVoiceListFetchTime > VOICE_LIST_CACHE_DURATION)) {
    logger.info('Forcing voice list refresh from Wavespeed schema API.');
    try {
      const freshVoices = await _fetchVoiceListFromSchema();
      if (freshVoices && freshVoices.length > 0) {
        cachedVoiceList = freshVoices;
        lastVoiceListFetchTime = now;
        logger.info(`Successfully refreshed ${cachedVoiceList.length} voices from schema API.`);
        return cachedVoiceList;
      }
    } catch (error) {
      logger.warn({ err: error }, 'Failed to refresh voice list from schema API, falling back to hardcoded list.');
    }
  }

  // Return cached list if available and fresh
  if (cachedVoiceList && (now - lastVoiceListFetchTime < VOICE_LIST_CACHE_DURATION)) {
    logger.debug('Returning cached voice list.');
    return cachedVoiceList;
  }

  // Otherwise, use hardcoded voice list
  logger.info('Loading voices from hardcoded list.');
  cachedVoiceList = getAllVoices();
  lastVoiceListFetchTime = now;
  return cachedVoiceList;
}

/**
 * Fetch voice list dynamically from Wavespeed schema API (optional, for future updates)
 * @returns {Array} - Array of voice objects
 * @private
 */
async function _fetchVoiceListFromSchema() {
  const schemaUrl = 'https://wavespeed.ai/center/default/api/v1/model_schema/minimax/speech-02-turbo';
  logger.info(`Attempting to fetch voice list from schema: ${schemaUrl}`);

  try {
    const response = await axios.get(schemaUrl, {
      timeout: 10000 // 10 second timeout
    });

    // The schema is a JSON object - we need to extract voice IDs from the voice_id field's x-enum
    const schema = response.data;

    // Navigate to the voice_id parameter in the schema
    if (schema.input_schema &&
      schema.input_schema.properties &&
      schema.input_schema.properties.voice_id &&
      schema.input_schema.properties.voice_id['x-enum']) {

      const voiceIds = schema.input_schema.properties.voice_id['x-enum'];

      logger.info(`Fetched ${voiceIds.length} voice IDs from schema.`);

      // Convert to voice objects with metadata
      return voiceIds.map(id => {
        const voice = getAllVoices().find(v => v.id === id);
        return voice || {
          id,
          name: id.replace(/[_-]/g, ' ').replace(/\b\w/g, chr => chr.toUpperCase()),
          language: 'Unknown',
          type: 'Pre-trained'
        };
      });
    } else {
      logger.warn('Schema API response missing expected voice_id x-enum field.');
      return [];
    }
  } catch (error) {
    logger.error({ err: error }, 'Failed to fetch voice list from Wavespeed schema API.');
    throw error;
  }
}

/**
 * Get voices grouped by language for better UX
 * @returns {Object} - Object with languages as keys and voice arrays as values
 */
export function getVoicesGroupedByLanguage() {
  return getVoicesByLanguage();
}
