# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This repository contains a Twitch Text-to-Speech (TTS) bot named WildcatTTS. The bot connects to Twitch chat and converts text messages to audio using a Wavespeed AI API-based TTS service. It allows streamers to have chat messages read aloud with configurable voices and emotions.

## Architecture

- **Core Components**:
  - **Twitch Integration**: Connects to Twitch chat via EventSub webhooks for receiving messages
  - **Command System**: Processes commands prefixed with `!tts` (chat responses configurable per-channel)
  - **TTS Service**: Generates speech audio via Wavespeed AI API
  - **TTS Queue**: Manages the order of messages to be spoken
  - **Web Server**: Hosts the browser-based audio player
  - **Firestore Storage**: Persists configuration and user preferences

- **Bot Behavior**:
  - **Chat Listening**: Bot uses EventSub `channel.chat.message` subscriptions to receive chat messages. The bot will appear in the channel's "Chat Bots" section of the viewer list (required by EventSub architecture).
  - **Chat Responses** (configurable per-channel): Control whether the bot sends chat responses via the `botRespondsInChat` boolean setting:
    - `true` (default): Interactive mode - bot can respond to chat commands like `!tts status` or `!myvoice`.
    - `false`: Silent mode - bot listens to chat but does NOT respond to commands. All configuration happens via the web dashboard.
  - The setting is configured per-channel via the `botRespondsInChat` field in Firestore's `ttsChannelConfigs` collection.
  - Implementation: See `src/components/twitch/eventsub.js` for EventSub webhook handling and `src/lib/chatSender.js` for message sending that respects the botRespondsInChat setting.

- **Key Flows**:
  1. Bot subscribes to EventSub webhooks for specified Twitch channels
  2. EventSub sends chat messages to the bot's webhook endpoint
  3. Messages are processed based on TTS mode (all chat or command only)
  4. TTS requests are queued and processed
  5. Generated audio URLs are sent to web client via WebSocket
  6. Web client plays the audio
  7. If botRespondsInChat is enabled, bot can send responses to chat; otherwise, bot remains silent

## Common Commands

### Starting the Bot
```bash
node bot.js
```

### Development Setup
```bash
# Set required environment variables
export TWITCH_CHANNELS=yourchannel
```

## TTS Features and Commands

- **Voice Customization**: Choose from multiple TTS voices
- **Emotion Control**: Set different emotions for speech
- **Language Boost**: Enhance recognition for specific languages.
- **Per-user Settings**: Configure voice, emotion, and language settings per user
- **Chat Commands**:
  - `!tts status` - View current TTS configuration
  - `!tts on/off` - Enable/disable TTS
  - `!tts mode all/command` - Set whether to read all messages or only commands
  - `!tts voices` - List available voices
  - `!tts emotion <emotion>` - Set speech emotion (neutral, happy, sad, angry, fearful, disgusted, surprised)
  - `!tts ignore [add] <username>` - Opt yourself out of TTS; mods can add anyone. The name is
    resolved to an immutable account ID at write time, so a rename does not shed the entry; an
    unresolvable name is refused.
  - `!tts ignore del` - Opt back in. With no name it means you. A viewer can only lift an entry
    they added themselves; mods can remove anyone. See the provenance notes below.
  - `!tts pause/resume` - Pause/resume the TTS queue
  - `!tts stop` - Stops current audio. Users can stop their own messages; mods can stop any.
  - `!tts clear` - Clears the pending TTS queue (does not stop current audio).
  - `!tts lang <language>` - Set your preferred language boost.
  - `!tts defaultlanguage <language>` - (Mod) Set channel's default language boost.
  - `!tts pronounce <word> = <how to say it>` - (Mod) Add or update a channel pronunciation.
  - `!tts pronounce list | remove <word> | off <word> | test <text> | defaults` - (Mod) Manage the dictionary. `off` disables a built-in without deleting it; `test` previews an expansion without speaking it.
  - `!tts profanity block|allow|status` - (Mod) Start or stop the profanity filter (off by default). The verb names the outcome because `on` reads as if it enables profanity; `on`/`off` and a few synonyms are still accepted.

## Pronunciation and Profanity

