// src/lib/emotes/emoteImageFetcher.js
// Fetches emote images from the Twitch CDN and extracts GIF frames via sharp.
import sharp from 'sharp';
import config from '../../config/index.js';
import logger from '../logger.js';

const { cdnUrl, maxGifFrames } = config.emote;
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
 * Fetch an animated emote GIF and extract evenly-spaced frames as PNG buffers.
 * Sharp uses native libvips for fast GIF decoding with automatic frame coalescing.
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
        const metadata = await sharp(gifBuffer, { animated: true }).metadata();
        const { pages } = metadata;

        if (!pages || pages <= 1) {
            // Not animated or single frame — return as static PNG
            const data = await sharp(gifBuffer).png().toBuffer();
            logger.info({ emoteId, fetchMs, extractMs: Date.now() - extractStart, totalMs: Date.now() - pipelineStart, pages: pages || 1 }, 'Animated emote single frame extracted');
            return [{ data, mimeType: 'image/png' }];
        }

        // Compute evenly-spaced frame indices (first, middle, last)
        const sampleCount = Math.min(maxGifFrames, pages);
        const selectedIndices = [];
        for (let i = 0; i < sampleCount; i++) {
            selectedIndices.push(Math.floor(i * (pages - 1) / Math.max(sampleCount - 1, 1)));
        }

        // Extract each selected frame (sharp's page option selects a single GIF page directly)
        const frameBuffers = await Promise.all(
            selectedIndices.map(async (frameIdx) => {
                const data = await sharp(gifBuffer, { page: frameIdx })
                    .png()
                    .toBuffer();
                return { data, mimeType: 'image/png' };
            })
        );

        const extractMs = Date.now() - extractStart;
        const totalMs = Date.now() - pipelineStart;
        logger.info({ emoteId, fetchMs, extractMs, totalMs, totalFrames: pages, sampledFrames: frameBuffers.length, frameIndices: selectedIndices }, 'Animated emote frames extracted');
        return frameBuffers;
    } catch (error) {
        logger.info({ err: error.message, emoteId, pipelineMs: Date.now() - pipelineStart }, 'Error extracting animated emote frames');
        return null;
    }
}
