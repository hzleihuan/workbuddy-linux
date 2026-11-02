# 从 WorkBuddy-darwin-x64-5.9.3 DMG 构建 loong64 版实现教程

| 项 | 值 |
|---|---|
| 目标上游 | WorkBuddy `5.9.3.42398134`（macOS x64 DMG，构建号 `d4692421`） |
| 验证环境 | 龙芯 3A6000 / loongnix 25.1 / loongarch64 ABI 2.0 / glibc 2.41 |
| 运行时 | Electron 43.7.7（darkyzhou/electron-loong64） |
| 转换工具 | `workbuddy-linux/scripts/lib/apply-linux-patches.js`（工程版本 `5.9.3+wb1`） |
| 实测产物 | `~/build/wb593-conv`（788 MB 运行树）、`workbuddy_5.9.3-2_loong64.deb`（271 MB） |
| 实测结果 | 验收脚本 `RESULT: PASS`；PTY 实弹 `PTY_OK_42`；asar 版本 `5.9.3` |

---

## 一、结论先行

整个转换是一条命令：

```bash
node scripts/lib/apply-linux-patches.js \
  "<WorkBuddy 5.9.3>/Contents/Resources/app.asar" \
  __WB_LINUX_PATCHES_V15__ \
  @lydell/node-pty-linux-loong64 \
  --layout=$HOME/build/wb593-conv \
  --runtime-from=/opt/WorkBuddy \
  --native-from=/opt/WorkBuddy
```

产物验收（4 项，含 PTY 实弹）：

```bash
APP=$HOME/build/wb593-conv bash ~/build/verify/verify.sh
# [1/4] 语法 ok  →  [2/4] asar 5.9.3  →  [3/4] 补丁落地  →  [4/4] PTY_OK_42
# RESULT: PASS
```

启动：

```bash
env -u ELECTRON_RUN_AS_NODE -u NODE_OPTIONS ~/build/wb593-conv/workbuddy
```

---

## 二、可行性边界（先讲清什么能做到）

Electron 应用的 JS 载荷与平台无关，平台差异只集中在运行时、原生模块、平台资源三处。按此拆解：

| 资产 | 能否从 DMG 直接得到 | 处置方式 |
|---|---|---|
| `app.asar`（全部业务 JS） | 可以 | 原样搬入，仅打少量运行时补丁 |
| `resources/` 内页面、字体、图标、扩展 | 可以 | 原样搬入 |
| Electron 二进制、`*.pak`、`icudtl.dat`、`snapshot_blob.bin`、`locales/`、`libEGL/libGLESv2/libffmpeg/libvk_swiftshader/libvulkan` | 不可以（Mach-O x86-64） | 换成龙芯 Electron 43.7.7 的同名文件 |
| 原生模块 `node-pty` / `koffi` / `im-napi.node` / `im-channels-native` | 不可以 | 换成 loongarch64 ELF，且编译基线的 glibc 不得高于本机 |
| macOS 专用件（`*.dylib`、`computer-use-launcher`、`turing-sdk`、`toybox-macos`、`zsh-macos`、`sandbox 5.9.5`、`*.lproj`、`*.icns`） | 不需要 | 剔除，Linux 无调用方 |
| IM 扩展（腾讯文档 / 编辑器 SDK） | 部分 | 只能以 loong64 原生桩满足"存在性检查"，功能不可用 |

> 据现有 loong64 deb 的包描述，官方 Linux 版应用资源只发布到 5.5.6。5.9.3 没有 Linux 安装包，所以只能走"darwin 资源 + 龙芯运行时"的拼装路线。

---

## 三、转换模型

```
DMG(WorkBuddy.app)                         参考 loong64 安装(/opt/WorkBuddy 或 deb)
   │                                                   │
   ├── Contents/Resources/**  ──搬──┐                  ├── electron + Chromium 资源
   │                                ├──► 转换树 out/ ───┼── 原生模块(loong64)
   ├── 剔除 mac 专属物 ─────────────┘                  ├── 启动器 / storage shim
   │                                                   └── 托盘图标 / apparmor
   └── app.asar ──打补丁──► out/resources/app.asar
```

三条规则贯穿整个转换：

1. **搬**：`Resources/` 整树搬迁（macOS 与 Linux 的 JS 载荷是同一份）。
2. **剔**：按规则删 mac 专属二进制，asar 内的同类条目一并删（否则 repack 时 header 仍声明 `unpacked`，会再写回磁盘）。
3. **换**：loong64 运行时 + 原生模块覆盖，逐项做 ELF 架构校验。

