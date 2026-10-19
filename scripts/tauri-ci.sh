#!/usr/bin/env bash
# Runs the Tauri CLI for CI and, after a Linux build, strips the libwayland
# copies linuxdeploy bundles into the AppImage.
#
# Those libraries come from the build runner and are older than the Mesa EGL
# drivers on rolling distros (Arch, Fedora, ...). Loading them makes WebKitGTK
# abort on Wayland with "Could not create default EGL display:
# EGL_BAD_PARAMETER". libwayland keeps a stable ABI, so the host's copy is
# always the right one to use.
#
# tauri-action calls this as `bash scripts/tauri-ci.sh build <args>`.
set -euo pipefail

APPIMAGETOOL_VERSION=1.9.1

npx tauri "$@"

if [[ "${1:-}" != "build" || "$(uname -s)" != "Linux" ]]; then
  exit 0
fi

mapfile -t appimages < <(find src-tauri/target -path '*/release/bundle/appimage/*.AppImage' -type f)
if [[ ${#appimages[@]} -eq 0 ]]; then
  echo "tauri-ci: no AppImage produced, nothing to patch"
  exit 0
fi

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

appimagetool="$work/appimagetool"
curl -fsSL -o "$appimagetool" \
  "https://github.com/AppImage/appimagetool/releases/download/${APPIMAGETOOL_VERSION}/appimagetool-x86_64.AppImage"
chmod +x "$appimagetool"

version="$(node -p "require('./src-tauri/tauri.conf.json').version")"

for appimage in "${appimages[@]}"; do
  appimage="$(realpath "$appimage")"
  echo "tauri-ci: removing bundled libwayland from $appimage"

  rm -rf "$work/squashfs-root"
  chmod +x "$appimage"
  (cd "$work" && "$appimage" --appimage-extract >/dev/null)

  removed="$(find "$work/squashfs-root/usr/lib" -maxdepth 1 -name 'libwayland-*' -print -delete)"
  if [[ -z "$removed" ]]; then
    echo "tauri-ci: no bundled libwayland found, leaving AppImage as built"
    continue
  fi
  echo "$removed"

  ARCH=x86_64 APPIMAGE_EXTRACT_AND_RUN=1 "$appimagetool" --no-appstream \
    "$work/squashfs-root" "$appimage"

  # The updater verifies this signature, so it must match the repacked file.
  if [[ -f "$appimage.sig" ]]; then
    rm "$appimage.sig"
    npx tauri signer sign --app-version "$version" "$appimage"
  fi
done
