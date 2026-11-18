# Chat behavior: what suppresses speech, and YouTube `!tts`

Design notes for `chatHandler.js` and `src/components/youtube/ytChatClient.js`.

- **`engineEnabled`, the ignore list and banned words suppress speech, never commands.** The
  guard at the top of `chatHandler.js` used to `return` before `processCommand`, so `!tts off`
  locked moderators out of `!tts on` (and everything else) until someone opened the dashboard,
  and an ignored viewer could not `!tts ignore del`. Commands run regardless; the only one held
  back for an ignored viewer or a banned word is `!tts <text>`, since that *is* speech.
  `!tts voice <not a voice>` falls back to `say.js` after that guard, so `say.js` repeats the
  ignore and banned-word checks. With the engine off, `say.js` refuses and replies, which is the
  better failure than silence.
  `tests/unit/chatHandlerSpeechGuard.test.js` pins all of this.
- **YouTube chat and `!tts`**: YouTube messages (`src/components/youtube/ytChatClient.js`)
  never go through `commandProcessor` — the bot cannot reply in a YouTube chat, so the
  subcommands have nothing to say there. The one exception is `!tts <text>`, which answers in
  audio: the handler recognises it via `src/lib/ttsCommandText.js`, strips the prefix from the
  text and from emote fragments, and speaks it as `command_say` in `all` and `command` mode
  (in `bits_points_only` it stays silent, as the Twitch `say` handler does). YouTube has no
  highlighted messages, so there `highlighted_only` works exactly like `bits_points_only`: `!tts`
  and plain chat are both silent. Without this a
  channel in command mode heard nothing from YouTube but Super Chats. Two boundaries are
  deliberate: a recognised subcommand name (`!tts off`, `!tts status`) stays **silent** rather
  than being read aloud as a word — the list lives in `commands/tts/subcommandNames.js`,
  separate from the dispatch map because importing `handlers/tts.js` from the YouTube client
  would close a cycle, and a test pins the two together — and `ttsPermissionLevel` is enforced
  as the Twitch `say` handler does. The proxy only forwards owner and moderator badges
  (membership badges carry no icon type), so a `subs`/`vip` gate admits only those two from
  YouTube. Role checks use **badges only**: `permissions.js` also treats a username equal to
  the channel name as the broadcaster, which is sound for an authenticated Twitch login but
  not for a YouTube display name, which the viewer picks — so `toRoleTags` never passes one. Note that YouTube's `all` mode does not apply `ttsPermissionLevel` at all; that
  predates this and was left alone.
- Spotlight mode (`mode: 'spotlight'`) sends chat to a model that picks the few messages to read.
  A candidate must pass the gates of `all` mode: engine on, viewer not ignored or opted out, no
  banned word, and `ttsPermissionLevel` allows the viewer. A message that starts with `!` is never
  a candidate, whatever `readCommandMessages` says. Spotlight mode never reads a command back. `!tts <text>` and cheers keep their own paths. On YouTube the
  permission level uses badges, as for `!tts`. YouTube `all` mode does not apply it. Nothing is
  formatted until the model picks the message. See `docs/spotlight.md`.

## Chat that a moderator removes

A moderator or a moderation bot can remove a chat message after the bot received it. Spam filters such as Sery Bot, Nightbot and Fossabot do this within about a second. The bot must not read a message that chat no longer shows. It removes the speech made from the message (`handlers/moderationHandler.js`, `ttsQueue.removeChatClips`).

Two EventSub types report a removal. They use the scopes of `channel.chat.message`, so a channel needs no new authorization.

| Type | What happened | What the bot removes |
|---|---|---|
| `channel.chat.message_delete` | One message was deleted | The clip of that message ID |
| `channel.chat.clear_user_messages` | A viewer was timed out or banned | Every clip from that viewer's chat messages in that channel |

Synthesis is too fast to stop. The first slice reaches the player in about 0.4 seconds. The wait happens later, because the player keeps its own queue. The server sends each clip as soon as it is ready, so in a busy chat a clip can wait 10 to 30 seconds in the player. The bot therefore looks for the clip in three places:

1. The server queue. The bot removes the item and stops its prefetch.
2. The clip in synthesis. The bot stops the request, and the player discards the slices it has (`audioEnd` with `discard`).
3. The player. The queue remembers the last 50 chat clips that it sent to the player, for 10 minutes. The bot sends `{ type: 'dropClip', clipIds }`. The player drops a clip that waits and stops a clip that plays now.

The bot also remembers each removal for 2 minutes. A message can still be on its way to `enqueue`, for example during an emote description, a Pub/Sub hop or a spotlight wait. `enqueue` drops such a message.

Twitch does not keep two webhooks in order, and a spam filter bans in the same second as the message. The ban can therefore arrive before the message. For this reason a timeout or a ban also covers messages that reach the bot up to 5 seconds after it (`REMOVAL_GRACE_MS`). A viewer cannot post during a timeout. The only message that can be lost is one written right after a 1-second purge. A message that arrives later than that is read as usual. Each chat item carries `chatAtMs`, the time that the message reached the bot, for this comparison. `chatHandler.js` sets it, because the timing context is gone after a spotlight wait or a Pub/Sub hop.

Only speech made from a Twitch chat message is removed. Announcements, the TTS reward and YouTube messages have no Twitch chat message, so they stay. A cheer is a chat message, so it is removed. A removal acts in every mode, also with the engine off.

These cases are not covered:

- A player from before this change ignores `dropClip`. Refresh the OBS source to get it. The server queue part works without the refresh.
- A whole clip in one WAV frame has an ID only when a spotlight card came with it. A clip without an ID cannot be named, and it plays. Current players get almost every clip as PCM slices, which carry an ID.
- A clip held for a reconnect (`holdClip`) is not dropped.
- The record of sent clips stays on the instance that sent them. After a change of owner, the new owner cannot name the clips that wait in the player.
- `/clear` (`channel.chat.clear`) is not subscribed.
- A spotlight candidate stays in the buffer and in the router context. If the router picks it, `enqueue` drops the clip, but the pick log can still list it.
- YouTube chat sends no removals.

Log key: `CHAT_REMOVAL`, at info when something was removed, with counts and no chat text. `tests/unit/ttsQueueChatRemoval.test.js` pins the behavior.
