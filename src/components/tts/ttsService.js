// src/components/tts/ttsService.js
import Replicate from 'replicate';
import logger from '../../lib/logger.js';
import config from '../../config/index.js';

const replicate = new Replicate({ auth: config.replicateApiKey }); // Ensure config.replicateApiKey is defined
const MODEL_NAME = "minimax/speech-02-turbo"; // IMPORTANT: Pin this to a specific version hash from Replicate

let cachedVoiceList = null;
let lastVoiceListFetchTime = 0;
const VOICE_LIST_CACHE_DURATION = 60 * 60 * 1000; // Cache for 1 hour (in milliseconds)

export async function generateSpeech(text, voiceId = config.tts?.defaultVoiceId || 'Friendly_Person', options = {}) {
  const input = {
    text,
    voice_id: voiceId,
    speed: options.speed ?? 1.0,
    volume: options.volume ?? 1.0,
    pitch: options.pitch ?? 0,
    emotion: options.emotion ?? 'neutral',
    english_normalization: options.englishNormalization ?? true,
    sample_rate: options.sampleRate ?? 32000,
    bitrate: options.bitrate ?? 128000,
    channel: options.channel ?? 'mono',
    language_boost: options.languageBoost ?? 'English',
    ...options
  };

  logger.debug({ input }, 'Sending TTS request to Replicate');
  try {
    const output = await replicate.run(MODEL_NAME, { input });
    // The output from this model is directly the URL string.
    if (typeof output === 'string' && output.startsWith('https://')) {
        logger.info({ outputUrl: output }, 'TTS audio generated successfully');
        return output;
    } else {
        logger.error({ outputReceived: output }, 'Replicate returned unexpected output format.');
        throw new Error('Replicate API returned an unexpected output format.');
    }
  } catch (error) {
    logger.error({ err: error, text }, 'Replicate API error in generateSpeech');
    throw new Error('Failed to generate speech via Replicate API.');
  }
}

/**
 * Fetches and parses the MiniMax TTS Voice List from the Replicate llms.txt file.
 * This function is responsible for the actual fetching and parsing.
 */
async function _fetchAndParseVoiceList() {
    const url = 'https://replicate.com/minimax/speech-02-turbo/llms.txt';
    logger.info(`Workspaceing voice list from ${url}`);
    try {
        const res = await fetch(url);
        if (!res.ok) {
          throw new Error(`Failed to load voice list: ${res.status} ${res.statusText}`);
        }

        const raw = await res.text();
        const lines = raw.split('\n');

        const header = '## MiniMax TTS Voice List';
        const startIdx = lines.findIndex(line => line.trim() === header);
        if (startIdx === -1) {
          logger.warn('Voice-list header not found in llms.txt. Unable to parse voices.');
          return []; // Return empty if header not found
        }

        const voiceIds = [];
        for (let i = startIdx + 1; i < lines.length; i++) {
          const trimmed = lines[i].trim();
          if (trimmed.startsWith('- ')) {
            voiceIds.push(trimmed.slice(2).trim()); // strip "- " and any trailing space
          } else if (trimmed === '') {
            continue; // skip blank lines
          } else if (trimmed.startsWith('#')) { // Stop if another header or comment section starts
            break;
          } else if (trimmed && !trimmed.startsWith('-')) { // Stop on any other non-bullet, non-empty line
            break;
          }
        }

        if (voiceIds.length === 0) {
            logger.warn('No voice IDs found after the header in llms.txt.');
            return [];
        }

        cachedVoiceList = voiceIds.map(id => {
          const name = id
            .replace(/[_-]/g, ' ')
            .replace(/\b\w/g, chr => chr.toUpperCase());

          const langPartMatch = id.match(/^([a-zA-Z\s\(\)]+?)(?:_|$)/);
          const language = langPartMatch && langPartMatch[1] ? langPartMatch[1].replace(/\s\($/, '(') : 'Unknown';


          return {
            id,
            name,
            language,
            type: 'Pre-trained' // As per your parsing logic
          };
        });
        lastVoiceListFetchTime = Date.now();
        logger.info(`Successfully fetched and parsed ${cachedVoiceList.length} voices.`);
        return cachedVoiceList;

    } catch (error) {
        logger.error({ err: error }, 'Failed to fetch or parse voice list from Replicate.');
        // In case of error, don't wipe a potentially stale cache if it exists
        return cachedVoiceList || []; // Return existing cache or empty array
    }
}

/**
 * Retrieves the available voice list, using a cached version if available and not stale.
 * This is the primary function other components should use to get the voice list.
 * @param {boolean} forceRefresh - If true, bypasses cache and fetches fresh list.
 * @returns {Promise<Array<{id: string, name: string, language: string, type: string}>>}
 */
export async function getAvailableVoices(forceRefresh = false) {
    const now = Date.now();
    if (forceRefresh || !cachedVoiceList || (now - lastVoiceListFetchTime > VOICE_LIST_CACHE_DURATION)) {
        logger.info(forceRefresh ? 'Forcing voice list refresh.' : 'Voice list cache stale or empty, fetching...');
        return await _fetchAndParseVoiceList();
    }
    logger.debug('Returning cached voice list.');
    return cachedVoiceList;
}

// Initialize the voice list cache on module load (optional, or lazy load on first call to getAvailableVoices)
// _fetchAndParseVoiceList().catch(err => logger.error({ err }, "Initial voice list fetch failed."));
// It's often better to lazy load or have a dedicated init function if startup time is critical.
// For Cloud Run, fetching during the first request (lazy loading) that needs it is acceptable.