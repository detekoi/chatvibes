# ChatVibes - Twitch Text-to-Speech Bot

ChatVibes is a Twitch bot that reads chat messages and events aloud using Text-to-Speech (TTS), controllable via chat commands. It's designed to be deployed on Google Cloud Run and integrates with OBS via a browser source for audio playback.

## Documentation

For a complete list of available commands and voices, visit the documentation:
* [Commands Documentation](https://detekoi.github.io/chatvibesdocs.html#commands)
* [Voices Documentation](https://detekoi.github.io/chatvibesdocs.html#voices)


## Features

* Reads Twitch chat messages aloud.
* Announces Twitch events (subscriptions, cheers, raids, etc.).
* Controllable via chat commands for enabling/disabling, managing the queue, changing voice settings, and more.
* Customizable voices and speech parameters via Replicate API (minimax/speech-02-turbo model).
* Per-user emotion preference for TTS.
* Ignores specified users.
* Audio playback through an OBS browser source.
* Designed for Google Cloud Run deployment.

## Setup

### Prerequisites

1.  **Node.js:** Version 18.x or later recommended.
2.  **npm:** Comes with Node.js.
3.  **Twitch Account for the Bot:** It's highly recommended to create a dedicated Twitch account for ChatVibes (e.g., "ChatVibesBot").
4.  **Twitch Application:**
    * Register a new application on the [Twitch Developer Console](https://dev.twitch.tv/console/apps).
    * Set the "OAuth Redirect URLs" to something like `http://localhost:3000/auth/twitch/callback` (even if not used by this specific TTS bot directly, it's good practice for Twitch apps).
    * Note down the **Client ID** and generate a **Client Secret**.
5.  **Replicate API Token:**
    * Sign up at [Replicate.com](https://replicate.com/).
    * Get your API token from your [account page](https://replicate.com/account/api-tokens).
6.  **Google Cloud Project:**
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

### OBS Browser Source Setup

1.  In OBS, add a new "Browser" source.
2.  Set the URL to `http://localhost:8080/?channel=yourchannelname`
    * Replace `yourchannelname` with the lowercase Twitch username of the channel this ChatVibes instance is for. This **must match** one of the channels the bot is in.
    * Ensure the port (`8080`) matches what ChatVibes is running on.
3.  Set Width and Height as needed (e.g., 300x100, can be small as it's audio-only).
4.  **Important:** After adding the source, right-click it in OBS, select "Interact". A window will pop up showing the page. If you see a button like "Click to Enable TTS Audio", click it once to allow the browser to play audio. This is required due to browser autoplay policies.

## Command Documentation

All TTS commands are prefixed with `!tts`. For example, `!tts status`.

---

### General Commands

**`!tts status`**
* **Description:** Gets the current status of the TTS application for the channel, including whether the engine is enabled, the current mode, queue length, and selected voice.
* **Permission:** Everyone
* **Usage:** `!tts status`

**`!tts voices`**
* **Description:** Shows how many voices are available and a summary by language or type. The full list is too long for chat.
* **Permission:** Everyone
* **Usage:** `!tts voices`

**`!tts commands`**
* **Description:** Lists all available `!tts` subcommands.
* **Permission:** Everyone
* **Usage:** `!tts commands`

---

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

---

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
* **Description:** Clears all pending messages and events from the TTS queue. Does not stop audio currently playing.
* **Permission:** Moderator
* **Usage:** `!tts clear`

**`!tts stop`**
* **Description:** If TTS is currently speaking an audio clip, this command will stop only that currently playing audio. The queue will continue processing the next item if not paused.
* **Permission:** Moderator
* **Usage:** `!tts stop`

---

### User & Event Preferences

**`!tts emotion <emotion_name|reset|auto>`**
* **Description:** Allows a user to set their preferred emotion for messages they trigger that are spoken by TTS. If reset or auto, uses the channel's default emotion (or the TTS model's auto-detection).
    * Valid emotions (from Replicate minimax/speech-02-turbo model): `auto`, `neutral`, `happy`, `sad`, `angry`, `fearful`, `disgusted`, `surprised`.
* **Permission:** Everyone (for their own preference)
* **Usage:**
    * `!tts emotion happy`
    * `!tts emotion reset`
    * `!tts emotion` (displays current personal preference)

**`!tts voice <voice_id|reset>`**
* **Description:** Allows a user to set their preferred voice for messages they trigger that are spoken by TTS. Use `reset` to revert to the channel's default voice. Use `!tts voices` to get a link to the available voice IDs.
* **Permission:** Everyone (for their own preference)
* **Usage:**
    * `!tts voice Friendly_Person`
    * `!tts voice reset`
    * `!tts voice` (displays current personal preference)

**`!tts ignore add <username>`**
* **Description:** Adds the specified Twitch user to the TTS ignore list for the channel. Messages from this user will not be spoken, even in 'all' mode.
* **Permission:** Moderator
* **Usage:** `!tts ignore add SomeUser`

**`!tts ignore del <username>`** (Alias: `!tts ignore delete <username>`, `!tts ignore rem <username>`, `!tts ignore remove <username>`)
* **Description:** Removes the specified Twitch user from the TTS ignore list.
* **Permission:** Moderator
* **Usage:** `!tts ignore del SomeUser`

**`!tts ignored`**
* **Description:** Lists all users currently on the TTS ignore list for the channel.
* **Permission:** Moderator (or Everyone, depending on configuration choice)
* **Usage:** `!tts ignored`

**`!tts events [on|off]`**
* **Description:** Toggles whether Twitch events (like subscriptions, cheers, raids, etc.) are announced by TTS.
* **Permission:** Moderator
* **Usage:**
    * `!tts events on`
    * `!tts events off`
    * `!tts events` (displays current event announcement status)

---

### Voice Configuration (Moderator Only)

**`!tts defaultvoice <voice_id|reset>`**
* **Description:** Sets the default TTS voice for the *channel*. Use `reset` to revert to the system default. Use `!tts voices` to see available types/get a link to IDs.
* **Permission:** Moderator
* **Usage:** `!tts defaultvoice Friendly_Person` (Use a valid Voice ID from the `minimax/speech-02-turbo` model)
* **Note:** This sets the *channel-wide* default voice. Individual users can still set their own preferred voice with `!tts voice <voice_id>`.

**`!tts speed <0.5-2.0>`** (Conceptual - for setting channel default speed)
* **Description:** Sets the default speech speed for the channel. (1.0 is normal).
* **Permission:** Moderator
* **Usage:** `!tts speed 1.2`

**`!tts pitch <-12-12>`** (Conceptual - for setting channel default pitch)
* **Description:** Sets the default speech pitch for the channel. (0 is normal).
* **Permission:** Moderator
* **Usage:** `!tts pitch 2`

*(Other parameters like volume, default emotion for the channel, etc., can be added similarly.)*

---

### Direct TTS (Moderator Only - for testing/announcements)

**`!tts say <message>`**
* **Description:** Immediately enqueues the provided message for TTS, regardless of the current mode. Useful for direct announcements or testing.
* **Permission:** Moderator
* **Usage:** `!tts say Welcome everyone to the stream!`

---

## Deployment to Google Cloud Run

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

## Contributing

(Details on how to contribute, coding standards, etc. - if applicable)

## License

[BSD 2-clause License](LICENSE.md)