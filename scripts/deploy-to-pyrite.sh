#!/usr/bin/env bash
set -euo pipefail

# Wise-Spliter Backend API Container Builder & Pusher for Pyrite Cloud (`scripts/deploy-to-pyrite.sh`)
# Modeled on `merry-tools/deploy-to-pyrite.sh` using `Dockerfile.api` (`linux/amd64`, port 4174).

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

UNIQUE_ID="$(head -c 4 /dev/urandom | od -An -tx1 | tr -d ' \n')"
IMAGE_REF="${IMAGE_REF:-ttl.sh/wise-spliter-api-${UNIQUE_ID}:24h}"

echo "========================================================================"
echo " Building Wise-Spliter Backend API Image for Pyrite Cloud (linux/amd64)"
echo "========================================================================"
docker build --platform linux/amd64 -t "$IMAGE_REF" -f Dockerfile.api .

echo ""
echo "========================================================================"
echo " Pushing Image ($IMAGE_REF)"
echo "========================================================================"
docker push "$IMAGE_REF"

echo ""
echo "SUCCESS - Wise-Spliter API image pushed:"
echo "  Image : $IMAGE_REF"
echo "  Port  : 4174"
echo "  Env   : SUPABASE_URL, SUPABASE_SECRET_KEY, VITE_SUPABASE_PUBLISHABLE_KEY, GRANT_TOKEN_SECRET, ALLOWED_ORIGINS"
echo "          NODE_ENV=production, TRUST_PROXY=true (Pyrite's ingress appends the client IP as the"
echo "          rightmost X-Forwarded-For hop; use TRUST_PROXY=cloudflare only if Cloudflare fronts the API"
echo "          AND the origin accepts traffic from Cloudflare alone)"
echo "  Auth  : Supabase email confirmations must be ON (the API refuses to start otherwise)"
echo ""
echo "Deploy via Pyrite Cloud Dashboard or Pyrite MCP (https://api.pyrite.cloud/mcp)."