- **Pronunciation entries can be scoped by language.** An entry may carry `only` or `except`
  (BCP-47 lists); with neither it applies everywhere, which is true of all but four built-ins,
  so there was no migration. Channel overrides accept the same shape — a bare string is the
  legacy form and means "everywhere", as with the ignore list. Scoping exists because these
  are English acronyms matched as **whole words**, and a few are ordinary words elsewhere:
  `ty` is "you" in Polish, Czech and Slovak, and `af` is "off" in Afrikaans and Dutch, where it
  also injects profanity into a normal sentence. Word boundaries cannot help — being a whole
  word is exactly the problem. They use `except` rather than `only: ["en"]` deliberately:
  Twitch acronyms travel, and a German channel's chat is still full of `gg` and `brb`, so
  scope by demonstrated collision rather than by origin. `scripts/audit-pronunciation-collisions.js`
  shortlists candidates for a human; see `docs/pronunciation-probe-results.md`, which also
  records the *unsolved* half — every expansion is English text, so `gm` on a German channel
  still speaks English words. Scoping bounds that, it does not remove it.
- **`getPronunciationRules` caches by locale as well as by source object**, and that is
  load-bearing. Channels with no overrides share one rule set, so a cache keyed on the
  `pronunciations` object alone would hand every such channel whichever language compiled
  first. `src/lib/profanity/index.js` keys its cache on the language combination for the same
  reason. The locale is derived inside the function from the config, so no call site can
  forget to pass it.
- **Pronunciation dictionary** (`src/lib/textRewrite/`): a built-in list of Twitch acronyms
  (`PRONUNCIATION_DEFAULTS` in `tts-config.json`) merged with per-channel overrides stored in the
  `pronunciations` map on the channel config. A channel entry with an empty value switches off the
  built-in of the same name; deleting the key restores it.
  - The built-in list was seeded from a live-API probe — see
    `docs/pronunciation-probe-results.md` and `scripts/probe-pronunciation.js`. Notably `lol` is
    deliberately absent: MiniMax already reads it as "el oh el", which is the natural result.
  - **An acronym is pinned if its expansion carries profanity, even when MiniMax expands it
    unaided.** The profanity filter runs on the text we send, so when the model does the expanding
    the profane words exist only in the audio, downstream of the filter — `wtf` was spoken in full
    on a channel with filtering on. Model-side expansion is also unstable between renders (`lmao`
    heard phonetically, `omg` as "oh em gee"), so it is not relied on for anything.
  - Matching is case-insensitive and single-pass, so an expansion is never re-scanned by another
    rule. Word boundaries use `\p{L}\p{N}` lookarounds rather than `\b`, which is ASCII-only.
  - MiniMax's own `pronunciation_dict` API parameter is deliberately **not** used: the probe showed
    it matches case-sensitively, so `LFG` would not match a `lfg` entry.
- **Profanity filter** (`src/lib/profanity/`): off by default, per channel. Word lists for all 40
  `languageBoost` values are hand-authored in `profanityLists.json` and validated by
  `tests/unit/profanityLists.test.js`. Substitution, not bleeping — an empty replacement would let
  a message reduce to `""`, which every caller drops silently instead of speaking.
  - Applied in `ttsQueue.enqueue`, not `formatTtsText`, because a viewer can override
    `languageBoost` for their own messages and that is only resolved there. When the viewer's
    language differs from the channel's, both lists apply.
  - **English is always in the active rule set**, whatever the channel language. The pronunciation
    dictionary is English-only and runs everywhere, so a Spanish channel still gets "let's fucking
    go" out of `lfg`; loading only the Spanish list would send that through untouched.
  - `languageBoost: 'auto'` (the default) uses the English list; language cannot be detected per
    message.
  - Slurs map to the literal word `"slur"` rather than a milder insult — a softened slur still
    lands as the thing it was. English only so far.
  - For scripts written without spaces (Han, Kana, Thai, Lao, Khmer, Myanmar) the `\p{L}`
    lookarounds are the wrong boundary test, since neighbouring characters are letters even at a
    real word edge. Those terms are matched bare and validated against `Intl.Segmenter` word
    boundaries instead, which is what separates 你在**操**什么 (filter it) from **操作**系统
    ("operating system", leave it). Segmentation is computed lazily, so English channels pay
    nothing for it.


## Key Files

- `src/components/tts/ttsService.js` - Handles TTS generation via Wavespeed AI API
- `src/components/tts/wavespeedVoices.js` - Hardcoded voice list with language categorization
- `src/components/tts/ttsQueue.js` - Manages TTS message queue
- `src/components/tts/ttsState.js` - Manages TTS configuration state
- `src/components/tts/ttsConstants.js` - Default settings and constants
- `src/i18n/` - Message catalogs and the ICU-subset formatter (see below)
- `scripts/translate-catalogs.js` - Build-time catalog translation (run by hand, never in CI)
- `src/components/commands/handlers/` - Command handlers for TTS
- `src/components/web/server.js` - WebSocket server for the TTS player
- `src/components/web/public/tts-player.js` - Browser-based audio player