> 5.9.3 起上游已自带 Linux 分支（托盘 `setContextMenu(buildFallbackMenu())`、`update-service.linux.js`、产品配置落盘 `ACC_PRODUCT_CONFIG_PATH`），所以 asar 层不再需要当年那批"救火补丁"，只剩 1 条更新 RPC 打桩真正落地。

---

## 四、环境准备

### 4.1 系统要求

| 项 | 要求 | 本机实测 |
|---|---|---|
| 架构 | loongarch64（loong64，ABI 2.0 新世界） | 龙芯 3A6000 |
| glibc | ≥ 2.38 | 2.41 |
| 磁盘 | ≥ 3 GB 空闲（DMG 解包 + 运行树 + 打包） | `/home` 45 GB 可用 |
| 内存 | ≥ 4 GB | — |

### 4.2 工具

| 工具 | 用途 | 安装 |
|---|---|---|
| p7zip | 解 DMG（HFS+ 镜像） | `sudo apt install p7zip-full` |
| node ≥ 18 | 跑转换脚本 | 本机 v22.22.3（nvm） |
| `@electron/asar@3.4.1` | 读写 app.asar | 见下 |
| dpkg-deb | 打 deb（可选） | 系统自带 |
| readelf（binutils） | 查原生件 glibc 基线（排错用） | 系统自带 |

```bash
mkdir -p ~/build/tool && cd ~/build/tool
npm init -y >/dev/null
npm install @electron/asar@3.4.1 --no-audit --no-fund --ignore-scripts
```

### 4.3 loong64 参考运行时：三种来源

转换脚本本身**不编译**任何原生件，只负责搬运与校验。运行时和原生模块必须由下列之一提供：

| 方案 | 做法 | 适用 |
|---|---|---|
| **A. 本机已装（推荐）** | `--runtime-from=/opt/WorkBuddy --native-from=/opt/WorkBuddy` | 已经跑着 loong64 版 WorkBuddy |
| **B. 从现有 deb 解出** | `dpkg-deb -x workbuddy_5.9.3-1_loong64.deb ~/build/ref`，再把 `--runtime-from` 指向 `~/build/ref/opt/WorkBuddy` | 只有 deb、未安装 |
| **C. 全自建** | 从 `github.com/darkyzhou/electron-loong64/releases` 取 Electron 43.7.7 的 `electron-v43.7.7-linux-loong64.zip`；node-pty / koffi / im-napi 用 node-gyp 针对 Electron 43 头文件重编 | 无现成 loong64 包时（见附录 C） |

A、B 两方案目录结构完全一致，脚本无需区分。

---

## 五、操作步骤

### S1 解 DMG 取 .app

```bash
mkdir -p ~/build/src
7z x -y -snl ~/下载/WorkBuddy-darwin-x64-5.9.3.42398134-d4692421.dmg -o$HOME/build/src
APP="$HOME/build/src/WorkBuddy 5.9.3/WorkBuddy.app"
ls -l "$APP/Contents/Resources/app.asar"        # 应为 181953410 字节
```

要点：

- `-snl` 保留符号链接；7z 会报 `Sub items Errors: 1`，是 DMG 内的特殊条目，只要 `.app` 解出、`app.asar` 字节数对得上就不影响。
- 校验版本：`python3 -c "import plistlib;print(plistlib.load(open('$APP/Contents/Info.plist','rb'))['CFBundleShortVersionString'])"` → `5.9.3`。

### S2 执行转换

```bash
cd ~/下载/YB-YBworkbuddylinux/workbuddy-linux

NODE_PATH=$HOME/build/tool/node_modules node scripts/lib/apply-linux-patches.js \
  "$HOME/build/src/WorkBuddy 5.9.3/WorkBuddy.app/Contents/Resources/app.asar" \
  __WB_LINUX_PATCHES_V15__ \
  @lydell/node-pty-linux-loong64 \
  --layout=$HOME/build/wb593-conv \
  --runtime-from=/opt/WorkBuddy \
  --native-from=/opt/WorkBuddy
```

参数说明：

