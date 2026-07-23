# WorkBuddy Linux AppImage 构建指南

本文档记录了在无 root 权限的 Ubuntu 24.04 容器环境中，从零构建 WorkBuddy Linux x86_64 AppImage 的完整流程。

---

## 环境要求

- **系统**: Ubuntu 24.04 (Noble Numbat) x86_64
- **权限**: 无 root、无 sudo
- **已有工具**: node (v22+), npm, npx, python3, curl, make, g++, ar, tar, xz, dpkg-deb

## 构建产物

- `dist/WorkBuddy-<version>-x86_64.AppImage` (~212MB)

---

## 第一步：克隆仓库

```bash
cd /home/work/.openclaw/workspace
git clone https://github.com/YB-YB/workbuddy-linux.git
cd workbuddy-linux
```

## 第二步：下载官方 DMG

通过 WorkBuddy 官网 API 获取最新版本 DMG 下载地址：

```bash
# 查询最新版本信息
curl -sL "https://www.codebuddy.cn/v2/update?platform=workbuddy-darwin-x64"
# 返回 JSON 中的 url 字段为 .zip，将后缀改为 .dmg 即为 DMG 下载地址

mkdir -p downloads
curl -L -o "downloads/WorkBuddy-darwin-x64-5.2.3.dmg" \
  "https://download.codebuddy.cn/workbuddy/saas/darwin-x64/WorkBuddy-darwin-x64-5.2.3.32357678-3865830d.dmg"
```

> **版本更新**: 重新查询 API 获取最新 URL，替换文件名和版本号即可。

## 第三步：安装无 root 依赖

由于没有 root 权限，需要手动下载 deb 包并解压到 `.local/` 目录。

### 3.1 基础工具

```bash
mkdir -p .local/bin .local/debs

# 7-Zip (从 7-zip.org 下载独立二进制)
curl -fsSL "https://7-zip.org/a/7z2301-linux-x64.tar.xz" -o /tmp/7z.tar.xz
tar xf /tmp/7z.tar.xz -C .local/bin/
chmod +x .local/bin/7zz

# unzip (从 Ubuntu 归档下载)
curl -fsSL "http://mirrors.kernel.org/ubuntu/pool/main/u/unzip/unzip_6.0-28ubuntu4.1_amd64.deb" \
  -o .local/debs/unzip.deb
dpkg-deb -x .local/debs/unzip.deb .local/
cp .local/usr/bin/unzip .local/bin/unzip
chmod +x .local/bin/unzip

# pkg-config
curl -fsSL "http://mirrors.kernel.org/ubuntu/pool/main/p/pkgconf/pkg-config_1.8.1-2build1_amd64.deb" \
  -o .local/debs/pkg-config.deb
dpkg-deb -x .local/debs/pkg-config.deb .local/
ln -sf ../usr/bin/pkg-config .local/bin/pkg-config
```

### 3.2 开发库头文件（用于原生模块编译）

