# Audio delivery and latency

## Synthesis

The bot gets speech from Gemini TTS through the Interactions API. `generateSpeech` in
`src/components/tts/ttsService.js` sends one streamed request for each clip. The request
holds the voice, the text, an optional style and an optional language hint. It always
sends `store: false`, because the API keeps interactions for weeks by default.

The answer is a stream of server-sent events. Each audio event carries a slice of raw
PCM (16-bit, mono, 24 kHz) in base64. `readGeminiAudio` decodes the slices and calls
`onChunk` with each one as it arrives. The slices joined together are the clip. A network
chunk can end in the middle of a sample, so `createSampleAligner` carries an odd byte to
the next slice. The player gets whole samples only.

Gemini has no volume field. `applyGain` multiplies the samples by the volume of the
channel before a slice leaves `ttsService.js`.

Measured on 2026-11-13 from a client on the US west coast: the first slice arrives
0.3 to 0.7 seconds after the request, for a message of any length. With 302.ai the median
was 1.1 seconds. Slices then arrive faster than they play.

## Failures

A request has two timeouts: 4 seconds to the first slice, and 4 seconds of silence
between slices. On a failure the bot tries the main model (`GEMINI_TTS_MODEL`) a second
time. Then it tries `GEMINI_TTS_FALLBACK_MODEL` one time. The fallback model uses the same
API, voices and style format, so no mapping is necessary. There is no second provider.

A spotlight clip sends its first attempt on the flex tier (`service_tier: "flex"`), which
costs half. The clip already waited for the router, so a slow answer does less harm. The
4 second timeout to the first slice also applies to the flex attempt. If flex does not
answer in that time, the second attempt uses the standard tier. No other clip uses flex.
See `docs/spotlight.md`.

Two cases stop the retries:

- The content filter refused the text (`TtsBlockedError`). A refusal is an HTTP 400 with
  the code `prohibited_content`, or a message that starts with "Input blocked". A second
  request gets the same answer.
- A slice already went to a player. A second request repeats the start of the clip.

The queue sends `audioEnd { discard: true }` on every failure path. The player holds a
clip open until its end arrives, so a missing `audioEnd` blocks the queue of the player.

## From the queue to the player

`ttsQueue` keeps the slices on the queue item (`createClip`). `beginChunkedDelivery`
forwards them to each player that announced `pcmAudio` in its hello message. The player
gets an `audioStart` JSON message with the sample rate, then binary frames, then
`audioEnd`. While an earlier clip plays, the queue collects the slices of a prefetched clip. It
sends them at the start of that clip's turn.

A player that did not announce `pcmAudio` gets the finished clip as one binary frame. The
frame holds a WAV file. This is also the path for a player from before the Gemini
migration. That player labels the frame as MP3, but Chromium reads the WAV header and
plays it. An OBS source that was open during the cutover continues to work without a
refresh. It only loses the early start.

## The clip card

A player that announces the hello feature `clipMeta` can show a card for a clip. The server sends
`{ type: 'clipMeta', clipId, kind, user, text, label, lang }` directly before the first frame of
the clip. On the PCM path it comes before `audioStart`. On the WAV path it comes before the WAV
frame. Each socket gets it once. `sendClipMeta` in `webSocket.js` selects the sockets, and
`processQueue` calls it. The bot sends it only when the clip has `display` data and the channel has
`spotlightCard` on.

The bot does not hold or replay this message. A held clip replays with no card. A player that does
not announce `clipMeta` gets no message, so old players keep working. An OBS source that is already
open must refresh to show the card. The player sets the card text with `textContent`. See
`docs/spotlight.md` for the card text and the layout.

## The player

`src/components/web/public/tts-player.js` plays PCM slices with Web Audio. It makes an
`AudioBuffer` from each slice and schedules it directly after the slice before it, on one
`AudioContext`. If the stream falls behind, the next slice starts 30 ms from the current
time, which gives a short gap and no overlap. A whole clip in one frame plays through the
`<audio>` element.

A browser tab keeps an `AudioContext` suspended until the page gets a click. In that
case, the player drops the clip after 400 ms and continues. It does the same thing when
the `<audio>` element refuses to play. OBS does not suspend the context.

## The timing log

`TTS_TIMING` is the latency log. `ttsQueue.logTiming` writes one info line for each clip.
It has each stage in milliseconds: Twitch to webhook, dedup claim, handler, Pub/Sub hop,
enqueue, queue wait, provider round trip, first slice sent, and total. It also has these
fields:

- `route`: `local`, `pubsub`, or `inbox`. `inbox` is a webhook that was forwarded to the
  owner of the channel (see `docs/multi-instance.md`).
- `prefetched` and `chunked`.
- `provider`, `model` and `usedFallbackModel`.
- `audioSeconds`: the length of the clip. Google bills by audio length, so this is the
  cost figure.
- `style`: the style text that was sent, or null.

The record travels in the async context (`src/lib/ttsTiming.js`) from the webhook to the
queue item, so handlers do not carry it. Every instance writes the "Received from Pub/Sub"
line, not only the instance that serves the clip. Use `route` to count the Pub/Sub share.

Query: `jsonPayload.logKey="TTS_TIMING"`. Provider log keys: `GEMINI_TTS_OK`,
`GEMINI_TTS_ERROR`, `GEMINI_TTS_BLOCKED`.

## Held clips

A clip that reaches no player is held and replayed (`holdClip` in `webSocket.js`). On
2026-10-05 an OBS source dropped (code 1006) one second before a clip arrived, and it was
back 0.4 seconds later. The clip was logged as sent and never played. The server now keeps a clip that no socket takes for 30 seconds. It keeps at most 3 clips
for each channel. It sends them to the next player that says hello. 30 seconds is also the time after which a channel with no player
loses its lease, so a quick reconnect arrives at the same instance. A later reconnect can
arrive at a different instance, and the clip expires (`HELD_AUDIO_EXPIRED`). A stop drops
held clips.

A new client has 2 seconds to say hello (`HELLO_GRACE_MS`). Before that time, the server
does not count it as an outdated player. On 2026-10-03 a source that
reconnected 18 ms before a clip was counted as outdated and missed the clip. That clip is
now held for its hello.

Log keys: `AUDIO_HELD`, `HELD_AUDIO_REPLAYED`, `HELD_AUDIO_EXPIRED`.

## Live test

`scripts/probe-audio-delivery.js` calls the real API. It tests the clip format, the
slices, the fallback model and the refusal error, and it writes each clip as a WAV file.
The unit tests mock `fetch`, so this script is the only test of the request body against
the real service.