| 参数 | 必需 | 说明 |
|---|---|---|
| 第 1 位：asar 路径 | 是 | 输入 asar；`--layout` 模式下会被搬到输出树后再打补丁 |
| 第 2 位：marker | 是 | 补丁标记，重复执行可幂等（本文用 `__WB_LINUX_PATCHES_V15__`） |
| 第 3 位：平台包 | 否 | `@lydell/node-pty-linux-<arch>`，省略则按 `--arch` 或本机架构推断 |
| `--layout=<dir>` | 是（本文） | 开启转换模式；省略则退化为"只给现成 Linux 树打 asar 补丁" |
| `--runtime-from` | 是 | loong64 Electron 运行时来源 |
| `--native-from` | 否 | 原生模块来源，默认同 `--runtime-from` |
| `--arch` | 否 | `loong64` / `x64` / `arm64` |
| `--dry-run` | 否 | 只分析不落盘，输出判定报告 |
| `--strict` | 否 | 把 `anchor-gone` 也算失败（CI 用） |
| `--force-env-shim` | 否 | 上游已原生落盘配置时仍强制注入 E2BIG shim |

典型输出（实测）：

```
=== 转换阶段：WorkBuddy.app → $HOME/build/wb593-conv (loong64) ===
剔除 mac 专属条目 112 个
Electron 运行时文件 21 项 → ...
  + resources/wb-storage-shim.cjs
  + resources/app.asar.unpacked/node_modules/@lydell/node-pty-linux-loong64
  ...
原生件体检：loongarch64=8，其它平台（应保留/惰性）=6，可疑=1
asar 内剔除 mac 专属条目: 47
wrote app.asar.new (52619067 bytes)
synced unpacked entries into app.asar.unpacked: 4880
patch summary: applied=2, upstream-native=5, anchor-gone=15, failed=0
```

### S3 读两份报告

| 文件 | 内容 | 期望 |
|---|---|---|
| `out/convert-report.json` | 转换阶段：剔除数、覆盖清单、运行时文件、原生件体检、notes | `arch=loong64`；`archCheck.leftover` 至多 `qimei.node`（mac 版，见第九节） |
| `out/.workbuddy-linux/patch-report.json` | 补丁阶段：每条补丁状态 + 上游能力探测 + 计数 | `verdict: ok`，`failed: 0` |

`patches` 字段的四个状态含义：

| 状态 | 含义 | 是否需要处理 |
|---|---|---|
| `applied` | 已注入（或 marker 已存在） | 否 |
| `upstream-native` | 上游已原生实现，脚本主动跳过 | 否，可考虑退役该补丁 |
| `anchor-gone` | 锚点不存在（上游改写/删除） | 看是否影响功能；`--strict` 下会失败 |
| `failed` | 必选补丁失败，脚本退出码 7 | 是，必须修 |

### S4 验收（4 项）

```bash
APP=$HOME/build/wb593-conv bash ~/build/verify/verify.sh
```

| 步骤 | 检查内容 | 失败含义 |
|---|---|---|
| 1 | `node --check main/index.js`、`main/main-bootstrap.js` | 补丁把源码写坏了（括号/语法） |
| 2 | 用目标 electron 以 `ELECTRON_RUN_AS_NODE=1` require `app.asar/package.json` | asar 头损坏或运行时不可执行 |
| 3 | `main-bootstrap.js` 含 `[wb-linux-patch] update RPC disabled` | 补丁未落地（回到 patch-report 查状态） |
| 4 | `@lydell/node-pty-linux-loong64` 实弹 `pty.spawn` 打印 `PTY_OK_42` | 原生层不可用（多半 glibc/架构，见第七节） |

### S5 启动

```bash
env -u ELECTRON_RUN_AS_NODE -u NODE_OPTIONS ~/build/wb593-conv/workbuddy
```

两个坑必须先避开：

1. **在现有 WorkBuddy 会话里跑**（比如从这个终端启动），环境里带着 `ELECTRON_RUN_AS_NODE=1` 和 WorkBuddy 自己的 `NODE_OPTIONS`，electron 会把 `--no-sandbox` 当成 node 参数，直接报
   `electron: bad option: --no-sandbox`。必须 `env -u` 清掉。
2. **单实例锁**：同名应用已在运行时，新进程会立刻把参数转交给已在跑的实例然后 `exit 0`，看起来"没反应"。要真验收，先关掉现有实例。

---

## 六、可选：打成 deb

复用现成 deb 的 `DEBIAN/`（preinst/postinst/prerm/postrm），只替换 `opt/WorkBuddy` 内容：

