#!/bin/bash
# Linux Electron runtime download. Sourced by install.sh.

electron_arch() {
    case "$ARCH" in
        x86_64) echo "x64" ;;
        aarch64) echo "arm64" ;;
        armv7l) echo "armv7l" ;;
        loongarch64) echo "loong64" ;;
        *) error "Unsupported architecture: $ARCH" ;;
    esac
}

# Parse Electron version from a path like:
#   /path/to/electron-v37.2.5-linux-loong64.zip  -> 37.2.5
#   /path/to/electron-v41.1.1-linux-x64.zip      -> 41.1.1
parse_electron_version_from_path() {
    local path="$1"
    local basename
    basename="$(basename "$path")"
    # Match electron-v<semver>-... pattern
    if [[ "$basename" =~ ^electron-v([0-9]+(\.[0-9]+){1,2})- ]]; then
        echo "${BASH_REMATCH[1]}"
        return 0
    fi
    return 1
}

download_electron_runtime() {
    local arch zip_name url cache_dir cached_zip partial_zip lock_dir checksum

    arch="$(electron_arch)"
    zip_name="electron-v${ELECTRON_VERSION}-linux-${arch}.zip"

    # If ELECTRON_LOCAL_ZIP is set, use the local file directly instead of
    # downloading. This is essential for architectures without official
    # Electron binaries (e.g. loongarch64) where users build or obtain
    # Electron from community sources.
    if [ -n "${ELECTRON_LOCAL_ZIP:-}" ]; then
        if [ ! -f "$ELECTRON_LOCAL_ZIP" ]; then
            error "ELECTRON_LOCAL_ZIP is set but file not found: $ELECTRON_LOCAL_ZIP"
        fi
        info "Using local Electron runtime: $ELECTRON_LOCAL_ZIP"

        # Detect Electron version from the local zip filename so that
        # subsequent native module rebuilds use matching ABI headers.
        local detected_version
        detected_version="$(parse_electron_version_from_path "$ELECTRON_LOCAL_ZIP" || true)"
        if [ -n "${detected_version:-}" ]; then
            ELECTRON_VERSION="$detected_version"
            info "Detected Electron version from local zip: $ELECTRON_VERSION"
        else
            warn "Could not parse version from ELECTRON_LOCAL_ZIP filename; using ELECTRON_VERSION=$ELECTRON_VERSION"
            warn "If native modules fail to load, set ELECTRON_VERSION to match your local zip."
        fi

        unzip -qo "$ELECTRON_LOCAL_ZIP" -d "$INSTALL_DIR"
        [ -x "$INSTALL_DIR/electron" ] || error "Electron binary was not extracted from local zip"
        return 0
    fi

    if [ -n "$ELECTRON_MIRROR" ]; then
        url="${ELECTRON_MIRROR%/}/v${ELECTRON_VERSION}/${zip_name}"
    else
        url="https://github.com/electron/electron/releases/download/v${ELECTRON_VERSION}/${zip_name}"
    fi

    cache_dir="${WORKBUDDY_ELECTRON_CACHE_DIR:-${XDG_CACHE_HOME:-$HOME/.cache}/workbuddy-linux/electron}"
    cached_zip="$cache_dir/$zip_name"
    partial_zip="$cached_zip.$$.$RANDOM.part"
    lock_dir="$cache_dir/$zip_name.lock"
    checksum="${ELECTRON_ZIP_SHA256:-}"
    mkdir -p "$cache_dir"

    while ! mkdir "$lock_dir" 2>/dev/null; do
        info "Waiting for Electron cache lock: $zip_name"
        sleep 1
    done
    trap "rm -rf '$lock_dir'" RETURN

    if [ ! -f "$cached_zip" ]; then
        info "Downloading $zip_name"
        curl -L --fail --progress-bar -o "$partial_zip" "$url"
        if [ -n "$checksum" ]; then
            printf '%s  %s\n' "$checksum" "$partial_zip" | sha256sum -c - >/dev/null || error "Electron runtime checksum mismatch: $zip_name"
        fi
        mv "$partial_zip" "$cached_zip"
    else
        info "Using cached Electron runtime: $cached_zip"
    fi

    if [ -n "$checksum" ]; then
        printf '%s  %s\n' "$checksum" "$cached_zip" | sha256sum -c - >/dev/null || error "Cached Electron runtime checksum mismatch: $zip_name"
    fi

    unzip -qo "$cached_zip" -d "$INSTALL_DIR"
    [ -x "$INSTALL_DIR/electron" ] || error "Electron binary was not extracted"
    rm -rf "$lock_dir"
    trap - RETURN
}

# Parse the Electron version out of a local zip file path of the form
# electron-vX.Y.Z-linux-<arch>.zip. Returns the version on stdout, or nothing
# if the pattern does not match.
parse_electron_version_from_path() {
    local path="$1"
    case "$path" in
        *electron-v[0-9]*\.*[0-9]*\.*[0-9]*-linux-*.zip)
            local v="${path#*electron-v}"
            v="${v%%-linux-*}"
            echo "$v"
            ;;
    esac
}
