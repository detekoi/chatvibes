# CLAUDE.md

WildcatTTS: a Twitch (and YouTube) text-to-speech bot. It receives chat over EventSub webhooks,
synthesises speech (302.ai streamed, Wavespeed as fallback) and pushes the audio over a WebSocket
to a browser player, usually an OBS browser source. Configuration lives in Firestore and is
edited from chat (`!tts …`) or the web dashboard (`../chatvibes-web-ui`).

This file holds the rules. The reasoning behind them — what broke, what was rejected, which
backfills ran — is in `docs/`. **Read the matching doc before changing a subsystem**; most of
these rules exist because the obvious implementation was already tried and failed.

## Commands

```bash
npm start                 # node src/bot.js
npm test                  # jest (ESM, needs the NODE_OPTIONS the script sets)
npm run lint
npm run sync-constants    # copy tts-config.json and locales.json to the web UI
npm run translate         # regenerate i18n catalogs; by hand, never in CI
```

## Flow

1. The elected leader subscribes each active channel to EventSub (`src/components/twitch/`).
2. `eventsub.js` receives the webhook, dedups it and hands chat to `chatHandler.js`.
3. `commandProcessor` runs `!tts` commands; otherwise the channel's mode decides if it is speech.
4. `ttsQueue.enqueue` resolves per-viewer settings, rewrites the text (pronunciation, profanity)
   and queues it; `ttsService.js` synthesises.
5. `web/server.js` streams the audio to `web/public/tts-player.js`.
6. Chat replies go through `src/lib/chatSender.js`, which honors `botRespondsInChat`.

YouTube chat arrives from `yt-chat-proxy` via `src/components/youtube/ytChatClient.js`.

## Key files

- `src/components/tts/` — `ttsService.js` (providers), `ttsQueue.js`, `ttsState.js` (config
  reads and writes), `ttsConstants.js` (`DEFAULT_TTS_SETTINGS`), `tts-config.json`,
  `wavespeedVoices.js`
- `src/components/commands/` — `commandProcessor.js`, `handlers/tts.js` (dispatch map), one file
  per `!tts` subcommand under `tts/`
- `src/lib/textRewrite/`, `src/lib/profanity/` — pronunciation dictionary, profanity filter
- `src/i18n/` — catalogs, `locales.json`, the ICU-subset formatter, the validator
- `src/lib/ignoreList.js`, `src/lib/rewardMuteList.js`, `src/lib/allowList.js` — each owns a
  Firestore format; never read those fields directly
- `scripts/` — backfills, EventSub maintenance, pronunciation probes (excluded from deploys)

## Channel config (`ttsChannelConfigs`)

`DEFAULT_TTS_SETTINGS` is the only source of defaults. Fields with non-obvious semantics:

| Field | Default | Note |
|---|---|---|
| `engineEnabled` | on | Suppresses speech, never commands |
| `mode` | `command` | `all`, `command`, `bits_points_only` |
| `botRespondsInChat` | `true` | `false` = listen only, configure from the dashboard |
| `readCheerMessages`, `bitsMinimumAmount` | `true`, 1 | Cheers skip `ttsPermissionLevel`; forced on in `bits_points_only` |
| `readCommandMessages` | `true` | `all` mode only: read other bots' `!commands`. Never affects `!tts` or cheers |
| `speakRedemptionEvents`, `mutedRewardIds` | — | Exclusion map keyed by reward ID; title is display only |
| `announceUnfulfilledRedemptions` | `true` | Read as `!== false`. In this mode every `.update` is suppressed |
| `ignoredUserIds` | — | Map of `"<platform>:<accountId>"` to a provenance record |
| `languageBoost` | `auto` | A synthesis hint, **not** a locale |
| `announcementLocale` | unset | Overrides the locale derived from `languageBoost` |
| `pronunciations` | — | Channel overrides; an empty value disables the built-in |
| `readFullUrls` | `false` | Off reads only the domain |

Also: voice (ID, speed, volume, pitch), emotion, profanity filter (off by default), per-user
preferences. Details: `docs/channel-config.md`.

## Chat commands

