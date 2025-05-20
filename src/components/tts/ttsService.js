// src/components/tts/ttsService.js
import Replicate from 'replicate';
import logger from '../../lib/logger.js';
import config from '../../config/index.js';
import { TTS_SPEED_DEFAULT, TTS_PITCH_DEFAULT } from './ttsConstants.js';

const replicate = new Replicate({ auth: config.tts.replicateApiToken });
const REPLICATE_MODEL = config.tts.replicateModel;

let cachedVoiceList = null;
let lastVoiceListFetchTime = 0;
const VOICE_LIST_CACHE_DURATION = 60 * 60 * 1000; // Cache for 1 hour (in milliseconds)

export async function generateSpeech(text, voiceId = config.tts?.defaultVoiceId || 'Friendly_Person', options = {}) {
  const input = {
    text,
    voice_id: voiceId,
    speed: options.speed ?? TTS_SPEED_DEFAULT,
    volume: options.volume ?? 1.0,
    pitch: options.pitch ?? TTS_PITCH_DEFAULT,
    emotion: options.emotion ?? config.tts?.defaultEmotion ?? 'auto',
    language_boost: options.languageBoost ?? config.tts?.defaultLanguageBoost ?? 'Automatic',
    english_normalization: options.englishNormalization ?? true,
    sample_rate: options.sampleRate ?? 32000,
    bitrate: options.bitrate ?? 128000,
    channel: options.channel ?? 'mono',
    language_boost: options.languageBoost ?? 'English',
    ...options
  };

  logger.debug({ input, model: REPLICATE_MODEL }, 'Sending TTS request to Replicate');
  try {
    const output = await replicate.run(REPLICATE_MODEL, { input });
    if (typeof output === 'string' && output.startsWith('https://')) {
        logger.info({ outputUrl: output }, 'TTS audio generated successfully');
        return output;
    } else {
        logger.error({ outputReceived: output, model: REPLICATE_MODEL }, 'Replicate returned unexpected output format.');
        throw new Error('Replicate API returned an unexpected output format.');
    }
  } catch (error) {
    logger.error({ err: error, text, model: REPLICATE_MODEL }, 'Replicate API error in generateSpeech');
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
        let allFoundVoiceIds = new Set(); // Use a Set to avoid duplicates

        // --- 1. Parse System Voice IDs from "Model inputs" section ---
        const voiceIdInputHeader = '- voice_id:';
        const voiceIdInputLineIndex = lines.findIndex(line => line.trim().startsWith(voiceIdInputHeader));

        if (voiceIdInputLineIndex !== -1) {
            const lineContent = lines[voiceIdInputLineIndex];
            // Extract text between "system voice IDs: " and " (string)"
            const systemVoicesMatch = lineContent.match(/system voice IDs:\s*([^)]+)\s*\(/i);
            if (systemVoicesMatch && systemVoicesMatch[1]) {
                const systemVoiceChunk = systemVoicesMatch[1];
                systemVoiceChunk.split(',')
                    .map(v => v.trim())
                    .filter(v => v) // Remove any empty strings
                    .forEach(vId => allFoundVoiceIds.add(vId));
                logger.debug(`Found ${allFoundVoiceIds.size} system voice IDs from input line.`);
            } else {
                logger.warn('Could not parse system voice IDs from the voice_id input line.');
            }
        } else {
            logger.warn('"voice_id" input line not found. Cannot parse system voices from there.');
        }

        // --- 2. Parse Main Voice List ---
        const mainListHeaderString = '> ## MiniMax TTS Voice List'; // Corrected header
        const mainListStartIndex = lines.findIndex(line => line.trim() === mainListHeaderString);

        if (mainListStartIndex === -1) {
            logger.warn(`Main voice list header "[${mainListHeaderString}]" not found. Only system voices (if any) will be available.`);
            // Optional: Log a sample if the main header is not found, similar to previous debugging
        } else {
            logger.info(`Found main voice list header at line index: ${mainListStartIndex}`);
            for (let i = mainListStartIndex + 1; i < lines.length; i++) {
                const trimmed = lines[i].trim();
                if (trimmed.startsWith('> - ')) { // Lines now start with "> - "
                    allFoundVoiceIds.add(trimmed.substring(4).trim()); // Strip "> - "
                } else if (trimmed.startsWith('- ')) { // Fallback for lines just starting with "- "
                     allFoundVoiceIds.add(trimmed.substring(2).trim());
                } else if (trimmed === '' || trimmed === '>') { // Skip blank lines or lines with only ">"
                    continue;
                } else if (trimmed.startsWith('#') || trimmed.startsWith('> #')) { // Stop if another header section starts
                    break;
                } else if (trimmed && !trimmed.startsWith('-') && !trimmed.startsWith('> -')) {
                    // If it's not empty, not a comment, and not a voice item, break.
                    // This condition might need adjustment if the file format between sections is noisy.
                    // logger.debug(`Stopping main list parsing at non-voice line: "${trimmed}"`);
                    // break; // Commenting this out as it might be too aggressive. Let it run through.
                }
            }
        }

        if (allFoundVoiceIds.size === 0) {
            logger.warn('No voice IDs found after parsing both sections in llms.txt.');
            cachedVoiceList = []; // Ensure it's an empty array
            return [];
        }

        // Convert Set to the desired array of objects format
        cachedVoiceList = Array.from(allFoundVoiceIds).map(id => {
            const name = id
                .replace(/[_-]/g, ' ')
                .replace(/\b\w/g, chr => chr.toUpperCase());

            // Attempt to extract language for system voices (simple heuristic)
            // For the main list, the format is "Language_Name" or "Language (Variant)_Name"
            let language = 'Unknown';
            if (id.includes('_')) {
                const parts = id.split('_');
                if (parts.length > 1 && /^[A-Z]/.test(parts[0])) { // If first part starts with uppercase, likely language
                    language = parts[0].replace(/\s\($/, '('); // Handle cases like "Chinese (Mandarin)"
                }
            } else if (id.toLowerCase().includes('english')) language = 'English';
            else if (id.toLowerCase().includes('chinese')) language = 'Chinese';
            else if (id.toLowerCase().includes('japanese')) language = 'Japanese';
            else if (id.toLowerCase().includes('korean')) language = 'Korean';
            else if (id.toLowerCase().includes('spanish')) language = 'Spanish';
            else if (id.toLowerCase().includes('portuguese')) language = 'Portuguese';
            // Add more language heuristics if needed for system voices

            return {
                id,
                name,
                language, // This will be more accurate for the main list items.
                type: 'Pre-trained'
            };
        });

        lastVoiceListFetchTime = Date.now();
        logger.info(`Successfully fetched and parsed ${cachedVoiceList.length} unique voices in total.`);
        return cachedVoiceList;

    } catch (error) {
        logger.error({ err: error }, 'Failed to fetch or parse voice list from Replicate.');
        return cachedVoiceList || []; // Return existing cache or empty array
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

// Initialize the voice list cache on module load (optional, or lazy load on first call to getAvailableVoices)
// _fetchAndParseVoiceList().catch(err => logger.error({ err }, "Initial voice list fetch failed."));
// It's often better to lazy load or have a dedicated init function if startup time is critical.
// For Cloud Run, fetching during the first request (lazy loading) that needs it is acceptable.