```bash
# 批量下载函数
download_deb() {
    local name="$1" url="$2"
    [ -f ".local/debs/${name}.deb" ] && return 0
    curl -fsSL "$url" -o ".local/debs/${name}.deb" 2>/dev/null && \
    dpkg-deb -x ".local/debs/${name}.deb" .local/ 2>/dev/null && \
    echo "OK: $name" || echo "FAIL: $name"
}

# X11 核心
download_deb "x11proto-dev" "http://mirrors.kernel.org/ubuntu/pool/main/x/xorgproto/x11proto-dev_2023.2-1_all.deb"
download_deb "libx11-6" "http://ftp.osuosl.org/pub/ubuntu/pool/main/libx/libx11/libx11-6_1.8.7-1build1_amd64.deb"
download_deb "libx11-dev" "http://ftp.osuosl.org/pub/ubuntu/pool/main/libx/libx11/libx11-dev_1.8.7-1build1_amd64.deb"
download_deb "libxau6" "http://ftp.osuosl.org/pub/ubuntu/pool/main/libx/libxau/libxau6_1.0.11-1build1_amd64.deb"
download_deb "libxau-dev" "http://ftp.osuosl.org/pub/ubuntu/pool/main/libx/libxau/libxau-dev_1.0.11-1build1_amd64.deb"
download_deb "libxdmcp6" "http://mirrors.kernel.org/ubuntu/pool/main/libx/libxdmcp/libxdmcp6_1.1.5-1_amd64.deb"
download_deb "libxdmcp-dev" "http://mirrors.kernel.org/ubuntu/pool/main/libx/libxdmcp/libxdmcp-dev_1.1.5-1_amd64.deb"
download_deb "xtrans-dev" "http://mirrors.kernel.org/ubuntu/pool/main/x/xtrans/xtrans-dev_1.4.0-1_all.deb"
download_deb "libxcb1" "http://mirrors.kernel.org/ubuntu/pool/main/libx/libxcb/libxcb1_1.15-1ubuntu2_amd64.deb"
download_deb "libxcb1-dev" "http://mirrors.kernel.org/ubuntu/pool/main/libx/libxcb/libxcb1-dev_1.15-1ubuntu2_amd64.deb"

# xkbfile
download_deb "libxkbfile1" "http://mirrors.kernel.org/ubuntu/pool/main/libx/libxkbfile/libxkbfile1_1.1.0-1build4_amd64.deb"
download_deb "libxkbfile-dev" "http://mirrors.kernel.org/ubuntu/pool/main/libx/libxkbfile/libxkbfile-dev_1.1.0-1build4_amd64.deb"

# libsecret
download_deb "libsecret-1-dev" "http://mirrors.kernel.org/ubuntu/pool/universe/libs/libsecret/libsecret-1-dev_0.21.4-1build3_amd64.deb"

# GLib (libsecret 依赖)
download_deb "libglib2.0-0t64" "http://mirrors.kernel.org/ubuntu/pool/main/g/glib2.0/libglib2.0-0t64_2.80.0-6ubuntu3.4_amd64.deb"
download_deb "libglib2.0-dev" "http://mirrors.kernel.org/ubuntu/pool/main/g/glib2.0/libglib2.0-dev_2.80.0-6ubuntu3.4_amd64.deb"
download_deb "libpcre2-dev" "http://mirrors.kernel.org/ubuntu/pool/main/p/pcre2/libpcre2-dev_10.42-1ubuntu2.1_amd64.deb"
download_deb "libpcre2-8-0" "http://mirrors.kernel.org/ubuntu/pool/main/p/pcre2/libpcre2-8-0_10.42-1ubuntu2.1_amd64.deb"
download_deb "zlib1g-dev" "http://mirrors.kernel.org/ubuntu/pool/main/z/zlib/zlib1g-dev_1.3.dfsg-3.1ubuntu2.1_amd64.deb"
download_deb "zlib1g" "http://mirrors.kernel.org/ubuntu/pool/main/z/zlib/zlib1g_1.3.dfsg-3.1ubuntu2.1_amd64.deb"

# libffi (glib 依赖)
download_deb "libffi-dev" "http://mirrors.kernel.org/ubuntu/pool/main/libf/libffi/libffi-dev_3.4.6-1build1_amd64.deb"

# Kerberos
download_deb "libkrb5-3" "http://security.ubuntu.com/ubuntu/pool/main/k/krb5/libkrb5-3_1.20.1-6ubuntu2.6_amd64.deb"
download_deb "libkrb5-dev" "http://security.ubuntu.com/ubuntu/pool/main/k/krb5/libkrb5-dev_1.20.1-6ubuntu2.6_amd64.deb"
download_deb "libk5crypto3" "http://security.ubuntu.com/ubuntu/pool/main/k/krb5/libk5crypto3_1.20.1-6ubuntu2.6_amd64.deb"
download_deb "libkrb5support0" "http://security.ubuntu.com/ubuntu/pool/main/k/krb5/libkrb5support0_1.20.1-6ubuntu2.6_amd64.deb"
download_deb "libgssapi-krb5-2" "http://security.ubuntu.com/ubuntu/pool/main/k/krb5/libgssapi-krb5-2_1.20.1-6ubuntu2.6_amd64.deb"

# squashfs-tools (AppImage 构建需要)
download_deb "squashfs-tools" "http://mirrors.kernel.org/ubuntu/pool/main/s/squashfs-tools/squashfs-tools_4.6.1-1build1_amd64.deb"
download_deb "liblzo2-2" "http://mirrors.kernel.org/ubuntu/pool/main/l/lzo2/liblzo2-2_2.10-2build4_amd64.deb"
```

### 3.3 验证 pkg-config

```bash
export PKG_CONFIG_PATH="$(pwd)/.local/usr/lib/x86_64-linux-gnu/pkgconfig:$(pwd)/.local/usr/share/pkgconfig"
pkg-config --exists x11 && echo "x11: OK" || echo "x11: FAIL"
pkg-config --exists xkbfile && echo "xkbfile: OK" || echo "xkbfile: FAIL"
```

## 第四步：修复补丁脚本适配新版本

