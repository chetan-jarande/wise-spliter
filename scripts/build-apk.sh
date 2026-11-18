#!/usr/bin/env bash
set -euo pipefail

# Wise-Spliter One-Command Android APK Builder (`scripts/build-apk.sh`)
# 1. Generates PWA + Android launcher mipmaps
# 2. Compiles production Vite bundle (`dist/`)
# 3. Syncs `dist/` & Capacitor plugins into `android/`
# 4. Builds installable APK via local Android SDK (if installed) or Docker (`Dockerfile.android`)
# 5. Outputs `releases/wise-spliter.apk` with size & SHA-256 verification

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

# Release builds must talk to a public HTTPS API; a cleartext or LAN URL would ship a broken or sniffable app.
if [ "${APK_RELEASE:-0}" = "1" ]; then
  API_URL="${VITE_API_BASE_URL:-}"
  API_HOST="$(printf '%s' "$API_URL" | sed -E 's#^[a-zA-Z]+://(\[[^]]*\]|[^/:]*).*#\1#' | tr 'A-Z' 'a-z')"
  if [[ "$API_URL" != https://* ]]; then
    echo "ERROR: apk-prod needs an https:// VITE_API_BASE_URL (got '${API_URL:-<empty>}')." >&2
    exit 2
  fi
  if [[ -z "$API_HOST" || "$API_HOST" == "localhost" || "$API_HOST" == *.localhost || "$API_HOST" == *.local \
     || "$API_HOST" == "0.0.0.0" || "$API_HOST" == "[::1]" || "$API_HOST" =~ ^127\. || "$API_HOST" =~ ^10\. \
     || "$API_HOST" =~ ^192\.168\. || "$API_HOST" =~ ^172\.(1[6-9]|2[0-9]|3[01])\. || "$API_HOST" =~ ^169\.254\. \
     || "$API_HOST" == "host.docker.internal" ]]; then
    echo "ERROR: apk-prod VITE_API_BASE_URL points at a loopback or LAN host ($API_HOST)." >&2
    exit 2
  fi
fi

OUTPUT_DIR="$REPO_ROOT/releases"
OUTPUT_APK="$OUTPUT_DIR/wise-spliter.apk"
BUILDER_IMAGE="wise-spliter-android-builder:sdk36"
GRADLE_CACHE_VOL="wise_spliter_gradle_cache"

echo "========================================================================"
echo " [1/4] Generating Wise-Spliter App Icons & Building Web Bundle (dist/)"
echo "========================================================================"
node scripts/generate-app-icons.mjs
bun run build

echo ""
echo "========================================================================"
echo " [2/4] Syncing Web Assets & Capacitor Plugins to android/"
echo "========================================================================"
bunx cap sync android

echo ""
echo "========================================================================"
echo " [3/4] Compiling Android APK (SDK 36 / JDK 21)"
echo "========================================================================"
if command -v java >/dev/null 2>&1 && { [ -n "${ANDROID_HOME:-}" ] || [ -n "${ANDROID_SDK_ROOT:-}" ]; }; then
  echo "[build-apk] Using host JDK + Android SDK (${ANDROID_HOME:-${ANDROID_SDK_ROOT}})"
  (cd android && chmod +x gradlew && ./gradlew assembleDebug --no-daemon)
else
  echo "[build-apk] Host Android SDK/JDK not detected -> building inside Docker ($BUILDER_IMAGE)"
  if ! docker image inspect "$BUILDER_IMAGE" >/dev/null 2>&1; then
    echo "[build-apk] Building cached Android SDK 36 Docker toolchain (one-time setup)..."
    docker build -t "$BUILDER_IMAGE" -f Dockerfile.android .
  fi

  # Mount the repo root so Gradle resolves ../node_modules/@capacitor/* relative paths cleanly
  docker run --rm \
    -v "$REPO_ROOT:/workspace" \
    -v "$GRADLE_CACHE_VOL:/root/.gradle" \
    -w /workspace/android \
    "$BUILDER_IMAGE" \
    bash -c "trap 'chown -R $(id -u):$(id -g) /workspace/android /workspace/node_modules/@capacitor 2>/dev/null || true' EXIT && chmod +x ./gradlew && ./gradlew assembleDebug --no-daemon"
fi

BUILT_APK="$REPO_ROOT/android/app/build/outputs/apk/debug/app-debug.apk"
if [ ! -f "$BUILT_APK" ]; then
  echo "ERROR: Expected APK not found at $BUILT_APK" >&2
  exit 1
fi

mkdir -p "$OUTPUT_DIR"
cp "$BUILT_APK" "$OUTPUT_APK"

echo ""
echo "========================================================================"
echo " [4/4] Verifying Installable APK Bundle"
echo "========================================================================"
APK_SIZE_HUMAN="$(du -h "$OUTPUT_APK" | cut -f1)"
APK_SHA256="$(sha256sum "$OUTPUT_APK" | awk '{print $1}')"

echo "  APK Output : $OUTPUT_APK"
echo "  File Size  : $APK_SIZE_HUMAN"
echo "  SHA-256    : $APK_SHA256"
echo ""
echo "  Install via USB/ADB : adb install -r releases/wise-spliter.apk"
echo "  Or copy releases/wise-spliter.apk to your Android phone and tap to install."
echo "========================================================================"