```bash
cd ~/build
dpkg-deb -R ~/下载/workbuddy_5.9.3-1_loong64.deb deb-root
/bin/rm -rf deb-root/opt/WorkBuddy
cp -a wb593-conv deb-root/opt/WorkBuddy
sed -i 's/^Version: .*/Version: 5.9.3-2/' deb-root/DEBIAN/control
sed -i "s/^Installed-Size: .*/Installed-Size: $(du -sk deb-root/opt/WorkBuddy | cut -f1)/" deb-root/DEBIAN/control
dpkg-deb --root-owner-group -Zzstd -z6 -b deb-root out/workbuddy_5.9.3-2_loong64.deb
dpkg-deb -f out/workbuddy_5.9.3-2_loong64.deb Package Version Architecture Installed-Size
```

实测结果：271 MB（zstd -6），5958 个归档条目，`Installed-Size` 需按实际 `du -sk` 回写（原包里的 724540 是旧树的值）。

安装时的注意点：

- `postinst` 会建 `/usr/bin/workbuddy`、修正 `chrome-sandbox` 属主与 4755 位、给 pty 建软链，因此必须用 root 安装：`sudo dpkg -i …`。
- 若当前正跑着 WorkBuddy，`preinst` 只会杀掉 `/opt/WorkBuddy/*` 前缀的进程，不会杀旧实例；升级顺序应是"装包 → 手动重启"。
- 换了版本号后记得同步 `DEBIAN/control` 里的 `Description`，否则包管理器里看不出这是自建版。

---

## 七、asar 补丁判定（5.9.3 实测）

| 补丁 | 状态 | 5.9.3 依据 |
|---|---|---|
| `mainEnvShim` | `upstream-native` | `module-base.js` 把产品配置落盘 `workbuddy-product-spill-*`，改用 `ACC_PRODUCT_CONFIG_PATH` 传递，`E2BIG` 场景消失 |
| `sidecarEnvShim` | `upstream-native` | 同上：配置走 `_PATH`，sidecar 无需 reclaim `_FILE` 指针 |
| `trayContextMenu` | `upstream-native` | `TrayController` 内 `process.platform==='linux' ? this.tray.setContextMenu(this.buildFallbackMenu())` |
| `trayIconPath` | `upstream-native` | 托盘图标已按 `tray-linux.png` 取本地文件路径 |
| `updateServiceDisabled` | `upstream-native` | 新增 `main/update-service.linux.js`（AppImage）并按 `linuxSelfUpdateSupported` 门控 |
| `updateRpcDisabled` | `applied` | 从 `main-bootstrap.js` 反查真实注册函数 `require_handler_registry.t` 后注入 |
| `cliIsCliInstalledTimeout` 等 6 个超时补丁 | `anchor-gone` | 函数被拆分/重命名；`isCliInstalled` 的 `which` 已自带 `timeout:5e3` |
| `networkDiagnosticsTimeouts` | `anchor-gone` | 该模块在 5.9.3 已不存在 |
| `linuxQuit*` 4 个 | `anchor-gone` | `window-all-closed` 已按平台分支，退出语义上游自带 |
| `cliExtensionPathObjectCompat` 等 3 个 | `anchor-gone` | `cli/dist/codebuddy.js` 结构变化，锚点不匹配 |

一句话：**5.9.3 上 asar 层只需 1 条补丁**，其余 5 条属于"上游已修，主动退役"，15 条属于"锚点过期，仅告警"。这份表也是下次上游升级时判断"补丁该不该继续维护"的依据。

---

## 八、排错速查

