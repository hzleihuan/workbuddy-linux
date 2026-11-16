#!/bin/bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

. "$REPO_DIR/scripts/lib/common.sh"

APP_DIR="${APP_DIR:-$REPO_DIR/workbuddy-app}"
DIST_DIR="${DIST_DIR:-$REPO_DIR/dist}"
PKG_ROOT="${PKG_ROOT:-$DIST_DIR/deb-root}"
PACKAGE_NAME="${PACKAGE_NAME:-workbuddy}"
# 安装目录名与包名解耦：deb 包名必须小写，但要与官方 loong64 包的
# /opt/WorkBuddy 布局保持一致，官方包可原地覆盖升级。
INSTALL_DIRNAME="${INSTALL_DIRNAME:-WorkBuddy}"
PACKAGE_VERSION="${PACKAGE_VERSION:-$(resolve_package_version)}"
DESKTOP_TEMPLATE="$REPO_DIR/packaging/linux/workbuddy.desktop"
CONTROL_TEMPLATE="$REPO_DIR/packaging/linux/control"

map_arch() {
    case "$(dpkg --print-architecture)" in
        amd64|arm64|armhf|loong64|loongarch64) dpkg --print-architecture ;;
        *) error "Unsupported Debian architecture: $(dpkg --print-architecture)" ;;
    esac
}

main() {
    [ -x "$APP_DIR/start.sh" ] || error "Missing generated app. Run ./install.sh first."
    require_cmd dpkg
    require_cmd dpkg-deb

    local arch output_file
    arch="$(map_arch)"
    output_file="$DIST_DIR/${PACKAGE_NAME}_${PACKAGE_VERSION}_${arch}.deb"

    rm -rf "$PKG_ROOT"
    mkdir -p \
        "$PKG_ROOT/DEBIAN" \
        "$PKG_ROOT/opt/$INSTALL_DIRNAME" \
        "$PKG_ROOT/usr/bin" \
        "$PKG_ROOT/usr/share/applications" \
        "$PKG_ROOT/usr/share/icons/hicolor/256x256/apps"

    cp -a "$APP_DIR/." "$PKG_ROOT/opt/$INSTALL_DIRNAME/"
    sanitize_package_tree "$PKG_ROOT"

    # cp -a 会原样保留源权限；源树中形如 744 的可执行文件（safe-bin/rm、
    # brokered-bin/zip、内置插件脚本等）装到系统后普通用户无权执行，
    # 这里统一补上组/其他执行位。chrome-sandbox 稍后单独设为 4755。
    find "$PKG_ROOT/opt/$INSTALL_DIRNAME" -type f -perm -u+x ! -perm -o+x \
        -exec chmod 0755 {} + 2>/dev/null || true

    # Set SUID bit on chrome-sandbox so Chromium can spawn child processes
    if [ -f "$PKG_ROOT/opt/$INSTALL_DIRNAME/chrome-sandbox" ]; then
        chmod 4755 "$PKG_ROOT/opt/$INSTALL_DIRNAME/chrome-sandbox"
    fi

    cat > "$PKG_ROOT/usr/bin/$PACKAGE_NAME" <<EOF
#!/bin/bash
exec /opt/$INSTALL_DIRNAME/start.sh "\$@"
EOF
    chmod 0755 "$PKG_ROOT/usr/bin/$PACKAGE_NAME"

    sed -e "s|__EXEC__|/opt/$INSTALL_DIRNAME/start.sh %F|g" "$DESKTOP_TEMPLATE" \
        > "$PKG_ROOT/usr/share/applications/$PACKAGE_NAME.desktop"
    chmod 0644 "$PKG_ROOT/usr/share/applications/$PACKAGE_NAME.desktop"

    if [ -f "$APP_DIR/.workbuddy-linux/workbuddy.png" ]; then
        cp "$APP_DIR/.workbuddy-linux/workbuddy.png" \
            "$PKG_ROOT/usr/share/icons/hicolor/256x256/apps/workbuddy.png"
        chmod 0644 "$PKG_ROOT/usr/share/icons/hicolor/256x256/apps/workbuddy.png"
    fi

    sed \
        -e "s/__PACKAGE_NAME__/$PACKAGE_NAME/g" \
        -e "s/__VERSION__/$PACKAGE_VERSION/g" \
        -e "s/__ARCH__/$arch/g" \
        "$CONTROL_TEMPLATE" > "$PKG_ROOT/DEBIAN/control"
    chmod 0644 "$PKG_ROOT/DEBIAN/control"

    # postinst — refresh desktop database and icon cache so
    # the start-menu entry appears immediately after install
    cat > "$PKG_ROOT/DEBIAN/postinst" <<'MAINTAINER_SCRIPT'
#!/bin/bash
set -e
if command -v update-desktop-database >/dev/null 2>&1; then
    update-desktop-database -q /usr/share/applications || true
fi
if command -v gtk-update-icon-cache >/dev/null 2>&1; then
    gtk-update-icon-cache -q -t -f /usr/share/icons/hicolor || true
fi
MAINTAINER_SCRIPT
    chmod 0755 "$PKG_ROOT/DEBIAN/postinst"

    # postrm — refresh desktop database after uninstall
    cat > "$PKG_ROOT/DEBIAN/postrm" <<'MAINTAINER_SCRIPT'
#!/bin/bash
set -e
if [ "$1" = "remove" ] || [ "$1" = "purge" ]; then
    if command -v update-desktop-database >/dev/null 2>&1; then
        update-desktop-database -q /usr/share/applications || true
    fi
fi
MAINTAINER_SCRIPT
    chmod 0755 "$PKG_ROOT/DEBIAN/postrm"

    mkdir -p "$DIST_DIR"
    dpkg-deb --root-owner-group --build "$PKG_ROOT" "$output_file" >&2
    info "Built package: $output_file"
}

main "$@"
