# Spotlight mode

Design notes for `mode: 'spotlight'`. The code is in `src/lib/spotlight/`, in the `spotlight` branches of `chatHandler.js` and `ytChatClient.js`, and in the clip card code of `ttsQueue.js`, `webSocket.js` and `tts-player.js`.

## What it is

In `all` mode a busy chat is noise. In `command` mode good messages go unread. Spotlight mode sits between the two. A small model reads chat in short batches and picks the few messages that are worth reading aloud. The bot speaks only those messages.

The small model is the router. It is a call to `gemini-3.5-flash-lite`, and the environment variable `SPOTLIGHT_GEMINI_MODEL` changes the model. The router returns the IDs of the picks and a short reason for each one.

The bot speaks each pick with the prefix from `announce.spotlight`. In English the text is "Chat spotlight from {user}: {message}". The bot says the prefix in the channel locale. The clip has the type `spotlight`.

The mode is named Spotlight so that it does not collide with `highlighted_only`, which reads the Twitch "Highlight My Message" reward. A highlighted message is an ordinary candidate in spotlight mode.

## The flow

1. `chatHandler.js` or `ytChatClient.js` makes sure that a message passes the gates below. The message then goes to `offerSpotlightCandidate` as a candidate.
2. The candidate holds the clean text, the viewer and a `speak` closure. The bot does not format the text and does not describe emotes at this point. An emote description is a model call, and most candidates are never read.
3. `spotlightBuffer.js` collects the candidates of a channel. It sends a batch to the router when the window ends or the batch is full.
4. The router returns the picks. The buffer drops a pick that is too old, then calls `speak` for each pick in chat order.
5. `speak` formats the text, adds the prefix and calls `dispatchTtsEvent` (Twitch) or `dispatchYouTubeTtsEvent` (YouTube). The clip then follows the normal path through `ttsQueue.enqueue`. The profanity filter, the disabled sound tags and the opt-out backstop all apply.
6. The buffer writes the pick to the pick log.

If both router attempts fail, the bot drops the batch and speaks nothing.

## Which messages are candidates

A candidate must pass the same gates as `all` mode:

- The engine is on.
- The viewer is not on the ignore list.
- The viewer has not opted out of TTS in every channel.
- The text has no banned word.
- The viewer has the `ttsPermissionLevel` of the channel.

On YouTube, the permission level uses the badges of the viewer. YouTube `all` mode does not apply the permission level, so spotlight mode is stricter there. On YouTube, `youtubeEnabled` must also be on. The global opt-out belongs to a Twitch account, so it does not apply to a YouTube viewer.

A message that starts with `!` is never a candidate. The `readCommandMessages` field does not change this. Spotlight mode never reads a command back, and `readCommandMessages` has no effect in this mode.

Some messages do not go through the buffer and work as in other modes:

- `!tts <text>` is speech from the viewer, and it follows the `command` mode rules.
- A cheer follows `readCheerMessages` and `bitsMinimumAmount`.
- A Super Chat, a Super Sticker, a membership, an event and a reward work as before.

A text with no letter and no digit is skipped before any model call. An emote-only message is an example.

## Batching

All limits are in `config.spotlight` (`src/config/loader.js`).

| Limit | Value | Meaning |
|---|---|---|
| `windowMs` | 6000 | The batch goes out 6 seconds after its first candidate. |
| `maxBatch` | 20 | The batch goes out at once when 20 candidates wait. |
| `maxBuffered` | 60 | The buffer drops the oldest candidate beyond 60. |
| `contextSize` | 15 | The router gets the last 15 messages of earlier batches as context. |
| `maxAgeMs` | 45000 | A pick that is older than 45 seconds is not spoken. |

One router call runs for each channel at a time. A candidate that arrives during a call waits for the next batch. The context lets the model see repeats and running jokes. It never picks from the context. A channel that is idle for 5 minutes loses its context.

The buffer reads the channel configuration again when it sends a batch. If the mode is no longer `spotlight`, or the engine is off, the bot discards the batch and everything that waits. If a viewer is on the ignore list now, or a text has a banned word now, the buffer removes that candidate. The candidate never reaches the model, the context or speech. A moderator who reacts to a message expects that nobody reads it a few seconds later.

## The router call

