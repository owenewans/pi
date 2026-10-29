#!/usr/bin/env bash
# builds Linux binaries and tar archives, including runtime assets.
# usage: ./scripts/build-binaries.sh [--skip-install] [--skip-build] [--offline-model-data] [--platform linux-x64|linux-arm64] [--out dir]
set -euo pipefail

cd "$(dirname "$0")/.."

SKIP_INSTALL=false
SKIP_BUILD=false
OFFLINE_MODEL_DATA=false
PLATFORM=""
OUTPUT_DIR="packages/coding-agent/binaries"

while [[ $# -gt 0 ]]; do
    case "$1" in
        --skip-install) SKIP_INSTALL=true; shift ;;
        --skip-build) SKIP_BUILD=true; shift ;;
        --offline-model-data) OFFLINE_MODEL_DATA=true; shift ;;
        --platform) PLATFORM="${2:?missing platform}"; shift 2 ;;
        --out) OUTPUT_DIR="${2:?missing output directory}"; shift 2 ;;
        *) printf 'Unknown option: %s\n' "$1" >&2; exit 1 ;;
    esac
done

case "$PLATFORM" in
    ""|linux-x64|linux-arm64) ;;
    *) printf 'Invalid platform: %s; expected linux-x64 or linux-arm64\n' "$PLATFORM" >&2; exit 1 ;;
esac

if [[ "$OUTPUT_DIR" != /* ]]; then
    OUTPUT_DIR="$PWD/$OUTPUT_DIR"
fi

if [[ "$SKIP_INSTALL" == false ]]; then
    npm ci --ignore-scripts
fi

if [[ "$SKIP_BUILD" == false ]]; then
    if [[ "$OFFLINE_MODEL_DATA" == true ]]; then
        npm run build:offline
    else
        npm run build
    fi
fi

PLATFORMS=(linux-x64 linux-arm64)
if [[ -n "$PLATFORM" ]]; then
    PLATFORMS=("$PLATFORM")
fi

cd packages/coding-agent
mkdir -p "$OUTPUT_DIR"

for platform in "${PLATFORMS[@]}"; do
    printf 'Building %s\n' "$platform"
    target="bun-$platform"
    if [[ "$platform" == linux-x64 ]]; then
        target="${target}-baseline"
    fi
    output="$OUTPUT_DIR/$platform"
    rm -rf -- "$output"
    mkdir -p "$output"

    # workers need explicit entrypoints; never autoload project preloads or .env.
    bun build --compile --no-compile-autoload-bunfig --no-compile-autoload-dotenv \
        --external canvas --external 'chromium-bidi/*' \
        --target="$target" ./dist/bun/cli.js ./src/utils/image-resize-worker.ts \
        ./src/extensions/codemode/worker.ts --outfile "$output/pi"

    cp package.json ../../license "$output/"
    cp ../../node_modules/@silvia-odwyer/photon-node/photon_rs_bg.wasm "$output/"
    cp "../../node_modules/@ast-grep/cli-${platform}-gnu/ast-grep" "$output/ast-grep"
    mkdir -p "$output/theme" "$output/assets" "$output/scripts"
    cp scripts/telegram-service.py "$output/scripts/"
    cp dist/modes/interactive/theme/*.json "$output/theme/"
    cp dist/modes/interactive/assets/* "$output/assets/"
    cp -r dist/core/export-html docs examples skills "$output/"

    native_path="native/linux/prebuilds"
    mkdir -p "$output/$native_path"
    cp -R "../tui/$native_path/$platform" "$output/$native_path/"

    # keep the archive wrapper without moving or deleting unrelated output paths.
    tar -C "$OUTPUT_DIR" --transform="s,^$platform,pi," -czf "$OUTPUT_DIR/pi-$platform.tar.gz" "$platform"
    printf 'Archive: %s/pi-%s.tar.gz\nBinary: %s/pi\n' "$OUTPUT_DIR" "$platform" "$output"
done
