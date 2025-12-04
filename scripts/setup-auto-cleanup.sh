#!/bin/bash
# Setup automated weekly secret cleanup via Cloud Scheduler

set -e

PROJECT_ID="chatvibestts"
REGION="us-central1"
SERVICE_URL="https://chatvibes-tts-service-906125386407.us-central1.run.app"
CLEANUP_ENDPOINT="${SERVICE_URL}/api/admin/secret-cleanup"
SCHEDULE_NAME="secret-cleanup-weekly"

echo "🔧 Setting up automated secret cleanup..."
echo "Project: $PROJECT_ID"
echo "Endpoint: $CLEANUP_ENDPOINT"
echo ""

# Create Cloud Scheduler job
# Runs every Sunday at 2 AM UTC (cron: 0 2 * * 0)
echo "Creating Cloud Scheduler job..."

gcloud scheduler jobs create http "$SCHEDULE_NAME" \
  --location="$REGION" \
  --schedule="0 2 * * 0" \
  --uri="$CLEANUP_ENDPOINT" \
  --http-method=POST \
  --headers="X-CloudScheduler=true" \
  --oidc-service-account-email="$PROJECT_ID@appspot.gserviceaccount.com" \
  --oidc-token-audience="$SERVICE_URL" \
  --attempt-deadline=300s \
  --project="$PROJECT_ID" \
  --description="Weekly cleanup of old Secret Manager versions" \
  2>/dev/null || \
gcloud scheduler jobs update http "$SCHEDULE_NAME" \
  --location="$REGION" \
  --schedule="0 2 * * 0" \
  --uri="$CLEANUP_ENDPOINT" \
  --http-method=POST \
  --headers="X-CloudScheduler=true" \
  --oidc-service-account-email="$PROJECT_ID@appspot.gserviceaccount.com" \
  --oidc-token-audience="$SERVICE_URL" \
  --attempt-deadline=300s \
  --project="$PROJECT_ID" \
  --description="Weekly cleanup of old Secret Manager versions"

echo ""
echo "✅ Cloud Scheduler job created successfully!"
echo ""
echo "📅 Schedule: Every Sunday at 2 AM UTC"
echo "🎯 Target: $CLEANUP_ENDPOINT"
echo ""
echo "To test it now:"
echo "  gcloud scheduler jobs run $SCHEDULE_NAME --location=$REGION --project=$PROJECT_ID"
echo ""
echo "To view job details:"
echo "  gcloud scheduler jobs describe $SCHEDULE_NAME --location=$REGION --project=$PROJECT_ID"
echo ""
echo "To view job logs:"
echo "  gcloud logging read 'resource.type=\"cloud_scheduler_job\" AND resource.labels.job_id=\"$SCHEDULE_NAME\"' --limit=10 --project=$PROJECT_ID"
