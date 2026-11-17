#!/usr/bin/env bash
# Runs on the server (see docs/deploy-vps.md). Pulls main, rebuilds only what
# changed, and restarts the site. Restarting ends battles in progress.
set -euo pipefail
cd "$(dirname "$0")/.."

old=$(git rev-parse HEAD)
git pull --ff-only
new=$(git rev-parse HEAD)

if [ "$old" = "$new" ]; then
	echo "Already up to date. Nothing deployed."
	exit 0
fi

echo "Deploying ${old:0:8} -> ${new:0:8}:"
git log --oneline "$old..$new"
changed=$(git diff --name-only "$old" "$new")

if grep -qE '^package(-lock)?\.json$' <<<"$changed"; then
	npm install --no-audit --no-fund
fi
if grep -qE '^(showdown/|scripts/setup\.mjs$)' <<<"$changed"; then
	npm run setup
fi

sudo systemctl restart draft-league
sleep 3
systemctl status draft-league --no-pager --lines=15
