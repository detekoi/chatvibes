// src/components/web/server.js
import http from 'http';
import path from 'path';
import fs from 'fs';
import { WebSocketServer } from 'ws'; // Correct import for ES Modules
import { fileURLToPath } from 'url';
import logger from '../../lib/logger.js'; // Assuming logger is in this path

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PUBLIC_DIR = path.join(__dirname, 'public'); // Corrected path to public relative to this file
const PORT = process.env.PORT || 8080;

let wssInstance = null;
const channelClients = new Map(); // channelName -> Set of WebSocket clients

const httpServer = http.createServer((req, res) => {
  let filePath = req.url;
  if (filePath === '/' || filePath === '' || filePath === '/tts-obs') { // Allow /tts-obs path
    filePath = '/index.html';
  }
  const fullPath = path.join(PUBLIC_DIR, filePath.substring(filePath.startsWith('/tts-obs') ? '/tts-obs'.length : 0)); // Adjust for /tts-obs

  const ext = path.extname(fullPath);
  let contentType = 'text/html';
  switch (ext) {
    case '.js':
      contentType = 'application/javascript';
      break;
    case '.css':
      contentType = 'text/css';
      break;
    // Add more types if needed
  }

  fs.readFile(fullPath, (err, data) => {
    if (err) {
      logger.warn(`Web server: 404 Not Found - ${req.url} (resolved to ${fullPath})`);
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('404 Not Found');
      return;
    }
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(data);
  });
});

export function initializeWebServer() {
    if (wssInstance) {
        logger.warn('ChatVibes TTS WebServer already initialized.');
        return { server: httpServer, wss: wssInstance, sendAudioToChannel };
    }

    wssInstance = new WebSocketServer({ server: httpServer });
    logger.info(`ChatVibes TTS WebSocket Server initialized and listening on HTTP server.`);

    wssInstance.on('connection', (ws, req) => {
        // A simple way for OBS to identify itself for the specific channel.
        // The channel name can be passed as a query parameter in the OBS Browser Source URL.
        // e.g., http://localhost:8080/?channel=yourchannelname
        const params = new URLSearchParams(req.url.split('?')[1] || '');
        const clientChannelName = params.get('channel')?.toLowerCase();

        if (!clientChannelName) {
            logger.warn('TTS WebSocket connection attempt without channel identifier. Closing.');
            ws.terminate();
            return;
        }
        logger.info(`TTS WebSocket client connected for channel: ${clientChannelName}`);

        if (!channelClients.has(clientChannelName)) {
            channelClients.set(clientChannelName, new Set());
        }
        channelClients.get(clientChannelName).add(ws);
        ws.send(JSON.stringify({ type: 'registered', channel: clientChannelName, message: 'Successfully registered with ChatVibes TTS WebSocket.' }));


        ws.on('message', (message) => {
            logger.debug(`Received WebSocket message from ${clientChannelName}: ${message}`);
            // Handle messages from client if needed (e.g., 'audioPlayed')
            // For now, we primarily send to the client.
        });

        ws.on('close', () => {
            logger.info(`TTS WebSocket client disconnected for channel: ${clientChannelName}`);
            if (clientChannelName && channelClients.has(clientChannelName)) {
                channelClients.get(clientChannelName).delete(ws);
                if (channelClients.get(clientChannelName).size === 0) {
                    channelClients.delete(clientChannelName);
                    logger.info(`No more TTS clients for channel: ${clientChannelName}, removing from map.`);
                }
            }
        });

        ws.on('error', (error) => {
            logger.error({ err: error, channel: clientChannelName }, 'TTS WebSocket client error.');
        });
    });
    // Start the HTTP server here after WSS is attached
     httpServer.listen(PORT, () => {
        logger.info(`ChatVibes Web Server (for TTS OBS Source) listening on http://localhost:${PORT}`);
    });

    return { server: httpServer, wss: wssInstance, sendAudioToChannel };
}

export function sendAudioToChannel(channelName, audioUrlOrCommand) {
  if (!wssInstance) {
    logger.warn('ChatVibes TTS WebSocket server not initialized. Cannot send audio.');
    return;
  }
  const lowerChannelName = channelName.toLowerCase();
  const clients = channelClients.get(lowerChannelName);

  if (!clients || clients.size === 0) {
    logger.debug(`No active TTS WebSocket clients for channel: ${lowerChannelName}. Audio not sent.`);
    return;
  }

  const messagePayload = {
    type: audioUrlOrCommand === 'STOP_CURRENT_AUDIO' ? 'stopAudio' : 'playAudio',
    url: audioUrlOrCommand !== 'STOP_CURRENT_AUDIO' ? audioUrlOrCommand : undefined,
  };
  const message = JSON.stringify(messagePayload);

  logger.debug(`Sending to ${clients.size} client(s) for channel ${lowerChannelName}: ${message}`);
  clients.forEach(ws => {
    if (ws.readyState === ws.OPEN) { // Use ws.OPEN from the WebSocket class
      ws.send(message);
    } else {
      logger.warn(`TTS WebSocket client for ${lowerChannelName} not open (state: ${ws.readyState}).`);
    }
  });
}