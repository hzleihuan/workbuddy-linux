#!/bin/bash
# App metadata helpers for the one-shot pipeline (scripts/pipeline.sh).
#
# 与 install.sh 里的 write_icon / write_build_metadata / write_version 同源，
# 但只做「打包脚本真正会读的那几件事」：
#   .workbuddy-linux/workbuddy.png       → build-deb.sh 的桌面图标
#   .workbuddy-linux/version             → 供人工核对
#   .workbuddy-linux/build-info.json     → common.sh:resolve_package_version()
#   start.sh                             → build-deb.sh 的入口存在性检查
#
# install.sh 保留自己那一份完整实现（含桌面项注册、本地 Web UI 等），
# 这里刻意不复用它，避免为了复用去改动已经验证过的老路径。

# write_desktop_icon <app_bundle> <install_dir>
write_desktop_icon() {
    local app_bundle="$1"
    local install_dir="$2"
    local icon_source="$app_bundle/Contents/Resources/icon.icns"
    local icon_target="$install_dir/.workbuddy-linux/workbuddy.png"
    local icon_tmp

    mkdir -p "$install_dir/.workbuddy-linux"

    if [ -f "$icon_target" ]; then
        return 0
    fi

    # 优先用随包的 Linux 托盘图标（512x512，已是 PNG，无需转换）
    local tray_png="$install_dir/resources/tray-linux@2x.png"
    if [ -f "$tray_png" ]; then
        cp "$tray_png" "$icon_target"
        return 0
    fi

    if [ ! -f "$icon_source" ]; then
        local alt_icon="$app_bundle/Contents/Resources/app.asar.unpacked/resources/icon.png"
        if [ -f "$alt_icon" ]; then
            cp "$alt_icon" "$icon_target"
            return 0
        fi
        warn "未找到应用图标，桌面项将回退到主题图标名"
        return 0
    fi

    icon_tmp="$(mktemp -d)"

    if command -v magick >/dev/null 2>&1; then
        magick "$icon_source" "$icon_target" >/dev/null 2>&1 && { rm -rf "$icon_tmp"; return 0; }
    elif command -v convert >/dev/null 2>&1; then
        convert "$icon_source" "$icon_target" >/dev/null 2>&1 && { rm -rf "$icon_tmp"; return 0; }
    fi

    # ICNS 内部的 256/512 条目就是裸 PNG，按签名直接抠出来，免装图像库。
    if python3 - "$icon_source" "$icon_target" <<'PY' 2>/dev/null; then
import struct, sys

def extract(icns_path, out_path):
    wanted = [b'ic09', b'ic08', b'ic13', b'ic14', b'ic10', b'ic07']
    with open(icns_path, 'rb') as f:
        if f.read(4) != b'icns':
            return False
        total = struct.unpack('>I', f.read(4))[0]
        found = {}
        while f.tell() < total:
            etype = f.read(4)
            if len(etype) < 4:
                break
            esize = struct.unpack('>I', f.read(4))[0]
            edata = f.read(esize - 8)
            if etype in wanted and edata[:4] == b'\x89PNG':
                found[etype] = edata
        for t in wanted:
            if t in found:
                with open(out_path, 'wb') as o:
                    o.write(found[t])
                return True
    return False

sys.exit(0 if extract(sys.argv[1], sys.argv[2]) else 1)
PY
        rm -rf "$icon_tmp"
        return 0
    fi

    rm -rf "$icon_tmp"
    warn "无法从 .icns 提取 PNG，桌面项将回退到主题图标名"
}

# write_app_metadata <install_dir> <upstream_version> <full_version> <electron_version> <app_id> <display_name>
write_app_metadata() {
    local install_dir="$1"
    local upstream_version="$2"
    local full_version="$3"
    local electron_version="$4"
    local app_id="$5"
    local display_name="$6"

    mkdir -p "$install_dir/.workbuddy-linux"

    echo -n "${full_version:-$upstream_version}" > "$install_dir/.workbuddy-linux/version"

    cat > "$install_dir/.workbuddy-linux/build-info.json" <<EOF
{
  "appId": "$app_id",
  "displayName": "$display_name",
  "upstreamVersion": "${upstream_version}",
  "fullVersion": "${full_version}",
  "electronVersion": "${electron_version}",
  "arch": "$(uname -m)",
  "generatedAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "generator": "scripts/pipeline.sh"
}
EOF
}

# write_start_shim <install_dir>
#
# build-deb/rpm/pacman 都以 <app>/start.sh 为安装包入口，并断言其可执行；
# loong64 路径的真实启动逻辑在转换阶段产出的 workbuddy 启动器里（负责
# NODE_OPTIONS 预载 wb-storage-shim、ozone 提示、loong64 渲染参数），
# 这里只做一层薄转发，不重复实现参数。
write_start_shim() {
    local install_dir="$1"

    cat > "$install_dir/start.sh" <<'EOF'
#!/bin/bash
# 由 scripts/pipeline.sh 生成：把安装包入口转发给转换阶段产出的启动器。
set -euo pipefail
APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec "$APP_DIR/workbuddy" "$@"
EOF
    chmod 0755 "$install_dir/start.sh"
}
