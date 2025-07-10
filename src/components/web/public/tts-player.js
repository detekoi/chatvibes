const audioPlayer = document.getElementById('ttsAudioPlayer');
const audioQueue = [];
let isPlaying = false;

// Determine WebSocket protocol based on current page protocol
const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
// Construct URL using current host (hostname and port)
// The channel needs to be passed as a query parameter in the OBS source URL
// e.g., http://localhost:8080/?channel=yourstreamername
const queryParams = new URLSearchParams(window.location.search);
const channelName = queryParams.get('channel');
const token = queryParams.get('token');

let wsUrl;
if (channelName) {
    if (token) {
        wsUrl = `${wsProtocol}//${window.location.host}/?channel=${channelName}&token=${token}`; // Include both channel and token
    } else {
        wsUrl = `${wsProtocol}//${window.location.host}/?channel=${channelName}`; // Fallback without token
    }
} else {
    // Fallback or error if channel name is not provided in OBS source URL
    console.error("Channel name not provided in query parameters! WebSocket cannot connect properly.");
    // Potentially display an error on the page or try a default if that makes sense for your setup
    // For now, we'll let it try to connect without it, but the server might reject.
    wsUrl = `${wsProtocol}//${window.location.host}/`;
}

console.log(`TTS WebSocket attempting to connect to: ${wsUrl}`);
let ws = null;
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 10;
const RECONNECT_DELAY_MS = 3000;

function connectWebSocket() {
    if (!channelName && wsProtocol === 'ws:') { // Only show alert for local dev if channel is missing
        alert("OBS Browser Source URL needs '?channel=yourchannelname' at the end for ChatVibes TTS to work!");
    } else if (!channelName) {
         console.error("CRITICAL: OBS Browser Source URL is missing '?channel=yourchannelname'. TTS will not function for a specific channel.");
    }

    ws = new WebSocket(wsUrl);

    ws.onopen = () => {
        console.log('TTS WebSocket connected successfully.');
        reconnectAttempts = 0; // Reset on successful connection
        // Optional: Send a registration message with the channel name if the server expects it
        // ws.send(JSON.stringify({ type: 'register', channel: channelName }));
    };

    ws.onmessage = (event) => {
        try {
            const data = JSON.parse(event.data);
            console.log('TTS WebSocket received data:', data); // Log all received data

            if (data.type === 'playAudio' && data.url) {
                audioQueue.push(data.url);
                playNextInQueue();
            } else if (data.type === 'stopAudio') {
                console.log('TTS WebSocket received stopAudio command');
                stopAllAudio();
            } else if (data.type === 'registered') {
                console.log(`TTS WebSocket registered for channel: ${data.channel}. Message: ${data.message}`);
            }
        } catch (e) {
            // This might be a direct URL string if your server doesn't always send JSON
            if (typeof event.data === 'string') {
                if (event.data.startsWith('https://') || event.data.startsWith('http://')) { // Check for http too for local testing
                    console.log('TTS WebSocket received direct audio URL:', event.data);
                    audioQueue.push(event.data);
                    playNextInQueue();
                } else if (event.data === 'STOP_CURRENT_AUDIO') {
                    console.log('TTS WebSocket received STOP_CURRENT_AUDIO command');
                    stopCurrentAudio(); // More specific stop
                } else {
                     console.warn('TTS WebSocket received non-JSON message:', event.data);
                }
            } else {
                console.error('TTS WebSocket received unparseable message:', event.data, e);
            }
        }
    };

    ws.onclose = (event) => {
        console.log(`TTS WebSocket disconnected. Code: ${event.code}, Reason: "${event.reason}". Attempting to reconnect... (Attempt ${reconnectAttempts + 1})`);
        ws = null; // Clear the instance
        if (reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
            reconnectAttempts++;
            setTimeout(connectWebSocket, RECONNECT_DELAY_MS * reconnectAttempts); // Exponential backoff-like delay
        } else {
            console.error(`TTS WebSocket: Max reconnect attempts (${MAX_RECONNECT_ATTEMPTS}) reached. Please check server and refresh OBS source.`);
        }
    };

    ws.onerror = (error) => {
        // This event usually fires before onclose when a connection fails
        console.error('TTS WebSocket error:', error);
        // onclose will handle reconnection logic
    };
}

function playNextInQueue() {
    if (isPlaying || audioQueue.length === 0) {
        return;
    }
    isPlaying = true;
    const audioUrl = audioQueue.shift();
    console.log('Player: Attempting to play audio:', audioUrl);
    
    // Set volume based on content type (music vs TTS)
    if (audioUrl.includes('replicate.delivery') && audioUrl.includes('wav')) {
        // Likely music content - may need volume adjustment
        audioPlayer.volume = 0.8;
    } else {
        // TTS content
        audioPlayer.volume = 1.0;
    }
    
    audioPlayer.src = audioUrl;
    audioPlayer.play()
        .then(() => console.log('Player: Playback started for:', audioUrl))
        .catch(e => {
            console.error('Player: Error playing audio:', audioUrl, e);
            isPlaying = false;
            playNextInQueue();
        });
}

audioPlayer.onended = () => {
    console.log('TTS Player: Audio finished playing.');
    isPlaying = false;
    playNextInQueue();
};

audioPlayer.onerror = (e) => {
    console.error('TTS Player: <audio> element error:', e);
    isPlaying = false;
    playNextInQueue();
};

function stopCurrentAudio() {
    console.log('TTS Player: Stopping current audio.');
    audioPlayer.pause();
    audioPlayer.currentTime = 0; // Reset time
    audioPlayer.src = ""; // Clear source
    isPlaying = false;
    // Note: This doesn't clear the audioQueue, allowing a 'resume' or next item to play.
}

function stopAllAudio() { // For !tts clear or full stop
    console.log('TTS Player: Stopping all audio and clearing queue.');
    audioPlayer.pause();
    audioPlayer.currentTime = 0;
    audioPlayer.src = "";
    isPlaying = false;
    audioQueue.length = 0; // Clear the queue
}

// Initial connection attempt
connectWebSocket();