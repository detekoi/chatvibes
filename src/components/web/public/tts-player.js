const audioPlayer = document.getElementById('ttsAudioPlayer');
const audioQueue = [];
let isPlaying = false;

// TODO: Get channel name from query param or a config endpoint from the server
// For Cloud Run, the instance URL will be fixed, but if it's multi-tenant later, this needs to be dynamic
const wsUrl = `wss://${window.location.host}`; // Adjust if server runs on different path/port
const ws = new WebSocket(wsUrl);

ws.onopen = () => {
    console.log('TTS WebSocket connected');
    // Optional: Send a message to identify this client (e.g., with channel name)
    // ws.send(JSON.stringify({ type: 'register', channel: 'theStreamersChannel' }));
};

ws.onmessage = (event) => {
    try {
        const data = JSON.parse(event.data);
        if (data.type === 'playAudio' && data.url) {
            console.log('Received audio URL:', data.url);
            audioQueue.push(data.url);
            playNextInQueue();
        } else if (data.type === 'stopAudio') { // Matches !tts stop command
            console.log('Received stop command');
            audioPlayer.pause();
            audioPlayer.currentTime = 0;
            audioQueue.length = 0; // Clear the queue
            isPlaying = false;
        }
    } catch (e) {
        // If direct URL is sent (not JSON)
        const audioUrl = event.data;
         if (typeof audioUrl === 'string' && audioUrl.startsWith('https://')) {
            console.log('Received direct audio URL:', audioUrl);
            audioQueue.push(audioUrl);
            playNextInQueue();
        } else if (audioUrl === 'STOP_CURRENT_AUDIO'){
            console.log('Received stop current audio command');
            audioPlayer.pause();
            audioPlayer.currentTime = 0;
            // Don't clear queue here, only stop current
            isPlaying = false; // This will allow next in queue if processQueue() continues
            // If processQueue has a delay, this might interrupt and play next quickly.
            // To truly stop and wait for !tts resume, server needs to manage queue state.
            // For `!tts stop`, it stops the current and processQueue continues.
            // If `!tts pause` is also active, then processQueue won't send next.
        } else {
            console.error('Received invalid WebSocket message:', event.data);
        }
    }
};

ws.onclose = () => {
    console.log('TTS WebSocket disconnected. Attempting to reconnect...');
    // Implement reconnection logic if needed, e.g., exponential backoff
    setTimeout(() => { window.location.reload(); }, 5000); // Simple reload
};
ws.onerror = (error) => {
    console.error('TTS WebSocket error:', error);
};

function playNextInQueue() {
    if (isPlaying || audioQueue.length === 0) {
        return;
    }
    isPlaying = true;
    const audioUrl = audioQueue.shift();
    audioPlayer.src = audioUrl;
    audioPlayer.play()
        .then(() => console.log('Playing:', audioUrl))
        .catch(e => {
            console.error('Error playing audio:', e);
            isPlaying = false;
            playNextInQueue(); // Try next if error
        });
}

audioPlayer.onended = () => {
    console.log('Audio finished playing');
    isPlaying = false;
    playNextInQueue();
};

audioPlayer.onerror = (e) => {
    console.error('Audio player error:', e);
    isPlaying = false;
    playNextInQueue(); // Try next in queue if current one errors
};