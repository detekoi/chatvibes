#!/bin/bash
# Script to migrate static secrets from Secret Manager to Cloud Run environment variables
# This eliminates Secret Manager API costs for static secrets

set -e

PROJECT_ID="chatvibestts"
SERVICE_NAME="chatvibes-tts-service"

echo "🔄 Migrating static secrets to Cloud Run environment variables..."
echo "Project: $PROJECT_ID"
echo "Service: $SERVICE_NAME"
echo ""

# Static secrets that rarely change - mount these as environment variables
STATIC_SECRETS=(
  "TWITCH_CLIENT_ID:twitch-client-id"
  "TWITCH_CLIENT_SECRET:twitch-client-secret"
  "TWITCH_BOT_USERNAME:twitch-bot-username"
  "TWITCH_EVENTSUB_SECRET:twitch-eventsub-secret"
  "WAVESPEED_API_KEY:WAVESPEED_API_KEY"
  "JWT_SECRET:jwt-secret-key"
  "API_302_KEY:302_KEY"
  "REPLICATE_API_TOKEN:replicate-api-token"
)

echo "📦 Static secrets to migrate (${#STATIC_SECRETS[@]}):"
for secret_map in "${STATIC_SECRETS[@]}"; do
  env_var=$(echo "$secret_map" | cut -d: -f1)
  secret_name=$(echo "$secret_map" | cut -d: -f2)
  echo "  - $env_var ← $secret_name:latest"
done
echo ""

# Build the --update-secrets flag
SECRET_FLAGS=""
for secret_map in "${STATIC_SECRETS[@]}"; do
  env_var=$(echo "$secret_map" | cut -d: -f1)
  secret_name=$(echo "$secret_map" | cut -d: -f2)
  if [ -z "$SECRET_FLAGS" ]; then
    SECRET_FLAGS="${env_var}=${secret_name}:latest"
  else
    SECRET_FLAGS="${SECRET_FLAGS},${env_var}=${secret_name}:latest"
  fi
done

echo "🚀 Updating Cloud Run service..."
echo "Command: gcloud run services update $SERVICE_NAME --update-secrets=\"$SECRET_FLAGS\""
echo ""

# Uncomment to execute:
# gcloud run services update "$SERVICE_NAME" \
#   --project "$PROJECT_ID" \
#   --update-secrets="$SECRET_FLAGS"

echo "⚠️  DRY RUN MODE - Command not executed"
echo ""
echo "To execute, uncomment the gcloud command in this script or run:"
echo ""
echo "gcloud run services update $SERVICE_NAME \\"
echo "  --project $PROJECT_ID \\"
echo "  --update-secrets=\"$SECRET_FLAGS\""
echo ""
echo "✅ After deployment, update your code to read from process.env instead of getSecretValue()"
