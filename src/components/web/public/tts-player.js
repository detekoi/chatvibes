const audioPlayer = document.getElementById('ttsAudioPlayer');
// Entries are either a URL string (a CDN link, or an object URL for a whole clip
// that arrived as one binary frame) or a clip object from the chunked path below.
const audioQueue = [];
let isPlaying = false;
// True while the <audio> element is the output of the entry being played. A clip
// that plays through Web Audio leaves the element idle, and a late event from the
// element (an error for an emptied src, for example) must not end that clip.
let audioElementActive = false;

// ---------------------------------------------------------------------------
// Chunked clips
//
// A player that announces 'pcmAudio' is sent each clip as it is rendered: an
// `audioStart` message with the sample rate, then binary frames carrying slices
// of raw 16-bit mono PCM, then `audioEnd`. Each slice is scheduled on a Web Audio
// context right behind the one before it, so playback begins on the first slice,
// about 0.4 s after the request and long before the whole clip exists.
//
// A clip that was not streamed arrives as one binary frame holding a WAV file and
// plays through the <audio> element.
// ---------------------------------------------------------------------------
const AudioContextClass = window.AudioContext || window.webkitAudioContext;
const supportsPcmAudio = typeof AudioContextClass === 'function';
let audioContext = null;

function getAudioContext() {
    if (!audioContext) audioContext = new AudioContextClass();
    // A browser tab starts suspended until the page gets a click. OBS does not.
    if (audioContext.state === 'suspended') audioContext.resume().catch(() => {});
    return audioContext;
}
if (supportsPcmAudio) {
    document.addEventListener('click', () => getAudioContext(), { once: true });
}

// The clip currently receiving slices from the socket, if any. Frames arrive in
// order on one socket, so a binary frame between audioStart and audioEnd belongs
// to this clip; outside that window it is a whole clip in one frame.
let openClip = null;
// The clip being played through Web Audio, if any.
let currentClip = null;

function newClip(id, sampleRate) {
    return {
        id,
        sampleRate: sampleRate > 0 ? sampleRate : 24000,
        chunks: [],          // ArrayBuffers of PCM in arrival order
        ended: false,        // audioEnd received
        discard: false,      // dropped: stopped, or the server said so
        appendIndex: 0,      // next chunk to schedule
        sources: new Set(),  // scheduled buffer sources that did not finish yet
        nextTime: 0,         // context time at which the next slice starts
    };
}

function isClip(entry) {
    return entry !== null && typeof entry === 'object' && Array.isArray(entry.chunks);
}

// ---------------------------------------------------------------------------
// The clip card (spotlight)
//
// For some clips the server sends a `clipMeta` message right before the clip's
// first frame: before `audioStart` on the PCM path, before the binary WAV frame
// otherwise. The card shows while THAT clip plays and goes away when it ends, is
// dropped or is stopped. A clip without meta never shows a card. The text is chat
// that the bot did not write, so it is only ever set with textContent.
// ---------------------------------------------------------------------------
const card = document.getElementById('clipCard');
const cardLabel = document.getElementById('clipCardLabel');
const cardUser = document.getElementById('clipCardUser');
const cardText = document.getElementById('clipCardText');
const reducedMotion = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
// A meta waits for its clip only briefly: it is sent directly before the clip.
const PENDING_META_TTL_MS = 5000;
const CARD_EXIT_MS = 160;
let pendingMeta = null;
// The queue entry (a clip object or an object URL) whose card is up.
let cardOwner = null;
let cardHideTimer = null;
// Object URL of a whole clip -> its meta.
const urlMeta = new Map();

function receiveClipMeta(data) {
    if (!data || typeof data.clipId !== 'string' || typeof data.text !== 'string' || !data.text) return;
    pendingMeta = {
        clipId: data.clipId,
        kind: String(data.kind || ''),
        user: typeof data.user === 'string' ? data.user : '',
        text: data.text,
        label: typeof data.label === 'string' ? data.label : '',
        lang: typeof data.lang === 'string' && /^[A-Za-z]{2,3}(-[A-Za-z0-9]{1,8})*$/.test(data.lang) ? data.lang : '',
        expiresAt: Date.now() + PENDING_META_TTL_MS,
    };
}

