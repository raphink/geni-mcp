#!/usr/bin/env bash
# Deploy geni-mcp to Google Cloud Functions (gen2) in the mcp-svcs project.
# Usage: ./deploy.sh
set -euo pipefail

ACCOUNT="raphink@gmail.com"
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
  --allow-unauthenticated

echo "Done."
