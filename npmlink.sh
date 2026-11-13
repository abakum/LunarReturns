#!/usr/bin/env bash
set -euo pipefail

repo_dir="$(dirname -- "$(readlink -f -- "${BASH_SOURCE[0]}")")"
prefix="$HOME/.local"

cd -- "$repo_dir"
npm_config_prefix="$prefix" npm link

case ":$PATH:" in
    *":$prefix/bin:"*) ;;
    *)
        printf '\nAdd this line to ~/.bashrc and run it in your current shell:\n'
        printf 'export PATH="$HOME/.local/bin:$PATH"\n'
        ;;
esac
