#!/usr/bin/env bash
# Deploy geni-mcp to Google Cloud Functions (gen2) in the mcp-svcs project.
# Usage: ./deploy.sh
set -euo pipefail

ACCOUNT="${GCLOUD_ACCOUNT:-$(gcloud config get-value account 2>/dev/null)}"
PROJECT="mcp-svcs"
REGION="europe-west1"
FUNCTION="geni-mcp"

# Build TypeScript
echo "Building TypeScript..."
npm run build

# Deploy
echo "Deploying $FUNCTION to $PROJECT ($REGION)..."
gcloud functions deploy "$FUNCTION" \
  --gen2 \
  --runtime=nodejs22 \
  --region="$REGION" \
  --project="$PROJECT" \
  --account="$ACCOUNT" \
  --source=. \
  --entry-point=geniMcp \
  --trigger-http \
  --allow-unauthenticated \
  --max-instances=1 \
  --remove-env-vars="GENI_CLIENT_ID,GENI_CLIENT_SECRET" \
  --set-secrets="GENI_CLIENT_ID=GENI_CLIENT_ID:latest,GENI_CLIENT_SECRET=GENI_CLIENT_SECRET:latest"

echo "Done."