`!tts` + `status`, `on|off`, `mode all|command`, `voices`, `emotion <e>`, `lang <l>`,
`pause|resume`, `stop` (own message; mods any), `clear`, `ignore [add] <user>`, `ignore del [user]`,
`<text>` (speak it). Mod only: `defaultlanguage <l>`, `pronounce <word> = <say>` and
`pronounce list|remove|off|test|defaults`, `redeems mute|unmute <title>` and `redeems list|all`,
`readcommands on|off`, `profanity block|allow|status`.

## Rules that are easy to break

**Chat handling** — `docs/chat-behavior.md`
- `engineEnabled`, the ignore list and banned words gate speech only. Commands always run; the
  one held back is `!tts <text>`, because it is speech.
- YouTube messages never reach `commandProcessor`. Only `!tts <text>` is recognised; subcommand
  names stay silent (`commands/tts/subcommandNames.js`, kept separate to avoid an import cycle).
  YouTube role checks use badges only, never the display name.
- A cheer starting with `!tts` goes to the cheer branch, not `say.js`.

**Text rewriting** — `docs/pronunciation-and-profanity.md`
- The profanity filter runs in `ttsQueue.enqueue`, not `formatTtsText`: the viewer's language is
  only resolved there. English is always in the active rule set.
- Pin an acronym in the dictionary if its expansion is profane, even when MiniMax expands it
  unaided; model-side expansion happens downstream of the filter.
- Rule caches key on locale as well as on the source object. Keep it that way.
- Rules run on the gaps between URLs. Do not reintroduce placeholder substitution.
- Scope a pronunciation entry by language (`except`) only where the local meaning differs.
- Do not use MiniMax's `pronunciation_dict` parameter; it matches case-sensitively.

**i18n** — `docs/i18n.md`
- Everything the bot says resolves at the channel locale, never per viewer. Commands use
  `context.t('cmd.…')`; a command without a translator throws by design.
- `en.json` is the contract. Catalogs are generated by `npm run translate` and committed;
  `src/i18n/validate.js` rejects anything malformed, including wrong plural categories.
- A message whose singular and plural differ in structure takes two keys (`x`, `x.repeated`).
- `format.js` is a dependency-free ICU subset; a literal `{` or `}` cannot appear in a message.
- Validators return `{ reasonKey, reasonParams }`, never prose. `usage` strings stay untranslated.
- Code that writes when a setting is absent must read through a function that lets Firestore
  errors propagate (`getStoredLanguageBoost`). `getTtsState` returns defaults on a failed read.

**Ignore list** — `docs/ignore-list.md`
- Keys are immutable account IDs; the label is display only. Build values with
  `buildIgnoreEntry` — all four fields on every write, because `merge: true` deep-merges.
- `source` decides who may lift an entry. A legacy string or unknown `source` reads as `moderator`.
- The format is mirrored by hand in `chatvibes-web-ui` (`functions/src/services/ignoreEntries.ts`,
  `public/js/common/ignoreEntries.ts`). Change all three together. The same applies to
  `rewardMuteList.js` and `functions/src/services/mutedRewards.ts`.

**Rewards** — `docs/channel-config.md`
- Title resolution is deterministic first; the model may only narrow within the candidates shown.
- Reward lookups need the broadcaster's token, so `customRewards.js` bypasses `helixClient.js`.
- The mute guard sits before the pending-approval stash in `handleRedemptionAnnouncement`.

**Channels and EventSub** — `docs/allow-list.md`, `docs/eventsub-duplicate-subscriptions.md`,
`docs/CHANNEL_MANAGEMENT.md`
- `isChannelAllowed` (document exists) is not `isChannelActive` (`isActive: true`). Gate anything
  that speaks or reacts on *active*; gate what belongs to the owner (overlay socket, settings
  API) on *allowed*.
- **Set `PUBLIC_URL` in `.env` to the deployed value before running any subscribe script.** The
  service answers on two hostnames and Twitch treats the callbacks as distinct, so every message
  is spoken twice. Check with `scripts/verify-channel-subscriptions.js`.

**Audio** — `docs/audio-delivery.md`
- Synthesis is streamed and forwarded slice by slice to players that announced `chunkedAudio`.
  Every failure path must send `audioEnd { discard: true }`, or the player holds the clip open.
- `TTS_TIMING` is the per-clip latency log: `jsonPayload.logKey="TTS_TIMING"`.

## Operations

Cloud Run (`chatvibestts`, `us-central1`) runs at `LOG_LEVEL=info`, and most silent branches log
at `debug` — an absent log line is not evidence that nothing happened.
