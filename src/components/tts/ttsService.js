// src/components/tts/ttsService.js
import axios from 'axios';
import logger from '../../lib/logger.js';
import config from '../../config/index.js';
import { TTS_SPEED_DEFAULT, TTS_PITCH_DEFAULT } from './ttsConstants.js';
import { getAllVoices, getVoicesByLanguage } from './wavespeedVoices.js';
import { getProviderForVoice, T302_LANGUAGE_BOOST_OPTIONS } from './voiceMigration.js';

const WAVESPEED_API_KEY = config.tts.wavespeedApiKey;
const WAVESPEED_ENDPOINT = config.tts.wavespeedEndpoint;

const T302_API_KEY = config.tts.t302ApiKey;
const T302_ENDPOINT = config.tts.t302Endpoint;

let cachedVoiceList = null;
let lastVoiceListFetchTime = 0;
const VOICE_LIST_CACHE_DURATION = 60 * 60 * 1000; // 1 hour

/**
 * Map legacy emotion values to Wavespeed-compatible values
 * @param {string} emotion - The emotion value
 * @returns {string} - Mapped emotion value
 */
function mapEmotion(emotion) {
  // Wavespeed doesn't support "auto", map to "neutral"
  if (emotion === 'auto') {
    return 'neutral';
  }
  // Wavespeed doesn't support "fluent", map to "neutral"
  if (emotion === 'fluent') {
    return 'neutral';
  }
  return emotion;
}

/**
 * Map legacy language boost values to Wavespeed-compatible values
 * @param {string} languageBoost - The language boost value
 * @returns {string} - Mapped language boost value
 */
function mapLanguageBoost(languageBoost) {
  // Map legacy values to Wavespeed format
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
  // Most requests complete in 2-5 seconds, so 15 seconds is generous
  const WAVESPEED_TIMEOUT_MS = 15000; // 15 seconds
  const timeoutPromise = new Promise((_, reject) => {
    setTimeout(() => reject(new Error('Wavespeed AI API request timed out')), WAVESPEED_TIMEOUT_MS);
  });

  // Safe languages for Wavespeed (speech-02-turbo)
  // Excludes languages supported by 2.6 but not 02 (e.g. Bulgarian, Danish, etc.)
  const WAVESPEED_SAFE_LANGUAGES = [
    "Chinese", "Chinese,Yue", "English", "Arabic", "Russian", "Spanish", "French", "Portuguese",
    "German", "Turkish", "Dutch", "Ukrainian", "Vietnamese", "Indonesian", "Japanese", "Italian",
    "Korean", "Thai", "Polish", "Romanian", "Greek", "Czech", "Finnish", "Hindi", "auto"
  ];

  // Sanitize language_boost for Wavespeed
  if (input.language_boost && !WAVESPEED_SAFE_LANGUAGES.includes(input.language_boost)) {
    logger.warn({
      original: input.language_boost,
      voiceId
    }, 'Language boost not supported by Wavespeed, falling back to auto');
    input.language_boost = 'auto';
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

  const response = await Promise.race([
    axios(requestConfig),
    timeoutPromise
  ]);

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
    return audioUrl;
  } else if (data.status === 'failed') {
    logger.error({ result, endpoint: WAVESPEED_ENDPOINT }, 'Wavespeed AI returned failed status.');

    // Provide specific error messages based on the failure reason
    if (data.error && data.error.includes("you don't have access to this voice_id")) {
      throw new Error(`Voice access denied: The voice "${voiceId}" requires special access permissions. Please try a different voice.`);
    }

    if (data.error && data.error.includes("voice_id")) {
      throw new Error(`Invalid voice: "${voiceId}" is not available. Please check the voice ID and try again.`);
    }

    throw new Error(`TTS generation failed: ${data.error || 'Unknown error'}`);
  } else {
    // In sync mode, we should always get completed or failed status
    logger.error({ result, endpoint: WAVESPEED_ENDPOINT }, 'Wavespeed AI returned unexpected status or missing outputs.');
    throw new Error(`Wavespeed AI API returned unexpected response format. Status: ${data.status || 'unknown'}`);
  }
}

/**
 * Internal function to attempt TTS generation via 302.ai
 */
