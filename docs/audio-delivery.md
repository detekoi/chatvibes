# Audio delivery and latency

- **Synthesis is streamed from 302.ai and forwarded slice by slice.** `attemptGeneration302`
  sends `stream: true` and reads server-sent events (`readSseAudio`), calling `onChunk` with
  each hex slice as it lands; the concatenation is the clip. Measured 2026-09-04: the first
  slice arrives 0.5-1.3s before a whole-clip response, and even the *complete* streamed clip
  lands sooner (36 chars: 1.4s vs 1.8-2.2s). `ttsQueue` keeps the slices on the queue item
  (`createClip`) and `beginChunkedDelivery` forwards them to players that announced
  `chunkedAudio` in their hello: an `audioStart` JSON message, binary frames, then `audioEnd`.
  A prefetched clip's slices are collected while the previous clip plays and replayed the
  instant its turn comes. Players that announced only `binaryAudio` still get one whole
  buffer at the end (the chunked recipients are excluded from that send), and the URL path is
  unchanged. `audioEnd { discard: true }` tells the player to drop the clip because the audio
  is arriving another way (Wavespeed fallback returns a URL) or not at all; the queue sends it
  on every failure path, since the player holds a clip open until its end arrives.
  `T302_STREAMING=false` returns to one whole-clip response per request.
- **The player feeds slices to a MediaSource** (`audio/mpeg`, supported by Chromium and so by
  OBS's browser source) and only announces `chunkedAudio` when `isTypeSupported` says so. A
  clip whose end has already landed when its turn comes is played as one Blob instead. Slice
  boundaries are not MP3-frame-aligned; MSE keeps a byte queue across appends, and joining
  the buffers server-side needs nothing.
- **`TTS_TIMING` is the latency log**, one info line per clip from `ttsQueue.logTiming`, with
  each stage in milliseconds (Twitch-to-webhook, dedup claim, handler, Pub/Sub hop, enqueue,
  queue wait, provider round trip, first slice sent, total) plus `route` (`local`/`pubsub`),
  `prefetched` and `chunked`. The record rides the async context (`src/lib/ttsTiming.js`)
  from the webhook to the queue item, so handlers do not carry it. The existing
  "Received from Pub/Sub" line over-counts — every instance logs it, not only the one that
  serves the clip — so `route` is the honest Pub/Sub share. Query:
  `jsonPayload.logKey="TTS_TIMING"`.
