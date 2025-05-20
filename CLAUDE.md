# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This repository contains a Twitch Text-to-Speech (TTS) bot named ChatVibes. The bot connects to Twitch chat and converts text messages to audio using a Replicate API-based TTS service. It allows streamers to have chat messages read aloud with configurable voices and emotions.

## Architecture

- **Core Components**:
  - **Twitch Integration**: Connects to Twitch chat via IRC
  - **Command System**: Processes commands prefixed with `!tts`
  - **TTS Service**: Generates speech audio via Replicate API
  - **TTS Queue**: Manages the order of messages to be spoken
  - **Web Server**: Hosts the browser-based audio player
  - **Firestore Storage**: Persists configuration and user preferences

- **Key Flows**:
  1. Bot connects to specified Twitch channels
  2. Messages are processed based on TTS mode (all chat or command only)
  3. TTS requests are queued and processed
  4. Generated audio URLs are sent to web client via WebSocket
  5. Web client plays the audio

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
  - `!tts emotion <emotion>` - Set speech emotion (auto, neutral, happy, sad, etc.)
  - `!tts ignore add/del <username>` - Manage ignored users
  - `!tts pause/resume` - Pause/resume the TTS queue
  - `!tts stop` - Stops current audio. Users can stop their own messages; mods can stop any.
  - `!tts clear` - Clears the pending TTS queue (does not stop current audio).
  - `!tts lang <language>` - Set your preferred language boost.
  - `!tts defaultlanguage <language>` - (Mod) Set channel's default language boost.


## Key Files

- `src/components/tts/ttsService.js` - Handles TTS generation via Replicate API
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
- Voice settings (ID, speed, volume, pitch)
- Emotion settings
- Language boost setting (New)
- List of ignored users
- User-specific preferences (including language)
