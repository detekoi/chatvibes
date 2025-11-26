# Code Changes for Environment Variable Migration

After running `migrate-to-env-vars.sh` to mount secrets in Cloud Run, update these files:

## 1. src/components/twitch/auth.js

**BEFORE:**
```javascript
async function getClientId() {
    if (cachedClientId) {
        return cachedClientId;
    }

    if (config.twitch.clientId) {
        cachedClientId = config.twitch.clientId;
        return cachedClientId;
    }

    // Load from Secret Manager
    try {
        const { getSecretValue } = await import('../../lib/secretManager.js');
        logger.info('ChatVibes: Loading Twitch Client ID from Secret Manager...');
        cachedClientId = await getSecretValue(config.twitch.clientIdSecretPath);
        // ...
    }
}
```

**AFTER:**
```javascript
async function getClientId() {
    if (cachedClientId) {
        return cachedClientId;
    }

    // Read from environment variable (mounted by Cloud Run)
    cachedClientId = process.env.TWITCH_CLIENT_ID || config.twitch.clientId;

    if (!cachedClientId) {
        throw new Error('TWITCH_CLIENT_ID not found in environment');
    }

    return cachedClientId;
}
```

Apply the same pattern to `getClientSecret()`.

## 2. src/config/loader.js

Add these to your config:

```javascript
export default {
  twitch: {
    // Prefer environment variables (mounted from Secret Manager)
    clientId: process.env.TWITCH_CLIENT_ID,
    clientSecret: process.env.TWITCH_CLIENT_SECRET,
    username: process.env.TWITCH_BOT_USERNAME,
    eventSubSecret: process.env.TWITCH_EVENTSUB_SECRET,

    // Keep these paths for OAuth tokens that change frequently
    botRefreshTokenSecretPath: process.env.TWITCH_BOT_REFRESH_TOKEN_SECRET ||
      'projects/chatvibestts/secrets/twitch-bot-refresh-token/versions/latest',
    // ...
  },

  tts: {
    // ...existing config...
    wavespeedApiKey: process.env.WAVESPEED_API_KEY,
    t302ApiKey: process.env.API_302_KEY,
  },

  jwt: {
    secret: process.env.JWT_SECRET,
  },

  music: {
    replicateApiToken: process.env.REPLICATE_API_TOKEN,
  }
}
```

## 3. Remove Secret Manager calls for static secrets

**Files to update:**
- `src/components/web/server.js` - JWT secret
- `src/components/tts/ttsService.js` - Wavespeed API key (if applicable)

**Pattern:**
```javascript
// BEFORE: const apiKey = await getSecretValue(config.wavespeed.apiKeyPath);
// AFTER:  const apiKey = process.env.WAVESPEED_API_KEY;
```

## 4. Keep Secret Manager for OAuth tokens

**DO NOT migrate these** - they refresh frequently:
- `twitch-bot-refresh-token`
- `twitch-access-token-*` (all user tokens)
- `twitch-refresh-token-*` (all user tokens)
- `obs-token-*` (channel-specific tokens)

These should continue using `getSecretValue()` with caching.

---

## Expected Cost Reduction

### Before Migration
- 66 versions × $0.06 = $3.96/month
- API access: ~$0.10/month
- **Total: ~$4/month (~$0.13/day)**

### After Migration
- Static secrets: 7 versions × $0.06 = $0.42/month (just for storage, no access cost)
- OAuth tokens: ~35 versions × $0.06 = $2.10/month
- API access: ~$0.05/month (90% reduction)
- **Total: ~$2.57/month (~$0.09/day)**

### Additional Savings
- **$1.40/month** (~$17/year)
- **Zero API latency** for static secrets (read from memory)
- **Better reliability** (no Secret Manager API dependency)

---

## Deployment Steps

1. Run migration script to mount secrets:
   ```bash
   chmod +x scripts/migrate-to-env-vars.sh
   bash scripts/migrate-to-env-vars.sh
   ```

2. Update code files as shown above

3. Test locally with environment variables:
   ```bash
   export TWITCH_CLIENT_ID="your_client_id"
   export TWITCH_CLIENT_SECRET="your_secret"
   node src/bot.js
   ```

4. Deploy to Cloud Run:
   ```bash
   # The gcloud run services update command will mount the secrets
   # from the migration script
   ```

5. Verify logs show no Secret Manager errors

6. Monitor costs in billing console after 24-48 hours
