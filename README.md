# ChatVibes - Twitch Text-to-Speech Bot

ChatVibes is a Twitch bot that reads chat messages and events aloud using Text-to-Speech (TTS), controllable via chat commands. It's designed to be deployed on Google Cloud Run and integrates with OBS via a browser source for audio playback.

> **Important:** Access to the cloud version of ChatVibes is currently invite-only via an allow-list. The self-serve web dashboard is disabled for unapproved channels. If you'd like to try the bot, please contact me via [this contact form](https://detekoi.github.io/#contact-me).

**[Streamer Dashboard →](https://chatvibestts.web.app/)** *(invite-only)*

[![License](https://img.shields.io/badge/License-BSD%202--Clause-blue.svg)](LICENSE.md) 

## Documentation

For a complete list of available commands and voices, visit the documentation:

  * [Commands Documentation](https://detekoi.github.io/chatvibesdocs.html#commands)
  * [Voices Documentation](https://detekoi.github.io/chatvibesdocs.html#voices)
  * [Language Support Documentation](https://detekoi.github.io/chatvibesdocs.html#language-boost)

## Features

  * Reads Twitch chat messages aloud.
  * Announces Twitch events (subscriptions, cheers, raids, etc.).
  * **Bot-Free Mode:** ChatVibes can now run in anonymous (bot-free) mode, reading chat without appearing as a bot in your viewer list. This is the default mode.
  * **Optional Chat Commands:** Enable authenticated mode to have the bot respond to commands in chat (like !tts status or !myvoice).
  * **Monetization with Bits:** Optionally require users to cheer a minimum number of Bits to have their message read aloud (Bits → TTS) or to generate music.
  * **Channel Points → TTS:** Create a custom Twitch Channel Point reward that viewers can redeem with a message to have it read aloud by the TTS bot.
  * Customizable voices and speech parameters via Wavespeed AI API (minimax/speech-02-turbo model).
  * Per-user voice, emotion, pitch and speed preferences for TTS.
  * Ignores specified users.
  * Audio playback through an OBS browser source.
  * Designed for Google Cloud Run deployment.

## Bot Modes: Anonymous vs Authenticated

ChatVibes operates in two modes:

### Anonymous Mode (Default - Bot-Free)

**How it works:** ChatVibes connects to your Twitch chat anonymously without appearing as a bot in your viewer list. It reads chat messages silently in the background.

**Advantages:**
- Cleaner viewer list (no bot account visible)
- Simpler setup - no bot authorization needed
- No rate limits or moderation concerns
- Works immediately after adding the OBS browser source

**Limitations:**
- Cannot respond to commands in chat (no !tts status, !myvoice, etc.)
- No chat confirmations or error messages
- Users must use the web dashboard for configuration

**When to use:** If you prefer a minimalist setup and don't need interactive chat commands.

### Authenticated Mode (Optional - Bot with Chat Commands)

**How it works:** A dedicated ChatVibes bot account joins your channel as a viewer and can read/send chat messages.

**Advantages:**
- Users can type !tts commands to get immediate responses
- Commands like !tts status, !myvoice provide instant feedback in chat
- Moderators can control TTS settings via chat
- Bot can acknowledge configuration changes

**Limitations:**
- Bot appears in your viewer list
- Requires bot authorization and channel join
- May need moderator status to avoid rate limits

**When to use:** If you want interactive chat commands and don't mind having a bot in your channel.

### Switching Between Modes

Contact the service admin or use the web dashboard to switch your channel between anonymous and authenticated modes. By default, all channels start in **anonymous mode**.

## Adding ChatVibes to Your Channel & Setup

**Note:** Access is currently invite-only. If you haven't been approved, you'll see an access denied message. [Request access here](https://detekoi.github.io/#contact-me).

Approved streamers can add or remove the ChatVibes Text-to-Speech (TTS) bot from their channel and configure it for their streaming software using the web interface:

1.  **Visit the ChatVibes Management Portal** *(invite-only)*:

      * Go to [ChatVibes Management Portal](https://chatvibestts.web.app/)
      * Click on "Login with Twitch"

2.  **Authorize the Application**:

      * You'll be redirected to Twitch to authorize ChatVibes to access necessary information.
      * Review and grant the required permissions. This process is secure and uses Twitch's official OAuth flow.

3.  **Manage the Bot & Access Setup Instructions**:

      * Once logged in, you'll see your dashboard.
      * Use the "Add Bot to My Channel" button to have ChatVibes join your channel.
      * If you wish to remove it, use the "Remove Bot from My Channel" button.
      * On the dashboard, you will also find **OBS Setup Instructions** which include your unique TTS URL for adding ChatVibes audio to your stream.

4.  **Bot Joining Time & Configuration**:

      * After adding the bot, it should join your Twitch channel within a few minutes.
      * For the TTS to function, you **must** add the provided TTS URL (from the OBS Setup Instructions on your dashboard) as a Browser Source in your streaming software (OBS, Streamlabs, etc.) and ensure audio monitoring is correctly configured as per the instructions.
      * If the bot doesn't seem to be active or responding to TTS triggers after setup, first double-check your OBS browser source and audio settings. Then, try removing and re-adding the bot via the dashboard.
      * Granting the bot moderator status (`/mod YourChatVibesBotName`) can sometimes help it avoid chat filters or rate limits, though it's not always required for basic TTS functionality. (Replace `YourChatVibesBotName` with your bot's actual Twitch username).

5.  **How TTS is Triggered**:

      * By default, ChatVibes is in **"all messages" mode**, where it reads most chat from all users. You can use the `!tts permission` and `!tts mode` commands to change this behavior. See [Commands](#command-documentation)
      * You can trigger TTS with a command like `!tts <your message>` or `!tts say <your message>`.
      * The bot also supports **Bits → TTS** and **Bits-for-Music** modes, where messages are only read or music is only generated if they are accompanied by a cheer that meets a channel-configurable minimum amount.
      * **Channel Points → TTS:** Viewers can redeem a custom Channel Point reward with a message to have it read aloud. See [Channel Points → TTS](#channel-points--tts) section below.
      * Please refer to the [main ChatVibes documentation](https://detekoi.github.io/chatvibesdocs.html) for details on setting up TTS triggers and customizing voice options.
      * The repository for the ChatVibes web UI is [here](https://github.com/detekoi/chatvibes-web-ui).

## Channel Points → TTS

ChatVibes supports creating a custom Twitch Channel Point reward that viewers can redeem with a message to have it read aloud by the TTS bot. This provides an alternative way for viewers to trigger TTS without using chat commands.

### How It Works

1. **Streamer Setup**: In the ChatVibes dashboard, go to the "Channel Points → TTS" section and enable the feature.
2. **Reward Creation**: The bot automatically creates a custom Channel Point reward on your Twitch channel with configurable settings.
3. **Viewer Redemption**: Viewers can redeem the reward with a custom message, which gets read aloud by the TTS bot.
4. **Content Policy**: The system includes built-in content filtering (length limits, link blocking, banned words) to help maintain stream quality.

### Configuration Options

**Basic Settings:**
- **Reward Title**: Customize the name of the Channel Point reward (e.g., "Text-to-Speech Message")
- **Cost**: Set how many Channel Points the reward costs to redeem
- **Prompt**: Helper text shown to viewers when redeeming
- **Auto-approve**: Skip the redemption queue for immediate processing

**Advanced Settings:**
- **Global Cooldown**: Minimum time between redemptions (in seconds)
- **Per-stream Limit**: Maximum number of redemptions per stream
- **Per-user Limit**: Maximum redemptions per user per stream
- **Content Policy**:
  - Minimum/maximum message length
  - Block links (prevents URLs from being read)
  - Banned words list (comma-separated)

### TTS Modes

The Channel Points → TTS feature works with all TTS modes:
- **All Messages**: Channel Point redemptions are read along with regular chat
- **Commands Only**: Only Channel Point redemptions and `!tts` commands are read
- **Bits/Points Only**: Only Bits cheers and Channel Point redemptions are read (regular chat is ignored)

### Management

- **Enable/Disable**: Toggle the feature on/off via the dashboard
- **Test Redemption**: Use the "Test redeem" button to simulate a redemption
- **Delete Reward**: Remove the Channel Point reward from Twitch entirely
- **Real-time Updates**: Changes take effect immediately

### Requirements

- The streamer must grant `channel:manage:redemptions` and `channel:read:redemptions` OAuth scopes during initial setup
- The bot must be added to the channel first
- Channel Points must be enabled on the Twitch channel

## Advanced

<details>
<summary>Click here if you prefer to run it yourself.</summary>

### Prerequisites

1.  **Node.js:** Version 18.x or later recommended.
2.  **npm:** Comes with Node.js.
3.  **Twitch Account for the Bot:** It's highly recommended to create a dedicated Twitch account for ChatVibes. (Centralized cloud service coming soon.)
4.  **Twitch Application:**
      * Register a new application on the [Twitch Developer Console](https://dev.twitch.tv/console/apps).
      * Set the "OAuth Redirect URLs" to something like `http://localhost:3000/auth/twitch/callback` (even if not used by this specific TTS bot directly, it's good practice for Twitch apps).
      * Note down the **Client ID** and generate a **Client Secret**.
5.  **Wavespeed AI API Key:**
      * Sign up at [Wavespeed AI](https://wavespeed.ai/).
      * Get your API key from your settings page.
6.  **Google Cloud Project:** (for perpetual uptime)
      * A Google Cloud Platform project.
      * Enabled APIs: Cloud Firestore API, Secret Manager API, Cloud Run API, Cloud Build API.
      * Firestore database created in Native mode.
      * `gcloud` CLI installed and configured for your project.

### Local Development Setup

1.  **Clone the Repository:**

    ```bash
    git clone <your-repo-url>
    cd chatvibes-tts
    ```

2.  **Install Dependencies:**

    ```bash
    npm install
    ```

3.  **Create `.env` File:**
    Copy `.env.example` to `.env` and fill in the required values:

      * `TWITCH_BOT_USERNAME`: The Twitch username for your bot (e.g., "ChatVibesBot").
      * `TWITCH_CHANNELS`: For local development only - comma-separated list of Twitch channels to join initially (e.g., "yourchannel,anotherchannel").
      * `TWITCH_CLIENT_ID`: Your Twitch application's Client ID.
      * `TWITCH_CLIENT_SECRET`: Your Twitch application's Client Secret.
      * `WAVESPEED_API_KEY`: Your Wavespeed AI API key.
      * `GOOGLE_CLOUD_PROJECT`: Your Google Cloud Project ID (e.g., "chatvibestts").
      * `TWITCH_BOT_REFRESH_TOKEN_SECRET_NAME`: Full resource name of the secret in Google Secret Manager holding the Twitch User Refresh Token for the `TWITCH_BOT_USERNAME` (e.g., `projects/chatvibestts/secrets/twitch-bot-refresh-token/versions/latest`).
      * `LOG_LEVEL`: (Optional, defaults to `info`, use `trace` or `debug` for more verbose logging).
      * `PINO_PRETTY_LOGGING`: (Optional, set to `true` for pretty console logs in development).
      * Other optional TTS defaults like `TTS_DEFAULT_VOICE_ID`, `TTS_DEFAULT_EMOTION`.

4.  **Obtain Twitch User Refresh Token for the Bot Account:**

      * Use a tool like the [Twitch CLI](https://github.com/twitchdev/twitch-cli) or another OAuth token generator.
      * Log in to Twitch as your **bot account**.
      * Generate a token with scopes: `chat:read` and `chat:edit`.
        Example with Twitch CLI:
        ```bash
        twitch token -u -s "chat:read chat:edit"
        ```
      * Store the **refresh token** (not the access token) in Google Secret Manager under the name you specified in `TWITCH_BOT_REFRESH_TOKEN_SECRET_NAME`.

5.  **Set Up Application Default Credentials (ADC) for Google Cloud (Local):**

    ```bash
    gcloud auth application-default login
    gcloud config set project chatvibestts # Your GCP Project ID
    ```

    Ensure the user account you log in with has "Cloud Datastore User" and "Secret Manager Secret Accessor" roles on the project.

6.  **Run the Bot Locally:**

    ```bash
    npm run dev
    ```

    The bot should connect to Twitch IRC and the web server for OBS will start (typically on `http://localhost:8080`).

### Deployment to Google Cloud Run

1.  **Build Docker Image:**

    ```bash
    gcloud builds submit --tag gcr.io/YOUR_GCP_PROJECT_ID/chatvibes-tts # Replace YOUR_GCP_PROJECT_ID
    ```

    (This uses the `cloudbuild.yaml` if present, or a default Docker build). Ensure your `Dockerfile` is correctly configured.

2.  **Deploy to Cloud Run:**
    Refer to the `cloudbuild.yaml` for deployment steps or use `gcloud run deploy`:

    ```bash
    gcloud run deploy chatvibes-tts-service \
      --image gcr.io/YOUR_GCP_PROJECT_ID/chatvibes-tts \
      --platform managed \
      --region YOUR_REGION \
      --allow-unauthenticated \
      --service-account YOUR_CHATVIBES_SERVICE_ACCOUNT_EMAIL \
      --set-secrets=TWITCH_BOT_REFRESH_TOKEN_SECRET_NAME=projects/YOUR_GCP_PROJECT_ID/secrets/YOUR_REFRESH_TOKEN_SECRET/versions/latest,WAVESPEED_API_KEY=projects/YOUR_GCP_PROJECT_ID/secrets/WAVESPEED_API_KEY/versions/latest \
      --set-env-vars=NODE_ENV=production,LOG_LEVEL=info,PINO_PRETTY_LOGGING=false,GOOGLE_CLOUD_PROJECT=YOUR_GCP_PROJECT_ID,TWITCH_BOT_USERNAME=YourBotName
      # Add other necessary env vars or secrets
    ```

      * Replace placeholders with your actual values.
      * Ensure the Cloud Run service account has "Cloud Datastore User" and "Secret Manager Secret Accessor" roles.

</details>

## OBS Browser Source Setup

1.  In OBS, add a new "Browser" source.
2.  Set the URL to your unique TTS URL from the ChatVibes dashboard (for cloud instances) or `http://localhost:8080/?channel=yourchannelname` for local development.
3.  Set Width and Height as needed (e.g., 300x100, can be small as it's audio-only).
4.  **Important:** After adding the source, right-click it in OBS, select "Interact". A window will pop up showing the page. If you see a button like "Click to Enable TTS Audio", click it once to allow the browser to play audio. This is required due to browser autoplay policies.
5.  **Audio Setup:** In the Audio Mixer section of OBS, click the three dots (⋮) next to the browser source's audio track, select "Advanced Audio Properties", and set "Audio Monitoring" to "Monitor and Output". This allows the streamer to hear the TTS audio.

## Command Documentation

All TTS commands are prefixed with `!tts`. For example, `!tts status`. Also documented here: [https://detekoi.github.io/chatvibesdocs.html\#commands](https://detekoi.github.io/chatvibesdocs.html#commands)

<details>
<summary>Click to expand command documentation.</summary>

### General Commands

**`!tts status`**

  * **Description:** Gets the current status of the TTS application for the channel, including whether the engine is enabled, the current mode, queue length, and default voice, pitch, speed, and emotion settings.
  * **Permission:** Everyone
  * **Usage:** `!tts status`

**`!tts voices`**

  * **Description:** Provides a link to the documentation section for available TTS voices.
  * **Permission:** Everyone
  * **Usage:** `!tts voices`

**`!tts languageslist`**

  * **Description:** Provides a list or link to available language boost options.
  * **Permission:** Everyone
  * **Usage:** `!tts languageslist`

**`!tts commands`** (Alias: `!tts help`)

  * **Description:** Provides a link to the full list of `!tts` subcommands.
  * **Permission:** Everyone
  * **Usage:** `!tts commands`

-----

### Engine & Mode Control (Moderator Only)

**`!tts on`** (Alias: `!tts enable`)

  * **Description:** Enables the TTS engine. Messages and events may be spoken based on the current mode.
  * **Permission:** Moderator
  * **Usage:** `!tts on`

**`!tts off`** (Alias: `!tts disable`)

  * **Description:** Disables the TTS engine entirely. No messages or events will be spoken.
  * **Permission:** Moderator
  * **Usage:** `!tts off`

**`!tts mode [all|command|bits_points_only]`**

  * **Description:** Toggles the TTS mode.
      * `all`: All chat messages (respecting the `!tts permission` setting) and enabled events will be spoken. **This is the default mode.**
      * `command`: Only messages triggered by specific TTS commands (like `!tts <message>`) or enabled events will be spoken. Regular chat is ignored.
      * `bits_points_only`: Only Bits cheer messages and Channel Point redemptions will be spoken. Regular chat and commands are ignored.
  * **Permission:** Moderator
  * **Usage:**
      * `!tts mode all`
      * `!tts mode command`
      * `!tts mode bits_points_only`
      * `!tts mode bits` (alias for bits_points_only)
      * `!tts mode points` (alias for bits_points_only)
      * `!tts mode` (displays current mode)

**`!tts permission [everyone|all|mods]`**

  * **Description:** Sets a filter on who can trigger TTS when the bot is in `all` mode. This does not affect `command` mode.
      * `everyone` or `all`: Any user's chat message can be spoken. (**Default**)
      * `mods`: Only messages from moderators and the broadcaster will be spoken.
  * **Permission:** Moderator
  * **Usage:**
      * `!tts permission everyone`
      * `!tts permission mods`
      * `!tts permission` (displays the current permission filter)

**`!tts bits [on|off|min <amount>]`**

  * **Description:** Configures the Bits → TTS feature, allowing channels to require a minimum Cheer amount to trigger TTS.
      * `on`: Enables Bits → TTS mode. Only messages with a sufficient cheer will be read.
      * `off`: Disables Bits → TTS mode.
      * `min <amount>`: Sets the minimum number of Bits required (e.g., `min 100`).
  * **Permission:** Moderator
  * **Usage:**
      * `!tts bits on`
      * `!tts bits off`
      * `!tts bits min 100`
      * `!tts bits` (displays the current Bits → TTS status)

-----

### Queue Management (Moderator Only)

**`!tts pause`**

  * **Description:** Pauses the processing of the TTS event queue. New messages/events will still be added to the queue but won't be spoken until resumed.
  * **Permission:** Moderator
  * **Usage:** `!tts pause`

**`!tts resume`**

  * **Description:** Resumes processing of the TTS event queue if it was paused.
  * **Permission:** Moderator
  * **Usage:** `!tts resume`

**`!tts clear`**

  * **Description:** Clears all *pending* messages and events from the TTS queue. This command does **not** stop audio that is currently playing or being generated.
  * **Permission:** Moderator
  * **Usage:** `!tts clear`

**`!tts stop`**

  * **Description:** Stops the currently playing or generating TTS audio.
      * Any user can stop a message if it was triggered by their own chat message.
      * Moderators and the broadcaster can stop any TTS audio, regardless of who initiated it.
  * **Permission:** Everyone (behavior is conditional based on who initiated the speech and who is stopping it)
  * **Usage:** `!tts stop`

-----

### User & Event Preferences

**`!tts prefs`** (Alias: `!tts preferences`)

  * **Description:** Sends you a short-lived link to **your personal TTS settings page**.  
      * Configure your own voice, pitch, speed, emotion, and language on a per-channel basis.  
      * Includes a red-outlined “Danger Zone” where you can add yourself to the channel’s TTS and/or Music ignore lists (only a moderator can undo this).  
      * The bot posts the link publicly in chat; it is signed for you only and expires after first access or 10 minutes. The page is pre-filled with the current channel.  
  * **Permission:** Everyone
  * **Usage:** `!tts prefs`

**`!tts voice <voice_id|reset>`**

  * **Description:** Allows a user to set their preferred voice for messages they trigger. Use `reset` to revert to the channel's default voice. Use `!tts voices` to get a link to available voice IDs.
  * **Permission:** Everyone (for their own preference)
  * **Usage:**
      * `!tts voice Friendly_Person`
      * `!tts voice reset`
      * `!tts voice` (displays current personal preference)

**`!tts emotion <emotion_name|reset|auto>`**

  * **Description:** Allows a user to set their preferred emotion for their messages. Valid emotions: `auto`, `neutral`, `happy`, `sad`, `angry`, `fearful`, `disgusted`, `surprised`. Use `reset` or `auto` for the channel default.
  * **Permission:** Everyone (for their own preference)
  * **Usage:**
      * `!tts emotion happy`
      * `!tts emotion reset`
      * `!tts emotion` (displays current personal preference)

**`!tts pitch <value|reset>`**

  * **Description:** Sets your personal TTS pitch. Value must be an integer between -12 and 12 (0 is normal). Use `reset` for the channel default.
  * **Permission:** Everyone (for their own preference)
  * **Usage:**
      * `!tts pitch 2`
      * `!tts pitch -3`
      * `!tts pitch reset`
      * `!tts pitch` (displays current personal preference)

**`!tts speed <value|reset>`**

  * **Description:** Sets your personal TTS speed. Value must be a number between 0.5 and 2.0 (1.0 is normal). Use `reset` for the channel default.
  * **Permission:** Everyone (for their own preference)
  * **Usage:**
      * `!tts speed 1.2`
      * `!tts speed 0.8`
      * `!tts speed reset`
      * `!tts speed` (displays current personal preference)

**`!tts language <language_name|auto|reset>`** (Alias: `!tts lang`)

  * **Description:** Sets your preferred language boost for TTS. Affects how speech is interpreted and generated for your messages. Use `auto`, `none`, or `reset` to use the channel's default. See `!tts languageslist` for available options.
  * **Permission:** Everyone
  * **Usage:**
      * `!tts language English`
      * `!tts language Japanese`
      * `!tts lang reset`
      * `!tts language` (displays current personal preference)

**`!tts ignore <username>`** / **`!tts ignore add <username>`**
* **Description:**
    * **For any user:** Allows you to add *yourself* to the TTS ignore list for the channel. Your messages will not be spoken. Use `!tts ignore yourusername` or `!tts ignore add yourusername`.
    * **For Moderators/Broadcaster:** Allows you to add *any specified Twitch user* to the TTS ignore list for the channel. Messages from this user will not be spoken.
* **Permission:** Everyone (to add themselves), Moderator (to add others)
* **Usage:**
    * `!tts ignore yourusername` (if you want to ignore yourself)
    * `!tts ignore add SomeOtherUser` (if you are a mod/broadcaster)

**`!tts ignore del <username>`** (Aliases: `delete`, `rem`, `remove`)

  * **Description:** Removes the specified Twitch user from the TTS ignore list.
  * **Permission:** Moderator only. (Users cannot remove themselves from the ignore list using this command; a mod must do it.)
  * **Usage:** `!tts ignore del SomeUser`

**`!tts ignored`**

  * **Description:** Lists all users currently on the TTS ignore list for the channel.
  * **Permission:** Moderator
  * **Usage:** `!tts ignored`

**`!tts events [on|off]`**

  * **Description:** Toggles whether Twitch events (like subscriptions, cheers, raids, etc.) are announced by TTS.
  * **Permission:** Moderator
  * **Usage:**
      * `!tts events on`
      * `!tts events off`
      * `!tts events` (displays current event announcement status)

-----

### Channel-Wide Default Configuration (Moderator Only)

**`!tts defaultvoice <voice_id|reset>`**

  * **Description:** Sets the default TTS voice for the *channel*. Use `reset` to revert to the system default. Use `!tts voices` for a link to voice IDs.
  * **Permission:** Moderator
  * **Usage:**
      * `!tts defaultvoice Friendly_Person`
      * `!tts defaultvoice reset`
      * `!tts defaultvoice` (displays current channel default)

**`!tts defaultemotion <emotion_name|reset>`**

  * **Description:** Sets the default TTS emotion for the *channel*. Valid emotions: `auto`, `neutral`, `happy`, `sad`, `angry`, `fearful`, `disgusted`, `surprised`. Use `reset` for system default (`auto`).
  * **Permission:** Moderator
  * **Usage:**
      * `!tts defaultemotion happy`
      * `!tts defaultemotion reset`
      * `!tts defaultemotion` (displays current channel default)

**`!tts defaultpitch <value|reset>`**

  * **Description:** Sets the default TTS pitch for the *channel*. Value must be an integer between -12 and 12 (0 is normal). Use `reset` for system default (0).
  * **Permission:** Moderator
  * **Usage:**
      * `!tts defaultpitch 2`
      * `!tts defaultpitch reset`
      * `!tts defaultpitch` (displays current channel default)

**`!tts defaultspeed <value|reset>`**

  * **Description:** Sets the default TTS speed for the *channel*. Value must be a number between 0.5 and 2.0 (1.0 is normal). Use `reset` for system default (1.0).
  * **Permission:** Moderator
  * **Usage:**
      * `!tts defaultspeed 1.2`
      * `!tts defaultspeed reset`
      * `!tts defaultspeed` (displays current channel default)

**`!tts defaultlanguage <language_name|reset>`**

  * **Description:** Sets the default TTS language boost for the *channel*. Use `reset` to revert to the system default (usually 'Automatic' or 'None'). See `!tts languageslist` for options.
  * **Permission:** Moderator
  * **Usage:**
      * `!tts defaultlanguage English`
      * `!tts defaultlanguage reset`
      * `!tts defaultlanguage` (displays current channel default)

-----

### Direct TTS

**`!tts <message>`** (Alias: `!tts say <message>`)
* **Description:** Immediately enqueues the provided message for TTS. This works in both `all` and `command` modes. It uses the requesting user's preferences (or channel defaults) for voice, pitch, speed, and emotion.
* **Permission:** Everyone
* **Usage:** `!tts Welcome everyone to the stream!` or `!tts say Welcome everyone!`

-----
  
### Music Generation Commands

**`!music <prompt>`**
* **Description:** Generates a short piece of music based on your prompt. If Bits-for-Music mode is on, the message must be accompanied by a cheer of the minimum required amount.
* **Permission:** Configurable by mods (default: everyone, can be mods only). User must not be on music ignore list.
* **Usage:** `!music epic orchestral battle theme`

**`!music on|off`**
* **Description:** (Mod only) Enables or disables the music generation feature for the channel.
* **Permission:** Moderator
* **Usage:** `!music on` or `!music off`

**`!music mode <all|mods>`**
* **Description:** (Mod only) Sets who can use the `!music <prompt>` command.
    * `all`: Everyone can generate music.
    * `mods`: Only moderators and the broadcaster can generate music.
* **Permission:** Moderator
* **Usage:** `!music mode all` or `!music mode mods`

**`!music bits [on|off|min <amount>]`**
* **Description:** (Mod only) Configures Bits-for-Music. When enabled, users must cheer with their prompt to generate music.
    * `on`: Enables Bits-for-Music mode.
    * `off`: Disables Bits-for-Music mode.
    * `min <amount>`: Sets the minimum number of Bits required (e.g., `min 100`).
* **Permission:** Moderator
* **Usage:**
    * `!music bits on`
    * `!music bits off`
    * `!music bits min 100`
    * `!music bits` (displays current status)

**`!music status`**
* **Description:** Shows the current status of music generation (enabled/disabled, mode, queue length, bits mode).
* **Permission:** Everyone
* **Usage:** `!music status`

**`!music clear`**
* **Description:** (Mod only) Clears all pending music generation requests from the queue.
* **Permission:** Moderator
* **Usage:** `!music clear`

**`!music ignore <username>`** / **`!music ignore add <username>`**
* **Description:**
    * **For any user:** Allows you to add *yourself* to the music ignore list. Your `!music <prompt>` requests will be ignored. Use `!music ignore yourusername` or `!music ignore add yourusername`.
    * **For Moderators/Broadcaster:** Allows you to add *any specified Twitch user* to the music ignore list.
* **Permission:** Everyone (to add themselves), Moderator (to add others)
* **Usage:**
    * `!music ignore yourusername` (if you want to ignore yourself)
    * `!music ignore add SomeOtherUser` (if you are a mod/broadcaster)

**`!music ignore del <username>`** (Aliases: `delete`, `rem`, `remove`)
* **Description:** (Mod only) Removes the specified Twitch user from the music ignore list.
* **Permission:** Moderator
* **Usage:** `!music ignore del SomeUser`

**`!music ignored`**
* **Description:** (Mod only) Lists all users currently on the music ignore list for the channel.
* **Permission:** Moderator
* **Usage:** `!music ignored`

</details>