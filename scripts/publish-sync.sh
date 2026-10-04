#!/bin/sh
# Unattended publish: pull the latest reviewed rates from the scraper's database,
# validate, and push to GitHub only when data/ changed. Vercel deploys main on push.
set -eu
export PATH=/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin
cd "$(dirname "$0")/.."
git pull --ff-only --quiet
node scripts/sync-from-supabase.mjs
node scripts/validate-data.mjs
# meta.json's synced_at changes every run; publish only when rates actually moved.
if git diff --quiet -- data/cities.json data/tariffs && [ -z "$(git ls-files --others --exclude-standard data)" ]; then
  git checkout -- data/meta.json
  echo "no data changes"
  exit 0
fi
git add data
git commit -q -m "data: sync $(date +%Y-%m-%d)"
git push -q
echo "published"
