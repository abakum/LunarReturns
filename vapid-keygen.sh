#!/usr/bin/env bash
# Generate the VAPID key pair ONCE, locally, before the first CI deploy:
#   - VAPID_PRIVATE / VAPID_PUBLIC -> GitHub Secrets (abakum/LunarReturns)
#   - .vapid.env (chmod 600, gitignored)  -> the ONLY backup of the private key
#   - vapid_public.txt                     -> committed to the repo
# Regeneration (--force) invalidates ALL existing push subscriptions.
# Usage: ./vapid-keygen.sh [--force] [--show-private]
set -euo pipefail

REPO=abakum/LunarReturns
PUB_FILE="$(cd "$(dirname "$0")" && pwd)/vapid_public.txt"
ENV_FILE="$(cd "$(dirname "$0")" && pwd)/.vapid.env"
FORCE=0
SHOW_PRIVATE=0
for arg in "$@"; do
  case "$arg" in
    --force) FORCE=1 ;;
    --show-private) SHOW_PRIVATE=1 ;;
    *) echo "usage: $0 [--force] [--show-private]" >&2; exit 1 ;;
  esac
done

die() { echo "ERROR: $*" >&2; exit 1; }
info() { echo "==> $*"; }

for cmd in gh git openssl python3 basenc; do
  command -v "$cmd" >/dev/null || die "$cmd not found; install it with your package manager and retry"
done
gh auth status >/dev/null 2>&1 || die "gh is not authenticated; run: gh auth login"

if [ "$FORCE" -eq 0 ]; then
  [ -f "$PUB_FILE" ] && die "$PUB_FILE already exists; use --force to regenerate (ALL push subscriptions will be lost)"
  if gh secret list -R "$REPO" --json name --jq '.[].name' 2>/dev/null | grep -qx VAPID_PRIVATE; then
    die "secret VAPID_PRIVATE already exists in $REPO; use --force to regenerate (ALL push subscriptions will be lost)"
  fi
else
  info "FORCED regeneration: the old key pair is discarded, all push subscriptions will be lost"
fi

info "Generating EC P-256 key pair"
PEM="$(mktemp "${TMPDIR:-/tmp}/vapid.XXXXXX.pem")"
trap 'rm -f "$PEM"' EXIT
openssl ecparam -name prime256v1 -genkey -noout -out "$PEM"

VAPID_PRIVATE="$(openssl ec -in "$PEM" -text -noout 2>/dev/null | awk '/priv:/{f=1;next} /pub:/{f=0} f' \
  | tr -d ' :\n' | python3 -c 'import sys,base64; print(base64.urlsafe_b64encode(bytes.fromhex(sys.stdin.read().strip())).decode().rstrip("="))')"
VAPID_PUBLIC="$(openssl ec -in "$PEM" -pubout -outform DER 2>/dev/null | tail -c 65 | basenc --base64url | tr -d '=')"
[ "${#VAPID_PRIVATE}" -eq 43 ] || die "failed to derive the private key (got ${#VAPID_PRIVATE} chars, want 43)"
[ "${#VAPID_PUBLIC}" -eq 88 ] || die "failed to derive the public key (got ${#VAPID_PUBLIC} chars, want 88)"

info "Writing $ENV_FILE (chmod 600) — the ONLY backup of the private key"
printf 'export VAPID_PRIVATE=%s\nexport VAPID_PUBLIC=%s\n' "$VAPID_PRIVATE" "$VAPID_PUBLIC" > "$ENV_FILE"
chmod 600 "$ENV_FILE"
GITIGNORE="$(cd "$(dirname "$0")" && pwd)/.gitignore"
grep -qx '.vapid.env' "$GITIGNORE" 2>/dev/null || printf '.vapid.env\n' >> "$GITIGNORE"

info "Saving VAPID_PRIVATE/VAPID_PUBLIC to GitHub Secrets ($REPO)"
printf '%s' "$VAPID_PRIVATE" | gh secret set VAPID_PRIVATE -R "$REPO"
printf '%s' "$VAPID_PUBLIC" | gh secret set VAPID_PUBLIC -R "$REPO"

info "Committing vapid_public.txt"
printf '%s' "$VAPID_PUBLIC" > "$PUB_FILE"
git -C "$(dirname "$0")" add "$PUB_FILE" .gitignore
git -C "$(dirname "$0")" commit -m "chore: add VAPID public key" >/dev/null
git -C "$(dirname "$0")" push

info "Done. Public key: $VAPID_PUBLIC"
if [ "$SHOW_PRIVATE" -eq 1 ]; then
  echo "    VAPID_PRIVATE=$VAPID_PRIVATE"
  echo "    Save it in your password manager; it is also in $ENV_FILE."
else
  echo "    Private key is in $ENV_FILE; rerun with --show-private to print it."
fi
