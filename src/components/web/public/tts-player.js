const audioPlayer = document.getElementById('ttsAudioPlayer');
// Entries are either a URL string (a CDN link, or an object URL for a whole clip
// that arrived as one binary frame) or a clip object from the chunked path below.
const audioQueue = [];
let isPlaying = false;

// ---------------------------------------------------------------------------
// Chunked clips
//
// A player that announces 'chunkedAudio' is sent each clip as it is rendered:
// an `audioStart` message, then binary frames carrying slices of the MP3, then
// `audioEnd`. Slices are fed to a MediaSource so playback can begin on the first
// one, which is 0.5-1.3s before the whole clip would have arrived. A clip whose
// end has already landed by the time its turn comes (the usual case for anything
// queued behind another clip) is played as one Blob instead — simpler, and
// nothing is gained by streaming bytes that are all here already.
//
// MediaSource for 'audio/mpeg' is supported by Chromium, so by OBS's browser
// source. If it is not, the feature is simply not announced and the server sends
// whole clips as before.
// ---------------------------------------------------------------------------
const CHUNKED_MIME = 'audio/mpeg';
const supportsChunkedAudio = (() => {
    try {
        return typeof MediaSource !== 'undefined'
            && typeof MediaSource.isTypeSupported === 'function'
            && MediaSource.isTypeSupported(CHUNKED_MIME);
    } catch (e) {
        return false;
    }
})();

// The clip currently receiving slices from the socket, if any. Frames arrive in
// order on one socket, so a binary frame between audioStart and audioEnd belongs
// to this clip; outside that window it is a whole clip in one frame.
let openClip = null;
// The clip being played through a MediaSource, if any.
let currentClip = null;

function newClip(id) {
    return {
        id,
        chunks: [],          // ArrayBuffers in arrival order
        ended: false,        // audioEnd received
        discard: false,      // dropped: stopped, or the server said so
        mediaSource: null,
        sourceBuffer: null,
        appendIndex: 0,      // next chunk to append to the SourceBuffer
        objectUrl: null,
    };
}

function isClip(entry) {
    return entry !== null && typeof entry === 'object' && Array.isArray(entry.chunks);
}

// Object URLs this player created from inline audio frames. Tracked so they can be
// revoked after playback — an OBS source runs for the length of a stream, and every
// un-revoked clip stays in memory until the page is reloaded. Also serves as proof
// of local origin when validating what we are about to feed the <audio> element.
const ownObjectUrls = new Set();
let currentObjectUrl = null;

function releaseAudioUrl(url) {
    if (url && ownObjectUrls.has(url)) {
        URL.revokeObjectURL(url);
        ownObjectUrls.delete(url);
    }
}

// Determine WebSocket protocol based on current page protocol
const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
// Construct URL using current host (hostname and port)
// The channel needs to be passed as a query parameter in the OBS source URL
// e.g., http://localhost:8080/?channel=yourstreamername
const queryParams = new URLSearchParams(window.location.search);
const channelName = queryParams.get('channel');
const token = queryParams.get('token');

/**
 * Validate that a given URL string is safe to use as an <audio> source.
 * Only allow http/https URLs (https in production; http may be used for local testing)
 * and reject any other protocol such as javascript:, data:, etc.
 *
 * Returns the sanitized URL string (from the URL constructor) if safe, or null if unsafe.
 */
function isSafeAudioUrl(url) {
    if (typeof url !== 'string' || url.trim() === '') {
        return null;
    }

    try {
        // Resolve against the current origin to prevent protocols like
        // "javascript:" or "data:" from being accepted as relative URLs.
        const parsed = new URL(url, window.location.origin);

        // Only allow http and https schemes.
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
            return null;
        }

        // Return the parsed href so callers use the sanitized URL, not the raw input.
        return parsed.href;
    } catch (e) {
        // Malformed URL
        return null;
    }
}

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
let keepaliveTimer = null;
const CLIENT_PING_INTERVAL_MS = 25000; // 25s to stay under common 30s LB idle timeouts

