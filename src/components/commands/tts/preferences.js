// src/components/commands/tts/preferences.js
import { enqueueMessage } from '../../../lib/ircSender.js';
import { getTtsState } from '../../tts/ttsState.js';
import jwt from 'jsonwebtoken';
import axios from 'axios';

const VIEWER_PAGE_BASE = process.env.WEB_UI_BASE_URL || 'https://chatvibestts.web.app';
const JWT_SECRET_KEY = process.env.JWT_SECRET_KEY;

if (!JWT_SECRET_KEY) {
    console.error('JWT_SECRET_KEY environment variable is required for preferences command');
}

/**
 * Creates a signed JWT token for viewer settings access
 * @param {string} channel - Channel name (without #)
 * @param {string} viewer - Viewer username
 * @returns {string} - Signed JWT token
 */
function createSignedToken(channel, viewer) {
    return jwt.sign(
        { 
            ch: channel, 
            usr: viewer, 
            typ: 'prefs',
            requiresTwitchAuth: true, // Force Twitch authentication for security
            iat: Math.floor(Date.now() / 1000) // Issued at time
        },
        JWT_SECRET_KEY,
        { 
            expiresIn: '10m',
            issuer: 'chatvibes-auth',
            audience: 'chatvibes-ws'
        }
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
        // Call the web UI's short link creation API (now requires Authorization header)
        const response = await axios.post(`${VIEWER_PAGE_BASE}/api/shortlink`, {
            url: longUrl
        }, {
            timeout: 5000,  // 5 second timeout
            headers: {
                'Authorization': `Bearer ${token}`
            }
        });
        
        console.log('Short link response:', response.status, response.data);
        
        if (response.data) {
            const out = response.data.absoluteUrl || response.data.shortUrl;
            if (out) {
                console.log('Successfully created short link:', out);
                return out;
            }
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
        const { channel, user, replyToId } = context;
        const channelNameNoHash = channel.substring(1).toLowerCase();
        const username = user.username;

        try {
            const ttsState = await getTtsState(channelNameNoHash);
            if (ttsState && ttsState.allowViewerPreferences === false) {
                enqueueMessage(channel, `The streamer has disabled personal voice settings for this channel.`, { replyToId });
                return;
            }
        } catch (e) {
            // If fetching state fails, proceed without blocking, but log to console
            console.error('Failed to fetch TTS state for allowViewerPreferences check:', e);
        }

        if (!JWT_SECRET_KEY) {
            console.error('JWT_SECRET_KEY not found in environment. Available env keys:', Object.keys(process.env).filter(k => k.includes('JWT')));
            enqueueMessage(channel, `Viewer preferences are temporarily unavailable. Please try again later.`, { replyToId });
            return;
        }

        try {
            const settingsUrl = await createViewerSettingsLink(channelNameNoHash, username);
            enqueueMessage(channel, `Configure your TTS settings here → ${settingsUrl}`, { replyToId });
        } catch (error) {
            console.error('Error creating viewer preferences link:', error);
            enqueueMessage(channel, `Unable to generate preferences link. Please try again later.`, { replyToId });
        }
    },
};