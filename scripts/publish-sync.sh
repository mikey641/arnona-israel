#!/bin/sh
# Unattended publish:
#   1. pull the latest reviewed rates from the scraper's database (when configured),
#   2. retry every authority that still has no published rates with the open scraper
#      from this machine (municipal sites and search engines block datacenter IPs),
#   3. validate, and push to GitHub only when rates changed. Vercel deploys main on push.
set -eu
export PATH=/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin
cd "$(dirname "$0")/.."
git pull --ff-only --quiet
if [ -n "${SUPABASE_URL:-}" ] || grep -q '^SUPABASE_URL=' .env.local 2>/dev/null; then
  node scripts/sync-from-supabase.mjs
fi
node scripts/blocked-sources.mjs || true
node scripts/scrape-missing.mjs --concurrency 4 || echo "scrape-missing exited non-zero"
node scripts/validate-data.mjs
# meta.json's synced_at changes every run; publish only when rates actually moved.
if git diff --quiet -- data/cities.json data/tariffs && [ -z "$(git ls-files --others --exclude-standard data)" ]; then
  git checkout -- data/meta.json
  echo "no data changes"
  exit 0
fi
git add data scraper/state
git commit -q -m "data: sync $(date +%Y-%m-%d)"
git push -q
echo "published"
