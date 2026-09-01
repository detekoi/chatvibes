# WildcatTTS - Twitch Text-to-Speech Bot

WildcatTTS is a Twitch bot that reads chat messages and events aloud with Text-to-Speech (TTS). You can control the bot with chat commands. WildcatTTS runs on Google Cloud Run and connects to OBS through a browser source for audio playback.

> **Note:** Access to the cloud version of WildcatTTS is invite-only. The web management dashboard is disabled for unapproved channels. If you want to use the bot, submit [this contact form](https://parfaitfair.com/#contact).

**[Streamer Dashboard →](https://tts.wildcat.chat/)** *(invite-only)*

[![License: AGPL v3](https://img.shields.io/badge/License-AGPL%20v3-blue.svg)](LICENSE.md)

## Documentation

To read the full list of commands and voices, visit the documentation:

  * [Commands Documentation](https://docs.wildcat.chat/wildcatttsdocs.html#commands)
  * [Voices Documentation](https://docs.wildcat.chat/wildcatttsdocs.html#voices)
  * [Language Support Documentation](https://docs.wildcat.chat/wildcatttsdocs.html#language-boost)

## Features

  * Reads Twitch chat messages aloud.
  * Announces Twitch events (subscriptions, cheers, and raids).
  * **Interactive or Silent Mode:** Configure the bot to answer chat commands or operate silently in the background.
  * **Monetization with Bits:** Require users to cheer a minimum number of Bits to read messages aloud or to generate music.
  * **Channel Points to TTS:** Create a custom Twitch Channel Point reward that viewers redeem with a message to read it aloud.
  * Customizable voices and speech parameters through the Wavespeed AI API (`minimax/speech-02-turbo` model).
  * Personal voice, emotion, pitch, and speed preferences for each user.
  * Ignores specified users.
  * Plays audio through an OBS browser source.
  * Runs on Google Cloud Run.

## How WildcatTTS Works

WildcatTTS uses Twitch EventSub to listen to your chat. The bot appears in your viewer list under "Chat Bots". Twitch EventSub requires this behavior for all channels.

### Chat Response Mode

You can configure how the bot responds to commands in chat:

**Interactive Mode (Default):**
- The bot responds to `!tts` commands in chat.
- Users can type commands like `!tts status`, `!myvoice`, and `!tts voice <name>` to receive immediate responses.
- Moderators can control TTS configuration through chat commands.
- Provides instant feedback and acknowledgments.

**Silent Mode:**
- The bot listens to chat but does not respond to commands.
- You must perform all configuration through the web dashboard.
- Provides a cleaner chat experience without bot responses.
- TTS functions normally without bot chat responses.

You can switch modes with the `botRespondsInChat` setting in the web dashboard.

## Adding WildcatTTS to Your Channel and Setup

**Note:** Access is invite-only. If you are not approved, the dashboard shows an access denied message. [Request access here](https://parfaitfair.com/#contact).

Approved streamers can add or remove WildcatTTS and configure streaming software with these steps:

1. **Visit the WildcatTTS Management Portal** *(invite-only)*:
   * Go to the [WildcatTTS Management Portal](https://tts.wildcat.chat/).
   * Select **Manage my channel** to sign in with Twitch.

2. **Authorize the Application**:
   * Twitch opens an authorization page for WildcatTTS.
   * Review and grant the required permissions. The application uses the official Twitch OAuth flow.

3. **Manage the Bot and Read Setup Instructions**:
   * Sign in to show your dashboard.
   * To activate the bot, select **Activate TTS service**.
   * To deactivate the bot, select **Deactivate TTS service**.
   * Read the **OBS Setup Instructions** on the dashboard to get your unique TTS URL.

4. **Bot Joining Time and Configuration**:
   * After you add the bot, the bot joins your Twitch channel within a few minutes.
   * To play TTS audio, add your unique TTS URL as a Browser Source in your streaming software (OBS or Streamlabs).
   * Configure audio monitoring according to the setup instructions.
   * If the bot does not respond after setup, make sure that your OBS browser source and audio settings are correct. Then deactivate and reactivate the TTS service through the dashboard.
   * To avoid chat filters, grant moderator status to the bot with `/mod <bot-username>`.

5. **How TTS Triggers Work**:
   * By default, WildcatTTS operates in **command** mode, where it reads only `!tts <message>`. You can use the `!tts mode` and `!tts permission` commands, or the dashboard, to change this behavior.
   * You can trigger TTS with commands such as `!tts <your message>` or `!tts say <your message>`.
   * In **Bits to TTS** mode, the bot reads messages only when a cheer meets the minimum Bit amount.
   * In **Channel Points to TTS** mode, viewers redeem a custom Channel Point reward to read a message.
   * Read the [WildcatTTS documentation](https://docs.wildcat.chat/wildcatttsdocs.html) for detailed trigger and voice setup.
   * The repository for the WildcatTTS web UI is located at [chatvibes-web-ui](https://github.com/detekoi/chatvibes-web-ui).

## Channel Points to TTS

WildcatTTS can create a custom Twitch Channel Point reward that viewers redeem with a message to read it aloud. This feature lets viewers trigger TTS without chat commands.

### How It Works

1. **Streamer Setup**: Open the **Channel Points to TTS** section in the WildcatTTS dashboard and enable the feature.
2. **Reward Creation**: The bot creates a custom Channel Point reward on your Twitch channel automatically.
3. **Viewer Redemption**: Viewers redeem the reward with a message. The bot reads the message aloud.
4. **Content Policy**: Built-in content filtering blocks links, enforces message length limits, and filters banned words.

### Configuration Options

**Basic Settings:**
- **Reward Title**: Name of the Channel Point reward.
- **Cost**: Number of Channel Points required to redeem.
- **Prompt**: Helper text shown to viewers during redemption.
- **Auto-approve**: Skip the redemption queue for immediate playback.

**Advanced Settings:**
- **Global Cooldown**: Minimum time between redemptions in seconds.
- **Per-stream Limit**: Maximum redemptions per stream.
- **Per-user Limit**: Maximum redemptions per user per stream.
- **Content Policy**: Minimum and maximum message length, link blocking, and banned word list.

### TTS Modes

The Channel Points to TTS feature works with all TTS modes:
- **All Messages**: Reads Channel Point redemptions and regular chat messages.
- **Commands Only**: Reads Channel Point redemptions and `!tts` commands only.
- **Bits/Points Only**: Reads Bits cheers and Channel Point redemptions only. Ignores regular chat.

### Management

- Enable or disable the feature in the dashboard.
- Select **Test redeem** to simulate a redemption.
- Remove the Channel Point reward from Twitch entirely when necessary.
- Configuration changes take effect immediately.

### Requirements

- Grant the `channel:manage:redemptions` and `channel:read:redemptions` OAuth scopes during initial setup.
- Activate the TTS service for your channel before you enable Channel Point rewards.
- Enable Channel Points on your Twitch channel.

## Advanced

<details>
<summary>Select here to read manual installation steps.</summary>

### Prerequisites

1. **Node.js:** Version 22.0.0 or later.
2. **npm:** Included with Node.js.
3. **Twitch Account for the Bot:** Create a dedicated Twitch account for WildcatTTS.
4. **Twitch Application:**
   * Register a new application on the [Twitch Developer Console](https://dev.twitch.tv/console/apps).
   * Set the OAuth Redirect URL to `http://localhost:3000/auth/twitch/callback`.
   * Record the **Client ID** and generate a **Client Secret**.
5. **Wavespeed AI API Key:**
   * Create an account at [Wavespeed AI](https://wavespeed.ai/).
   * Copy your API key from the settings page.
6. **Google Cloud Project:**
   * Create a Google Cloud Platform project.
   * Enable the Cloud Firestore API, Secret Manager API, Cloud Run API, and Cloud Build API.
   * Create a Firestore database in Native mode.
   * Install and configure the `gcloud` CLI.

### Local Development Setup

1. **Clone the Repository:**

   ```bash
   git clone <your-repo-url>
   cd tts-twitch
   ```

2. **Install Dependencies:**

   ```bash
   npm install
   ```

3. **Create `.env` File:**
   Copy `.env.example` to `.env` and set the required variables:

   * `TWITCH_BOT_USERNAME`: Twitch username for your bot account.
   * `TWITCH_CHANNELS`: Comma-separated list of Twitch channels to join initially during local development.
   * `TWITCH_CLIENT_ID`: Client ID for your Twitch application.
   * `TWITCH_CLIENT_SECRET`: Client Secret for your Twitch application.
   * `WAVESPEED_API_KEY`: API key for Wavespeed AI.
   * `GOOGLE_CLOUD_PROJECT`: Google Cloud Project ID.
   * `TWITCH_BOT_REFRESH_TOKEN_SECRET_NAME`: Full resource name of the secret in Google Secret Manager holding the Twitch refresh token for the bot account.
   * `PUBLIC_URL`: Deployed service URL (for example, `https://chatvibes-tts-service-906125386407.us-central1.run.app`).
   * `CLEANUP_OIDC_AUDIENCE`: (Optional) Override for the OIDC token audience used by Cloud Scheduler.
   * `CLEANUP_INVOKER_SA`: (Optional) Service account permitted to invoke the cleanup endpoint.
   * `LOG_LEVEL`: (Optional) Log verbosity level (defaults to `info`).
   * `PINO_PRETTY_LOGGING`: (Optional) Set to `true` for formatted console logs in development.

4. **Obtain a Twitch User Refresh Token for the Bot Account:**

   * Log in to Twitch as your bot account.
   * Generate a token with the `chat:read` and `chat:edit` scopes using the Twitch CLI or an OAuth token generator:
     ```bash
     twitch token -u -s "chat:read chat:edit"
     ```
   * Store the refresh token in Google Secret Manager under the name set in `TWITCH_BOT_REFRESH_TOKEN_SECRET_NAME`.

5. **Set Up Application Default Credentials (ADC) for Google Cloud:**

   ```bash
   gcloud auth application-default login
   gcloud config set project <YOUR_GCP_PROJECT_ID>
   ```

   Make sure that your Google account has the **Cloud Datastore User** and **Secret Manager Secret Accessor** roles.

6. **Run the Bot Locally:**

   ```bash
   npm run dev
   ```

   The bot connects to Twitch IRC, and the web server starts (by default on `http://localhost:8080`).

### Deployment to Google Cloud Run

1. **Build the Docker Image:**

   ```bash
   gcloud builds submit --tag gcr.io/YOUR_GCP_PROJECT_ID/chatvibes-tts
   ```

2. **Deploy to Cloud Run:**

   ```bash
   gcloud run deploy chatvibes-tts-service \
     --image gcr.io/YOUR_GCP_PROJECT_ID/chatvibes-tts \
     --platform managed \
     --region YOUR_REGION \
     --allow-unauthenticated \
     --service-account YOUR_CHATVIBES_SERVICE_ACCOUNT_EMAIL \
     --set-secrets=TWITCH_BOT_REFRESH_TOKEN_SECRET_NAME=projects/YOUR_GCP_PROJECT_ID/secrets/YOUR_REFRESH_TOKEN_SECRET/versions/latest,WAVESPEED_API_KEY=projects/YOUR_GCP_PROJECT_ID/secrets/WAVESPEED_API_KEY/versions/latest \
     --set-env-vars=NODE_ENV=production,LOG_LEVEL=info,PINO_PRETTY_LOGGING=false,GOOGLE_CLOUD_PROJECT=YOUR_GCP_PROJECT_ID,TWITCH_BOT_USERNAME=YourBotName
   ```

   Make sure that the Cloud Run service account has the **Cloud Datastore User** and **Secret Manager Secret Accessor** roles.

</details>

## OBS Browser Source Setup

1. In OBS, add a new **Browser** source.
2. Set the URL to your unique TTS URL from the WildcatTTS dashboard (the **OBS Setup** button). For local development, point it at your local server; the player needs both the `channel` and `token` query parameters.
3. Keep the default width and height. The page has no visible content, and size does not affect audio.
4. Select **Control audio via OBS**, and make sure **Shutdown source when not visible** is not selected.
5. Open the **Audio Mixer** section in OBS.
6. Select the options menu (⋮) next to the browser source audio track and select **Advanced Audio Properties**.
7. Set **Audio Monitoring** to **Monitor and Output**.

## Command Documentation

All TTS commands start with `!tts` (for example, `!tts status`). You can also read the command documentation online: [Commands Documentation](https://docs.wildcat.chat/wildcatttsdocs.html#commands).

<details>
<summary>Select here to expand command documentation.</summary>

### General Commands

**`!tts status`**

  * **Description:** Shows the current status of TTS for the channel, including engine status, active mode, queue length, and default settings.
  * **Permission:** Everyone
  * **Usage:** `!tts status`

**`!tts voices`**

  * **Description:** Provides a link to available TTS voice IDs.
  * **Permission:** Everyone
  * **Usage:** `!tts voices`

**`!tts languageslist`**

  * **Description:** Provides a link to available language boost options.
  * **Permission:** Everyone
  * **Usage:** `!tts languageslist`

**`!tts commands`** (Alias: `!tts help`)

  * **Description:** Provides a link to the complete list of `!tts` subcommands.
  * **Permission:** Everyone
  * **Usage:** `!tts commands`

---

### Engine and Mode Control (Moderators Only)

**`!tts on`** (Alias: `!tts enable`)

  * **Description:** Enables the TTS engine.
  * **Permission:** Moderator
  * **Usage:** `!tts on`

**`!tts off`** (Alias: `!tts disable`)

  * **Description:** Disables the TTS engine entirely.
  * **Permission:** Moderator
  * **Usage:** `!tts off`

**`!tts mode [all|command|bits_points_only]`**

  * **Description:** Changes the TTS mode.
      * `all`: Reads all chat messages (based on `!tts permission` setting) and enabled events. **(Default)**
      * `command`: Reads only explicit `!tts` commands and enabled events. Ignores regular chat.
      * `bits_points_only`: Reads only Bits cheers and Channel Point redemptions. Ignores regular chat and commands.
  * **Permission:** Moderator
  * **Usage:**
      * `!tts mode all`
      * `!tts mode command`
      * `!tts mode bits_points_only`
      * `!tts mode bits` (alias for `bits_points_only`)
      * `!tts mode points` (alias for `bits_points_only`)
      * `!tts mode` (shows current mode)

**`!tts permission [everyone|all|mods]`**

  * **Description:** Filters who can trigger TTS when the bot is in `all` mode.
      * `everyone` or `all`: Reads chat messages from any user. **(Default)**
      * `mods`: Reads chat messages from moderators and the broadcaster only.
  * **Permission:** Moderator
  * **Usage:**
      * `!tts permission everyone`
      * `!tts permission mods`
      * `!tts permission` (shows current permission setting)

**`!tts bitsconfig [on|off|min <amount>]`** (Alias: `!tts bits`)

  * **Description:** Configures Bits to TTS mode and minimum cheer requirements.
      * `on`: Enables Bits to TTS mode.
      * `off`: Disables Bits to TTS mode.
      * `min <amount>`: Sets the minimum Bit cheer amount (for example, `min 100`).
  * **Permission:** Moderator
  * **Usage:**
      * `!tts bits on`
      * `!tts bits off`
      * `!tts bits min 100`
      * `!tts bits` (shows current Bits status)

---

### Queue Management (Moderators Only)

**`!tts pause`**

  * **Description:** Pauses TTS queue processing. New messages stay in the queue until you resume processing.
  * **Permission:** Moderator
  * **Usage:** `!tts pause`

**`!tts resume`**

  * **Description:** Resumes TTS queue processing if paused.
  * **Permission:** Moderator
  * **Usage:** `!tts resume`

**`!tts clear`**

  * **Description:** Removes pending messages and events from the TTS queue. Does not stop currently playing audio.
  * **Permission:** Moderator
  * **Usage:** `!tts clear`

**`!tts stop`**

  * **Description:** Stops currently playing or generating TTS audio.
      * Any user can stop audio triggered by their own chat message.
      * Moderators and the broadcaster can stop any TTS audio.
  * **Permission:** Everyone (conditional based on message sender)
  * **Usage:** `!tts stop`

---

### User and Event Preferences

**`!tts prefs`** (Alias: `!tts preferences`)

  * **Description:** Sends a short-lived link to your personal TTS settings page in chat. The link expires after 10 minutes or first use.
  * **Permission:** Everyone
  * **Usage:** `!tts prefs`

**`!tts voice <voice_id|reset>`**

  * **Description:** Sets your preferred TTS voice ID. Use `reset` to return to the channel default.
  * **Permission:** Everyone
  * **Usage:**
      * `!tts voice Friendly_Person`
      * `!tts voice reset`
      * `!tts voice` (shows current personal voice)

**`!tts emotion <emotion_name|reset|auto>`**

  * **Description:** Sets your preferred TTS emotion. Valid options: `auto`, `neutral`, `happy`, `sad`, `angry`, `fearful`, `disgusted`, `surprised`.
  * **Permission:** Everyone
  * **Usage:**
      * `!tts emotion happy`
      * `!tts emotion reset`
      * `!tts emotion` (shows current personal emotion)

**`!tts pitch <value|reset>`**

  * **Description:** Sets your personal TTS pitch between -12 and 12 (0 is normal).
  * **Permission:** Everyone
  * **Usage:**
      * `!tts pitch 2`
      * `!tts pitch -3`
      * `!tts pitch reset`
      * `!tts pitch` (shows current personal pitch)

**`!tts speed <value|reset>`**

  * **Description:** Sets your personal TTS speed between 0.5 and 2.0 (1.0 is normal).
  * **Permission:** Everyone
  * **Usage:**
      * `!tts speed 1.2`
      * `!tts speed 0.8`
      * `!tts speed reset`
      * `!tts speed` (shows current personal speed)

**`!tts language <language_name|auto|reset>`** (Alias: `!tts lang`)

  * **Description:** Sets your preferred language boost. Use `auto`, `none`, or `reset` for channel default.
  * **Permission:** Everyone
  * **Usage:**
      * `!tts language English`
      * `!tts language Japanese`
      * `!tts lang reset`
      * `!tts language` (shows current personal language)

**`!tts ignore <username>`** / **`!tts ignore add <username>`**

  * **Description:** Adds a user to the channel TTS ignore list. Users can add themselves; moderators can add any user.
  * **Permission:** Everyone (for self), Moderator (for other users)
  * **Usage:**
      * `!tts ignore yourusername`
      * `!tts ignore add SomeOtherUser`

**`!tts ignore del <username>`** (Aliases: `delete`, `rem`, `remove`)

  * **Description:** Removes a user from the TTS ignore list.
  * **Permission:** Moderator
  * **Usage:** `!tts ignore del SomeUser`

**`!tts ignored`**

  * **Description:** Shows all users on the TTS ignore list for the channel.
  * **Permission:** Moderator
  * **Usage:** `!tts ignored`

**`!tts events [on|off]`**

  * **Description:** Toggles announcements for Twitch events (subscriptions, cheers, and raids).
  * **Permission:** Moderator
  * **Usage:**
      * `!tts events on`
      * `!tts events off`
      * `!tts events` (shows current event announcement status)

---

### Channel Configuration (Moderators Only)

**`!tts defaultvoice <voice_id|reset>`**

  * **Description:** Sets default TTS voice for the channel.
  * **Permission:** Moderator
  * **Usage:**
      * `!tts defaultvoice Friendly_Person`
      * `!tts defaultvoice reset`

**`!tts defaultemotion <emotion_name|reset>`**

  * **Description:** Sets default TTS emotion for the channel.
  * **Permission:** Moderator
  * **Usage:**
      * `!tts defaultemotion happy`
      * `!tts defaultemotion reset`

**`!tts defaultpitch <value|reset>`**

  * **Description:** Sets default TTS pitch for the channel (-12 to 12).
  * **Permission:** Moderator
  * **Usage:**
      * `!tts defaultpitch 2`
      * `!tts defaultpitch reset`

**`!tts defaultspeed <value|reset>`**

  * **Description:** Sets default TTS speed for the channel (0.5 to 2.0).
  * **Permission:** Moderator
  * **Usage:**
      * `!tts defaultspeed 1.2`
      * `!tts defaultspeed reset`

**`!tts defaultlanguage <language_name|reset>`**

  * **Description:** Sets default language boost for the channel.
  * **Permission:** Moderator
  * **Usage:**
      * `!tts defaultlanguage English`
      * `!tts defaultlanguage reset`

---

### Direct TTS

**`!tts <message>`** (Alias: `!tts say <message>`)

  * **Description:** Enqueues a message for immediate TTS playback using user or channel defaults.
  * **Permission:** Everyone
  * **Usage:** `!tts Welcome everyone to the stream!`

</details>