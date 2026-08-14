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
  - `!tts ignore add/del <username>` - Manage ignored users
  - `!tts pause/resume` - Pause/resume the TTS queue
  - `!tts stop` - Stops current audio. Users can stop their own messages; mods can stop any.
  - `!tts clear` - Clears the pending TTS queue (does not stop current audio).
  - `!tts lang <language>` - Set your preferred language boost.
  - `!tts defaultlanguage <language>` - (Mod) Set channel's default language boost.
  - `!tts pronounce <word> = <how to say it>` - (Mod) Add or update a channel pronunciation.
  - `!tts pronounce list | remove <word> | off <word> | test <text> | defaults` - (Mod) Manage the dictionary. `off` disables a built-in without deleting it; `test` previews an expansion without speaking it.
  - `!tts profanity on|off|status` - (Mod) Toggle the profanity filter (off by default).

## Pronunciation and Profanity

- **Pronunciation dictionary** (`src/lib/textRewrite/`): a built-in list of Twitch acronyms
  (`PRONUNCIATION_DEFAULTS` in `tts-config.json`) merged with per-channel overrides stored in the
  `pronunciations` map on the channel config. A channel entry with an empty value switches off the
  built-in of the same name; deleting the key restores it.
  - The built-in list was trimmed against the live API — see `docs/pronunciation-probe-results.md`
    and `scripts/probe-pronunciation.js`. Only entries the model actually gets wrong or reads as
    bare letters are included. Notably `lol` is deliberately absent: MiniMax already reads it as
    "el oh el", which is the natural result.
  - Matching is case-insensitive and anchored to word boundaries using `\p{L}\p{N}` lookarounds
    rather than `\b`, which is ASCII-only and would misfire on non-English text. Replacement is a
    single pass, so an expansion is never re-scanned by another rule.
  - MiniMax's own `pronunciation_dict` API parameter is deliberately **not** used: the probe showed
    it matches case-sensitively, so `LFG` would not match a `lfg` entry.
- **Profanity filter** (`src/lib/profanity/`): off by default, per channel. Word lists for all 40
  `languageBoost` values are hand-authored in `profanityLists.json` and validated by
  `tests/unit/profanityLists.test.js`. Substitution, not bleeping — an empty replacement would let
  a message reduce to `""`, which every caller drops silently instead of speaking.
  - Applied in `ttsQueue.enqueue`, not `formatTtsText`, because a viewer can override
    `languageBoost` for their own messages and that is only resolved there. When the viewer's
    language differs from the channel's, both lists apply.
  - `languageBoost: 'auto'` (the default) uses the English list; language cannot be detected per
    message.


## Key Files

- `src/components/tts/ttsService.js` - Handles TTS generation via Wavespeed AI API
- `src/components/tts/wavespeedVoices.js` - Hardcoded voice list with language categorization
- `src/components/tts/ttsQueue.js` - Manages TTS message queue
- `src/components/tts/ttsState.js` - Manages TTS configuration state
- `src/components/tts/ttsConstants.js` - Default settings and constants
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
- List of ignored users
- User-specific preferences (including language)

### Migration
The code automatically migrates old `botMode` settings to `botRespondsInChat`:
- `'authenticated'` → `true` (bot responds in chat)
- `'anonymous'` or `'auto'` → `false` (bot is silent)