`spotlightRouter.pickNotable` uses a raw `fetch` to the Interactions API, in the style of `ttsService.js`. It does not use the SDK. The fixed rules are in `spotlightPrompt.js`. They go in `system_instruction`. The chat goes in the input, as JSON.

- Every request sends `store: false`. The API keeps interactions for weeks by default, and the chat text is not ours to keep. Do not remove it.
- The request sends no `temperature`, `top_p` or `top_k`. The model ignores them, and later versions reject them. The thinking level is `minimal`.
- The candidate IDs are short batch labels (`m1`, `m2`). The code keeps only IDs that it sent, each one once. The model cannot pick a message that is not in the batch.
- Chat text is data for the model. A message that asks to be picked or claims to come from the streamer is rejected by the rules.
- The guidance of the streamer is a preference. It can narrow the picks or favor one kind of pick. It cannot make the model pick a kind of message that the rules reject.
- Most batches have no pick. The empty answer is normal.

The first attempt uses the flex tier, which costs half. Flex is best effort. The attempt has a limit of 10 seconds (`flexTimeoutMs`). The bot makes one standard-tier attempt with a limit of 6 seconds (`standardTimeoutMs`) after one of these results from flex:

- The attempt timed out.
- A network error.
- HTTP 429.
- An HTTP 5xx status.
- An answer that does not match the schema.

A 4xx status other than 429 is a fault in the request, so the bot does not repeat it. There is no other retry. A batch that both attempts miss is dropped. A batch that arrives when `GEMINI_API_KEY` is not set is also dropped.

The bot sends a batch two times at most. A flex call that the bot aborts can still be billed, so the flex limit is short.

## The first probe

`scripts/probe-spotlight-router.js` calls the real API. The flags are in the header of the script. `--module` calls `pickNotable` from the real router module.

On 2026-11-17 the first probe made 18 calls in one off-peak window. Flex had a median of 1.6 seconds and a maximum of 3.5 seconds. The standard tier had a median of 0.7 seconds. The cost is about $0.17 for 1000 batches on flex.

This is one window at one time of day. Flex is best effort, so the numbers do not describe peak hours. Use the `SPOTLIGHT_ROUTE` log (see Operations) to measure the real flex share.

## Several instances

The buffer is state that only the owner of a channel has whole. See `docs/multi-instance.md`.

- `offerSpotlightCandidate` and the flush act only where `ownsBroadcaster()` is true.
- When this instance loses a channel, `wireSpotlightOwnership` drops the buffer of that channel. A handover loses at most one window of candidates. The queue handoff does not carry the buffer.
- If no browser source is open on any instance, nobody owns the channel. Spotlight mode then does nothing for that channel. This is correct, because nobody can hear a pick.
- Every instance receives every YouTube message. The buffer keys a YouTube candidate to the bound Twitch channel, and it accepts the candidate only on the owner of that channel.
- The pick log has one writer, the owner.

With ownership off (outside Cloud Run), every `ownsBroadcaster()` call returns true and the local process does everything.

## The card in the browser source

If `spotlightCard` is on, the browser source shows a card with the name of the viewer and the message while the bot reads a pick. The card is off by default. The streamer turns it on in the dashboard.

The card has its own message on the player WebSocket:

```json
{ "type": "clipMeta", "clipId": "...", "kind": "spotlight", "user": "...", "text": "...", "label": "...", "lang": "..." }
```

- A player says that it can show cards with the hello feature `clipMeta`. A player that does not say it gets nothing, and an old player keeps working with no card.
- The server sends the message directly before the first frame of the clip to each socket, once for each socket. On the PCM path it comes before `audioStart`. On the WAV path it comes before the WAV frame. `sendClipMeta` in `webSocket.js` selects the sockets, and `processQueue` calls it.
- A queue item holds `display { kind, user, text }`. `ttsQueue.enqueue` applies the disabled sound tags and the profanity filter to `display.text`. It also cuts the text to 200 code points and the name to 50. A text that is empty after that gives no card, and the clip is still spoken.
- The text on the card is the clean message of the viewer, not the formatted speech. It does not have the prefix.
- The label comes from the server (`overlay.spotlight.label`) in the channel locale, because the player has no catalogs. `lang` is that locale.
- The bot does not hold or replay the message. A clip that the bot holds for 30 seconds (see `docs/audio-delivery.md`) replays with no card.
- `clipMetaFor` reads `spotlightCard` when the clip is delivered, not at prefetch. A card shows only while its own clip plays.