function connectWebSocket() {
    if (!channelName && wsProtocol === 'ws:') { // Only show alert for local dev if channel is missing
        alert("OBS Browser Source URL needs '?channel=yourchannelname' at the end for WildcatTTS to work!");
    } else if (!channelName) {
        console.error("CRITICAL: OBS Browser Source URL is missing '?channel=yourchannelname'. TTS will not function for a specific channel.");
    }

    ws = new WebSocket(wsUrl);
    // Slices go into a SourceBuffer, which takes ArrayBuffers; a whole clip in one
    // frame is wrapped in a Blob below, as it always was.
    ws.binaryType = 'arraybuffer';

    ws.onopen = () => {
        console.log('TTS WebSocket connected successfully.');
        // The attempt counter is deliberately NOT reset here. The server can accept
        // the upgrade and then close the socket (bad token), so treating onopen as
        // success would zero the counter on every rejected attempt and reconnect
        // forever at the shortest delay. It is reset on 'registered' instead, which
        // only arrives after the server has authenticated this client.
        // Announce what this player understands. The server sends audio as raw
        // binary frames only to clients that declare 'binaryAudio'; without this
        // it asks the TTS provider for a URL instead, which still works but is
        // roughly a second slower per clip.
        try {
            const features = ['binaryAudio'];
            if (supportsChunkedAudio) features.push('chunkedAudio');
            ws.send(JSON.stringify({ type: 'hello', features }));
        } catch (e) {
            console.warn('TTS WebSocket: error sending hello', e);
        }
        // Start client keepalive ping
        if (keepaliveTimer) {
            clearInterval(keepaliveTimer);
        }
        keepaliveTimer = setInterval(() => {
            try {
                if (ws && ws.readyState === WebSocket.OPEN) {
                    // Send lightweight application-level ping
                    ws.send(JSON.stringify({ type: 'ping', ts: Date.now() }));
                }
            } catch (e) {
                console.warn('TTS WebSocket: error sending client ping', e);
            }
        }, CLIENT_PING_INTERVAL_MS);
        // Optional: Send a registration message with the channel name if the server expects it
        // ws.send(JSON.stringify({ type: 'register', channel: channelName }));
    };

    ws.onmessage = (event) => {
        // Binary frame: the audio bytes themselves, sent inline over this socket so
        // the browser never has to fetch them from a CDN. Object URLs are revoked
        // once played (see releaseAudioUrl) — without that an OBS source running for
        // a whole stream would hold on to every clip it has ever played.
        if (event.data instanceof ArrayBuffer || event.data instanceof Blob) {
            if (openClip) {
                receiveChunk(openClip, event.data);
                return;
            }
            const blob = event.data instanceof Blob ? event.data : new Blob([event.data], { type: 'audio/mpeg' });
            const objectUrl = URL.createObjectURL(blob);
            ownObjectUrls.add(objectUrl);
            audioQueue.push(objectUrl);
            playNextInQueue();
            return;
        }

        try {
            const data = JSON.parse(event.data);
            console.log('TTS WebSocket received data:', data); // Log all received data

            if (data.type === 'playAudio' && data.url) {
                const safeUrl = isSafeAudioUrl(data.url);
                if (safeUrl) {
                    audioQueue.push(safeUrl);
                    playNextInQueue();
                } else {
                    console.warn('TTS WebSocket received unsafe audio URL, ignoring:', data.url);
                }
            } else if (data.type === 'audioStart' && data.clipId) {
                if (openClip && !openClip.ended) {
                    // Should not happen — the server ends one clip before starting the
                    // next — but never leave a clip open forever waiting for frames.
                    console.warn('Player: audioStart while a clip was still open; closing it', openClip.id);
                    finishClip(openClip, true);
                }
                openClip = newClip(data.clipId);
                audioQueue.push(openClip);
                playNextInQueue();
            } else if (data.type === 'audioEnd') {
                if (openClip && openClip.id === data.clipId) {
                    const clip = openClip;
                    openClip = null;
                    finishClip(clip, !!data.discard);
                } else {
                    console.warn('Player: audioEnd for a clip that is not open:', data.clipId);
                }
            } else if (data.type === 'stopAudio') {
                console.log('TTS WebSocket received stopAudio command');
                stopAllAudio();
            } else if (data.type === 'registered') {
                console.log(`TTS WebSocket registered for channel: ${data.channel}. Message: ${data.message}`);
                reconnectAttempts = 0; // Authenticated — this connection really succeeded
            } else if (data.type === 'pong') {
                // Server responded to app-level ping; nothing else to do
                // Could update a lastSeen timestamp if desired
            }
        } catch (e) {
            // This might be a direct URL string if your server doesn't always send JSON
            if (typeof event.data === 'string') {
                const safeDirectUrl = isSafeAudioUrl(event.data);
                if (safeDirectUrl) { // Accept only validated http/https URLs
                    console.log('TTS WebSocket received direct audio URL:', event.data);
                    audioQueue.push(safeDirectUrl);
                    playNextInQueue();
                } else if (event.data === 'STOP_CURRENT_AUDIO') {
                    console.log('TTS WebSocket received STOP_CURRENT_AUDIO command');
                    stopCurrentAudio(); // More specific stop
                } else {
                    console.warn('TTS WebSocket received non-JSON or unsafe message:', event.data);
                }
            } else {
                console.error('TTS WebSocket received unparseable message:', event.data, e);
            }
        }
    };

    ws.onclose = (event) => {
        console.log(`TTS WebSocket disconnected. Code: ${event.code}, Reason: "${event.reason}". Attempting to reconnect... (Attempt ${reconnectAttempts + 1})`);
        ws = null; // Clear the instance
        if (keepaliveTimer) {
            clearInterval(keepaliveTimer);
            keepaliveTimer = null;
        }
        // 1008 is a policy rejection (channel not allowed, bad token). Retrying
        // cannot change the answer, so stop rather than hammer the server until
        // the attempt cap runs out.
        if (event.code === 1008) {
            console.error(`TTS WebSocket: server refused this connection ("${event.reason}"). Not retrying — check the browser source URL, then refresh it.`);
            return;
        }

        if (reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
            reconnectAttempts++;
            // Use faster initial reconnect delay, then exponential backoff
            const delay = reconnectAttempts === 1 ? 1000 : RECONNECT_DELAY_MS * (reconnectAttempts - 1);
            setTimeout(connectWebSocket, delay);
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
    const next = audioQueue.shift();

    if (isClip(next)) {
        if (next.discard) {
            // Dropped while it sat in the queue; move on without touching the player.
            playNextInQueue();
            return;
        }
        isPlaying = true;
        releaseAudioUrl(currentObjectUrl);
        if (next.ended) {
            // Everything is here already: one Blob, no MediaSource needed.
            const blob = new Blob(next.chunks, { type: CHUNKED_MIME });
            next.chunks = [];
            const objectUrl = URL.createObjectURL(blob);
            ownObjectUrls.add(objectUrl);
            currentObjectUrl = objectUrl;
            startPlayback(objectUrl, `clip ${next.id}`);
        } else {
            playClipStreaming(next);
        }
        return;
    }

    isPlaying = true;
    const audioUrl = next;
    console.log('Player: Attempting to play audio:', audioUrl);

    // Release the previous clip's bytes now that we are moving on.
    releaseAudioUrl(currentObjectUrl);
    currentObjectUrl = ownObjectUrls.has(audioUrl) ? audioUrl : null;

    // As a defensive measure, re-validate the URL before assigning it to the audio element.
    // isSafeAudioUrl returns the sanitized href or null. Object URLs we minted
    // ourselves are exempt: they are blob: scheme, which isSafeAudioUrl rejects by
    // design, and membership in ownObjectUrls is proof of local origin — a URL
    // string arriving over the socket can never be in that set.
    const safeSrc = currentObjectUrl || isSafeAudioUrl(audioUrl);
    if (!safeSrc) {
        console.warn('Player: Skipping unsafe audio URL from queue:', audioUrl);
        isPlaying = false;
        // Try the next item in the queue, if any.
        playNextInQueue();
        return;
    }

    startPlayback(safeSrc, audioUrl);
}

function startPlayback(src, label) {
    // Set volume based on content type (music vs TTS)
    // Music files are typically .wav format, TTS is typically .mp3
    if (src.includes('.wav')) {
        // Likely music content - may need volume adjustment
        audioPlayer.volume = 0.8;
    } else {
        // TTS content
        audioPlayer.volume = 1.0;
    }

    audioPlayer.src = src;
    audioPlayer.play()
        .then(() => console.log('Player: Playback started for:', label))
        .catch(e => {
            console.error('Player: Error playing audio:', label, e);
            if (currentClip) currentClip.discard = true;
            currentClip = null;
            releaseAudioUrl(currentObjectUrl);
            currentObjectUrl = null;
            isPlaying = false;
            playNextInQueue();
        });
}

// A slice arrived for the open clip. If it is the clip playing, the SourceBuffer
// pump picks it up; if it is still queued, it waits with the others.
function receiveChunk(clip, data) {
    if (clip.discard) return;
    if (data instanceof ArrayBuffer) {
        clip.chunks.push(data);
        if (clip === currentClip) pumpAppends(clip);
        return;
    }
    // A Blob only shows up if binaryType did not take; read it into an ArrayBuffer,
    // chaining on the previous conversion so order is kept.
    clip.pendingBlob = (clip.pendingBlob || Promise.resolve())
        .then(() => data.arrayBuffer())
        .then(buf => {
            if (clip.discard) return;
            clip.chunks.push(buf);
            if (clip === currentClip) pumpAppends(clip);
        });
}

// audioEnd arrived, or the clip is being abandoned.
function finishClip(clip, discard) {
    const settle = () => {
        clip.ended = true;
        if (discard) {
            clip.discard = true;
            clip.chunks = [];
            if (clip === currentClip) {
                // Playing right now: stop and advance. The server is sending the
                // finished audio another way, or gave up on it.
                console.log('Player: server discarded the clip being played', clip.id);
                stopCurrentAudio();
            }
            return;
        }
        if (clip === currentClip) pumpAppends(clip);
    };
    if (clip.pendingBlob) clip.pendingBlob.then(settle);
    else settle();
}

function playClipStreaming(clip) {
    currentClip = clip;
    const mediaSource = new MediaSource();
    clip.mediaSource = mediaSource;
    clip.objectUrl = URL.createObjectURL(mediaSource);
    ownObjectUrls.add(clip.objectUrl);
    currentObjectUrl = clip.objectUrl;

    mediaSource.addEventListener('sourceopen', () => {
        if (currentClip !== clip) return; // stopped before the source opened
        try {
            clip.sourceBuffer = mediaSource.addSourceBuffer(CHUNKED_MIME);
        } catch (e) {
            console.error('Player: could not open a SourceBuffer; skipping clip', clip.id, e);
            clip.discard = true;
            stopCurrentAudio();
            return;
        }
        clip.sourceBuffer.addEventListener('updateend', () => pumpAppends(clip));
        clip.sourceBuffer.addEventListener('error', e => console.error('Player: SourceBuffer error', clip.id, e));
        pumpAppends(clip);
    }, { once: true });

    // play() on an empty MediaSource simply waits for data, so it can be issued
    // now; the promise resolves once the first slice has been decoded.
    startPlayback(clip.objectUrl, `clip ${clip.id}`);
}

// Append the next slice, or close the stream once the last one is in. Called on
// every event that could unblock the SourceBuffer: a new slice, updateend, audioEnd.
function pumpAppends(clip) {
    const sb = clip.sourceBuffer;
    const ms = clip.mediaSource;
    if (!sb || !ms || ms.readyState !== 'open' || sb.updating || clip.discard) return;
    if (clip.appendIndex < clip.chunks.length) {
        const chunk = clip.chunks[clip.appendIndex];
        clip.chunks[clip.appendIndex] = null; // let the bytes go once appended
        clip.appendIndex++;
        try {
            sb.appendBuffer(chunk);
        } catch (e) {
            console.error('Player: appendBuffer failed; abandoning clip', clip.id, e);
            clip.discard = true;
            stopCurrentAudio();
        }
        return;
    }
    if (clip.ended) {
        try {
            ms.endOfStream();
        } catch (e) {
            console.warn('Player: endOfStream failed', clip.id, e);
        }
    }
}

audioPlayer.onended = () => {
    console.log('TTS Player: Audio finished playing.');
    // Release here rather than only on the next clip, so the last message of a quiet
    // period does not sit in memory until somebody speaks again.
    releaseAudioUrl(currentObjectUrl);
    currentObjectUrl = null;
    currentClip = null;
    isPlaying = false;
    playNextInQueue();
};

audioPlayer.onerror = (e) => {
    console.error('TTS Player: <audio> element error:', e);
    if (currentClip) currentClip.discard = true;
    currentClip = null;
    releaseAudioUrl(currentObjectUrl);
    currentObjectUrl = null;
    isPlaying = false;
    playNextInQueue();
};

function stopCurrentAudio() {
    console.log('TTS Player: Stopping current audio.');
    // Slices still arriving for a stopped clip are dropped on receipt.
    if (currentClip) currentClip.discard = true;
    currentClip = null;
    audioPlayer.pause();
    audioPlayer.currentTime = 0; // Reset time
    audioPlayer.src = ""; // Clear source
    releaseAudioUrl(currentObjectUrl);
    currentObjectUrl = null;
    isPlaying = false;
    // Deliberately does not clear audioQueue — `!tts stop` drops the clip that is
    // playing, not the ones behind it. Those have to be started explicitly: nothing
    // else will, since onended never fires for audio that was paused rather than
    // finished, so without this the queue sat idle until the next message arrived.
    playNextInQueue();
}

function stopAllAudio() { // For !tts clear or full stop
    console.log('TTS Player: Stopping all audio and clearing queue.');
    if (currentClip) currentClip.discard = true;
    currentClip = null;
    audioPlayer.pause();
    audioPlayer.currentTime = 0;
    audioPlayer.src = "";
    releaseAudioUrl(currentObjectUrl);
    currentObjectUrl = null;
    isPlaying = false;
    // Discard bytes for clips that will now never play. A queued chunked clip is
    // marked rather than closed: its remaining frames are dropped on receipt and
    // its audioEnd closes it normally.
    audioQueue.forEach(entry => {
        if (isClip(entry)) { entry.discard = true; entry.chunks = []; }
        else releaseAudioUrl(entry);
    });
    audioQueue.length = 0; // Clear the queue
}

// Initial connection attempt
connectWebSocket();