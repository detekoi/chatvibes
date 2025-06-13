// src/components/commands/tts/preferences.js
import { enqueueMessage } from '../../../lib/ircSender.js';
import jwt from 'jsonwebtoken';
import axios from 'axios';

const VIEWER_PAGE_BASE = process.env.WEB_UI_BASE_URL || 'https://chatvibestts.web.app';
const JWT_SECRET = process.env.JWT_SECRET_KEY;

if (!JWT_SECRET) {
    console.error('JWT_SECRET environment variable is required for preferences command');
}

/**
 * Creates a signed JWT token for viewer settings access
 * @param {string} channel - Channel name (without #)
 * @param {string} viewer - Viewer username
 * @returns {string} - Signed JWT token
 */
function createSignedToken(channel, viewer) {
    return jwt.sign(
        { ch: channel, usr: viewer, typ: 'prefs' },
        JWT_SECRET,
        { expiresIn: '10m' }
    );
}

/**
 * Creates a short link for viewer preferences via the web UI API
 * @param {string} channel - Channel name
 * @param {string} viewer - Viewer username
 * @returns {Promise<string>} - Short link URL
 */
async function createViewerSettingsLink(channel, viewer) {
    const token = createSignedToken(channel, viewer);
    const longUrl = `${VIEWER_PAGE_BASE}/viewer-settings.html?channel=${encodeURIComponent(channel)}&token=${token}`;
    
    try {
        console.log('Attempting to create short link for:', longUrl);
        // Call the web UI's short link creation API (no auth required for this endpoint)
        const response = await axios.post(`${VIEWER_PAGE_BASE}/api/shortlink`, {
            url: longUrl
        }, {
            timeout: 5000  // 5 second timeout
        });
        
        console.log('Short link response:', response.status, response.data);
        
        if (response.data && response.data.shortUrl) {
            console.log('Successfully created short link:', response.data.shortUrl);
            return response.data.shortUrl;
        } else {
            throw new Error('No shortUrl in response');
        }
    } catch (error) {
        console.error('Failed to create short link, using long URL:', error.message);
        if (error.response) {
            console.error('Response status:', error.response.status);
            console.error('Response data:', error.response.data);
        }
        // Fallback to long URL if short link service fails
        return longUrl;
    }
}

export default {
    name: 'preferences',
    description: 'Get a link to customize your personal TTS settings for this channel',
    usage: '!tts preferences',
    aliases: ['prefs'],
    permission: 'everyone',
    execute: async (context) => {
        const { channel, user, ircClient } = context;
        const channelNameNoHash = channel.substring(1).toLowerCase();
        const username = user.username;
        const displayName = user['display-name'] || username;

        if (!JWT_SECRET) {
            console.error('JWT_SECRET_KEY not found in environment. Available env keys:', Object.keys(process.env).filter(k => k.includes('JWT')));
            enqueueMessage(channel, `@${displayName}, Viewer preferences are temporarily unavailable. Please try again later.`);
            return;
        }

        try {
            const settingsUrl = await createViewerSettingsLink(channelNameNoHash, username);
            enqueueMessage(channel, `@${displayName} configure your TTS settings here → ${settingsUrl}`);
        } catch (error) {
            console.error('Error creating viewer preferences link:', error);
            enqueueMessage(channel, `@${displayName}, Unable to generate preferences link. Please try again later.`);
        }
    },
};