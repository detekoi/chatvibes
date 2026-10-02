# Channel configuration: modes, cheers, commands, rewards

Design notes for the fields of `ttsChannelConfigs` whose behavior is not obvious from the
code. The ignore list and i18n have their own files (`ignore-list.md`, `i18n.md`).

- Mode (`all`, `command`, `bits_points_only` or `highlighted_only`). **The default for a channel that never chose one
  is `command`**, and the dashboard writes `mode: 'command'` at first sign-in when the field is
  unset so the bot and the dashboard agree. Before 2026-08-31 the bot's in-memory default was
  `all` while the dashboard displayed an unset mode as `command`; the channels that had lived with
  that were backfilled to `mode: 'all'` by `scripts/backfill_mode_all.js` so nothing they heard
  changed. In `bits_points_only` and `highlighted_only` mode `!tts <text>` is silent on both
  platforms, so speech is only ever something a viewer paid for.
- **`highlighted_only` mode.** A streamer asked for this mode. They wanted TTS to read chat only
  when a viewer spends channel points on the built-in Twitch reward "Highlight My Message". Twitch
  sends these messages as ordinary `channel.chat.message` events with
  `message_type: "channel_points_highlighted"`. These events have **no**
  `channel_points_custom_reward_id`, so the redemption path never receives them. Only
  `chatHandler.js` can catch them.

  The streamer chose a fourth mode, not a toggle. The streamer also chose that `bits_points_only`
  continues to drop highlights. The result is `command` mode without free-text speech, plus
  highlights:
  - TTS reads a highlight as type `highlight`. A highlight **skips `ttsPermissionLevel`**, because
    the viewer paid, the same as for a cheer. `engineEnabled`, the ignore list, and banned words
    still suppress it.
  - Plain chat and `!tts <text>` are silent, because `say.js` returns early, as in
    `bits_points_only`. If a highlight starts with `!tts <text>`, TTS drops the prefix and reads
    the rest as a highlight. Cheers take the same `isPaidSay` route, so the message never reaches
    `say.js`.
  - Cheers keep their own switch. `readCheerMessages` and `bitsMinimumAmount` apply as in `all`
    and `command`. Only `bits_points_only` forces cheers on. If a highlight also carries a cheer
    that the cheer rules skip, TTS still reads it as a highlight. The viewer paid for the
    highlight separately.
  - The paths that do not read `mode` do not change. These are the configured TTS reward
    (`processTtsRedemption`), other reward announcements under `speakRedemptionEvents` and
    `mutedRewardIds`, and sub, raid, and follow events. `!tts` subcommands run as in every mode.
    TTS does not read the `!commands` of other bots, because `readCommandMessages` applies only in
    `all`.
  - YouTube has no highlights. On YouTube, the mode works exactly like `bits_points_only`.

  `chatHandlerHighlighted.test.js` covers this behavior.
- **Cheer messages (`readCheerMessages`, `bitsMinimumAmount`).** The text attached to a cheer is
  read in every mode once it meets `bitsMinimumAmount` (default 1), and **a cheer is never subject
  to `ttsPermissionLevel`**, because it is paid for. `readCheerMessages` (default `true`) switches
  that off in every mode except `bits_points_only`, which ignores it because reading cheers is the
  point of that mode. This replaced `bitsModeEnabled`, whose dashboard label "Require Bits for
  TTS" implied a gate it never was: it only ever *added* cheer reading to `command` mode and was
  a no-op in `all`. The five command-mode channels that existed at the switch were backfilled to
  `readCheerMessages: false` by `scripts/backfill_read_cheer_messages.js` so they heard no change,
  and the dead field was deleted. Before this, cheers in `all` mode were gated by the permission
  level; that went with the change.
  A cheer whose text starts with `!tts` is routed to the cheer branch with the prefix dropped, not
  to `say.js`: through `say` it would hit the permission level and go silent in `bits_points_only`,
  which is the opposite of what a paid message deserves. `chatHandlerCheers.test.js` pins it.
- **Chat commands for other bots (`readCommandMessages`).** In `all` mode a `!`-prefixed message the
  bot does not recognise (`!lurk`, `!so`, `!sr` for Nightbot or StreamElements) gets `null` back from
  `commandProcessor`, falls through to the regular-chat branch of `chatHandler.js` and is read as chat;
  a command the bot does know but that is not `!tts` is read aloud there on purpose. `readCommandMessages`
  (default `true`, so no backfill and no channel heard a change) switches both off: a message starting
  with `!` is then not speech. Two things are deliberately outside it. `!tts` never reaches either
  branch, because `say.js` enqueues its own speech and returns `'tts'` before the setting is consulted,
  so `!tts <text>` keeps working with it off. A cheer whose text starts with `!` is still read, as
  cheers are exempt from every other gate. The setting means nothing in `command`,
  `bits_points_only` and `highlighted_only`, which never read these, so the dashboard shows the switch off and locked there
  (the mirror of the cheer switch, which locks *on* in `bits_points_only`). The YouTube client applies
  the same test at its `all` fallthrough, after `!tts` has been recognised. `!tts readcommands on|off`
  flips it from chat. `chatHandlerCommandMessages.test.js` and `ytChatCommandMessages.test.js` pin it.
