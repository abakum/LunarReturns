#!/usr/bin/env bash
# Deploy LunarReturns to Yandex Cloud: bucket + CORS, service account,
# static key (rotated on every run, copy stored in GitHub Secrets),
# function version from function/handler.py, writing FUNCTION_URL into the page.
# Usage: ./deploy.sh [bootstrap | deploy]  (default: auto-detect)
set -euo pipefail

BUCKET=lunarreturns
FN_NAME=lunarreturns-presign
SA_NAME=lunarreturns-fn
REPO=abakum/LunarReturns
ALLOWED_UIDS="${ALLOWED_UIDS:-}"
EXPIRES="${EXPIRES:-600}"
PAGE_DIR="$(cd "$(dirname "$0")/.." && pwd)/abakum.github.io/LunarReturns"
PAGE="$PAGE_DIR/index.html"

export PATH="$PATH:$HOME/yandex-cloud/bin"

die() { echo "ERROR: $*" >&2; exit 1; }
info() { echo "==> $*"; }

install_yc() {
  info "Installing yc into $HOME/yandex-cloud (no sudo)"
  curl -sSL https://storage.yandexcloud.net/yandexcloud-yc/install.sh \
    | bash -s -- -i "$HOME/yandex-cloud" || die "failed to install yc"
  [ -x "$HOME/yandex-cloud/bin/yc" ] || die "yc installed but binary not found"
}

for cmd in gh zip curl jq; do
  command -v "$cmd" >/dev/null || die "$cmd not found; install it with your package manager and retry"
done
command -v yc >/dev/null || install_yc

if ! gh auth status >/dev/null 2>&1; then
  info "gh is not authenticated; running gh auth login"
  gh auth login
fi

if [ -z "$(yc config get folder-id)" ]; then
  info "yc profile is not initialized; running yc init"
  yc init
fi
FOLDER_ID="$(yc config get folder-id)"
[ -n "$FOLDER_ID" ] || die "folder-id is not set in the yc profile; run yc init"

rotate_key() {
  info "Creating new static key for $SA_NAME"
  local out key_id secret new_id old
  out="$(yc iam access-key create --service-account-name "$SA_NAME" \
    --description "rotated by deploy.sh $(date -u +%FT%TZ)")"
  new_id="$(printf '%s\n' "$out" | awk '/^access_key:/{f=1} f && /^  id:/ {print $2; exit}')"
  key_id="$(printf '%s\n' "$out" | awk '/key_id:/ {print $2; exit}')"
  secret="$(printf '%s\n' "$out" | awk '/secret:/ {print $2; exit}')"
  [ -n "$new_id" ] && [ -n "$key_id" ] && [ -n "$secret" ] \
    || { printf '%s\n' "$out"; die "failed to parse key_id/secret"; }

  info "Saving key to GitHub Secrets ($REPO)"
  printf '%s' "$key_id" | gh secret set S3_ACCESS_KEY_ID -R "$REPO"
  printf '%s' "$secret" | gh secret set S3_SECRET_ACCESS_KEY -R "$REPO"

  info "Deleting old keys of $SA_NAME"
  while read -r old; do
    [ "$old" = "$new_id" ] && continue
    yc iam access-key delete "$old" >/dev/null 2>&1 || true
  done < <(yc iam access-key list --service-account-name "$SA_NAME" --format json | jq -r '.[].id')

  S3_ACCESS_KEY_ID="$key_id"
  S3_SECRET_ACCESS_KEY="$secret"
}

