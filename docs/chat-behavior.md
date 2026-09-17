# Chat behavior: what suppresses speech, and YouTube `!tts`

Design notes for `chatHandler.js` and `src/components/youtube/ytChatClient.js`.

- **`engineEnabled`, the ignore list and banned words suppress speech, never commands.** The
  guard at the top of `chatHandler.js` used to `return` before `processCommand`, so `!tts off`
  locked moderators out of `!tts on` (and everything else) until someone opened the dashboard,
  and an ignored viewer could not `!tts ignore del`. Commands run regardless; the only one held
  back for an ignored viewer or a banned word is `!tts <text>`, since that *is* speech. With the
  engine off, `say.js` refuses and replies, which is the better failure than silence.
  `tests/unit/chatHandlerSpeechGuard.test.js` pins all of this.
- **YouTube chat and `!tts`**: YouTube messages (`src/components/youtube/ytChatClient.js`)
  never go through `commandProcessor` — the bot cannot reply in a YouTube chat, so the
  subcommands have nothing to say there. The one exception is `!tts <text>`, which answers in
  audio: the handler recognises it via `src/lib/ttsCommandText.js`, strips the prefix from the
  text and from emote fragments, and speaks it as `command_say` in `all` and `command` mode
  (in `bits_points_only` it stays silent, as the Twitch `say` handler does). Without this a
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