不同版本的 WorkBuddy 代码结构可能有变化，需要调整 `scripts/lib/apply-linux-patches.js` 中的锚点。

### 4.1 updateRpcDisabled 锚点 (v5.2.3+)

v5.2.3 将 `registerUpdateHandlers(server, deps)` 改为 `registerUpdateHandlers(registry, deps)`，`handleRpc$1` 改为 `handleRpc`。

搜索旧锚点：
```js
const updateRpcMarker = 'function registerUpdateHandlers(server, deps) {';
```

替换为同时兼容新旧版本的逻辑（约第 765-795 行）：
```js
const updateRpcMarkerOld = 'function registerUpdateHandlers(server, deps) {';
const updateRpcMarkerNew = 'function registerUpdateHandlers(registry, deps) {';
let updateRpcIdx = source.indexOf(updateRpcMarkerOld);
let useNewPattern = false;
if (updateRpcIdx < 0) {
    updateRpcIdx = source.indexOf(updateRpcMarkerNew);
    useNewPattern = true;
}
if (updateRpcIdx >= 0) {
    const marker = useNewPattern ? updateRpcMarkerNew : updateRpcMarkerOld;
    const rpcFn = useNewPattern
        ? 'require_workbuddy_auth_product_coordinator.handleRpc(registry,'
        : 'handleRpc$1(server,';
    const linuxRpcShim =
        marker + '\n' +
        '\tif (process.platform === "linux") {\n' +
        '\t\t' + rpcFn + ' "updateCheck", async () => {});\n' +
        // ... 其余 RPC 同理
        '\t}';
    // ...
}
```

### 4.2 networkDiagnosticsTimeouts 改为可选

在 v5.2.3 中，网络诊断代码不存在。将所有 `markRequired('networkDiagnosticsTimeouts', false)` 改为 `markOptional('networkDiagnosticsTimeouts', false)`，并将条件判断 `if (!patchReport.required.networkDiagnosticsTimeouts)` 改为 `if (!patchReport.required.networkDiagnosticsTimeouts && !patchReport.optional?.networkDiagnosticsTimeouts)`。

## 第五步：设置环境变量并构建

```bash
cd /home/work/.openclaw/workspace/workbuddy-linux

export PATH="$(pwd)/.local/bin:$(pwd)/.local/usr/bin:$PATH"
export PKG_CONFIG_PATH="$(pwd)/.local/usr/lib/x86_64-linux-gnu/pkgconfig:$(pwd)/.local/usr/share/pkgconfig"
export CPATH="$(pwd)/.local/usr/include:$(pwd)/.local/usr/include/x86_64-linux-gnu"
export LIBRARY_PATH="$(pwd)/.local/usr/lib/x86_64-linux-gnu:$(pwd)/.local/usr/lib"
export LD_LIBRARY_PATH="$(pwd)/.local/usr/lib/x86_64-linux-gnu:$(pwd)/.local/usr/lib:$(pwd)/.local/lib/x86_64-linux-gnu"

# 使用国内镜像加速 Electron 下载
export ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/"

# 清理可能的残留锁文件
rm -rf ~/.cache/workbuddy-linux/electron/*.lock ~/.cache/workbuddy-linux/electron/*.part

# 执行构建
bash install.sh
```

构建成功标志：
```
[INFO] Build complete: /path/to/workbuddy-app
[INFO] Run: /path/to/workbuddy-app/start.sh
```

## 第六步：打包 AppImage

由于容器环境无 FUSE，appimagetool（本身是 AppImage）无法直接运行。使用 mksquashfs 手动构建：

```bash
export PATH="$(pwd)/.local/bin:$(pwd)/.local/usr/bin:$PATH"
export LD_LIBRARY_PATH="$(pwd)/.local/usr/lib/x86_64-linux-gnu:$(pwd)/.local/usr/lib:$(pwd)/.local/lib/x86_64-linux-gnu"

# 下载 AppImage runtime
curl -fsSL "https://github.com/AppImage/type2-runtime/releases/download/continuous/runtime-x86_64" \
  -o .cache/appimagetool/runtime-x86_64

# 手动构建 AppImage
APPDIR="dist/AppDir"
OUTPUT="dist/WorkBuddy-5.2.3-x86_64.AppImage"
RUNTIME=".cache/appimagetool/runtime-x86_64"

.local/usr/bin/mksquashfs "$APPDIR" "${OUTPUT}.squashfs" \
  -noappend -comp gzip -root-owned -no-xattrs

cat "$RUNTIME" "${OUTPUT}.squashfs" > "$OUTPUT"
chmod +x "$OUTPUT"
rm -f "${OUTPUT}.squashfs"

ls -lh "$OUTPUT"
```

