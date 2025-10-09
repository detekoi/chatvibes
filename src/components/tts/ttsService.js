// src/components/tts/ttsService.js
import Replicate from 'replicate';
import logger from '../../lib/logger.js';
import config from '../../config/index.js';
import { TTS_SPEED_DEFAULT, TTS_PITCH_DEFAULT } from './ttsConstants.js'; // Ensure these are available

const replicate = new Replicate({ auth: config.tts.replicateApiToken });
const REPLICATE_MODEL = config.tts.replicateModel;

let cachedVoiceList = null;
let lastVoiceListFetchTime = 0;
const VOICE_LIST_CACHE_DURATION = 60 * 60 * 1000; 

export async function generateSpeech(text, voiceId = config.tts?.defaultVoiceId || 'Friendly_Person', options = {}) {
  logger.info({
    logKey: "TTS_GENERATE_SPEECH_CALLED",
    textToGenerate: text,
    voiceIdForTTS: voiceId,
    optionsSummary: { speed: options.speed, pitch: options.pitch, emotion: options.emotion, languageBoost: options.languageBoost },
    timestamp_ms: Date.now()
  }, `TTS_GENERATE_SPEECH_CALLED for text: "${text.substring(0, 30)}...", Voice: ${voiceId}`);

  const input = {
    text,
    voice_id: voiceId,
    speed: options.speed ?? TTS_SPEED_DEFAULT,
    volume: options.volume ?? 1.0,
    pitch: options.pitch ?? TTS_PITCH_DEFAULT,
    emotion: options.emotion ?? config.tts?.defaultEmotion ?? 'auto',
    language_boost: options.languageBoost ?? config.tts?.defaultLanguageBoost ?? 'Automatic',
    english_normalization: options.englishNormalization !== undefined
        ? options.englishNormalization
        : false,
    sample_rate: options.sampleRate ?? 32000,
    bitrate: options.bitrate ?? 128000,
    channel: options.channel ?? 'mono',
    // ...options // This spread can be problematic if options contains 'signal'
  };
   // Explicitly apply options that are part of the schema, avoiding spread of 'signal'
   if (options.languageBoost) input.language_boost = options.languageBoost;
   if (options.englishNormalization !== undefined) input.english_normalization = options.englishNormalization;
   // Add other overridable options here if necessary


  logger.debug({ input, model: REPLICATE_MODEL }, 'Sending TTS request to Replicate');

  const runOptions = { input };
  if (options.signal) {
    runOptions.signal = options.signal;
  }

  // Add timeout to prevent hanging indefinitely
  const REPLICATE_TIMEOUT_MS = 60000; // 60 seconds
  const timeoutPromise = new Promise((_, reject) => {
    setTimeout(() => reject(new Error('Replicate API request timed out')), REPLICATE_TIMEOUT_MS);
  });

  try {
    const output = await Promise.race([
      replicate.run(REPLICATE_MODEL, runOptions),
      timeoutPromise
    ]);

    // Check if the request was aborted *during* the replicate.run call
    if (options.signal && options.signal.aborted) {
      logger.info({ model: REPLICATE_MODEL, text }, 'Replicate run was aborted while awaiting.');
      throw new DOMException('Aborted by user', 'AbortError'); // Standard way to signal abortion
    }

    if (typeof output === 'string' && output.startsWith('https://')) {
        logger.info({ outputUrl: output }, 'TTS audio generated successfully');
        return output;
    } else {
        logger.error({ outputReceived: output, model: REPLICATE_MODEL }, 'Replicate returned unexpected output format.');
        throw new Error('Replicate API returned an unexpected output format.');
    }
  } catch (error) {
    if (error.name === 'AbortError') { // Catch standard AbortError
        logger.info({ text, model: REPLICATE_MODEL }, 'Replicate API call aborted in generateSpeech.');
        throw error; // Re-throw to be caught by processQueue
    }
    // Log other errors
    const logError = { message: error.message, name: error.name, stack: error.stack, response: error.response?.data };
    logger.error({ err: logError, text, model: REPLICATE_MODEL }, 'Replicate API error in generateSpeech');
    throw new Error(`Failed to generate speech via Replicate API: ${error.message}`);
  }
}

