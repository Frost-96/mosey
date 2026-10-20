#!/bin/sh
set -eu
source_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
app_path=${1:-/tmp/MoseyDockLiveProbe.app}
case "$app_path" in /*.app) ;; *) echo 'Provide an absolute new .app output path' >&2; exit 64;; esac
if [ -e "$app_path" ]; then echo 'Refusing to replace an existing app/TCC identity; choose a new path intentionally.' >&2; exit 73; fi
if [ "$(uname -m)" != arm64 ]; then echo 'This research app targets Apple Silicon only.' >&2; exit 65; fi
mkdir -p "$app_path/Contents/MacOS"
swiftc -O -target arm64-apple-macos15.0 -parse-as-library -module-cache-path "${TMPDIR:-/tmp}/mosey-dock-live-module-cache" "$source_dir/dock-live.swift" -o "$app_path/Contents/MacOS/dock-live"
cat > "$app_path/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>local.mosey.dockliveprobe.experimental</string>
<key>CFBundleExecutable</key><string>dock-live</string>
<key>CFBundleName</key><string>Mosey Dock Live Probe</string>
<key>CFBundleDisplayName</key><string>Mosey Dock Live Probe</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleVersion</key><string>1</string>
<key>CFBundleShortVersionString</key><string>0.1</string>
<key>LSMinimumSystemVersion</key><string>15.0</string>
<key>NSHighResolutionCapable</key><true/>
<key>NSPrincipalClass</key><string>NSApplication</string>
<key>NSScreenCaptureUsageDescription</key><string>Inspect local isolated Dock alpha statistics for an explicit geometry experiment. No pixels are saved or uploaded.</string>
</dict></plist>
PLIST
codesign --force --sign - --identifier local.mosey.dockliveprobe.experimental "$app_path"
codesign --verify --strict "$app_path"
codesign -dvvv "$app_path" 2> "${app_path%.app}-signing.txt"
printf '%s\n' "$app_path"
