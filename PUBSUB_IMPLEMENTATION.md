# Pub/Sub Implementation for Cross-Instance TTS Communication

## Problem
The TTS bot was experiencing issues where WebSocket connections and IRC chat messages were being handled by different Cloud Run instances. This caused TTS messages to be dropped with "no active WebSocket clients" errors, even though clients were connected.

**Root Cause:** 
- Cloud Run scales horizontally with multiple instances
- IRC leader election ensures only one instance handles Twitch chat
- WebSocket connections can be on ANY instance (load balanced)
- In-memory `channelClients` Map is not shared across instances
- Result: IRC instance doesn't see WebSocket clients on other instances

## Solution
Implemented Google Cloud Pub/Sub for cross-instance communication:

1. **IRC Leader Instance**: Publishes TTS events to Pub/Sub topic
2. **All Instances**: Subscribe to the topic and process locally if they have WebSocket clients
3. **Result**: Any instance with WebSocket clients will receive and process TTS events

## Changes Made

### 1. New Pub/Sub Module (`src/lib/pubsub.js`)
- `initializePubSub()` - Initialize client and ensure topic exists
- `publishTtsEvent(channel, eventData)` - Publish TTS event to topic
- `subscribeTtsEvents(handler)` - Subscribe with auto-expiring subscription
- `closePubSub()` - Clean up resources on shutdown

### 2. Updated Bot (`src/bot.js`)
- Added Pub/Sub imports
- Initialize Pub/Sub on startup (all instances)
- Set up subscriber that calls `ttsQueue.enqueue()` for local processing
- Replaced ALL `ttsQueue.enqueue()` calls with `publishTtsEvent()` in:
  - Regular chat messages
  - Channel point redemptions
  - Cheer messages
  - Commands
  - Events (subs, raids, etc.)
- Added Pub/Sub cleanup to graceful shutdown

### 3. Updated Dependencies (`package.json`)
- Added `@google-cloud/pubsub: ^4.0.0`

### 4. Updated Cloud Build (`cloudbuild.yaml`)
- Added `GOOGLE_CLOUD_PROJECT` environment variable
- Added IAM permission grants for:
  - `roles/pubsub.publisher` - To publish TTS events
  - `roles/pubsub.subscriber` - To receive TTS events

## Architecture Flow

```
[IRC Leader Instance]
  Chat Message Received
  ↓
  publishTtsEvent() → Pub/Sub Topic
  
[Pub/Sub Topic: chatvibes-tts-events]
  ↓ (broadcasts to all subscribers)
  
[Instance A]        [Instance B]        [Instance C]
  Subscriber          Subscriber          Subscriber
  ↓                   ↓                   ↓
  Has WS clients?     Has WS clients?     Has WS clients?
  ✓ YES → Process     ✗ NO → Skip         ✗ NO → Skip
  ↓
  ttsQueue.enqueue()
  ↓
  Generate TTS
  ↓
  Send to WebSocket clients
```

## Deployment Steps

### Option 1: Deploy via Cloud Build (Recommended)
```bash
cd /Users/henry/Dev/tts-twitch

# Install new dependency locally (for development)
npm install

# Commit changes
git add .
git commit -m "Implement Pub/Sub for cross-instance TTS communication"
git push

# Cloud Build will automatically:
# 1. Build the Docker image
# 2. Deploy to Cloud Run
# 3. Grant Pub/Sub permissions
```

### Option 2: Manual Deployment
```bash
# Install dependencies
npm install

# Grant Pub/Sub permissions manually (if not using Cloud Build)
PROJECT_ID="906125386407"
SERVICE_ACCOUNT="906125386407-compute@developer.gserviceaccount.com"

gcloud projects add-iam-policy-binding $PROJECT_ID \
  --member="serviceAccount:$SERVICE_ACCOUNT" \
  --role="roles/pubsub.publisher"

gcloud projects add-iam-policy-binding $PROJECT_ID \
  --member="serviceAccount:$SERVICE_ACCOUNT" \
  --role="roles/pubsub.subscriber"

# Deploy
gcloud run deploy twitch-tts-app \
  --source . \
  --region us-central1 \
  --set-env-vars GOOGLE_CLOUD_PROJECT=$PROJECT_ID
```

## Testing

After deployment:

1. **Check Logs**: Look for Pub/Sub initialization messages
   ```
   Pub/Sub client initialized successfully
   Pub/Sub subscription created: chatvibes-tts-sub-...
   ```

2. **Test TTS**: 
   - Open OBS browser source (creates WebSocket connection)
   - Send chat message in Twitch
   - Should see in logs:
     ```
     Published TTS event to Pub/Sub
     Received TTS event from Pub/Sub, processing locally
     Processing TTS for [user]
     ```

3. **Verify Cross-Instance**: Check that different revision logs show:
   - One revision publishes the event
   - Same or different revision processes it

## Monitoring

### Check Pub/Sub Topic
```bash
gcloud pubsub topics list
gcloud pubsub topics describe chatvibes-tts-events
```

### Check Active Subscriptions
```bash
gcloud pubsub subscriptions list --filter="chatvibes-tts-sub"
```

### View Message Stats
```bash
gcloud pubsub topics describe chatvibes-tts-events --format="table(name, messageStoragePolicy)"
```

## Benefits

✅ **Works across all instances** - No matter which instance handles chat or WebSocket  
✅ **Automatic cleanup** - Subscriptions expire after 10 minutes of inactivity  
✅ **Scalable** - Can handle unlimited instances  
✅ **Reliable** - Pub/Sub ensures message delivery  
✅ **Minimal latency** - Pub/Sub adds <100ms typically  

## Troubleshooting

### "Pub/Sub not initialized" errors
- Check that `initializePubSub()` is called during startup
- Verify `GOOGLE_CLOUD_PROJECT` environment variable is set

### Still seeing "no active WebSocket clients"
- Check that ALL instances show subscription creation in logs
- Verify IAM permissions were granted correctly
- Check Pub/Sub topic exists: `gcloud pubsub topics describe chatvibes-tts-events`

### Messages not being received
- Check for subscription errors in logs
- Verify the Pub/Sub topic has active subscriptions
- Ensure service account has both publisher and subscriber roles

## Cost Considerations

Pub/Sub pricing:
- **Publishing**: ~$40 per TB
- **Delivery**: ~$40 per TB
- **Subscriptions**: Free
- **Storage**: ~$0.27 per GB-month (for undelivered messages)

For a typical TTS bot with ~100 messages/hour:
- Message size: ~1KB per event
- Monthly data: 100 msg/hr × 24hr × 30 days × 1KB = 72 MB
- **Estimated cost**: Less than $0.01/month

The cost is negligible compared to the reliability benefits!