// The pending meta, if it is for this clip ID (or for any clip when id is null)
// and not stale. Taking it clears it, so it can never attach to a later clip.
function takePendingMeta(clipId) {
    const meta = pendingMeta;
    pendingMeta = null;
    if (!meta || meta.expiresAt < Date.now()) return null;
    if (clipId !== null && meta.clipId !== clipId) return null;
    return meta;
}

function showCard(owner, meta) {
    if (!card || !meta) return;
    clearTimeout(cardHideTimer);
    cardOwner = owner;
    cardLabel.textContent = meta.label || '';
    if (meta.lang) cardLabel.lang = meta.lang;
    else cardLabel.removeAttribute('lang');
    cardUser.textContent = meta.user;
    cardText.textContent = meta.text;
    card.hidden = false;
    // Start the entrance from the hidden state, so the transition runs.
    void card.offsetWidth;
    card.classList.add('is-visible');
}

// Hide the card if it belongs to `owner`, or whatever card is up when owner is omitted.
function hideCard(owner) {
    if (!card || cardOwner === null) return;
    if (owner !== undefined && owner !== cardOwner) return;
    cardOwner = null;
    card.classList.remove('is-visible');
    clearTimeout(cardHideTimer);
    const after = reducedMotion && reducedMotion.matches ? 0 : CARD_EXIT_MS;
    cardHideTimer = setTimeout(() => {
        if (cardOwner === null) card.hidden = true;
    }, after);
}

// Object URLs this player created from inline audio frames. Tracked so they can be
// revoked after playback — an OBS source runs for the length of a stream, and every
// un-revoked clip stays in memory until the page is reloaded. Also serves as proof
// of local origin when validating what we are about to feed the <audio> element.
const ownObjectUrls = new Set();
let currentObjectUrl = null;

