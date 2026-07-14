#!/usr/bin/env bash
# One-shot deploy helper for linkhub.
# Run from inside the linkhub/ folder:  bash deploy.sh
# It pauses and tells you exactly what to paste when it needs something.

set -e
BOLD=$'\033[1m'; GREEN=$'\033[32m'; YELLOW=$'\033[33m'; RESET=$'\033[0m'
say() { echo; echo "${BOLD}==> $1${RESET}"; }

say "Step 1/7: Installing dependencies"
npm install --legacy-peer-deps

say "Step 2/7: Logging into Cloudflare"
echo "A browser window will open. Approve the login, then come back here."
npx wrangler login

say "Step 3/7: Creating the database"
echo "${YELLOW}When this finishes, COPY the database_id it prints.${RESET}"
npx wrangler d1 create linkhub-db || true
echo
echo "${YELLOW}Paste the database_id here and press Enter:${RESET}"
read -r DBID
# write it into wrangler.toml
if [ -n "$DBID" ]; then
  sed -i.bak "s/^database_id = .*/database_id = \"$DBID\"/" wrangler.toml
  echo "${GREEN}Saved database_id to wrangler.toml${RESET}"
fi

say "Step 4/7: Creating the tables"
npm run db:init:remote

say "Step 5/7: Setting your two secrets"
echo "You'll be asked to type/paste a value for each. Use a long random string."
echo "${YELLOW}Secret 1 of 2: DASHBOARD_TOKEN (this is your password to view analytics)${RESET}"
npx wrangler secret put DASHBOARD_TOKEN
echo "${YELLOW}Secret 2 of 2: VISITOR_SALT (just mash a long random string, you never type it again)${RESET}"
npx wrangler secret put VISITOR_SALT

say "Step 6/7: Deploying"
npx wrangler deploy

say "Step 7/7: Done"
echo "${GREEN}Your page is live at the *.workers.dev URL shown above.${RESET}"
echo "Analytics: add /dashboard to that URL and enter your DASHBOARD_TOKEN."
echo
echo "Next: attach your custom domain in the Cloudflare dashboard, and if Bot"
echo "Fight Mode is on, add the WAF allow rule for ASN 32934 (see README)."