## Configuration

TTS configuration is stored in Firestore's `ttsChannelConfigs` collection with these settings:
- Engine enabled/disabled
- Mode (all chat or command only)
- **Bot Chat Responses** (`botRespondsInChat` field): Boolean controlling whether the bot sends chat responses - `true` (default, interactive mode), `false` (silent mode)
- Voice settings (ID, speed, volume, pitch)
- Emotion settings
- Language boost setting
- URL handling (`readFullUrls` - defaults to false, reads only domain names when false)
- Ignore list (`ignoredUserIds` — see below)
- Redemption announcements (`announceUnfulfilledRedemptions` — defaults to on, see below)
- User-specific preferences (including language)
- Announcement locale (`announcementLocale` — optional, see i18n below)

### Internationalization (`src/i18n/`)

Announcements are spoken aloud, so an English string on a Spanish channel is not a label a
viewer can ignore — it is read out in a Spanish accent. Catalogs live in
`src/i18n/messages/<bcp47>.json`, one per supported language.

- **`languageBoost` is not a locale.** It is a MiniMax *synthesis hint*, it defaults to
  `auto`, and `ttsService.mapLanguageBoost()` also accepts `'None'`/`'Automatic'`, none of
  which name a language. `src/i18n/locales.json` is the single source of truth mapping
  `languageBoost` ↔ BCP-47 ↔ Twitch `broadcaster_language`; a test asserts it stays in step
  with `VALID_LANGUAGE_BOOSTS`. `npm run sync-constants` copies it to the web UI.
- **`announcementLocale` overrides the derived value**, so a channel can run an English voice
  with Spanish announcements. Unset (the normal case) derives from `languageBoost`, and
  `auto` falls back to English — so no migration was needed.
- **Everything the bot emits resolves at the *channel* level**, never per-viewer: an
  announcement is heard by the whole channel. This is why announcements render in the handler
  before dispatch and `ttsQueue.enqueue`'s per-message resolution is untouched — in
  particular the profanity filter that deliberately lives there did not have to move.
- **Translations are generated at build time and committed**, by `npm run translate`
  (`gemini-3.7-flash`). Runtime translation was rejected for these strings: they are a closed
  set of templates, so translating per-message would put a Gemini round-trip in the TTS hot
  path and produce output that varies between renders. Emote descriptions are the one
  genuinely unbounded surface and stay a runtime call.
- **Nothing from the model is trusted.** `src/i18n/validate.js` runs in CI over every
  catalog: keys complete, no orphans, placeholders preserved, ICU well-formed, and plural
  branches matching *exactly* the categories `Intl.PluralRules` reports for that locale. That
  last rule is the one that matters — asked to translate an English `one`/`other` message,
  a model will happily return `one`/`other` for Arabic, which needs six categories, and the
  result reads as the wrong grammatical form for most numbers.
- **`src/i18n/format.js` is a deliberate ICU subset** (`{arg}`, `plural`, `select`, `#`) with
  no dependency, because the web dashboard builds with `esbuild bundle: false` and has no
  bundler entry point. It does not support ICU apostrophe escaping, so a literal `{` or `}`
  cannot appear in a message.
- **Grammatical gender is only partly solvable.** Slavic, Semitic and Indic languages inflect
  verbs by subject gender and the bot rarely knows it, so the translation prompt requires
  genderless phrasings (present tense, noun phrases) instead of defaulting to masculine.
  Hebrew and Arabic cannot comply — their verbs inflect for gender in *every* tense — so
  those catalogs carry a masculine default. Where a gender *is* known (`resolvePronounSubject`
  on resub and watch-streak messages), `announce.saidMessage` takes a `{g, select, ...}`.
  Any message given a gender key must expose it in `messages/en.json`, or the validator
  rejects the translated form as an invented placeholder.
- The English catalog is the contract every other locale is checked against, so
  `translate-catalogs.js` refuses to translate it even when named explicitly.
