# Ignore list (`ignoredUserIds`)

`src/lib/ignoreList.js` owns the format; every check goes through it rather than reading the
field directly. Entries are a map of `"<platform>:<accountId>"` to a record of who imposed them:

```
ignoredUserIds: {
  "twitch:52343457": { label: "Spammer", source: "moderator", by: "twitch:99", at: "2026-08-20T…" },
  "twitch:99887766": { label: "Viewer",  source: "self",      by: "twitch:99887766", at: "…" },
  "youtube:UCX6OQ3DkcsbYNE6H8uQQuVA": "A YouTube Viewer"   // legacy string, reads as moderator
}
```

- **The key is an immutable account ID, never a login.** The list used to hold lowercased logins,
  which a viewer shed by renaming — Twitch allows a login change every 60 days. The reverse was
  worse: Twitch releases abandoned logins after about six months, so whoever claimed a name still
  on a list was silently muted with no way to find out why.
- **The label is for display only.** Nothing matches on it, and it goes stale when someone renames.
  `!tts ignore del <name>` therefore matches the *stored label* first and only resolves the name
  afresh if no label matches — resolving first would return the renamed account's ID and miss the
  entry it belongs to. A viewer removing *their own* entry is matched by key instead, since their
  ID is on the message that invoked the command.
- **`source` decides who may lift the entry**, and is the whole reason the value is a record rather
  than a string. A viewer may clear an opt-out they imposed on themselves; only a moderator may
  clear a moderator's. Without it the two are indistinguishable, and the viewer opt-out endpoint
  was a blind toggle keyed on the caller's own ID — so a viewer a mod had muted for TTS abuse could
  clear that mute with one authenticated POST. The disabled checkbox in the web UI was the only
  thing standing in the way, which meant the backend was simultaneously too permissive (anyone
  could clear their own mute via the API) and the frontend too restrictive (nobody could undo their
  own opt-out).
- **A bare string value reads as `moderator`.** That is the pre-provenance shape, and so is any
  record whose `source` is missing or unrecognized. The default runs one way deliberately: guessing
  `self` would unlock every mute placed before provenance existed, while guessing `moderator` only
  costs a viewer one moderator action. There is no migration — legacy entries stay readable.
- **Every write sets all four fields.** `set({ merge: true })` deep-merges into the entry object as
  well as into the map, so a partial write would silently inherit the previous `source`. A mod
  muting someone who had opted out themselves would leave it marked `self` and still self-clearable.
  Build values with `buildIgnoreEntry` rather than by hand.
- `isIgnored` tests only for the presence of the key, so it is value-shape agnostic — none of the
  ten drop-path call sites had to change when provenance was added.
- Both platforms supply an ID on every inbound message: Twitch as `chatter_user_id`/`user_id` on
  the EventSub payload, YouTube as `authorExternalChannelId`, which `yt-chat-proxy` already
  forwards as `channelId` (see `internal/youtube/poller.go`).
- **Adding requires resolving a name to an ID.** Twitch goes through Helix `getUsersByLogin`. A
  name that resolves to nothing is refused rather than stored, since a stored non-matching name
  would sit in the list looking effective forever. YouTube has no lookup the bot can call — the
  proxy speaks InnerTube and holds no API key — so `ytChatClient` keeps a bounded 6-hour cache of
  recent chatters (`findRecentYouTubeChatter`) that maps a display name back to its channel ID.
  Names that were ambiguous within that window are reported, not guessed at.
- Stored as a map, so `arrayUnion`/`arrayRemove` do not apply: writes deep-merge a single key and
  deletes go through a `FieldPath`, exactly as `pronunciations` does. The colon in the key is why
  a dotted string path would be wrong.
- The web dashboard writes the same map (`chatvibes-web-ui`, `functions/src/api/settings.ts`), and
  resolves through Helix the same way. Everything added there is `moderator`-sourced:
  `authorizeChannelAccess` requires the caller's login to equal the channel name, so that route is
  broadcaster-only and actual mods act through chat. The viewer self-ignore toggle in `viewer.ts`
  needs no lookup — the caller is authenticated, so their ID is already in hand — and refuses with
  403 when the existing entry is not the caller's own.
- The format is mirrored by hand in two more places, since the three codebases share no package:
  `functions/src/services/ignoreEntries.ts` and `public/js/common/ignoreEntries.ts`. Change all
  three together.
- Migrated from the old `ignoredUsers` array by `scripts/migrate_ignored_users_to_ids.js`, which
  runs in two phases so the bot and dashboard can deploy in any order.

## Global opt-out (`ttsUserPreferences.globalOptOut`)

A viewer can opt out of TTS in every channel from the web dashboard. `src/lib/globalOptOut.js` owns
the field names:

```
ttsUserPreferences/<twitchUserId>: { globalOptOut: true, globalOptOutAt: "2026-10-23T…", … }
```

- It belongs to the viewer. It is on the viewer's own preferences document, not on a channel
  config. No moderator can set or clear it, so it has no `source`. Opting back in deletes both
  fields. The only writer is `PUT /api/viewer/opt-out` in `chatvibes-web-ui`
  (`functions/src/api/viewer.ts`).
- It stops the viewer's own words, not the announcements about them. An announcement (`type:
  'event'`) puts only the announcement in `text`. When the resub, watch streak or reward redemption
  announcement has a message from the viewer, the handler puts the full sentence in
  `textWithViewerMessage`. `ttsQueue.enqueue` speaks that field only for a viewer who did not opt
  out. If a handler forgets the field, the message is lost for everyone, which a test shows at
  once. The opposite design leaked the words of an opted-out viewer. The per-channel ignore list is
  stricter and skips the whole announcement.
- The TTS Channel Points reward (`type: 'reward'`) is read for an opted-out viewer, because the
  redemption is a paid request to be read. The same is true for a viewer who muted themselves in
  one channel. Only a moderator mute refuses the reward, with a refund. See
  `docs/channel-config.md`.
- The handlers check first, and `enqueue` checks last. Before they format a message,
  `chatHandler.js`, `say.js` and the resub, watch streak and redemption announcements call
  `isViewerGloballyOptedOut`. Formatting can send the text to the emote describer and the login to
  the pronoun lookup. The text of an opted-out viewer must not get that far. `enqueue` drops every
  other type from an opted-out viewer, so a route that passes the handler guards stays silent. One
  example is `!tts voice <not a voice>`, which falls back to `say.js` after the chat handler let it
  through as a command.
- The read ignores `allowViewerPreferences`. The opt-out is the consent of the viewer, not a
  preference, so a channel cannot turn it off. The voice preferences still apply only where the
  channel allows them. A YouTube item (`platform: 'youtube'`) skips the read, because only the
  dashboard sets the flag, by Twitch user ID.
- A failed read lets the viewer speak. `getGlobalUserPreferences` returns `{}` on a Firestore error
  and does not cache it, so the next message tries again. A change takes up to 60 seconds to reach
  each instance, which is the TTL of the cache. No listener exists on this collection.
- It covers Twitch only. The dashboard signs in with Twitch, and nothing links a YouTube channel ID
  to a Twitch account.