deploy_version() {
  info "Creating function version from function/handler.py"
  (
    cd "$(dirname "$0")/function"
    rm -f fn.zip
    zip -q fn.zip handler.py
  )
  local env="S3_ACCESS_KEY_ID=${S3_ACCESS_KEY_ID},S3_SECRET_ACCESS_KEY=${S3_SECRET_ACCESS_KEY},BUCKET=${BUCKET},EXPIRES=${EXPIRES}"
  [ -n "$ALLOWED_UIDS" ] && env="${env},ALLOWED_UIDS=${ALLOWED_UIDS}"
  yc serverless function version create \
    --function-name "$FN_NAME" --runtime python312 \
    --entrypoint handler.handler --memory 128MB --execution-timeout 10s \
    --source-path "$(dirname "$0")/function/fn.zip" \
    --environment "$env"
  yc serverless function allow-unauthenticated-invoke "$FN_NAME"
  unset S3_ACCESS_KEY_ID S3_SECRET_ACCESS_KEY
}

function_url() {
  yc serverless function get "$FN_NAME" --format json | jq -r '.http_invoke_url'
}

smoke_test() {
  local url="$1" code body
  code="$(curl -s -o /tmp/kilo/lr_resp.json -w '%{http_code}' \
    -H 'Content-Type: application/json' -d '{}' "$url" || true)"
  body="$(cat /tmp/kilo/lr_resp.json 2>/dev/null || true)"
  info "Smoke test (no token): HTTP $code, body: $body"
  case "$code" in
    2*|4*) echo "    Function responds (auth error without a token is expected)" ;;
    *) echo "WARNING: unexpected status $code from function" ;;
  esac
}

write_page_url() {
  local url="$1"
  if [ ! -f "$PAGE" ]; then
    echo "WARNING: $PAGE not found — set FUNCTION_URL manually: $url"
    return
  fi
  if grep -q "FUNCTION_URL = \"$url\"" "$PAGE"; then
    info "FUNCTION_URL in the page is already up to date"
    return
  fi
  if [ "$(grep -c 'const FUNCTION_URL' "$PAGE")" -ne 1 ]; then
    echo "WARNING: $PAGE does not contain exactly one 'const FUNCTION_URL' — set it manually: $url"
    return
  fi
  sed -i "s|const FUNCTION_URL = \"[^\"]*\";|const FUNCTION_URL = \"$url\";|" "$PAGE"
  info "FUNCTION_URL written to $PAGE"
  git -C "$PAGE_DIR" diff -- index.html || true
  echo "    Now commit and push the abakum.github.io repo manually."
}

bootstrap() {
  info "Bucket $BUCKET and CORS"
  if ! yc storage bucket get --name "$BUCKET" >/dev/null 2>&1; then
    yc storage bucket create --name "$BUCKET" --default-storage-class standard --max-size 1
  fi
  yc storage bucket update --name "$BUCKET" --max-size 1 --remove-cors >/dev/null
  yc storage bucket update --name "$BUCKET" \
    --cors 'allowed-origins=https://abakum.github.io,allowed-methods=METHOD_GET,allowed-methods=METHOD_PUT,allowed-headers=*,max-age-seconds=3600' \
    || die "failed to set bucket CORS"

  info "Service account $SA_NAME (storage.editor)"
  yc iam service-account create "$SA_NAME" || true
  yc resource-manager folder add-access-binding "$FOLDER_ID" \
    --role storage.editor --service-account-name "$SA_NAME" || true

  rotate_key

  info "Function $FN_NAME"
  yc serverless function create "$FN_NAME" || true
  deploy_version

  local url; url="$(function_url)"
  smoke_test "$url"
  write_page_url "$url"
  info "Done. Function URL: $url"
}

deploy() {
  rotate_key
  deploy_version
  local url; url="$(function_url)"
  smoke_test "$url"
  write_page_url "$url"
  info "Done. Function URL: $url"
}

main() {
  local action="${1:-auto}"
  if [ "$action" = "auto" ]; then
    if yc serverless function get "$FN_NAME" >/dev/null 2>&1; then
      action=deploy
    else
      action=bootstrap
    fi
    info "Auto-detected action: $action (function $FN_NAME $([ "$action" = deploy ] && echo exists || echo not found))"
  fi
  case "$action" in
    bootstrap) bootstrap ;;
    deploy) deploy ;;
    *) die "usage: $0 [bootstrap | deploy]" ;;
  esac
}
main "$@"