// ... (rest of ttsService.js: _fetchAndParseVoiceList, getAvailableVoices)
async function _fetchAndParseVoiceList() {
    const url = 'https://replicate.com/minimax/speech-02-turbo/llms.txt';
    logger.info(`Fetching voice list from ${url}`);
    try {
        const res = await fetch(url); // Ensure fetch is available (Node 18+) or use a library
        if (!res.ok) {
            throw new Error(`Failed to load voice list: ${res.status} ${res.statusText}`);
        }

        const raw = await res.text();
        const lines = raw.split('\n');
        let allFoundVoiceIds = new Set();

        const mainListHeaderString = '> ## MiniMax TTS Voice List'; 
        const mainListStartIndex = lines.findIndex(line => line.trim() === mainListHeaderString);

        if (mainListStartIndex === -1) {
            logger.warn(`Main voice list header "[${mainListHeaderString}]" not found. Voice list will be empty.`);
        } else {
            logger.info(`Found main voice list header at line index: ${mainListStartIndex}`);
            for (let i = mainListStartIndex + 1; i < lines.length; i++) {
                const trimmed = lines[i].trim();
                if (trimmed.startsWith('> - ')) { 
                    allFoundVoiceIds.add(trimmed.substring(4).trim()); 
                } else if (trimmed.startsWith('- ')) { 
                     allFoundVoiceIds.add(trimmed.substring(2).trim());
                } else if (trimmed === '' || trimmed === '>') { 
                    continue;
                } else if (trimmed.startsWith('#') || trimmed.startsWith('> #')) { 
                    break;
                }
            }
        }

        if (allFoundVoiceIds.size === 0) {
            logger.warn('No voice IDs found after parsing in llms.txt.');
            cachedVoiceList = [];
            return [];
        }

        cachedVoiceList = Array.from(allFoundVoiceIds).map(id => {
            const name = id
                .replace(/[_-]/g, ' ')
                .replace(/\b\w/g, chr => chr.toUpperCase());

            let language = 'Unknown';
            if (id.includes('_')) {
                const parts = id.split('_');
                if (parts.length > 1 && /^[A-Z]/.test(parts[0])) { 
                    language = parts[0].replace(/\s\($/, '('); 
                }
            } else if (id.toLowerCase().includes('english')) language = 'English';
            // ... (other language heuristics)
            else if (id.toLowerCase().includes('chinese')) language = 'Chinese';
            else if (id.toLowerCase().includes('japanese')) language = 'Japanese';
            else if (id.toLowerCase().includes('korean')) language = 'Korean';
            else if (id.toLowerCase().includes('spanish')) language = 'Spanish';
            else if (id.toLowerCase().includes('portuguese')) language = 'Portuguese';


            return {
                id,
                name,
                language, 
                type: 'Pre-trained' 
            };
        });

        lastVoiceListFetchTime = Date.now();
        logger.info(`Successfully fetched and parsed ${cachedVoiceList.length} unique voices in total.`);
        return cachedVoiceList;

    } catch (error) {
        logger.error({ err: error }, 'Failed to fetch or parse voice list from Replicate.');
        return cachedVoiceList || []; 
    }
}

export async function getAvailableVoices(forceRefresh = false) {
    const now = Date.now();
    if (forceRefresh || !cachedVoiceList || (now - lastVoiceListFetchTime > VOICE_LIST_CACHE_DURATION)) {
        logger.info(forceRefresh ? 'Forcing voice list refresh.' : 'Voice list cache stale or empty, fetching...');
        return await _fetchAndParseVoiceList();
    }
    logger.debug('Returning cached voice list.');
    return cachedVoiceList;
}