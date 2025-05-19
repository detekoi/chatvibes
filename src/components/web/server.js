const http = require('http');
const path = require('path');
const fs = require('fs');
const WebSocket = require('ws');

const PUBLIC_DIR = path.join(__dirname, '../../../public');
const PORT = process.env.PORT || 8080;

// Serve static files (index.html, tts-player.js)
const server = http.createServer((req, res) => {
  let filePath = req.url;
  if (filePath === '/' || filePath === '') {
    filePath = '/index.html';
  }
  const fullPath = path.join(PUBLIC_DIR, filePath);

  fs.readFile(fullPath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('404 Not Found');
      return;
    }
    // Basic content type handling
    let contentType = 'text/html';
    if (filePath.endsWith('.js')) contentType = 'application/javascript';
    if (filePath.endsWith('.css')) contentType = 'text/css';
    if (filePath.endsWith('.json')) contentType = 'application/json';
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(data);
  });
});

// WebSocket server
const wss = new WebSocket.Server({ server });

// Map of channelName -> Set of WebSocket clients
const channelClients = new Map();

wss.on('connection', (ws, req) => {
  // Expect the client to send a message with the channel name after connecting
  let channelName = null;

  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message);
      if (data.type === 'register' && data.channel) {
        channelName = data.channel;
        if (!channelClients.has(channelName)) {
          channelClients.set(channelName, new Set());
        }
        channelClients.get(channelName).add(ws);
        ws.send(JSON.stringify({ type: 'registered', channel: channelName }));
      }
    } catch (e) {
      // Ignore malformed messages
    }
  });

  ws.on('close', () => {
    if (channelName && channelClients.has(channelName)) {
      channelClients.get(channelName).delete(ws);
      if (channelClients.get(channelName).size === 0) {
        channelClients.delete(channelName);
      }
    }
  });
});

function sendAudioToChannel(channelName, audioUrl) {
  const clients = channelClients.get(channelName);
  if (!clients) return;
  const message = JSON.stringify({
    type: audioUrl === 'STOP_CURRENT_AUDIO' ? 'stop' : 'play',
    url: audioUrl !== 'STOP_CURRENT_AUDIO' ? audioUrl : undefined,
  });
  for (const ws of clients) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(message);
    }
  }
}

module.exports = {
  server,
  sendAudioToChannel,
};

// Start server if run directly
if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`Server listening on http://localhost:${PORT}`);
  });
}
