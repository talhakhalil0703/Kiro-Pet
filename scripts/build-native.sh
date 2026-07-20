#!/usr/bin/env bash
set -euo pipefail

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "The native overlay helper currently builds on macOS only." >&2
  exit 1
fi

mkdir -p bin
mkdir -p "${TMPDIR:-/tmp}/kiro-pet-swift-module-cache"
xcrun swiftc \
  -module-cache-path "${TMPDIR:-/tmp}/kiro-pet-swift-module-cache" \
  -O \
  -framework AppKit \
  -framework WebKit \
  native/macos/KiroPetOverlay.swift \
  -o bin/kiro-pet-overlay
codesign --force --sign - bin/kiro-pet-overlay
