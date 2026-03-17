// src/lib/emotes/emoteImageFetcher.js
// Fetches emote images from the Twitch CDN and extracts GIF frames via sharp.
import sharp from 'sharp';
import config from '../../config/index.js';
import logger from '../logger.js';

const { cdnUrl } = config.emote;
const EMOTE_IMAGE_FORMAT = 'static/dark/3.0';
const ANIMATED_EMOTE_IMAGE_FORMAT = 'animated/dark/3.0';

/**
 * Return the static PNG URL for a Twitch emote.
 * @param {string} emoteId
 * @returns {string}
 */
export function getEmoteImageUrl(emoteId) {
    return `${cdnUrl}/${emoteId}/${EMOTE_IMAGE_FORMAT}`;
}

/**
 * Return the animated GIF URL for a Twitch emote.
 * @param {string} emoteId
 * @returns {string}
 */
export function getAnimatedEmoteUrl(emoteId) {
    return `${cdnUrl}/${emoteId}/${ANIMATED_EMOTE_IMAGE_FORMAT}`;
}

/**
 * Fetch an emote image as bytes (static PNG).
 * @param {string} emoteId
 * @returns {Promise<{data: Buffer, mimeType: string} | null>}
 */
export async function fetchEmoteImage(emoteId) {
    try {
        const url = getEmoteImageUrl(emoteId);
        const response = await fetch(url);
        if (!response.ok) {
            logger.debug({ emoteId, status: response.status }, 'Failed to fetch emote image');
            return null;
        }
        const arrayBuffer = await response.arrayBuffer();
        const contentType = response.headers.get('content-type') || 'image/png';
        // Safety check: never send GIF to Gemini (shouldn't happen with 'static' theme)
        const safeMimeType = contentType.includes('gif') ? 'image/png' : contentType;
        return {
            data: Buffer.from(arrayBuffer),
            mimeType: safeMimeType,
        };
    } catch (error) {
        logger.debug({ err: error, emoteId }, 'Error fetching emote image');
        return null;
    }
}

/**
 * Fetch an animated emote GIF and return it as a single tall vertical strip PNG.
 * All frames are stacked top-to-bottom by libvips in one decode pass and sent
 * directly to Gemini, which can interpret the full animation context from the strip.
 * @param {string} emoteId
 * @returns {Promise<Array<{data: Buffer, mimeType: string}> | null>}
 */
export async function fetchAnimatedEmoteFrames(emoteId) {
    const pipelineStart = Date.now();
    try {
        const url = getAnimatedEmoteUrl(emoteId);
        const response = await fetch(url);
        if (!response.ok) {
            logger.debug({ emoteId, status: response.status }, 'Failed to fetch animated emote GIF');
            return null;
        }
        const arrayBuffer = await response.arrayBuffer();
        const gifBuffer = Buffer.from(arrayBuffer);
        const fetchMs = Date.now() - pipelineStart;

        const extractStart = Date.now();
        // Decode the full GIF into a single tall PNG strip — all frames stacked vertically.
        // Gemini receives the strip directly and can interpret the animation from it.
        const { pages } = await sharp(gifBuffer, { animated: true }).metadata();
        const stripData = await sharp(gifBuffer, { animated: true }).png().toBuffer();
        const extractMs = Date.now() - extractStart;
        const totalMs = Date.now() - pipelineStart;

        logger.info({ emoteId, fetchMs, extractMs, totalMs, totalFrames: pages || 1 }, 'Animated emote strip extracted');
        return [{ data: stripData, mimeType: 'image/png' }];
    } catch (error) {
        logger.info({ err: error.message, emoteId, pipelineMs: Date.now() - pipelineStart }, 'Error extracting animated emote frames');
        return null;
    }
}
