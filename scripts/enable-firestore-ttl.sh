#!/bin/bash
# Script to enable Firestore TTL policies for deduplication collections
# This will automatically delete documents after their expireAt timestamp

set -e

PROJECT_ID="${GCP_PROJECT:-chatvibestts}"
DATABASE_ID="${FIRESTORE_DATABASE:-(default)}"

echo "Enabling Firestore TTL policies for project: $PROJECT_ID"
echo "Database: $DATABASE_ID"
echo ""

# Enable TTL for processedEventSubMessages collection
echo "Setting TTL policy on 'processedEventSubMessages' collection..."
gcloud firestore fields ttls update expireAt \
  --collection-group=processedEventSubMessages \
  --enable-ttl \
  --project="$PROJECT_ID" \
  --database="$DATABASE_ID" \
  --quiet

echo "✓ TTL policy enabled for processedEventSubMessages"
echo ""

# Enable TTL for processedTtsEvents collection
echo "Setting TTL policy on 'processedTtsEvents' collection..."
gcloud firestore fields ttls update expireAt \
  --collection-group=processedTtsEvents \
  --enable-ttl \
  --project="$PROJECT_ID" \
  --database="$DATABASE_ID" \
  --quiet

echo "✓ TTL policy enabled for processedTtsEvents"
echo ""

echo "✓ All TTL policies configured successfully!"
echo ""
echo "Note: Documents will now be automatically deleted after their 'expireAt' timestamp."
echo "The TTL service runs in the background and may take up to 72 hours to start deleting old documents."
echo "For more info: https://cloud.google.com/firestore/docs/ttl"