## 第七步：打包 DEB 和 RPM

### 7.1 打包 DEB

deb 包构建只需 `dpkg-deb`（系统自带）：

```bash
bash scripts/build-deb.sh
```

产物：`dist/workbuddy_<version>_amd64.deb`

> 包体约636MB（含 Electron 运行时），压缩耗时约3分钟。

### 7.2 打包 RPM

rpmbuild 在无 root 容器中需要额外处理：

```bash
# 1. 安装 rpmbuild 及其依赖库
for pkg in rpm-common rpm2cpio librpm9t64 librpmio9t64 librpmbuild9t64 \
           libpopt0 liblua5.3-0 libmagic1t64 libarchive13t64 \
           liblzma5 libbz2-1.0 libelf1t64 libdw1t64; do
    url=$(curl -fsSL "http://packages.ubuntu.com/noble/amd64/${pkg}/download" 2>/dev/null \
        | grep -oE 'http[^"]*'${pkg}'[^"]*\.deb' | head -1)
    [ -n "$url" ] && curl -fsSL "$url" -o ".local/debs/${pkg}.deb" 2>/dev/null \
        && dpkg-deb -x ".local/debs/${pkg}.deb" .local/ 2>/dev/null \
        && echo "OK: $pkg" || echo "FAIL: $pkg"
done

# 2. 创建 rpmbuild 包装脚本（绕过硬编码的 /usr/lib/rpm/rpmrc）
REPO_DIR="$(pwd)"
cat > .local/bin/rpmbuild <<WRAPPER
#!/bin/bash
exec ${REPO_DIR}/.local/usr/bin/rpmbuild \\
    --rcfile "${REPO_DIR}/.local/usr/lib/rpm/rpmrc" \\
    "\\$@"
WRAPPER
chmod +x .local/bin/rpmbuild

# 3. 执行构建
export PATH="$(pwd)/.local/bin:$PATH"
export LD_LIBRARY_PATH="$(pwd)/.local/usr/lib/x86_64-linux-gnu:$(pwd)/.local/usr/lib:$(pwd)/.local/lib/x86_64-linux-gnu"
bash scripts/build-rpm.sh
```

产物：`dist/workbuddy-<version>-1.x86_64.rpm`

> rpmbuild 过程中会报大量 `file: not found` 和 `magic_load failed` 警告，因容器缺少 `file` 命令，不影响产物，可忽略。

---

## 第八步：验证

```bash
# 检查文件类型
file dist/WorkBuddy-*-x86_64.AppImage

# 查看构建元数据
cat workbuddy-app/.workbuddy-linux/build-info.json
cat workbuddy-app/.workbuddy-linux/patch-report.json
```

---

## 常见问题

### Q: Electron 下载极慢
设置国内镜像：`export ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/"`

### Q: "Waiting for Electron cache lock" 卡住
```bash
rm -rf ~/.cache/workbuddy-linux/electron/*.lock ~/.cache/workbuddy-linux/electron/*.part
```

### Q: appimagetool 报错 "Failed to open squashfs image"
容器无 FUSE，无法运行 AppImage 格式的 appimagetool。按第六步用 mksquashfs 手动构建。

### Q: 补丁脚本报 "required patches failed"
新版本代码结构变化导致锚点不匹配。查看 `patch-report.json` 中哪些 required 为 false，然后在 `apply-linux-patches.js` 中更新对应锚点或改为可选。

### Q: mksquashfs 报 "liblzo2.so.2: cannot open shared object"
确保 `LD_LIBRARY_PATH` 包含 `.local/lib/x86_64-linux-gnu`。

### Q: 某些 deb 包下载 404
Ubuntu 归档的包版本会更新。到 https://packages.ubuntu.com 搜索包名，获取当前版本的下载 URL。

### Q: rpmbuild 报错 "Unable to open /usr/lib/rpm/rpmrc"
rpmbuild 硬编码读取系统路径。按第 8.2 节创建包装脚本，用 `--rcfile` 指向本地 rpmrc 文件。

### Q: rpmbuild 报错 "magic_load failed"
容器缺少 `file` 命令和 magic 文件，不影响打包结果，警告可忽略。

---

## 版本记录

| 日期 | WorkBuddy 版本 | Electron 版本 | 产物 | 备注 |
|------|----------------|--------------|------|------|
| 2026-07-08 | 5.2.3 | 37.10.3 | AppImage 212MB / deb 159MB / rpm 211MB | 首次构建成功，需修改补丁脚本适配 |
