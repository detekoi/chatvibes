# ChatVibes - Twitch Text-to-Speech Bot

ChatVibes is a Twitch bot that reads chat messages and events aloud using Text-to-Speech (TTS), controllable via chat commands. It's designed to be deployed on Google Cloud Run and integrates with OBS via a browser source for audio playback.

**[Add ChatVibes to your Twitch channel →](https://chatvibestts.web.app/)**

[![License](https://img.shields.io/badge/License-BSD%202--Clause-blue.svg)](LICENSE.md) 

## Documentation

For a complete list of available commands and voices, visit the documentation:

  * [Commands Documentation](https://detekoi.github.io/chatvibesdocs.html#commands)
  * [Voices Documentation](https://detekoi.github.io/chatvibesdocs.html#voices)
  * [Language Support Documentation](https://detekoi.github.io/chatvibesdocs.html#language-boost)

## Features

  * Reads Twitch chat messages aloud.
  * Announces Twitch events (subscriptions, cheers, raids, etc.).
  * **Monetization with Bits:** Optionally require users to cheer a minimum number of Bits to have their message read aloud.
  * Controllable via chat commands for enabling/disabling, managing the queue, changing voice settings, and more.
  * Customizable voices and speech parameters via Replicate API (minimax/speech-02-turbo model).
  * Per-user voice, emotion, pitch and speed preferences for TTS.
  * Ignores specified users.
  * Audio playback through an OBS browser source.
  * Designed for Google Cloud Run deployment.

## Adding ChatVibes to Your Channel & Setup

Streamers can easily add or remove the ChatVibes Text-to-Speech (TTS) bot from their channel and configure it for their streaming software using the web interface:

1.  **Visit the ChatVibes Management Portal**:

      * Go to [ChatVibes Management Portal](https://chatvibestts.web.app/) (Make sure this is your correct deployed URL)
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

      * ChatVibes TTS is typically triggered by specific events you configure (e.g., channel point redemptions, specific commands like `!say <message>`, donations, subscriptions, etc., depending on the bot's features).
      * The bot also supports a **Bits-for-TTS** mode, where messages are only read if they are accompanied by a cheer that meets a channel-configurable minimum amount.
      * Please refer to the [main ChatVibes documentation](https://detekoi.github.io/chatvibesdocs.html) for details on setting up TTS triggers and customizing voice options.
      * The repository for the ChatVibes web UI is [here](https://github.com/detekoi/chatvibes-web-ui).

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
5.  **Replicate API Token:**
      * Sign up at [Replicate.com](https://replicate.com/).
      * Get your API token from your [account page](https://replicate.com/account/api-tokens).
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
      * `TWITCH_CHANNELS`: Comma-separated list of Twitch channels to join initially (e.g., "yourchannel,anotherchannel").
      * `TWITCH_CLIENT_ID`: Your Twitch application's Client ID.
      * `TWITCH_CLIENT_SECRET`: Your Twitch application's Client Secret.
      * `REPLICATE_API_TOKEN`: Your Replicate API token.
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
      --set-secrets=TWITCH_BOT_REFRESH_TOKEN_SECRET_NAME=projects/YOUR_GCP_PROJECT_ID/secrets/YOUR_REFRESH_TOKEN_SECRET/versions/latest,REPLICATE_API_TOKEN=projects/YOUR_GCP_PROJECT_ID/secrets/YOUR_REPLICATE_TOKEN_SECRET/versions/latest \
      --set-env-vars=NODE_ENV=production,LOG_LEVEL=info,PINO_PRETTY_LOGGING=false,GOOGLE_CLOUD_PROJECT=YOUR_GCP_PROJECT_ID,TWITCH_BOT_USERNAME=YourBotName,REPLICATE_TTS_MODEL_NAME="minimax/speech-02-turbo"
      # Add other necessary env vars or secrets
    ```

      * Replace placeholders with your actual values.
      * Ensure the Cloud Run service account has "Cloud Datastore User" and "Secret Manager Secret Accessor" roles.

</details>

## OBS Browser Source Setup

1.  In OBS, add a new "Browser" source.
2.  Set the URL to `http://localhost:8080/?channel=yourchannelname`
      * Replace `yourchannelname` with the lowercase Twitch username of the channel this ChatVibes instance is for. This **must match** one of the channels the bot is in.
      * Ensure the port (`8080`) matches what ChatVibes is running on.
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

**`!tts mode [all|command]`**

  * **Description:** Toggles the TTS mode.
      * `all`: All chat messages (not from ignored users or commands) and enabled events will be spoken.
      * `command`: Only messages triggered by specific TTS commands (like `!tts say`) or enabled events will be spoken. Regular chat is ignored.
  * **Permission:** Moderator
  * **Usage:**
      * `!tts mode all`
      * `!tts mode command`
      * `!tts mode` (displays current mode)

**`!tts bits [on|off|min <amount>]`**

  * **Description:** Configures the Bits-for-TTS feature, allowing channels to require a minimum Cheer amount to trigger TTS.
      * `on`: Enables Bits-for-TTS mode. Only messages with a sufficient cheer will be read.
      * `off`: Disables Bits-for-TTS mode.
      * `min <amount>`: Sets the minimum number of Bits required (e.g., `min 100`).
  * **Permission:** Moderator
  * **Usage:**
      * `!tts bits on`
      * `!tts bits off`
      * `!tts bits min 100`
      * `!tts bits` (displays the current Bits-for-TTS status)

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

**`!tts ignore add <username>`**

  * **Description:**
      * **For any user:** Allows you to add *yourself* to the TTS ignore list for the channel. Your messages will not be spoken.
      * **For Moderators/Broadcaster:** Allows you to add *any specified Twitch user* to the TTS ignore list for the channel. Messages from this user will not be spoken.
  * **Permission:** Everyone (to add themselves), Moderator (to add others)
  * **Usage:**
      * `!tts ignore add yourusername` (if you want to ignore yourself)
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

### Direct TTS (Moderator Only - for testing/announcements)

**`!tts say <message>`**

  * **Description:** Immediately enqueues the provided message for TTS, regardless of the current mode. Uses the requesting user's preferences or channel defaults for voice, pitch, speed, and emotion.
  * **Permission:** Moderator
  * **Usage:** `!tts say Welcome everyone to the stream!`

</details>