function releaseAudioUrl(url) {
    if (url) urlMeta.delete(url);
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
    // Slices are read as 16-bit samples, which needs ArrayBuffers; a whole clip in
    // one frame is wrapped in a Blob below.
    ws.binaryType = 'arraybuffer';

    ws.onopen = () => {
        console.log('TTS WebSocket connected successfully.');
        // The attempt counter is deliberately NOT reset here. The server can accept
        // the upgrade and then close the socket (bad token), so treating onopen as
        // success would zero the counter on every rejected attempt and reconnect
        // forever at the shortest delay. It is reset on 'registered' instead, which
        // only arrives after the server has authenticated this client.
        // Announce what this player understands. 'binaryAudio' means a whole clip
        // can arrive as one binary frame. 'pcmAudio' means the clip can arrive
        // slice by slice as raw PCM.
        try {
            const features = ['binaryAudio'];
            if (supportsPcmAudio) features.push('pcmAudio');
            // 'clipMeta' means a clip can come with a card to show while it plays.
            if (card) features.push('clipMeta');
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
            const blob = event.data instanceof Blob ? event.data : new Blob([event.data], { type: 'audio/wav' });
            const objectUrl = URL.createObjectURL(blob);
            ownObjectUrls.add(objectUrl);
            // A meta sent for a whole clip comes directly before its frame.
            const meta = takePendingMeta(null);
            if (meta) urlMeta.set(objectUrl, meta);
            audioQueue.push(objectUrl);
            playNextInQueue();
            return;
        }

        try {
            const data = JSON.parse(event.data);
            console.log('TTS WebSocket received data:', data); // Log all received data

            if (data.type === 'audioStart' && data.clipId) {
                if (openClip && !openClip.ended) {
                    // Should not happen — the server ends one clip before starting the
                    // next — but never leave a clip open forever waiting for frames.
                    console.warn('Player: audioStart while a clip was still open; closing it', openClip.id);
                    finishClip(openClip, true);
                }
                openClip = newClip(data.clipId, data.sampleRate);
                openClip.meta = takePendingMeta(data.clipId);
                audioQueue.push(openClip);
                playNextInQueue();
            } else if (data.type === 'clipMeta') {
                receiveClipMeta(data);
            } else if (data.type === 'audioEnd') {
                if (data.discard && pendingMeta && pendingMeta.clipId === data.clipId) pendingMeta = null;
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
            // The server sends JSON. The bare stop word is from an older server.
            if (event.data === 'STOP_CURRENT_AUDIO') {
                console.log('TTS WebSocket received STOP_CURRENT_AUDIO command');
                stopCurrentAudio(); // More specific stop
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
        // No audioEnd can arrive for a clip that was open on this socket. Left open,
        // it holds the queue forever, and the next binary frame (a held clip that the
        // server replays as one WAV file) would be read as its raw PCM.
        if (openClip) {
            const clip = openClip;
            openClip = null;
            finishClip(clip, true);
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
        currentObjectUrl = null;
        playClipPcm(next);
        return;
    }

    isPlaying = true;
    const audioUrl = next;
    console.log('Player: Attempting to play audio:', audioUrl);

    // Release the previous clip's bytes now that we are moving on.
    releaseAudioUrl(currentObjectUrl);
    // The queue holds only object URLs that this page made from binary frames.
    // The server sends no audio URLs, so anything else is not played.
    currentObjectUrl = ownObjectUrls.has(audioUrl) ? audioUrl : null;
    const safeSrc = currentObjectUrl;
    if (!safeSrc) {
        console.warn('Player: Skipping an audio URL that this page did not make:', audioUrl);
        isPlaying = false;
        // Try the next item in the queue, if any.
        playNextInQueue();
        return;
    }

    startPlayback(safeSrc, audioUrl);
}

function startPlayback(src, label) {
    // The server applies the channel's volume to the samples.
    audioPlayer.volume = 1.0;

    audioElementActive = true;
    audioPlayer.src = src;
    audioPlayer.play()
        .then(() => {
            console.log('Player: Playback started for:', label);
            if (audioElementActive && currentObjectUrl === src) showCard(src, urlMeta.get(src));
        })
        .catch(e => {
            console.error('Player: Error playing audio:', label, e);
            if (!audioElementActive) return; // stopped or replaced while play() was pending
            audioElementActive = false;
            hideCard(src);
            releaseAudioUrl(currentObjectUrl);
            currentObjectUrl = null;
            isPlaying = false;
            playNextInQueue();
        });
}

// A slice arrived for the open clip. If it is the clip playing, it is scheduled
// now; if it is still queued, it waits with the others.
function receiveChunk(clip, data) {
    if (clip.discard) return;
    if (data instanceof ArrayBuffer) {
        clip.chunks.push(data);
        if (clip === currentClip) pumpPcm(clip);
        return;
    }
    // A Blob only shows up if binaryType did not take; read it into an ArrayBuffer,
    // chaining on the previous conversion so order is kept.
    clip.pendingBlob = (clip.pendingBlob || Promise.resolve())
        .then(() => data.arrayBuffer())
        .then(buf => {
            if (clip.discard) return;
            clip.chunks.push(buf);
            if (clip === currentClip) pumpPcm(clip);
        });
}

// audioEnd arrived, or the clip is being abandoned.
function finishClip(clip, discard) {
    const settle = () => {
        clip.ended = true;
        if (discard) {
            hideCard(clip);
            clip.discard = true;
            clip.chunks = [];
            if (clip === currentClip) {
                // Playing right now: stop and advance. The server gave up on it.
                console.log('Player: server discarded the clip being played', clip.id);
                stopCurrentAudio();
            }
            return;
        }
        if (clip === currentClip) pumpPcm(clip);
    };
    if (clip.pendingBlob) clip.pendingBlob.then(settle);
    else settle();
}

function playClipPcm(clip) {
    currentClip = clip;
    const ctx = getAudioContext();
    if (ctx.state === 'running') {
        console.log('Player: Playback started for: clip', clip.id);
        showCard(clip, clip.meta);
        pumpPcm(clip);
        return;
    }
    // A browser tab keeps the context suspended until the page gets a click, and
    // resume() then stays pending. Do not hold the queue for it: drop the clip, as
    // a refused play() does on the <audio> path. OBS never comes here.
    const giveUp = setTimeout(() => {
        if (clip !== currentClip || ctx.state === 'running') return;
        console.warn('Player: audio is blocked until the page gets a click; skipping clip', clip.id);
        hideCard(clip);
        clip.discard = true;
        clip.chunks = [];
        currentClip = null;
        isPlaying = false;
        playNextInQueue();
    }, 400);
    ctx.resume().then(() => {
        if (clip !== currentClip || clip.discard) return;
        clearTimeout(giveUp);
        console.log('Player: Playback started for: clip', clip.id);
        showCard(clip, clip.meta);
        pumpPcm(clip);
    }).catch(() => {});
}

// Schedule every slice that has arrived, and finish the clip once the last one
// has played. Called on every event that can move the clip on: a new slice,
// audioEnd, and the end of a scheduled slice.
function pumpPcm(clip) {
    if (clip.discard || clip !== currentClip) return;
    const ctx = getAudioContext();
    if (ctx.state !== 'running') return; // playClipPcm is still waiting for the context
    while (clip.appendIndex < clip.chunks.length) {
        const chunk = clip.chunks[clip.appendIndex];
        clip.chunks[clip.appendIndex] = null; // let the bytes go once scheduled
        clip.appendIndex++;
        try {
            schedulePcm(clip, ctx, chunk);
        } catch (e) {
            console.error('Player: could not schedule a slice; abandoning clip', clip.id, e);
            clip.discard = true;
            stopCurrentAudio();
            return;
        }
    }
    if (clip.ended && clip.sources.size === 0) finishPcmClip(clip);
}

function schedulePcm(clip, ctx, arrayBuffer) {
    // The server sends whole samples. Ignore a stray last byte and do not shift the rest.
    const samples = new Int16Array(arrayBuffer, 0, Math.floor(arrayBuffer.byteLength / 2));
    if (samples.length === 0) return;
    const buffer = ctx.createBuffer(1, samples.length, clip.sampleRate);
    const channel = buffer.getChannelData(0);
    for (let i = 0; i < samples.length; i++) channel[i] = samples[i] / 32768;

    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(ctx.destination);
    // Right behind the previous slice. If the stream fell behind, start a moment
    // from now: a short gap is better than audio scheduled in the past.
    const startAt = Math.max(clip.nextTime, ctx.currentTime + 0.03);
    source.start(startAt);
    clip.nextTime = startAt + buffer.duration;
    clip.sources.add(source);
    source.onended = () => {
        clip.sources.delete(source);
        pumpPcm(clip);
    };
}

function finishPcmClip(clip) {
    if (clip !== currentClip) return;
    console.log('TTS Player: Clip finished playing.', clip.id);
    hideCard(clip);
    currentClip = null;
    isPlaying = false;
    playNextInQueue();
}

// Silence a clip that is playing through Web Audio. The slices are already
// scheduled, so each source is stopped; its onended must not advance the queue.
function stopPcmSources(clip) {
    if (!clip || !clip.sources) return;
    for (const source of clip.sources) {
        source.onended = null;
        try { source.stop(); } catch (e) { /* not started yet, or already over */ }
    }
    clip.sources.clear();
}

audioPlayer.onended = () => {
    if (!audioElementActive) return;
    audioElementActive = false;
    console.log('TTS Player: Audio finished playing.');
    hideCard(currentObjectUrl);
    // Release here rather than only on the next clip, so the last message of a quiet
    // period does not sit in memory until somebody speaks again.
    releaseAudioUrl(currentObjectUrl);
    currentObjectUrl = null;
    currentClip = null;
    isPlaying = false;
    playNextInQueue();
};

audioPlayer.onerror = (e) => {
    if (!audioElementActive) return;
    audioElementActive = false;
    console.error('TTS Player: <audio> element error:', e);
    hideCard(currentObjectUrl);
    releaseAudioUrl(currentObjectUrl);
    currentObjectUrl = null;
    isPlaying = false;
    playNextInQueue();
};

function stopCurrentAudio() {
    console.log('TTS Player: Stopping current audio.');
    hideCard();
    // Slices still arriving for a stopped clip are dropped on receipt.
    if (currentClip) currentClip.discard = true;
    stopPcmSources(currentClip);
    currentClip = null;
    if (audioElementActive) {
        audioElementActive = false;
        audioPlayer.pause();
        audioPlayer.currentTime = 0;
        audioPlayer.src = "";
    }
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
    hideCard();
    pendingMeta = null;
    if (currentClip) currentClip.discard = true;
    stopPcmSources(currentClip);
    currentClip = null;
    if (audioElementActive) {
        audioElementActive = false;
        audioPlayer.pause();
        audioPlayer.currentTime = 0;
        audioPlayer.src = "";
    }
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