#!/usr/bin/env bash
# Deploy LunarReturns to Yandex Cloud: bucket + CORS, service account,
# static key (rotated on every run, copy stored in GitHub Secrets),
# function version from function/handler.py, writing FUNCTION_URL into the page.
# Usage: ./deploy.sh [bootstrap | deploy]  (default: auto-detect)
set -euo pipefail

BUCKET=lunarreturns
FN_NAME=lunarreturns-presign
FN_PUSH_NAME=lunarreturns-push
TRIGGER_NAME=lunarreturns-push-timer
SA_NAME=lunarreturns-fn
REPO=abakum/LunarReturns
MAX_SIZE_BYTES=1073741824  # 1 GiB (the free tier; yc --max-size takes bytes)
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

if [ "${CI:-}" != true ] && [ -z "${GH_TOKEN:-}${YC_SA_KEY:-}" ]; then
  if ! gh auth status >/dev/null 2>&1; then
    info "gh is not authenticated; running gh auth login"
    gh auth login
  fi

  if [ -z "$(yc config get folder-id)" ]; then
    info "yc profile is not initialized; running yc init"
    yc init
  fi
fi
FOLDER_ID="$(yc config get folder-id)"
[ -n "$FOLDER_ID" ] || die "folder-id is not set in the yc profile; run yc init"

ensure_vapid_keys() {
  if [ -z "${VAPID_PRIVATE:-}" ] || [ -z "${VAPID_PUBLIC:-}" ]; then
    if [ -f "$(dirname "$0")/.vapid.env" ]; then
      info "Loading VAPID keys from .vapid.env"
      # shellcheck disable=SC1091
      set -a; . "$(dirname "$0")/.vapid.env"; set +a
    fi
  fi
  if [ -z "${VAPID_PRIVATE:-}" ] || [ -z "${VAPID_PUBLIC:-}" ]; then
    die "VAPID_PRIVATE/VAPID_PUBLIC not set; in CI they come from secrets, locally run ./vapid-keygen.sh once (see .kilo/plans/20260824-push-subscriptions-format.md) or source .vapid.env"
  fi
}

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
  # version create prints the function env (incl. secrets) — silence it in CI logs
  create_version "$FN_NAME" handler.handler 10s "$(dirname "$0")/function/fn.zip" "$env"
  yc serverless function allow-unauthenticated-invoke "$FN_NAME"
}

# create_version <function> <entrypoint> <timeout> <source> <env>
create_version() {
  if [ "${CI:-}" = true ]; then
    yc serverless function version create \
      --function-name "$1" --runtime python312 \
      --entrypoint "$2" --memory 128MB --execution-timeout "$3" \
      --source-path "$4" --environment "$5" >/dev/null
  else
    yc serverless function version create \
      --function-name "$1" --runtime python312 \
      --entrypoint "$2" --memory 128MB --execution-timeout "$3" \
      --source-path "$4" --environment "$5"
  fi
}

deploy_push_version() {
  info "Creating function version for $FN_PUSH_NAME"
  ensure_vapid_keys
  yc serverless function create "$FN_PUSH_NAME" >/dev/null 2>&1 || true  # ok if it already exists
  (
    cd "$(dirname "$0")/function"
    rm -f fn-push.zip
    zip -q fn-push.zip handler.py push.py requirements.txt
  )
  local env="S3_ACCESS_KEY_ID=${S3_ACCESS_KEY_ID},S3_SECRET_ACCESS_KEY=${S3_SECRET_ACCESS_KEY},BUCKET=${BUCKET}"
  [ -n "${VAPID_SUBJECT:-}" ] && env="${env},VAPID_SUBJECT=${VAPID_SUBJECT}"
  # ВК-мини-апп: секреты для проверки sign и отправки уведомлений
  # (gh secret set VK_APP_SECRET/VK_SERVICE_TOKEN -R abakum/LunarReturns).
  if [ -n "${VK_APP_SECRET:-}" ] && [ -n "${VK_SERVICE_TOKEN:-}" ]; then
    env="${env},VK_APP_SECRET=${VK_APP_SECRET},VK_SERVICE_TOKEN=${VK_SERVICE_TOKEN}"
  else
    echo "WARNING: VK_APP_SECRET/VK_SERVICE_TOKEN not set — VK push actions disabled" >&2
  fi
  # version create prints the function env (incl. secrets) — silence it in CI logs
  create_version "$FN_PUSH_NAME" push.handler 30s "$(dirname "$0")/function/fn-push.zip" \
    "$env,VAPID_PRIVATE=${VAPID_PRIVATE},VAPID_PUBLIC=${VAPID_PUBLIC}"
  yc serverless function allow-unauthenticated-invoke "$FN_PUSH_NAME"
}

