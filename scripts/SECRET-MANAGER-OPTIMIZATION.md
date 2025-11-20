# Google Secret Manager Cost Optimization

## Problem

Google Secret Manager charges **$0.06 per active secret version per month**. With multiple OAuth tokens that refresh frequently, old versions can accumulate quickly, leading to unnecessary costs.

**Before optimization:** 794 active versions = **$47.64/month (~$1.59/day)**
**After optimization:** 61 active versions = **~$3.66/month (~$0.12/day)**

**Savings: ~$44/month** 💰

---

## Solutions Implemented

### 1. ✅ One-Time Cleanup Script

**File:** `scripts/cleanup-secret-versions.js`

Disables old secret versions, keeping only the latest 2 versions per secret.

**Usage:**
```bash
# Dry run (preview changes)
node scripts/cleanup-secret-versions.js

# Execute cleanup
node scripts/cleanup-secret-versions.js --execute
```

**Run this periodically** (monthly) or set up a Cloud Scheduler job to automate it.

### 2. ✅ Automatic Cleanup on Secret Updates

**File:** `src/lib/secretManager.js:92`

The `addSecretVersion()` function now automatically disables old versions when creating new ones, keeping only the latest 2 versions enabled.

This prevents the accumulation problem from happening again in the future.

---

## Alternative: Use Cloud Run Secret Mounting (Zero Per-Access Cost)

Instead of using the Secret Manager API to fetch secrets at runtime, you can mount secrets directly as environment variables or files in your Cloud Run service. This eliminates per-access costs entirely.

### Benefits
- **No API access costs** - Secrets are injected at container startup
- **Better performance** - No network calls to fetch secrets
- **Automatic caching** - Secrets are available in memory
- **Same security** - Uses the same IAM permissions

### Migration Steps

#### Option A: Mount as Environment Variables

1. **Update Cloud Run service configuration:**

```bash
# Example: Mount client ID as environment variable
gcloud run services update chatvibes-tts-service \
  --project chatvibestts \
  --update-secrets=TWITCH_CLIENT_ID=twitch-client-id:latest

# Mount multiple secrets
gcloud run services update chatvibes-tts-service \
  --project chatvibestts \
  --update-secrets=\
TWITCH_CLIENT_ID=twitch-client-id:latest,\
TWITCH_CLIENT_SECRET=twitch-client-secret:latest,\
WAVESPEED_API_KEY=WAVESPEED_API_KEY:latest
```

2. **Update code to read from environment variables:**

```javascript
// Instead of:
const clientId = await getSecretValue(config.twitch.clientIdSecretPath);

// Use:
const clientId = process.env.TWITCH_CLIENT_ID;
```

3. **Simplify your config:**

```javascript
// src/config/loader.js
twitch: {
  clientId: process.env.TWITCH_CLIENT_ID,
  clientSecret: process.env.TWITCH_CLIENT_SECRET,
  // ...
}
```

#### Option B: Mount as Files

For more complex secrets (like JSON credentials), mount as files:

```bash
gcloud run services update chatvibes-tts-service \
  --project chatvibestts \
  --update-secrets=/secrets/twitch-client-id=twitch-client-id:latest
```

Then read from the file:
```javascript
import fs from 'fs';
const clientId = fs.readFileSync('/secrets/twitch-client-id', 'utf8');
```

### Recommended Secrets to Mount

**Static secrets** (rarely change) - Mount these as environment variables:
- `TWITCH_CLIENT_ID`
- `TWITCH_CLIENT_SECRET`
- `WAVESPEED_API_KEY`
- `jwt-secret-key`
- `twitch-eventsub-secret`

**Dynamic secrets** (frequently updated) - Keep using Secret Manager API with caching:
- OAuth access tokens (refresh frequently)
- User-specific tokens

---

## Cost Breakdown

### Current Costs (After Cleanup)

| Item | Count | Unit Cost | Monthly Cost |
|------|-------|-----------|--------------|
| Active secret versions | 61 | $0.06 | $3.66 |
| API access operations | ~1000/month | Free (under 10k) | $0 |
| **Total** | | | **~$3.66/month** |

### With Secret Mounting (Recommended)

| Item | Count | Unit Cost | Monthly Cost |
|------|-------|-----------|--------------|
| Static secrets (mounted) | 5 versions | $0.06 | $0.30 |
| Dynamic OAuth tokens | 32 versions | $0.06 | $1.92 |
| API access operations | ~100/month | Free | $0 |
| **Total** | | | **~$2.22/month** |

**Additional savings: ~$1.44/month** ($17.28/year)

---

## Monitoring

### Check secret version counts:

```bash
# List all secrets with version counts
for secret in $(gcloud secrets list --project chatvibestts --format="value(name)"); do
  count=$(gcloud secrets versions list "$secret" --project chatvibestts --filter="state=ENABLED" --format="value(name)" 2>/dev/null | wc -l | tr -d ' ')
  echo "$secret: $count enabled versions"
done
```

### View billing:

```bash
# Check Secret Manager costs
gcloud billing accounts list
# Then view detailed billing in the GCP Console
```

---

## Maintenance Schedule

- **Monthly:** Run `cleanup-secret-versions.js` to audit and clean up any accumulated versions
- **Quarterly:** Review which secrets could be migrated to Cloud Run secret mounting
- **Annually:** Audit unused secrets and consider deletion

---

## References

- [Google Secret Manager Pricing](https://cloud.google.com/secret-manager/pricing)
- [Cloud Run Secret Mounting](https://cloud.google.com/run/docs/configuring/secrets)
- [Best Practices for Secrets](https://cloud.google.com/secret-manager/docs/best-practices)
