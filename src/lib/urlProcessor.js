// src/lib/urlProcessor.js
import logger from './logger.js';

/**
 * Regular expression to match URLs (full protocol or domain.tld pattern)
 * Matches both:
 * - Full URLs with protocol: http://example.com, https://www.site.com/path
 * - Domains without protocol: example.com, www.domain.org
 */
const URL_REGEX = /(https?:\/\/\S+|\b\w+\.[a-z]{2,}\b)/gi;

/**
 * Extracts a human-readable domain name from a URL string
 * @param {string} url - The URL to process
 * @returns {string} - A speech-friendly domain name
 * 
 * Examples:
 * - "https://www.google.com/search?q=test" -> "google dot com"
 * - "some-cool-site.org" -> "some cool site dot org"
 * - "www.example.co.uk" -> "example dot co dot uk"
 */
export function extractDomainForSpeech(url) {
    try {
        let domain = url;
        
        // Remove protocol if present
        domain = domain.replace(/^https?:\/\//, '');
        
        // Remove www. prefix
        domain = domain.replace(/^www\./, '');
        
        // Remove path, query params, and hash
        domain = domain.split('/')[0];
        domain = domain.split('?')[0];
        domain = domain.split('#')[0];
        
        // Replace hyphens and underscores with spaces for more natural speech
        domain = domain.replace(/[-_]/g, ' ');
        
        // Replace dots with " dot " for speech
        domain = domain.replace(/\./g, ' dot ');
        
        // Clean up multiple spaces
        domain = domain.replace(/\s+/g, ' ').trim();
        
        return domain;
    } catch (error) {
        logger.error({ err: error, url }, 'Error extracting domain from URL');
        return url; // Fallback to original if processing fails
    }
}

/**
 * Processes a message to replace URLs with speech-friendly domain names
 * @param {string} message - The original message text
 * @param {boolean} readFullUrls - If true, leaves URLs unchanged. If false, replaces with domain names.
 * @returns {string} - The processed message
 */
export function processMessageUrls(message, readFullUrls = false) {
    if (!message || typeof message !== 'string') {
        return message;
    }
    
    // If readFullUrls is true, return the message as-is
    if (readFullUrls) {
        return message;
    }
    
    // Replace all URLs with speech-friendly domain names
    const processed = message.replace(URL_REGEX, (match) => {
        const speechFriendly = extractDomainForSpeech(match);
        logger.debug({ original: match, processed: speechFriendly }, 'URL replacement in TTS message');
        return speechFriendly;
    });
    
    return processed;
}

/**
 * Checks if a message contains any URLs
 * @param {string} message - The message to check
 * @returns {boolean} - True if the message contains URLs
 */
export function containsUrl(message) {
    if (!message || typeof message !== 'string') {
        return false;
    }
    // Create a new regex instance to avoid state issues with global flag
    const urlTest = /(https?:\/\/\S+|\b\w+\.[a-z]{2,}\b)/i;
    return urlTest.test(message);
}