ensure_timer_trigger() {
  info "Timer trigger $TRIGGER_NAME (daily 06:00 UTC = 09:00 MSK)"
  if yc serverless trigger get "$TRIGGER_NAME" >/dev/null 2>&1; then
    info "Trigger already exists"
    return
  fi
  yc serverless function add-access-binding "$FN_PUSH_NAME" \
    --role serverless.functions.invoker --service-account-name "$SA_NAME" || true
  yc serverless trigger create timer \
    --name "$TRIGGER_NAME" \
    --cron-expression '0 6 ? * * *' \
    --invoke-function-name "$FN_PUSH_NAME" \
    --invoke-function-service-account-name "$SA_NAME"
}

function_url() {
  yc serverless function get "$FN_NAME" --format json | jq -r '.http_invoke_url'
}

push_function_url() {
  yc serverless function get "$FN_PUSH_NAME" --format json | jq -r '.http_invoke_url'
}

smoke_test() {
  local url="$1" code body
  mkdir -p /tmp/kilo
  code="$(curl -s -o /tmp/kilo/lr_resp.json -w '%{http_code}' \
    -H 'Content-Type: application/json' -d '{}' "$url" || true)"
  body="$(cat /tmp/kilo/lr_resp.json 2>/dev/null || true)"
  info "Smoke test (no token): HTTP $code, body: $body"
  case "$code" in
    2*|4*) echo "    Function responds (auth error without a token is expected)" ;;
    *) echo "WARNING: unexpected status $code from function" ;;
  esac
}

write_page_var() {
  local var="$1" url="$2"
  if [ ! -f "$PAGE" ]; then
    echo "WARNING: $PAGE not found — set $var manually: $url"
    return
  fi
  if grep -q "const $var = \"$url\"" "$PAGE"; then
    info "$var in the page is already up to date"
    return
  fi
  if [ "$(grep -c "const $var" "$PAGE")" -ne 1 ]; then
    echo "WARNING: $PAGE does not contain exactly one 'const $var' — set it manually: $url"
    return
  fi
  sed -i "s|const $var = \"[^\"]*\";|const $var = \"$url\";|" "$PAGE"
  info "$var written to $PAGE"
}

commit_page() {
  # in CI commit and push automatically; locally the user commits by hand
  if [ "${CI:-}" = true ]; then
    if git -C "$PAGE_DIR" diff --quiet -- index.html; then
      info "index.html unchanged — nothing to commit"
      return
    fi
    git -C "$PAGE_DIR" add index.html
    git -C "$PAGE_DIR" -c user.name="github-actions[bot]" \
      -c user.email="41898282+github-actions[bot]@users.noreply.github.com" \
      commit -m "LunarReturns: update function URLs (deploy.sh)" >/dev/null
    git -C "$PAGE_DIR" push
    info "Pushed index.html to abakum.github.io"
  else
    git -C "$PAGE_DIR" diff -- index.html || true
    echo "    Now commit and push the abakum.github.io repo manually."
  fi
}

write_page_url() {
  local url="$1"
  write_page_var FUNCTION_URL "$url"
  commit_page
}

write_push_url() {
  local url="$1"
  write_page_var PUSH_URL "$url"
  commit_page
}

bootstrap() {
  info "Bucket $BUCKET and CORS"
  if ! yc storage bucket get --name "$BUCKET" >/dev/null 2>&1; then
    yc storage bucket create --name "$BUCKET" --default-storage-class standard --max-size "$MAX_SIZE_BYTES"
  fi
  yc storage bucket update --name "$BUCKET" --max-size "$MAX_SIZE_BYTES" --remove-cors >/dev/null
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

  bootstrap_push
}

bootstrap_push() {
  if [ -z "${VAPID_PRIVATE:-}" ] && [ ! -f "$(dirname "$0")/.vapid.env" ]; then
    info "VAPID keys not set — skipping $FN_PUSH_NAME bootstrap (run ./vapid-keygen.sh once, then rerun deploy)"
    return
  fi
  ensure_vapid_keys
  info "Function $FN_PUSH_NAME"
  yc serverless function create "$FN_PUSH_NAME" || true
  deploy_push_version
  ensure_timer_trigger
  local url; url="$(push_function_url)"
  write_push_url "$url"
  write_page_var PUSH_PUBLIC_KEY "$VAPID_PUBLIC"
  commit_page
  info "Done. Push function URL: $url"
}

deploy() {
  ensure_vapid_keys
  rotate_key
  deploy_version
  local url; url="$(function_url)"
  smoke_test "$url"
  write_page_url "$url"
  info "Done. Function URL: $url"

  deploy_push_version
  ensure_timer_trigger
  local purl; purl="$(push_function_url)"
  write_push_url "$purl"
  write_page_var PUSH_PUBLIC_KEY "$VAPID_PUBLIC"
  commit_page
  info "Done. Push function URL: $purl"
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
