# Channel Management Guide

## Adding New Channels

### Prerequisites
1. Broadcaster must authorize the app with required scopes (done via web UI)
2. Channel must be added to `managedChannels` collection in Firestore (done via web UI)

### Automatic Setup
When a channel is added to Firestore with `isActive: true`, the bot automatically:
1. Detects the new channel via Firestore listener
2. Subscribes to all required EventSub events
3. Begins receiving chat messages and events

### Verification
After adding a channel, verify EventSub subscriptions are working:

```bash
# Check all channels
node scripts/verify-channel-subscriptions.js

# Fix a specific channel if needed
node scripts/manage-eventsub.js subscribe <channel-name>
```

## Troubleshooting

### Channel Not Receiving Chat Messages

**Symptom:** Channel is active but chat messages aren't being processed.

**Diagnosis:**
```bash
# 1. Verify subscriptions exist
node scripts/verify-channel-subscriptions.js

# 2. Check logs for errors
gcloud logging read 'resource.type=cloud_run_revision AND
  resource.labels.service_name=chatvibes-tts-service AND
  (severity=ERROR OR severity=WARNING) AND
  jsonPayload.channel="<channel-name>"'
  --limit 50 --project chatvibestts
```

**Common Issues:**

1. **Missing `channel.chat.message` subscription**
   - Check logs for: `CRITICAL: Failed to subscribe to channel.chat.message`
   - Fix: `node scripts/manage-eventsub.js subscribe <channel-name>`

2. **403 Forbidden errors**
   - Cause: Broadcaster hasn't authorized the app
   - Fix: Broadcaster needs to complete OAuth flow in web UI

3. **Wrong broadcaster user ID**
   - Cause: Username was transferred to different account
   - Fix: Re-add the channel in web UI

### EventSub Subscription Failures

**Error:** `auth must use app access token to create webhook subscription`
- This should not happen after the Nov 21 fix
- If it does, check that code is up to date

**Error:** `403 Forbidden`
- Broadcaster hasn't authorized the required scopes
- Have them log into the web UI to authorize

**Error:** `404 Not Found`
- Channel/user doesn't exist
- Verify username spelling

## Monitoring

### Health Checks
Run verification script periodically (e.g., daily via cron):

```bash
# Returns exit code 0 if healthy, 1 if issues found
node scripts/verify-channel-subscriptions.js
```

### Log Monitoring
Watch for these log patterns:

**Critical:**
```
CRITICAL: Failed to subscribe to channel.chat.message
```

**Warnings:**
```
EventSub subscription failed: <type>
```

## Best Practices

1. **Always verify after adding channels**
   ```bash
   node scripts/verify-channel-subscriptions.js
   ```

2. **Monitor deployment logs** when new code is deployed
   - EventSub subscriptions are re-verified on startup
   - Check for any CRITICAL errors

3. **Keep subscription list clean**
   - Inactive channels should have `isActive: false` in Firestore
   - Old subscriptions are automatically cleaned up

4. **Test in development first**
   - Use test channels before adding production streamers
   - Verify all features work correctly

## Scripts Reference

### `verify-channel-subscriptions.js`
Checks all active channels have required EventSub subscriptions.

**Usage:**
```bash
node scripts/verify-channel-subscriptions.js
```

**Output:**
- ✅ Lists healthy channels
- ❌ Lists channels with issues (with severity: CRITICAL or WARNING)
- Exit code 0 = all healthy, 1 = issues found

### `manage-eventsub.js`
Manual EventSub subscription management.

**Usage:**
```bash
# List all subscriptions
node scripts/manage-eventsub.js list

# Subscribe a specific channel
node scripts/manage-eventsub.js subscribe <channel-name>

# Subscribe all active managed channels
node scripts/manage-eventsub.js subscribe-all

# Delete specific subscription
node scripts/manage-eventsub.js delete <subscription-id>
```

## Required EventSub Subscriptions

Every active channel must have these subscriptions:

- ✅ **channel.chat.message** (CRITICAL - required for chat)
- channel.subscribe
- channel.subscription.message
- channel.subscription.gift
- channel.cheer
- channel.raid
- channel.channel_points_custom_reward_redemption.add
- channel.channel_points_custom_reward_redemption.update

Missing any of these will cause incomplete functionality. Missing `channel.chat.message` will prevent all chat-based TTS.
