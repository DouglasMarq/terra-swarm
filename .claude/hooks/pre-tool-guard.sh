#!/usr/bin/env bash
# Blocks Write/Edit on protected files (.env files, lock files, generated Tauri schemas, tsc output of vite.config.ts and build output).
# Requires jq.

jq --version >/dev/null 2>&1 || { echo >&2 "jq is required but not installed. Aborting."; exit 2; }

FILE_PATH=$(jq -r '.tool_input.file_path // empty')

case "$FILE_PATH" in
  *.env.example) ;;
  .env | .env.* | */.env | */.env.* | *package-lock.json | *Cargo.lock | \
  */src-tauri/gen/* | src-tauri/gen/* | */src-tauri/target/* | src-tauri/target/* | \
  */dist/* | dist/* | *.tsbuildinfo | *vite.config.js | *vite.config.d.ts )
    echo "BLOCK: Protected file — .env, lock files (npm install / cargo update) and generated Tauri schemas or build output must not be edited by Claude" >&2
    exit 2
    ;;
esac
exit 0
