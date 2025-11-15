# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This repository contains a Twitch Text-to-Speech (TTS) bot named ChatVibes. The bot connects to Twitch chat and converts text messages to audio using a Wavespeed AI API-based TTS service. It allows streamers to have chat messages read aloud with configurable voices and emotions.

## Architecture

- **Core Components**:
  - **Twitch Integration**: Connects to Twitch chat via IRC (supports both anonymous and authenticated modes)
  - **Command System**: Processes commands prefixed with `!tts` (only sends chat responses in authenticated mode)
  - **TTS Service**: Generates speech audio via Wavespeed AI API
  - **TTS Queue**: Manages the order of messages to be spoken
  - **Web Server**: Hosts the browser-based audio player
  - **Firestore Storage**: Persists configuration and user preferences

- **Bot Modes**:
  - **Anonymous Mode** (default): Connects to Twitch IRC using a "justinfan" anonymous connection. The bot does not appear in the viewer list and cannot send chat messages. All configuration happens via the web dashboard.
  - **Authenticated Mode** (optional): Uses OAuth to connect as a dedicated bot account. The bot appears in the viewer list and can respond to chat commands like `!tts status` or `!myvoice`.
  - The mode is configured per-channel via the `botMode` field in Firestore's `ttsChannelConfigs` collection. Valid values: `'anonymous'`, `'authenticated'`, or `'auto'` (try authenticated, fallback to anonymous).
  - Implementation: See `src/components/twitch/ircClient.js` for connection logic and `src/lib/ircSender.js` for message sending that respects the current mode.

- **Key Flows**:
  1. Bot connects to specified Twitch channels (anonymous or authenticated based on channel config)
  2. Messages are processed based on TTS mode (all chat or command only)
  3. TTS requests are queued and processed
  4. Generated audio URLs are sent to web client via WebSocket
  5. Web client plays the audio
  6. In authenticated mode, bot can respond to commands in chat; in anonymous mode, responses are silent

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
- **Bot Mode** (`botMode` field): Determines IRC connection type - `'anonymous'` (default, bot-free), `'authenticated'` (bot with chat commands), or `'auto'`
- Voice settings (ID, speed, volume, pitch)
- Emotion settings
- Language boost setting
- URL handling (`readFullUrls` - defaults to false, reads only domain names when false)
- List of ignored users
- User-specific preferences (including language)

### Migration
Run `node scripts/migrateBotMode.js` to add the `botMode` field to existing channel configs (defaults to `'anonymous'`).
