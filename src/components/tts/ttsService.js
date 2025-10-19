// src/components/tts/ttsService.js
import axios from 'axios';
import logger from '../../lib/logger.js';
import config from '../../config/index.js';
import { TTS_SPEED_DEFAULT, TTS_PITCH_DEFAULT } from './ttsConstants.js';
import { getAllVoices, getVoicesByLanguage } from './wavespeedVoices.js';

const WAVESPEED_API_KEY = config.tts.wavespeedApiKey;
const WAVESPEED_ENDPOINT = config.tts.wavespeedEndpoint;

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

  logger.debug({ input, endpoint: WAVESPEED_ENDPOINT }, 'Sending TTS request to Wavespeed AI');

  // Add timeout to prevent hanging indefinitely
  const WAVESPEED_TIMEOUT_MS = 60000; // 60 seconds
  const timeoutPromise = new Promise((_, reject) => {
    setTimeout(() => reject(new Error('Wavespeed AI API request timed out')), WAVESPEED_TIMEOUT_MS);
  });

  try {
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
        throw new Error(`Wavespeed AI returned failed status for TTS generation: ${data.error || 'Unknown error'}`);
    } else {
        // In sync mode, we should always get completed or failed status
        logger.error({ result, endpoint: WAVESPEED_ENDPOINT }, 'Wavespeed AI returned unexpected status or missing outputs.');
        throw new Error(`Wavespeed AI API returned unexpected response format. Status: ${data.status || 'unknown'}`);
    }
  } catch (error) {
    if (error.name === 'AbortError' || error.name === 'CanceledError') {
        logger.info({ text, endpoint: WAVESPEED_ENDPOINT }, 'Wavespeed AI API call aborted in generateSpeech.');
        throw error;
    }

    // Log detailed error information
    const logError = {
        message: error.message,
        name: error.name,
        stack: error.stack,
        response: error.response?.data
    };
    logger.error({ err: logError, text, endpoint: WAVESPEED_ENDPOINT }, 'Wavespeed AI API error in generateSpeech');
    throw new Error(`Failed to generate speech via Wavespeed AI API: ${error.message}`);
  }
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