- **Muted rewards (`mutedRewardIds`).** Redemption announcements are all-or-nothing under
  `speakRedemptionEvents`; this map carves out the rewards that stay silent, typically soundboards,
  which play their own audio. It is an **exclusion** list keyed by Twitch's reward ID (a rename
  must not shed the entry) with the title stored for display only, so every existing channel hears
  no change and there was no migration. `src/lib/rewardMuteList.js` owns the format and the
  dashboard mirrors it in `functions/src/services/mutedRewards.ts`; change both together. The guard
  sits in `handleRedemptionAnnouncement` **before** the pending-approval stash, so a muted reward is
  neither announced on `.add` nor held and spoken on approval. The configured TTS reward is never in
  this list: it is not announced anyway, and `!tts redeems mute` refuses it.
  - **`!tts redeems mute <title>` resolves the title to an ID through Helix**, which needs the
    *broadcaster's* token (`channel:manage:redemptions`), not the app token, so
    `customRewards.js` calls Helix directly rather than through `helixClient.js`, using the token
    the dashboard stored (`broadcasterToken.js`, shared with redemption rejection). A channel whose
    streamer never signed in to the dashboard is told so.
  - **Resolution is deterministic first, model second, and the model may only narrow.**
    `rewardResolver.js` takes the exact title, then a unique partial match (every typed word in one
    title, any order). Only when that yields nothing or several does it ask Gemini
    (`rewardMatcherApi.js`, the emote describer's client and model) — for typos and paraphrases — and
    it accepts the answer only if the model is confident *and* the ID is in the pool it was shown.
    A pick from outside the candidates, a low-confidence pick, an error or no API key all fall back
    to the deterministic answer, so the model cannot mute a reward the words could not have meant.
    Every reply names the reward actually muted, and `unmute` matches against the stored titles
    without a Helix call, so a wrong resolution costs one command.
- **Bot Chat Responses** (`botRespondsInChat` field): Boolean controlling whether the bot sends chat responses - `true` (default, interactive mode), `false` (silent mode).
  `DEFAULT_TTS_SETTINGS` is the only default. Until 2026-09-17 `ttsState.js` overrode it for any
  channel whose config lacked the field: `true` if a dead `botMode` field said `'authenticated'`,
  otherwise a hardcoded `false` left behind when the default moved to `true`, so such a channel was
  silent while `CLAUDE.md` said it responded. `scripts/backfill_bot_responds_in_chat.js` wrote down
  what each channel was actually getting (three `true`, six `false`) so nothing changed for them,
  and deleted `botMode`.

## Keys: account IDs, never logins

Twitch logins can be renamed and then claimed by someone else; the user ID never changes. A
record keyed by login is lost on a rename and, worse, inherited by whoever takes the name next.
So every channel- and viewer-scoped document is keyed by ID: channel configs by broadcaster ID,
viewer preferences by user ID (the YouTube channel ID for YouTube chatters), the persisted queue
by broadcaster ID, the ignore list by `<platform>:<accountId>` (`ignore-list.md`).

- **Most callers hold a login**, because EventSub handlers and commands pass the channel's login
  around. `ttsState.js` maps it to the ID through the allow-list cache (`getChannelIdFromName`).
- **An unmapped login used to fall back to itself.** That read, and created, documents under
  a login key that nothing else used. At startup, before the allow-list loads, a lookup would
  miss, cache defaults under the login, and keep serving them for the life of the process. Now an
  unmapped login resolves to null: `getTtsState` serves defaults without caching them,
  `getStoredLanguageBoost` throws, and every writer returns false. For the same reason
  `restoreAllQueues` runs after the channel load in `bot.js` (with channel ownership on, each
  queue is restored by the instance that takes its channel instead).
- **Viewer preferences used to fall back from the ID key to the login key** on read, and wrote
  to the login when no ID was passed. Both paths are gone, here and in the web UI
  (`functions/src/services/preferences.ts`, `/api/tts/user-voice`). An event without a user ID
  (an anonymous gift, for example) gets channel defaults.
- **Per-channel `userPreferences` are read-only legacy.** Chat commands and the dashboard write
  the global `ttsUserPreferences` document. The per-channel setters had no callers and were
  removed. Existing entries are still honored below the global ones.
- **`!tts stop` decides "your own message" by user ID** (`currentUserIdSpeaking`), not by
  comparing logins.

The earlier migration scripts (since deleted) skipped any login whose ID key already existed, which
left a few records behind. `scripts/migrate-login-keys.js` merges them instead (fields already
under the ID key win) and reports `managedChannels` documents that lack a `twitchUserId`.

## Redemption announcements and the reward queue (`announceUnfulfilledRedemptions`)

A channel points reward that has **Skip Reward Requests Queue** switched off is redeemed as
`.add` + `unfulfilled` and sits in the streamer's queue. **`announceUnfulfilledRedemptions`
decides whether that is announced on arrival or held until the streamer accepts it, and it
defaults to `true`** — the field is read as `!== false`, so a config written before the setting
existed announces too.

The deferred behavior (`false`) is the safer one in isolation: it waits for the `.update` +
`fulfilled` that an acceptance produces, so a redemption the streamer rejects is never spoken.
It is not the default because **a streamer who never works the queue then never hears those
rewards at all**, which reads as the bot ignoring half the channel's rewards. That was the
originally reported symptom, and it is awkward to diagnose: Cloud Run runs at `LOG_LEVEL=info`
and every silent branch logs at `debug`, so the only visible signal is that the announced
`rewardTitle` values are all skip-queue rewards. Confirm with:

```
gcloud logging read 'jsonPayload.channelLogin="<channel>" AND jsonPayload.rewardTitle:*' \
  --project=chatvibestts --freshness=30d --format='value(jsonPayload.rewardTitle)' | sort | uniq -c
```

In the default mode **every** `.update` is suppressed, rather than relying on the `wasAnnounced`
guard: that map is per-instance with a 15 minute TTL, so an approval arriving an hour later on
another Cloud Run instance would announce a second time.
