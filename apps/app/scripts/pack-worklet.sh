#!/usr/bin/env bash
# Packs the worklet (worklet/main.js) into one bare-pack bundle for every
# mobile host, with addons referenced as linked: (scripts/link-addons.sh puts
# the binaries in the app). Output: assets/worklet/main.bundle.js, a CommonJS
# module exporting the bundle text (bare-pack format bundle.cjs), imported by
# src/client/native.js and passed to Worklet#start('/app.bundle', text).
# The output is outside worklet/ so Metro's blockList (worklet/*.js) never
# hides it. Then fails if the bundle could reach a Node built-in.
# Run from anywhere: npm run pack:worklet -w apps/app
set -euo pipefail

cd "$(dirname "$0")/.."

out="assets/worklet/main.bundle.js"
mkdir -p "$(dirname "$out")"
# --base is the repo root, so bundle paths are /apps/app/... and
# /node_modules/... (with apps/app as base, the hoisted modules would sit
# at /../../node_modules).
../../node_modules/.bin/bare-pack \
  --base ../.. \
  --linked \
  --host ios-arm64 \
  --host ios-arm64-simulator \
  --host ios-x64-simulator \
  --host android-arm64 \
  --host android-x64 \
  --format bundle.cjs \
  --out "$out" \
  worklet/main.js
node scripts/check-bundle.js "$out"