- **`src/lib/channelLanguageSync.js` fills the language in from Twitch** so a streamer who
  never opens the dashboard still gets announcements in their own language. It reads
  `broadcaster_language` from Helix `/channels` (via `getChannelInformation`, batching 100
  broadcaster IDs per request) and **writes only when the channel has made no choice** —
  `languageBoost` unset or one of the auto values. An explicit setting is never overwritten,
  which is why this needs no opt-out in the dashboard. Twitch languages with no MiniMax
  equivalent (`other`, `asl`, and the ones the provider does not synthesise) leave the
  channel on auto rather than being guessed at. It runs from the leader-election hook
  alongside EventSub, so N Cloud Run instances do not all poll Helix and race on the write,
  and every write logs at `info` because the silent branches log at `debug`.
- **It reads through `getStoredLanguageBoost`, never `getTtsState`, and that distinction is
  load-bearing.** `getTtsState` swallows a Firestore read error and returns
  `DEFAULT_TTS_SETTINGS`, whose `languageBoost` is `'auto'` — indistinguishable from a channel
  that genuinely never chose one. Any caller that *writes* on the absence of a setting would
  therefore destroy a real preference during a transient outage. `getStoredLanguageBoost` lets
  the error propagate so the sync can skip the channel instead. The same trap is noted inline
  at `getTtsState`'s catch block ("a failed read is not evidence the channel is new"); apply
  the same reasoning to any future setting that gets auto-populated.

### Redemption announcements and the reward queue (`announceUnfulfilledRedemptions`)

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

### Ignore list (`ignoredUserIds`)

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

### Allow-list vs. active (`managedChannels`)

`src/lib/allowList.js` answers two separate questions, and conflating them is a bug:

- `isChannelAllowed()` — the channel is **approved** to use the service, which means a
  `managedChannels` document exists for it. Approval is granted by an admin creating the document;
  the web UI's `/api/bot/add` refuses to activate a channel that has none.
- `isChannelActive()` — the bot is **switched on** (`isActive: true` on that document).

"Deactivate TTS Service" in the dashboard clears `isActive` and keeps the document, so a channel
that stops using the bot stays approved: its OBS overlay socket and its dashboard keep working, and
switching the bot back on needs no re-approval. Only deleting the document revokes approval.

Gate on `isChannelActive` anything that speaks or reacts in a channel (EventSub events, channel
point redemptions) — a stale EventSub subscription can outlive the deactivation that unsubscribed
it. Gate on `isChannelAllowed` anything that merely belongs to the channel owner (the overlay
WebSocket, the settings API). The sibling ChatSage bot (`twitch-knowledge-bot`) mirrors this split,
except that its allow-list fails closed with no startup grace period.

### EventSub duplicate subscriptions (`PUBLIC_URL`)

Twitch keys subscription identity on type + condition + **transport callback**. Cloud Run answers
this service on two hostnames — `chatvibes-tts-service-906125386407.us-central1.run.app` (the
deployed `PUBLIC_URL`) and `chatvibes-tts-service-h7kj56ct4q-uc.a.run.app` (the hash form that
`gcloud run services list` prints) — so the same subscription registered under each is two
subscriptions as far as Twitch is concerned.

**Neither existing guard catches that.** The 409 "already exists" handling in `twitchSubs.js`
never fires, because the two are not identical to Twitch. The idempotency check in `eventsub.js`
does not either: it keys on `twitch-eventsub-message-id`, which Twitch assigns *per delivery*, so
each copy arrives with its own id and both pass.

The symptom is every chat message spoken twice and audio drifting further behind chat as the
doubled queue drains at half speed. It reads as a TTS or queue bug, which is the wrong place to
look. **Set `PUBLIC_URL` in a local `.env` to the deployed value before running any subscribe
script**, or the run silently doubles every channel it touches.

A second, unrelated path to the same symptom is a race: two concurrent subscribe calls can both
create a subscription before either sees a 409, producing two identical subs on the *same*
callback (observed milliseconds apart). The `activeSubscriptionRequests` in-flight guard is
per-instance and does not span Cloud Run instances.

`scripts/verify-channel-subscriptions.js` detects both, plus callback drift, and exits non-zero.
It counts subscriptions rather than collapsing them into a set of type names — the set is what hid
the original occurrence. `scripts/cleanup-eventsub.js` deletes strays on the legacy hostname.
When removing a duplicate, confirm the surviving copy exists first or you drop coverage.

### Migration
The code automatically migrates old `botMode` settings to `botRespondsInChat`:
- `'authenticated'` → `true` (bot responds in chat)
- `'anonymous'` or `'auto'` → `false` (bot is silent)