| 症状 | 根因 | 处置 |
|---|---|---|
| 启动后无窗口、日志出现 `E2BIG` | 产品配置字符串撑爆单个环境变量（MAX_ARG_STRLEN 128KB） | 确认 `patch-report.json` 里 `mainEnvShim` 是 `upstream-native`；旧版本用 `--force-env-shim` |
| `Session spawn failed: Cannot find module './prebuilds/linux-loong64/pty.node'` | 报错具有误导性：实际是 **glibc 版本不够**（例如二进制要求 `GLIBC_2.42`，本机 2.41），`loadNativeModule()` 把最后一个候选的错误抛出来 | `readelf -V <pty.node> \| grep -o 'GLIBC_2\.[0-9]*' \| sort -V \| tail -1` 查基线；换成本机编译的 `pty.node`，不要去找文件 |
| `electron: bad option: --no-sandbox` | 环境里存在 `ELECTRON_RUN_AS_NODE=1`（WorkBuddy 会话会注入） | `env -u ELECTRON_RUN_AS_NODE -u NODE_OPTIONS ./workbuddy` |
| 启动脚本仍去跑 `/opt/WorkBuddy/electron` | `workbuddy` 启动器里 `DIR="/opt/WorkBuddy"` 写死 | 转换脚本会自动改写成"脚本所在目录"；手工搬运时自行 `sed` 替换 |
| 托盘图标是红叉 / 右键菜单空白 | AppIndicator 只认磁盘文件路径与 `setContextMenu` | 确认 `resources/tray-linux.png` 存在；5.9.3 上游已处理，无需补丁 |
| at-rest 解密失败、`symmetricAvailable=false` | 缺少 `electron.workbuddyStorage` 注入 | 启动时必须有 `NODE_OPTIONS=--require=<dir>/resources/wb-storage-shim.cjs`（启动器已带） |
| `rm: 权限不够: .../safe-bin/rm` | WorkBuddy 内置安全 shim 拦截了 `rm` | 脚本里用绝对路径 `/bin/rm` |
| `dpkg-deb -b` 后包体积异常大 | 未剔除 mac 产物，或 asar 内仍声明 `unpacked` 的旧条目被写回 | 看 `convert-report.json` 的 `pruned`；确认用的是 `--layout` 模式 |
| asar 打完后体积变大、`require` 原生模块失败 | 用了文件级 `unpack` glob（`@electron/asar` 对该参数按父目录 `matchBase` 匹配，天然失效） | 用本脚本的目录级 `unpackDir` + sidecar 同步逻辑（`5.9.3+wb1` 起） |

---

## 九、已知边界

1. **IM 扩展不可用**：`workbuddy-editor-sdk-supervisor` 与 `im-napi.node` 是 loong64 原生桩，仅满足 daemon 启动时的存在性检查；腾讯文档 / 编辑器能力在 loong64 上实际不可用，不影响本机会话。
2. **`qimei.node` 仍是 mac 版**：官方未提供 Linux 产物，本机既有安装也带着它，属惰性文件；若某条链路真的 require 它会失败。
3. **自动更新不生效**：上游仅在 AppImage 形态下允许 Linux 自更新（`linuxSelfUpdateSupported`），deb 安装不会真的升级。
4. **托盘依赖桌面环境**：X11/现代面板下 AppIndicator 正常；纯 Wayland 会话可能需要 `ELECTRON_OZONE_PLATFORM_HINT` 调整（启动器默认 `auto`）。
5. **上游升级即失效风险**：补丁锚点随版本漂移。每次换 DMG 后先跑 `--dry-run` 看 `capabilities` 与 `anchor-gone` 清单，再决定是否动手。

---

## 附录 A 验收脚本

已落地两份，可直接用：

| 文件 | 作用 |
|---|---|
| `~/build/verify/verify.sh` | 4 项验收（语法 / asar / 补丁 / PTY） |
| `~/build/verify/pty-smoke.cjs` | PTY 实弹：`@lydell/node-pty-linux-loong64` → `PTY_OK_42` |

## 附录 B 完整命令清单

```bash
# 0. 工具
mkdir -p ~/build/tool && cd ~/build/tool && npm init -y >/dev/null
npm install @electron/asar@3.4.1 --no-audit --no-fund --ignore-scripts

# 1. 解 dmg
mkdir -p ~/build/src
7z x -y -snl ~/下载/WorkBuddy-darwin-x64-5.9.3.42398134-d4692421.dmg -o$HOME/build/src

# 2. 转换
cd ~/下载/YB-YBworkbuddylinux/workbuddy-linux
NODE_PATH=$HOME/build/tool/node_modules node scripts/lib/apply-linux-patches.js \
  "$HOME/build/src/WorkBuddy 5.9.3/WorkBuddy.app/Contents/Resources/app.asar" \
  __WB_LINUX_PATCHES_V15__ @lydell/node-pty-linux-loong64 \
  --layout=$HOME/build/wb593-conv --runtime-from=/opt/WorkBuddy --native-from=/opt/WorkBuddy

# 3. 验收
APP=$HOME/build/wb593-conv bash ~/build/verify/verify.sh

# 4. 启动（先在另一个终端确认没有同名实例在跑）
env -u ELECTRON_RUN_AS_NODE -u NODE_OPTIONS ~/build/wb593-conv/workbuddy

# 5. 打 deb（可选）
cd ~/build && dpkg-deb -R ~/下载/workbuddy_5.9.3-1_loong64.deb deb-root
/bin/rm -rf deb-root/opt/WorkBuddy && cp -a wb593-conv deb-root/opt/WorkBuddy
sed -i 's/^Version: .*/Version: 5.9.3-2/' deb-root/DEBIAN/control
dpkg-deb --root-owner-group -Zzstd -z6 -b deb-root out/workbuddy_5.9.3-2_loong64.deb
```

