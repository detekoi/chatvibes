#!/bin/bash
# Cleanup unused secrets to reduce storage costs
# Each secret version costs $0.06/month

set -e

PROJECT_ID="chatvibestts"

echo "🗑️  Secret Manager Cleanup Plan"
echo "================================"
echo ""

# Secrets that appear to be unused or duplicates
SECRETS_TO_DELETE=(
  "T302_API_KEY_SECRET"        # Duplicate/old name (now using 302_KEY)
)

# Secrets that might be unused (need verification)
SECRETS_TO_VERIFY=(
  "allowed-channels"           # Used in scripts but maybe deprecated?
  "chatvibes-initial-channels" # Used in GitHub workflow but maybe deprecated?
)

echo "⚠️  REVIEW BEFORE DELETING:"
echo ""
echo "Secrets marked for deletion:"
for secret in "${SECRETS_TO_DELETE[@]}"; do
  enabled=$(gcloud secrets versions list "$secret" --project "$PROJECT_ID" --filter="state=ENABLED" --format="value(name)" 2>/dev/null | wc -l | tr -d ' ')
  cost=$(echo "scale=2; $enabled * 0.06" | bc)
  echo "  - $secret ($enabled versions, \$$cost/month)"
done
echo ""

echo "Secrets that need verification (found in code):"
for secret in "${SECRETS_TO_VERIFY[@]}"; do
  enabled=$(gcloud secrets versions list "$secret" --project "$PROJECT_ID" --filter="state=ENABLED" --format="value(name)" 2>/dev/null | wc -l | tr -d ' ')
  cost=$(echo "scale=2; $enabled * 0.06" | bc)
  echo "  - $secret ($enabled versions, \$$cost/month)"
done
echo ""

echo "📝 IMPORTANT CHECKS:"
echo ""
echo "1. Is the music service (Replicate) still active?"
echo "   File: src/components/music/musicService.py"
echo "   grep -r 'replicate' src/"
echo ""
echo "2. Is the allow-list feature still used?"
echo "   File: src/lib/allowList.js"
echo "   grep -r 'allowed-channels' src/"
echo ""
echo "3. Are initial channels still loaded from secrets?"
echo "   Check: .github/workflows/deploy-chatvibes.yml"
echo ""

echo "💡 To delete a secret (IRREVERSIBLE):"
echo "   gcloud secrets delete SECRET_NAME --project=$PROJECT_ID"
echo ""

echo "💡 To just disable versions (reversible):"
echo "   gcloud secrets versions disable VERSION --project=$PROJECT_ID"
echo ""

echo "⚠️  WAIT: Verify these are truly unused before deleting!"