The player (`tts-player.js`) keeps the message for 5 seconds and attaches it to the next clip that matches. It shows the card when the clip starts to play. It hides the card when the clip ends, when the bot discards the clip, and when a stop arrives.

The player sets all text with `textContent`. The text is chat, and the bot did not write it. Do not use `innerHTML`.

`index.html` loads two fonts from Google Fonts (Archivo and Public Sans). If the network is not available, the card uses system fonts. The card is marked `aria-hidden`, because it repeats what the audio says.

An OBS source that is already open needs a refresh before it can show the card, because the old page does not announce `clipMeta`.

## The pick log

The bot writes the last picks of a channel to the Firestore document `ttsSpotlightLog/<broadcasterId>`. The field `picks` is an array, with the newest pick last. It holds 30 picks at most. Each entry has these fields:

- `user`: the display name of the viewer.
- `userId`: the account ID, or null.
- `text`: the message, 500 characters at most.
- `reason`: the reason from the router.
- `at`: the time when the bot spoke the pick, in epoch milliseconds.
- `platform`: `twitch` or `youtube`.

Only the owner writes the log. A write that fails logs a warning and never holds back speech. The writes of one channel run one after another.

The dashboard reads this log. `functions/src/services/spotlight.ts` in `chatvibes-web-ui` mirrors the format by hand. Change both together.

## Configuration

| Field | Default | Note |
|---|---|---|
| `mode` | `command` | `spotlight` is a new value. |
| `spotlightGuidance` | unset | Free text, 300 characters at most. |
| `spotlightCard` | `false` | Shows the card in the browser source. Dashboard only. |

The limit is `SPOTLIGHT.GUIDANCE_MAX` in `tts-config.json`. `npm run sync-constants` copies it to the web UI. An empty string clears the guidance.

A moderator sets the guidance with `!tts spotlight <text|off>`. The bare command `!tts spotlight` shows the current guidance. The bot refuses a text over the limit and says so in a reply. `!tts mode spotlight` turns the mode on. The command `!tts spotlight` is on the list in `subcommandNames.js`, so YouTube stays silent for it.

## Operations

- `SPOTLIGHT_ROUTE` is one info line for each batch. Query: `jsonPayload.logKey="SPOTLIGHT_ROUTE"`. The line never has chat text. It has these fields:
  - `tier`: `flex`, `standard` or `failed`.
  - `fellBack`, the outcome of each attempt and the milliseconds of each attempt.
  - The batch size, the context size and the number of picks.
  - The token counts.
- A failure on both tiers logs a warning with the outcome of each attempt. A rejected request (a 4xx status) logs a warning and is not repeated.
- `TTS_TIMING` has `route: 'spotlight'` for a pick. Its stages measure from the pick decision. `spotlightWaitMs` is the wait from the chat message to the decision. It is not part of `totalMs`.
- Most other branches log at `debug`. The bot runs at `LOG_LEVEL=info`, so an absent line does not prove that nothing happened. The debug lines say why the buffer dropped a candidate or a batch.
- Do not put chat text in an info log line. The log of the router is the model for this.
- To measure the flex share, the fallback share and the picks for each batch, read `SPOTLIGHT_ROUTE` after a deployment.

## What version 1 leaves out

- There is no pace cap. The model decides how many messages to pick. A channel that wants fewer picks uses the guidance.
- There is no fairness between viewers. A viewer who writes good messages can have many picks.
- No code removes a queued clip when a moderator deletes the chat message. This is true for every mode. It needs new EventSub subscriptions and a queue lookup by message ID. In spotlight mode a deleted message can still be read, because a candidate waits for the window and the router call.
- A held clip replays with no card.

## Related change in the same branch

Pull request #71 moved the emote describer and the reward matcher to `gemini-3.5-flash-lite` by default. It also fixed a fault. With `@google/genai`, `systemInstruction` must be inside `config` for `generateContent` calls. The SDK drops a top-level `systemInstruction`, so the system prompts of the emote describer and the reward matcher never reached the API before. Keep `systemInstruction` inside `config`.