## 附录 C 转换树与 DMG 的差异清单（实测）

**运行时（21 项，来自 loong64 参考安装）**

`electron`、`chrome_100_percent.pak`、`chrome_200_percent.pak`、`chrome-sandbox`、`chrome_crashpad_handler`、`icudtl.dat`、`libEGL.so`、`libGLESv2.so`、`libffmpeg.so`、`libvk_swiftshader.so`、`libvulkan.so.1`、`resources.pak`、`snapshot_blob.bin`、`v8_context_snapshot.bin`、`vk_swiftshader_icd.json`、`version`、`LICENSE`、`LICENSES.chromium.html`、`locales/`、`run.sh`、`workbuddy`

**resources 层覆盖（26 项）**

`default_app.asar`、`workbuddy-editor-sdk-supervisor`、`wb-storage-shim.cjs`、`apparmor-profile`、`tray-linux.png`、`tray-linux@2x.png`、`node_modules/`、`app.asar.unpacked/resources/im-backend-cmd/im-napi.node`、`…/@genie/im-channels-native`、`…/koffi/build/koffi/linux_loong64`、`…/node-pty/build`、`…/node-pty/prebuilds/linux-loong64`、`…/@lydell/node-pty-linux-loong64`（两处）、`cli/vendor/ripgrep` 与 `cli/vendor/genie-trash` 的 loong64/loongarch64/loong64-linux/loongarch64-linux 四个目录、`vendor/genie-trash` 同名四目录

**剔除（resources 层 112 项 + asar 内 47 项）**

`.dylib` / `.icns` / `*.lproj`、所有 `*darwin*` 路径与包、`@ban-dal`（无 loong64 预编译）、非目标架构的 `@lydell/node-pty-*`、mac 工具（`computer-use-launcher`、`turing-sdk`、`toybox-macos`、`zsh-macos`、`wecom-cli`、`sandbox/5.9.5/*`、`esbuild` mac 版）、`TuringShield.bundle`、`workbuddy-wechat-notifier`

**体积变化**

| 项 | 变化 |
|---|---|
| `app.asar` | 181,953,410 → 52,619,067（修正 `unpacked` 语义后，原该在 `app.asar.unpacked` 的 323 个文件回归磁盘） |
| 运行树总计 | 788 MB |
| deb（zstd -6） | 271 MB |

## 附录 D 全自建 loong64 原生件要点（方案 C，本次未实测）

| 组件 | 要点 |
|---|---|
| Electron 运行时 | `github.com/darkyzhou/electron-loong64/releases` 取 `electron-v43.7.7-linux-loong64.zip`，资产结构与官方同构（含 debug/symbols/mksnapshot/ffmpeg/chromedriver/node headers） |
| node-pty | 用 node-gyp 针对 Electron 43 头文件重编：`npm_config_target=43.7.7 npm_config_disturl=https://electronjs.org/headers npm_config_arch=loong64 node-gyp rebuild`；**编译机的 glibc 越低越好**（本机 2.41，deb 内产物按 2.36 编，可在更低版本机器上跑） |
| koffi | 官方 prebuild 无 loong64，需按 koffi 文档用其 CMake 流程产出 `linux_loong64/koffi.node` |
| im-napi / editor-sdk-supervisor | 无源码可编，用 loong64 空桩满足存在性检查即可（与现有 deb 做法一致） |
| 校验 | 每个产物 `readelf -h` 确认 `Machine: LoongArch`，`readelf -V` 确认最高 `GLIBC_x.y` ≤ 目标机 |

---

教程与脚本配套，脚本本体见 `workbuddy-linux/scripts/lib/apply-linux-patches.js`，改动说明见该仓库 `CHANGELOG.md` 的 `5.9.3+wb1` 条目。
