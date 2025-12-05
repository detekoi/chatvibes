#!/bin/bash
# Deploy the cleanup script as a Cloud Run job

set -e

PROJECT_ID="chatvibestts"
REGION="us-central1"
JOB_NAME="secret-cleanup-job"

echo "🚀 Deploying Secret Manager cleanup job..."

# Build and deploy the Cloud Run job
gcloud run jobs deploy "$JOB_NAME" \
  --source=. \
  --region="$REGION" \
  --project="$PROJECT_ID" \
  --max-retries=2 \
  --task-timeout=10m \
  --execute-now

echo "✅ Job deployed successfully!"
echo ""
echo "Next, create a Cloud Scheduler to run this weekly:"
echo ""
echo "gcloud scheduler jobs create http secret-cleanup-schedule \\"
echo "  --location=$REGION \\"
echo "  --schedule='0 2 * * 0' \\"
echo "  --uri='https://$REGION-run.googleapis.com/apis/run.googleapis.com/v1/namespaces/$PROJECT_ID/jobs/$JOB_NAME:run' \\"
echo "  --http-method=POST \\"
echo "  --oauth-service-account-email=$PROJECT_ID@appspot.gserviceaccount.com \\"
echo "  --project=$PROJECT_ID"