async function attemptGeneration302(text, voiceId, options = {}) {
  const apiKey = config.tts.t302ApiKey;
  if (!apiKey) {
    throw new Error('302.ai API key is missing');
  }

  const T302_TIMEOUT_MS = 30000; // 30 seconds
  const timeoutPromise = new Promise((_, reject) => {
    setTimeout(() => reject(new Error('302.ai API request timed out')), T302_TIMEOUT_MS);
  });

  const input = {
    model: 'speech-2.6-turbo',
    text,
    stream: false,
    voice_setting: {
      voice_id: voiceId,
      speed: options.speed ?? TTS_SPEED_DEFAULT,
      vol: options.volume ?? 1.0,
      pitch: options.pitch ?? TTS_PITCH_DEFAULT,
      emotion: mapEmotion(options.emotion ?? config.tts?.defaultEmotion ?? 'neutral'),
      text_normalization: options.englishNormalization !== undefined ? options.englishNormalization : false,
    },
    audio_setting: {
      sample_rate: options.sampleRate ?? 32000,
      bitrate: options.bitrate ?? 128000,
      format: options.format ?? 'mp3',
      channel: options.channel === 'mono' ? 1 : options.channel === 'stereo' ? 2 : 1,
    },
    language_boost: mapLanguageBoost(options.languageBoost ?? config.tts?.defaultLanguageBoost ?? 'auto'),
    output_format: 'url'
  };

  const requestConfig = {
    method: 'POST',
    url: T302_ENDPOINT,
    headers: {
      'Authorization': `Bearer ${T302_API_KEY}`,
      'Content-Type': 'application/json'
    },
    data: input
  };

  if (options.signal) {
    requestConfig.signal = options.signal;
  }

  const response = await Promise.race([
    axios(requestConfig),
    timeoutPromise
  ]);

  if (options.signal && options.signal.aborted) {
    logger.info({ endpoint: T302_ENDPOINT, text }, '302.ai request was aborted while awaiting.');
    throw new DOMException('Aborted by user', 'AbortError');
  }

  const result = response.data;

  // 302.ai response structure check
  if (result.data && result.data.url) {
    const audioUrl = result.data.url;
    logger.info({ outputUrl: audioUrl }, 'TTS audio generated successfully via 302.ai');
    return audioUrl;
  } else if (result.data && result.data.audio) {
    // Some endpoints return 'audio' instead of 'url'
    const audioUrl = result.data.audio;
    logger.info({ outputUrl: audioUrl }, 'TTS audio generated successfully via 302.ai (audio field)');
    return audioUrl;
  } else if (result.url) {
    // Some endpoints might return url directly
    const audioUrl = result.url;
    logger.info({ outputUrl: audioUrl }, 'TTS audio generated successfully via 302.ai (direct url)');
    return audioUrl;
  } else {
    logger.error({ result, endpoint: T302_ENDPOINT }, '302.ai returned unexpected response format.');
    throw new Error(`302.ai API returned unexpected response format: ${JSON.stringify(result)}`);
  }
}

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
    volume: options.volume ?? 1.0,
    pitch: options.pitch ?? TTS_PITCH_DEFAULT,
    emotion: mapEmotion(options.emotion ?? config.tts?.defaultEmotion ?? 'neutral'),
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
    try {
      let audioUrl;
      if (is302) {
        // If this is a retry and the provider is 302, we might want to fallback to Wavespeed
        // But only if the voice is actually supported by Wavespeed (which they all are currently)
        if (attempt > 0) {
          logger.warn({ text: text.substring(0, 30) }, 'Falling back to Wavespeed API after 302.ai failure');
          audioUrl = await attemptGeneration(text, voiceId, input, options);
        } else {
          audioUrl = await attemptGeneration302(text, voiceId, options);
        }
      } else {
        audioUrl = await attemptGeneration(text, voiceId, input, options);
      }

      // Log successful retry
      if (attempt > 0) {
        logger.info({ attempt, text: text.substring(0, 30), provider: is302 && attempt > 0 ? 'wavespeed (fallback)' : provider }, 'TTS generation succeeded after retry');
      }

      return audioUrl;
    } catch (error) {
      lastError = error;

      // Don't retry on abort
      if (error.name === 'AbortError' || error.name === 'CanceledError') {
        logger.info({ text, endpoint }, `${provider} API call aborted in generateSpeech.`);
        throw error;
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
