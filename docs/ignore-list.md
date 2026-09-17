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
