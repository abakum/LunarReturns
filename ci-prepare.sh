#!/usr/bin/env bash
# One-time local preparation for CI deploys (run from a laptop):
#   1. Grant SA `github-actions` the roles it lacks as folder `editor`
#      (serverless.functions.admin, iam.serviceAccounts.accessKeyAdmin).
#   2. Create an authorized key for it, store in GitHub Secrets
#      YC_SA_KEY / YC_FOLDER_ID.
#   3. Store a PAT (entered interactively) as the GH_PAT secret —
#      GITHUB_TOKEN in CI cannot manage repo secrets, deploy.sh needs
#      `gh secret set` for S3 key rotation. Create the PAT manually first:
#      https://github.com/settings/tokens → repo scope.
#   4. Self-check the new key against the resources deploy.sh touches.
#   5. Print sa.json once — save it in your password manager; the GitHub
#      secret cannot be read back. Losing it is recoverable by re-running
#      this script (unlike the VAPID key, subscriptions are not affected).
# Idempotent: safe to re-run.
set -euo pipefail

REPO=abakum/LunarReturns
DEPLOY_SA=github-actions
S3_SA=lunarreturns-fn
FN_NAME=lunarreturns-presign

export PATH="$PATH:$HOME/yandex-cloud/bin"

die() { echo "ERROR: $*" >&2; exit 1; }
info() { echo "==> $*"; }

command -v gh >/dev/null || die "gh not found; install it with your package manager and retry"
command -v yc >/dev/null || die "yc not found; run deploy.sh once to install it, or install manually"
gh auth status >/dev/null 2>&1 || die "gh is not authenticated; run: gh auth login"
FOLDER_ID="$(yc config get folder-id)"
[ -n "$FOLDER_ID" ] || die "folder-id is not set in the yc profile; run yc init"

info "Granting roles to SA $DEPLOY_SA on folder $FOLDER_ID"
yc resource-manager folder add-access-binding "$FOLDER_ID" \
  --role serverless.functions.admin --service-account-name "$DEPLOY_SA" || true
yc resource-manager folder add-access-binding "$FOLDER_ID" \
  --role iam.serviceAccounts.accessKeyAdmin --service-account-name "$DEPLOY_SA" || true

info "Creating authorized key for SA $DEPLOY_SA"
SA_KEY="$(mktemp "${TMPDIR:-/tmp}/sa.XXXXXX.json")"
trap 'rm -f "$SA_KEY"' EXIT
yc iam key create --service-account-name "$DEPLOY_SA" --output "$SA_KEY" \
  || die "failed to create the authorized key; check that SA $DEPLOY_SA exists"

info "Saving YC_SA_KEY/YC_FOLDER_ID to GitHub Secrets ($REPO)"
gh secret set YC_SA_KEY -R "$REPO" < "$SA_KEY"
gh secret set YC_FOLDER_ID -R "$REPO" --body "$FOLDER_ID"

if gh secret list -R "$REPO" --json name --jq '.[].name' 2>/dev/null | grep -qx GH_PAT; then
  info "Secret GH_PAT already exists — skipping (delete it in repo settings to re-enter)"
else
  info "GH_PAT: GITHUB_TOKEN in CI cannot manage repo secrets; deploy.sh needs gh secret set for S3 key rotation"
  info "Create a PAT with 'repo' scope: https://github.com/settings/tokens"
  printf 'Paste the PAT (input hidden): '
  read -rs PAT
  echo
  [ -n "$PAT" ] || die "empty PAT; rerun this script to retry"
  printf '%s' "$PAT" | gh secret set GH_PAT -R "$REPO"
  info "PAT saved as secret GH_PAT (also store it in your password manager)"
  unset PAT
fi

info "Self-check: listing keys of SA $S3_SA with the new key"
yc iam access-key list --service-account-name "$S3_SA" >/dev/null \
  || die "access-key list failed: role iam.serviceAccounts.accessKeyAdmin is probably not effective yet"
info "Self-check: reading function $FN_NAME with the new key"
yc serverless function get "$FN_NAME" >/dev/null \
  || die "function get failed: role serverless.functions.admin is probably not effective yet"

info "Save this sa.json in your password manager (the GitHub secret cannot be read back):"
cat "$SA_KEY"
info "Done. Re-running this script is safe (a new key replaces the old secret)."
