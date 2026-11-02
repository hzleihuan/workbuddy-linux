#!/usr/bin/env node
/**
 * Patch main/index.js inside a WorkBuddy app.asar so it runs on Linux.
 *
 * Fixes applied:
 *   1. Prelude shim: hide ACC_PRODUCT_CONFIG_V3 / _V2 from libc's
 *      environ so Chromium's internal /proc/self/exe spawn for the
 *      network/GPU/utility services doesn't fail with E2BIG.
 *
 *   2. Attach the tray context menu via setContextMenu() on Linux so
 *      the libayatana-appindicator backend renders the right-click
 *      menu (the AppIndicator never emits the click/right-click events
 *      upstream relies on).
 *
 *   3. Construct the Linux Tray from an on-disk PNG path (the
 *      .workbuddy-linux/workbuddy.png file written by install.sh)
 *      instead of a resized in-memory NativeImage — AppIndicator on
 *      Mint/Cinnamon otherwise renders a missing-image placeholder.
 *
 *   4. Disable the "Check for Updates..." menu entry and stub out the
 *      update* RPC handlers. The upstream updater drives the macOS
 *      ShipIt / Windows Squirrel installers, neither of which applies
 *      on a Linux port.
 *
 *   5. (in the env shim) Monkey-patch child_process.spawn/spawnSync
 *      to spill oversized env entries (ACC_PRODUCT_CONFIG_V3 / _V2)
 *      to a private temp file and replace them with a *_FILE pointer.
 *      The sidecar-entry.js shim reads the file back and re-injects
 *      the value via the same Proxy so the sidecar still sees the
 *      full JSON. This eliminates the spawn E2BIG that previously
 *      broke sidecar startup and plugin marketplace updates.
 *
 * The script operates directly on an app.asar file. It extracts it to a
 * temp directory, edits main/index.js + main/sidecar-entry.js, and
 * repacks the asar while preserving the original unpacked=true set.
 *
 * ---------------------------------------------------------------------------
 * 5.9.x note — 为什么大部分补丁从 "注入" 变成 "探测"
 * ---------------------------------------------------------------------------
 * 5.9.3 把单文件 main/index.js 拆成了 300+ 个 main/*.js 模块并做了重命名，
 * 同时把当年这些补丁要解决的问题在**上游**修掉了：
 *
 *   ACC_PRODUCT_CONFIG_* 溢出 → 上游自带 spill（ACC_PRODUCT_CONFIG_PATH +
 *       workbuddy-product-spill-*.json），E2BIG shim 已无必要；
 *   托盘菜单/图标 → TrayController 已内置 linux 分支
 *       (this.tray.setContextMenu(this.buildFallbackMenu()) + tray-linux.png)；
 *   自动更新 → 已拆出 main/update-service.linux.js(AppImage) 并按
 *       linuxSelfUpdateSupported 门控；
 *   isCliInstalled 卡死 → 上游已加 exec timeout:5e3。
 *
 * 于是本脚本对每个补丁给出四种结果，而不是简单的 true/false：
 *
 *   applied          已注入（或已存在 marker）
 *   upstream-native  上游已原生实现，本脚本主动跳过（不是失败）
 *   anchor-gone      锚点不存在：上游改写/删除，或版本过新（仅告警）
 *   failed           必选补丁失败 → 退出码 7
 *
 * 能力探测（capabilities）在一次运行里只做一遍，结果写进 patch-report.json，
 * 便于每次上游升级后快速看出"哪些补丁已经可以退役"。
 *
 * ---------------------------------------------------------------------------
 * Usage:
 *   node apply-linux-patches.js <path/to/app.asar> <marker> <@lydell/node-pty-linux-arch>
 *
 * 参数（均可省略，也可以用环境变量）：
 *   --arch=loong64|x64|arm64       覆盖架构（默认从 platform pkg 推断）
 *   --strict                       有 anchor-gone 的必选补丁时同样失败
 *   --force-env-shim               即使上游已自带 config spill 也注入 E2BIG shim
 *   --layout=<outDir>              dmg 转换模式：先组装 loong64 运行树，再打补丁
 *   --app=<X.app>                  转换模式的输入 .app（默认从 asar 路径反推）
 *   --runtime-from=<dir>           loong64 Electron 运行时来源目录（默认 /opt/WorkBuddy）
 *   --native-from=<dir>            loong64 原生模块来源目录（默认同 runtime-from）
 *   --dry-run                      只做分析并打印报告，不写任何文件
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
let asar;
try {
    asar = require('@electron/asar');
} catch (err) {
    console.error('[apply-linux-patches] ERROR: 缺少 @electron/asar。请把 NODE_PATH 指向已安装该模块的目录（如 .asar-tool/node_modules），或先执行 npm i @electron/asar@3.4.1');
    process.exit(2);
}

// ---------------------------------------------------------------------------
// 参数解析：兼容 install.sh 的三段位置参数，同时支持 --flag。
// ---------------------------------------------------------------------------
const argv = process.argv.slice(2);
const FLAGS = {
    strict: false,
    forceEnvShim: false,
    dryRun: false,
    layoutOut: process.env.WB_LAYOUT_OUT || '',
    layoutApp: process.env.WB_LAYOUT_APP || '',
    runtimeFrom: process.env.WB_RUNTIME_FROM || '/opt/WorkBuddy',
    nativeFrom: process.env.WB_NATIVE_FROM || '',
    arch: '',
};
const positional = [];
for (const a of argv) {
    const m = /^--([a-zA-Z-]+)(?:=(.*))?$/.exec(a);
    if (!m) { positional.push(a); continue; }
    const key = m[1];
    const val = m[2];
    switch (key) {
        case 'strict': FLAGS.strict = true; break;
        case 'force-env-shim': FLAGS.forceEnvShim = true; break;
        case 'dry-run': FLAGS.dryRun = true; break;
        case 'layout': FLAGS.layoutOut = val || ''; break;
        case 'app': FLAGS.layoutApp = val || ''; break;
        case 'runtime-from': FLAGS.runtimeFrom = val || ''; break;
        case 'native-from': FLAGS.nativeFrom = val || ''; break;
        case 'arch': FLAGS.arch = val || ''; break;
        default:
            console.error('[apply-linux-patches] ERROR: unknown flag --' + key);
            process.exit(2);
    }
}
if (process.env.WB_STRICT === '1') FLAGS.strict = true;
if (process.env.WB_FORCE_ENV_SHIM === '1') FLAGS.forceEnvShim = true;
if (!FLAGS.nativeFrom) FLAGS.nativeFrom = FLAGS.runtimeFrom;

let [, , asarPath, marker, lydellPlatformPackage] = [null, null, ...positional];
if (!asarPath || !marker) {
    console.error('Usage: apply-linux-patches.js <path/to/app.asar> <marker> <@lydell/node-pty-linux-arch>');
    console.error('       apply-linux-patches.js --layout=<outDir> --app=<X.app> --runtime-from=<dir> <path/to/app.asar> <marker>');
    process.exit(2);
}

const LYDELL_RE = /^@lydell\/node-pty-linux-(x64|arm64|loong64)$/;
const ARCH_ALIASES = {
    loong64: 'loong64',
    loongarch64: 'loong64',
    'loongarch64-linux': 'loong64',
    x64: 'x64',
    amd64: 'x64',
    arm64: 'arm64',
    aarch64: 'arm64',
};

function resolveArch(explicit) {
    if (explicit) {
        const a = ARCH_ALIASES[String(explicit).toLowerCase()];
        if (!a) throw new Error('unsupported --arch: ' + explicit);
        return a;
    }
    if (lydellPlatformPackage && LYDELL_RE.test(lydellPlatformPackage)) {
        return LYDELL_RE.exec(lydellPlatformPackage)[1];
    }
    // 目标架构必须显式给出：按构建机架构静默推断会在交叉构建时产出架构错位的 asar。
    throw new Error('必须指定 @lydell/node-pty-linux-<arch> 或 --arch，不做本机架构推断');
}

let TARGET_ARCH;
try {
    TARGET_ARCH = resolveArch(FLAGS.arch);
} catch (err) {
    console.error('[apply-linux-patches] ERROR: ' + err.message);
    process.exit(2);
}
if (!lydellPlatformPackage) lydellPlatformPackage = '@lydell/node-pty-linux-' + TARGET_ARCH;
if (!LYDELL_RE.test(lydellPlatformPackage)) {
    console.error('[apply-linux-patches] ERROR: unsupported @lydell platform package: ' + lydellPlatformPackage);
    process.exit(2);
}

function log(msg) { console.log('  [apply-linux-patches] ' + msg); }
function warn(msg) { console.warn('  [apply-linux-patches] NOTE: ' + msg); }

// ---------------------------------------------------------------------------
// 补丁状态词表 + 报告结构。
// required/optional 两棵旧结构保留，供 install.sh / 历史脚本读取；
// 新结构 patches[name] = { status, detail } 给人看。
// ---------------------------------------------------------------------------
const STATUS = {
    APPLIED: 'applied',
    UPSTREAM: 'upstream-native',
    GONE: 'anchor-gone',
    FAILED: 'failed',
};

const patchReport = {
    marker,
    lydellPlatformPackage,
    arch: TARGET_ARCH,
    required: {},
    optional: {},
    patches: {},
    capabilities: {},
    counts: {},
    verdict: 'pending',
};

function setPatch(name, status, detail, required) {
    patchReport.patches[name] = { status, detail: detail || '', required: Boolean(required) };
    if (required) patchReport.required[name] = status === STATUS.APPLIED || status === STATUS.UPSTREAM;
    else patchReport.optional[name] = status === STATUS.APPLIED;
    const label = status === STATUS.APPLIED ? 'ok' :
        status === STATUS.UPSTREAM ? 'upstream' :
            status === STATUS.GONE ? 'gone' : 'FAIL';
    log('[' + label + '] ' + name + (detail ? ' — ' + detail : ''));
}

// 旧调用点保持不变：markRequired(name, ok) / markOptional(name, ok)
function markRequired(name, ok) {
    setPatch(name, ok ? STATUS.APPLIED : STATUS.FAILED, '', true);
}

function markOptional(name, ok) {
    setPatch(name, ok ? STATUS.APPLIED : STATUS.GONE, '', false);
}

function markUpstream(name, detail, required) {
    setPatch(name, STATUS.UPSTREAM, detail, required);
}

function markAnchorGone(name, detail) {
    setPatch(name, STATUS.GONE, detail, false);
}

function assertRequiredPatches() {
    const failed = Object.entries(patchReport.required)
        .filter(([, ok]) => !ok)
        .map(([name]) => name);
    if (FLAGS.strict) {
        for (const [name, p] of Object.entries(patchReport.patches)) {
            if (p.required && p.status === STATUS.GONE && !failed.includes(name)) failed.push(name);
        }
    }
    if (failed.length > 0) {
        console.error('[apply-linux-patches] ERROR: required patches not applied: ' + failed.join(', '));
        process.exit(7);
    }
}

function summarizeReport() {
    const counts = { applied: 0, 'upstream-native': 0, 'anchor-gone': 0, failed: 0 };
    for (const p of Object.values(patchReport.patches)) counts[p.status] = (counts[p.status] || 0) + 1;
    patchReport.counts = counts;
    patchReport.verdict = counts.failed > 0 ? 'fail' : 'ok';
    log('patch summary: ' + Object.entries(counts).map(([k, v]) => k + '=' + v).join(', '));
}

// ---------------------------------------------------------------------------
// 1. Extract the asar into a temp dir. We pull file contents straight from
//    asar.extractFile() instead of relying on the CLI so that:
//      (a) we don't depend on the CLI sniffing the sibling .unpacked dir,
//      (b) we can reliably recover the exact bytes for every entry.
//    Unpacked entries are copied from the sibling <asar>.unpacked/ dir.
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// 0. 转换阶段（可选）：把 macOS .app 的 Resources 树 + 本机 loong64 运行时 /
//    原生模块，组装成可直接运行的 Linux 目录树。
//
//    这一步回答的是"从 dmh 到本机能跑"里 asar 之外的部分。当年这些动作散在
//    install.sh / native-modules.sh / 手工脚本里，判据只能靠 diff 两份安装来
//    反推；这里把它们固化成三条规则：
//
//      A. Resources 树整体搬过来（macOS 与 Linux 的 JS 载荷是同一份）。
//      B. 剔除 mac 专属二进制（.dylib / .icns / *.lproj / *darwin* / 已知
//         mac 工具），保留所有跨平台 JS 与资源。
//      C. 覆盖 loong64 原生层：Electron 运行时、node-pty、koffi、im-napi、
//         im-channels-native、ripgrep/genie-trash vendor、tray 图标、
//         wb-storage-shim 等。缺一个就起不来或崩溃，所以逐项校验 ELF 架构。
//
//    来源目录（--runtime-from / --native-from）默认指向本机已知可用的安装
//    （/opt/WorkBuddy）。loong64 原生件无法从 dmg 里"变"出来，必须由既有
//    安装或 deb 提供——脚本负责搬运与校验，不负责编译。
// ---------------------------------------------------------------------------
const MAC_ONLY_EXT = /\.(dylib|icns|dSYM)$/i;
// darwin/arm64-mac 目录与文件名（node-pty-darwin-x64、os-bridge.darwin-arm64.node …）
const MAC_ONLY_PATH_PART = /(^|[-_/.])darwin([-_](x64|arm64))?([-_/.]|$)|(^|[-_/])(x64|arm64)-darwin([-_/.]|$)|(^|[-_/])(toybox-macos|zsh-macos)([-_/.]|$)/i;
// 明确只属于 mac 交付物的可执行文件。按**路径后缀**匹配，兼容
// resources/ 与 resources/app.asar.unpacked/ 两种落点。
const MAC_ONLY_PATHS = [
    'cli/bin/native',
    'cli/vendor/shim/native',
    'cli/vendor/wecom-cli/wecom-cli',
    'cli/vendor/sandbox/5.9.5/betterleaks',
    'cli/vendor/sandbox/5.9.5/sandbox-center',
    'cli/vendor/sandbox/5.9.5/sandbox-cli',
    'cli/vendor/sandbox/5.9.5/sandbox-cli-gc',
    'native/computer-use-launcher',
    'native/turing-sdk',
    'node_modules/electron-macos-notification',
    'node_modules/fn-key-monitor',
    'node_modules/@genie/agent-harness/bin/native',
    'node_modules/@genie/agent-harness/cli/bin/native',
    'node_modules/@genie/agent-harness/cli/vendor/shim/native',
    'node_modules/@genie/agent-harness/cli/vendor/ripgrep',
    'resources/plugins/workbuddy-builtin/builtin-plugins/weixinpay/prebuilds',
    'resources/plugins/workbuddy-builtin/mcps/agently-cli/bin/agently-cli',
    'resources/extensions/workbuddy-baas-v2/node_modules/esbuild/bin/esbuild',
    'resources/wecom-agent-confirm/WeComAgentConfirmSDK.dll',
    // macOS 专用的两个辅助载荷（本机既有构建同样不带）
    'TuringShield.bundle',
    'workbuddy-wechat-notifier',
];
// 目标架构对应的 @lydell/node-pty 平台包；其它架构整包剔除（本机既有构建同样如此）
const KEEP_LYDELL_RE = new RegExp('(^|/)node_modules/@lydell/node-pty-linux-' + TARGET_ARCH + '(/|$)');
function isMacOnlyPath(rel) {
    if (MAC_ONLY_EXT.test(rel) || MAC_ONLY_PATH_PART.test(rel)) return 'mac-extension/arch';
    if (/(^|\/)[^/]+\.lproj(\/|$)/.test(rel)) return 'mac-lproj';
    for (const p of MAC_ONLY_PATHS) {
        if (rel === p || rel.endsWith('/' + p)) return 'mac-tool';
    }
    if (/(^|\/)node_modules\/@lydell\/node-pty-/.test(rel) && !KEEP_LYDELL_RE.test(rel)) return 'other-arch-pty';
    // 只发布 x64/arm64/win32 预编译的包，loong64 上根本加载不了；
    // 本机既有构建同样整包剔除，剔除后功能由 JS 回退路径覆盖。
    if (/(^|\/)node_modules\/@ban-dal(\/|$)/.test(rel)) return 'no-loong64-build';
    return '';
}

// loong64 原生层清单：relative path + 期望类型
const NATIVE_OVERLAY = [
    { rel: 'resources/default_app.asar', kind: 'file' },
    { rel: 'resources/workbuddy-editor-sdk-supervisor', kind: 'file' },
    { rel: 'resources/wb-storage-shim.cjs', kind: 'file' },
    { rel: 'resources/apparmor-profile', kind: 'file' },
    { rel: 'resources/tray-linux.png', kind: 'file' },
    { rel: 'resources/tray-linux@2x.png', kind: 'file' },
    { rel: 'resources/node_modules', kind: 'dir', optional: true },
    { rel: 'resources/app.asar.unpacked/resources/im-backend-cmd/im-napi.node', kind: 'file' },
    { rel: 'resources/app.asar.unpacked/node_modules/@genie/im-channels-native', kind: 'dir' },
    { rel: 'resources/app.asar.unpacked/node_modules/koffi/build/koffi/linux_loong64', kind: 'dir' },
    { rel: 'resources/app.asar.unpacked/node_modules/node-pty/build', kind: 'dir', optional: true },
    { rel: 'resources/app.asar.unpacked/node_modules/node-pty/prebuilds/linux-loong64', kind: 'dir' },
    { rel: 'resources/app.asar.unpacked/node_modules/@lydell/node-pty-linux-loong64', kind: 'dir' },
    { rel: 'resources/app.asar.unpacked/cli/node_modules/@lydell/node-pty-linux-loong64', kind: 'dir' },
];
const VENDOR_ARCH_DIRS = ['linux-loong64', 'linux-loongarch64', 'loong64-linux', 'loongarch64-linux'];
const VENDOR_TOOLS = ['ripgrep', 'genie-trash'];

const ELF_MACHINE = { 62: 'x86-64', 183: 'aarch64', 258: 'loongarch64' };

function readMagicKind(file) {
    let fd;
    try {
        fd = fs.openSync(file, 'r');
        const buf = Buffer.alloc(20);
        const n = fs.readSync(fd, buf, 0, 20, 0);
        if (n < 4) return { kind: 'empty' };
        if (buf[0] === 0x7f && buf[1] === 0x45 && buf[2] === 0x4c && buf[3] === 0x46) {
            const m = n >= 20 ? buf.readUInt16LE(18) : 0;
            return { kind: 'elf', machine: ELF_MACHINE[m] || ('elf-machine-' + m) };
        }
        if (buf[0] === 0xcf || buf[0] === 0xce || buf[0] === 0xca || buf[0] === 0xfe) return { kind: 'macho' };
        if (buf[0] === 0x4d && buf[1] === 0x5a) return { kind: 'pe' };
        return { kind: 'data' };
    } catch (err) {
        return { kind: 'unreadable', error: err.message };
    } finally {
        try { fs.closeSync(fd); } catch (_) {}
    }
}

function walkTree(root, relBase, visitor) {
    if (!fs.existsSync(root)) return;
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
        const rel = relBase ? relBase + '/' + entry.name : entry.name;
        const abs = path.join(root, entry.name);
        if (entry.isDirectory()) {
            visitor(rel, abs, true);
            walkTree(abs, rel, visitor);
        } else {
            visitor(rel, abs, false);
        }
    }
}

function copyInto(src, dst, rel) {
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.cpSync(src, dst, { recursive: true, force: true, preserveTimestamps: true, verbatimSymlinks: true });
    log('  + ' + rel);
}

function runLayoutStage() {
    const outDir = path.resolve(FLAGS.layoutOut);
    const appDir = FLAGS.layoutApp
        ? path.resolve(FLAGS.layoutApp)
        : path.resolve(asarPath, '..', '..', '..'); // Resources/app.asar → Contents → X.app
    const srcResources = path.join(appDir, 'Contents', 'Resources');
    if (!fs.existsSync(srcResources)) {
        console.error('[apply-linux-patches] ERROR: --layout 需要 .app 目录（找不到 ' + srcResources + '）');
        process.exit(2);
    }
    const runtimeFrom = FLAGS.runtimeFrom && fs.existsSync(FLAGS.runtimeFrom) ? path.resolve(FLAGS.runtimeFrom) : '';
    const nativeFrom = FLAGS.nativeFrom && fs.existsSync(FLAGS.nativeFrom) ? path.resolve(FLAGS.nativeFrom) : '';
    if (!runtimeFrom) {
        console.error('[apply-linux-patches] ERROR: --layout 需要 --runtime-from 指向 loong64 Electron 运行时目录（默认 /opt/WorkBuddy 不存在）');
        process.exit(2);
    }

    log('=== 转换阶段：' + path.basename(appDir) + ' → ' + outDir + ' (' + TARGET_ARCH + ') ===');
    const report = { app: appDir, out: outDir, arch: TARGET_ARCH, runtimeFrom, nativeFrom, pruned: 0, overlays: [], runtimeFiles: [], notes: [] };
    fs.mkdirSync(outDir, { recursive: true });

    // A. Resources 树整体搬运（app.asar 也一起搬，后面原地打补丁）
    const outResources = path.join(outDir, 'resources');
    fs.cpSync(srcResources, outResources, { recursive: true, force: true, preserveTimestamps: true });

    // B. 剔除 mac 专属物
    const toPrune = [];
    walkTree(outResources, '', (rel, abs) => {
        const why = isMacOnlyPath(rel);
        if (why) toPrune.push({ rel, abs, why });
    });
    for (const p of toPrune.sort((a, b) => a.rel.split('/').length - b.rel.split('/').length)) {
        if (!fs.existsSync(p.abs)) continue;
        try { fs.rmSync(p.abs, { recursive: true, force: true }); report.pruned++; }
        catch (err) { report.notes.push('prune ' + p.rel + ': ' + err.message); }
    }
    log('剔除 mac 专属条目 ' + report.pruned + ' 个');

    // C1. Electron 运行时（loong64）
    const runtimeFiles = [
        'electron', 'chrome_100_percent.pak', 'chrome_200_percent.pak', 'chrome-sandbox',
        'chrome_crashpad_handler', 'icudtl.dat', 'libEGL.so', 'libGLESv2.so', 'libffmpeg.so',
        'libvk_swiftshader.so', 'libvulkan.so.1', 'resources.pak', 'snapshot_blob.bin',
        'v8_context_snapshot.bin', 'vk_swiftshader_icd.json', 'version', 'LICENSE',
        'LICENSES.chromium.html',
    ];
    for (const f of runtimeFiles) {
        const src = path.join(runtimeFrom, f);
        if (!fs.existsSync(src)) { report.notes.push('runtime 缺少 ' + f); continue; }
        fs.cpSync(src, path.join(outDir, f), { force: true });
        fs.chmodSync(path.join(outDir, f), fs.statSync(src).mode & 0o777);
        report.runtimeFiles.push(f);
    }
    if (fs.existsSync(path.join(runtimeFrom, 'locales'))) {
        fs.cpSync(path.join(runtimeFrom, 'locales'), path.join(outDir, 'locales'), { recursive: true, force: true });
        report.runtimeFiles.push('locales/');
    }
    // 启动器与 shim：优先复用来源目录里已验证的版本。
    // 注意来源里的 workbuddy 把安装路径写死成 DIR="/opt/WorkBuddy"，直接搬过来
    // 会去跑原来那份 electron。这里改写成"脚本自身所在目录"，让输出目录可搬迁。
    const launchers = ['run.sh', 'workbuddy'];
    for (const f of launchers) {
        const src = path.join(runtimeFrom, f);
        if (!fs.existsSync(src)) { report.notes.push('缺少启动器 ' + f); continue; }
        let text = fs.readFileSync(src, 'utf8');
        const rewritten = text
            .replace(/^DIR="\/opt\/[^"]*"$/m, 'DIR="$(cd "$(dirname "$0")" && pwd)"')
            .replace(/^DIR=\/opt\/\S*$/m, 'DIR="$(cd "$(dirname "$0")" && pwd)"');
        if (rewritten !== text) {
            report.notes.push(f + ': 安装路径常量改写为脚本所在目录');
            text = rewritten;
        }
        const dst = path.join(outDir, f);
        fs.writeFileSync(dst, text);
        fs.chmodSync(dst, 0o755);
        report.runtimeFiles.push(f);
    }
    log('Electron 运行时文件 ' + report.runtimeFiles.length + ' 项 → ' + outDir);

    // C2. loong64 原生模块覆盖
    for (const item of NATIVE_OVERLAY) {
        const src = path.join(nativeFrom, item.rel);
        const dst = path.join(outDir, item.rel);
        if (!fs.existsSync(src)) {
            if (!item.optional) report.notes.push('native 缺少 ' + item.rel);
            continue;
        }
        fs.rmSync(dst, { recursive: true, force: true });
        copyInto(src, dst, item.rel);
        report.overlays.push(item.rel);
    }
    for (const tool of VENDOR_TOOLS) {
        for (const base of ['resources/app.asar.unpacked/cli/vendor', 'resources/vendor']) {
            for (const d of VENDOR_ARCH_DIRS) {
                const src = path.join(nativeFrom, base, tool, d);
                if (!fs.existsSync(src)) continue;
                copyInto(src, path.join(outDir, base, tool, d), base + '/' + tool + '/' + d);
                report.overlays.push(base + '/' + tool + '/' + d);
            }
        }
    }

    // C3. pty.node 架构校验/兜底：本机曾踩过"mac/glibc 不匹配但报错指向缺失路径"的坑，
    //     这里至少把非 loongarch64 的 pty.node 换成参考安装里的那份。
    const refPtyNode = (() => {
        const candidates = [
            path.join(nativeFrom, 'resources/app.asar.unpacked/node_modules/node-pty/build/Release/pty.node'),
            path.join(nativeFrom, 'resources/app.asar.unpacked/node_modules/node-pty/prebuilds/linux-loong64/pty.node'),
            path.join(nativeFrom, 'resources/app.asar.unpacked/node_modules/@lydell/node-pty-linux-loong64/prebuilds/linux-loong64/pty.node'),
        ];
        for (const c of candidates) {
            if (fs.existsSync(c) && readMagicKind(c).machine === 'loongarch64') return c;
        }
        return '';
    })();
    walkTree(outDir, '', (rel, abs, isDir) => {
        if (isDir || path.basename(rel) !== 'pty.node') return;
        // 只处理"本架构该用"的那几处：node-pty 的加载顺序是
        // build/Release → build/Debug → prebuilds/<platform>-<arch>。
        // 其它平台目录（prebuilds/linux-x64、darwin-*）保持原样，别乱改。
        if (!/build\/(Release|Debug)\//.test(rel) &&
            !/prebuilds\/(linux[-_](loong64|loongarch64)|(loong64|loongarch64)[-_]linux)\//.test(rel)) return;
        const magic = readMagicKind(abs);
        if (magic.machine === 'loongarch64') return;
        if (refPtyNode) {
            fs.cpSync(refPtyNode, abs, { force: true });
            report.notes.push('pty.node 架构为 ' + (magic.machine || magic.kind) + '，已替换为参考 loong64 版本：' + rel);
        } else {
            report.notes.push('pty.node 架构为 ' + (magic.machine || magic.kind) + '，且无参考 loong64 版本可替换：' + rel);
        }
    });

    // C4. 原生件架构体检
    //
    // 只把"本平台该用却架构不对"的文件当问题。其它平台的 prebuild / win32 资源
    // 留在树里不影响 Linux 运行（也不会被 require），单独计数即可。
    const OTHER_PLATFORM_RE = /(prebuilds|build|vendor|bin)\/(linux[-_](x64|ia32|arm64|armhf|riscv64)|darwin|win32|musl|freebsd|openbsd)\/|(^|[-_/.])darwin|win32|\.(dll|exe)$/i;
    const archCheck = { pinned: 0, otherPlatform: 0, leftover: [] };
    walkTree(outResources, '', (rel, abs, isDir) => {
        if (isDir) return;
        if (!/\.(node|so|so\.[0-9.]+)$/.test(rel)) return;
        const m = readMagicKind(abs);
        if (m.kind === 'elf' && m.machine === 'loongarch64') { archCheck.pinned++; return; }
        if (OTHER_PLATFORM_RE.test(rel)) { archCheck.otherPlatform++; return; }
        archCheck.leftover.push(rel + ' (' + (m.machine || m.kind) + ')');
    });
    report.archCheck = archCheck;
    log('原生件体检：loongarch64=' + archCheck.pinned +
        '，其它平台（应保留/惰性）=' + archCheck.otherPlatform +
        '，可疑=' + archCheck.leftover.length);
    for (const f of archCheck.leftover.slice(0, 10)) warn('架构可疑的原生件: ' + f);

    const reportPath = path.join(outDir, 'convert-report.json');
    if (!FLAGS.dryRun) fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
    log('转换报告：' + reportPath);

    // 后续 asar 补丁直接作用在新树上
    asarPath = path.join(outResources, 'app.asar');
    return report;
}

if (FLAGS.layoutOut && !FLAGS.dryRun) runLayoutStage();
else if (FLAGS.layoutOut && FLAGS.dryRun) log('--dry-run：跳过转换阶段（本来会输出到 ' + FLAGS.layoutOut + '）');

if (!fs.existsSync(asarPath)) {
    console.error('[apply-linux-patches] ERROR: asar file not found: ' + asarPath);
    process.exit(2);
}
const { header } = asar.getRawHeader(asarPath);
const unpackedSiblingDir = asarPath + '.unpacked';
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-asar-patch-'));
process.on('exit', () => {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
});

// ---------------------------------------------------------------------------
// Walk the header, collect every file's metadata, and write the bytes to
// the temp dir. Also accumulate the "unpacked" set for later.
// ---------------------------------------------------------------------------
const unpackedFiles = [];
function safeExtractPath(rel) {
    if (!rel || path.isAbsolute(rel) || rel.split('/').includes('..')) {
        throw new Error('unsafe asar entry path: ' + rel);
    }
    const abs = path.resolve(tmpDir, rel);
    const root = path.resolve(tmpDir) + path.sep;
    if (abs !== path.resolve(tmpDir) && !abs.startsWith(root)) {
        throw new Error('asar entry escapes temp dir: ' + rel);
    }
    return abs;
}

function walk(node, prefix) {
    if (!node.files) return;
    for (const [name, entry] of Object.entries(node.files)) {
        const rel = prefix ? prefix + '/' + name : name;
        const abs = safeExtractPath(rel);
        if (entry.files) {
            fs.mkdirSync(abs, { recursive: true });
            walk(entry, rel);
        } else if (entry.link) {
            // Symlink entries — extractFile can't give us the target, so
            // we just recreate them directly.
            try {
                fs.mkdirSync(path.dirname(abs), { recursive: true });
                fs.symlinkSync(entry.link, abs);
            } catch (err) {
                console.warn('  [apply-linux-patches] skipped symlink ' + rel + ': ' + err.message);
            }
        } else {
            fs.mkdirSync(path.dirname(abs), { recursive: true });
            if (entry.unpacked) {
                unpackedFiles.push(rel);
                const src = path.join(unpackedSiblingDir, rel);
                if (fs.existsSync(src)) {
                    fs.copyFileSync(src, abs);
                    const stat = fs.statSync(src);
                    fs.chmodSync(abs, stat.mode & 0o777);
                } else {
                    // Unpacked file missing from sibling dir — write an empty
                    // placeholder so the header can still reference it. This
                    // path is only hit if someone has deleted files from
                    // app.asar.unpacked/ between build and patch.
                    fs.writeFileSync(abs, Buffer.alloc(0));
                    console.warn('  [apply-linux-patches] missing unpacked file: ' + rel);
                }
            } else {
                const buf = asar.extractFile(asarPath, rel);
                fs.writeFileSync(abs, buf);
                if (entry.executable) {
                    fs.chmodSync(abs, 0o755);
                }
            }
        }
    }
}
walk(header, '');
log('Extracted ' + unpackedFiles.length + ' unpacked + packed entries to temp dir');

// ---------------------------------------------------------------------------
// 1b. 能力探测（capability probe）
//
// 上游把当年这些补丁的动机自己修掉之后，继续注入只会白改代码、并把
// "锚点没找到" 的噪音当成错误。这里一次性读完全部主进程 JS，按特征判定
// 哪些能力已经由上游提供；补丁段落据此跳过并标记 upstream-native。
// ---------------------------------------------------------------------------
const mainModulesDir = path.join(tmpDir, 'main');
function collectJs(root, relBase, acc) {
    if (!fs.existsSync(root)) return acc;
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
        const abs = path.join(root, entry.name);
        if (entry.isDirectory()) collectJs(abs, relBase ? relBase + '/' + entry.name : entry.name, acc);
        else if (entry.name.endsWith('.js')) {
            try { acc.push({ rel: (relBase ? relBase + '/' : '') + entry.name, text: fs.readFileSync(abs, 'utf8') }); } catch (_) {}
        }
    }
    return acc;
}
const mainModules = collectJs(mainModulesDir, '', []);
const mainCorpus = mainModules.map(m => m.text).join('\n');
function anyMain(re) { return mainModules.some(m => re.test(m.text)); }

const CAPS = {
    // 上游把 ACC_PRODUCT_CONFIG_* 落盘到私有文件，用 _PATH 传递 → E2BIG 不再出现
    productConfigSpill:
        /ACC_PRODUCT_CONFIG_PATH/.test(mainCorpus) &&
        /workbuddy-product-spill|acc-product-config-v3\.json/.test(mainCorpus),
    // TrayController 自带 linux 分支：setContextMenu(buildFallbackMenu()) + tray-linux.png
    linuxTray:
        /this\.tray\.setContextMenu\(/.test(mainCorpus) &&
        /tray-linux/.test(mainCorpus),
    // 独立的 linux 更新服务（AppImage 自更新，按 linuxSelfUpdateSupported 门控）
    linuxUpdateService: fs.existsSync(path.join(mainModulesDir, 'update-service.linux.js')),
    // isCliInstalled 的 `which` 检查自带 exec timeout
    cliExecTimeout: anyMain(/isCliInstalled/) && anyMain(/timeout:\s*5e3\s*,\s*env/),
    // window-all-closed 已按平台分支（非 darwin 且有托盘时保留进程）
    lifecyclePlatformAware: anyMain(/process\.platform\s*!==\s*[`"']darwin[`"']/),
    // 主进程已拆模块（5.9.x 形态）
    moduleSplit: fs.existsSync(path.join(mainModulesDir, 'main-bootstrap.js')),
};
patchReport.capabilities = CAPS;
log('上游能力探测: ' + Object.entries(CAPS).map(([k, v]) => k + '=' + (v ? 'yes' : 'no')).join(', '));
patchReport.moduleCount = mainModules.length;

// 转换模式下，把 asar 内的 mac 专属条目也删掉：只删磁盘 sidecar 是不够的，
// asar header 仍声明它们 unpacked，repack 后的 sidecar 同步会把它们再写回来。
// 它们只会在 macOS 上被 require，Linux 下属于纯负担（体积 + 混淆架构体检）。
if (FLAGS.layoutOut) {
    let prunedInAsar = 0;
    walkTree(tmpDir, '', (rel, abs) => {
        if (!isMacOnlyPath(rel)) return;
        try { fs.rmSync(abs, { recursive: true, force: true }); prunedInAsar++; } catch (_) {}
    });
    log('asar 内剔除 mac 专属条目: ' + prunedInAsar);
    patchReport.prunedInAsar = prunedInAsar;
}


// ---------------------------------------------------------------------------
// 2. Apply the two source patches to main/index.js.
// ---------------------------------------------------------------------------
const indexPath = path.join(tmpDir, 'main', 'index.js');
if (!fs.existsSync(indexPath)) {
    console.error('[apply-linux-patches] ERROR: main/index.js missing in asar');
    process.exit(3);
}

let source = fs.readFileSync(indexPath, 'utf8');

const SHIM_BODY = `// ${marker} — WorkBuddy Linux runtime patches (env + tray + compose timeout)
(function wbLinuxEnvShim() {
  if (process.platform !== "linux") return;
  try {
    // ---------------------------------------------------------------
    // Part A: keep the oversized product-config JSON out of libc
    // environ so Chromium's own execvp("/proc/self/exe") for network,
    // GPU and utility subprocesses doesn't fail with E2BIG.
    //
    // We replace process.env with a Proxy that stores the two hidden
    // keys in a private JS slot, hides them from every enumeration
    // path (has/ownKeys/getOwnPropertyDescriptor), and returns them
    // only via direct property access. Node's child_process spawn
    // enumerates process.env to build the child environment, so the
    // oversized string never lands in the child's argv block either.
    // ---------------------------------------------------------------
    var HIDDEN = new Set(["ACC_PRODUCT_CONFIG_V3", "ACC_PRODUCT_CONFIG_V2"]);
    var real = process.env;
    var store = Object.create(null);
    HIDDEN.forEach(function (key) {
      if (typeof real[key] === "string") {
        store[key] = real[key];
        try { delete real[key]; } catch (_) {}
      }
    });
    var proxy = new Proxy(real, {
      get: function (target, prop) {
        if (typeof prop === "string" && HIDDEN.has(prop)) return store[prop];
        return Reflect.get(target, prop);
      },
      set: function (target, prop, value) {
        if (typeof prop === "string" && HIDDEN.has(prop)) {
          store[prop] = value == null ? undefined : String(value);
          try { delete target[prop]; } catch (_) {}
          return true;
        }
        return Reflect.set(target, prop, value);
      },
      deleteProperty: function (target, prop) {
        if (typeof prop === "string" && HIDDEN.has(prop)) {
          delete store[prop];
          try { delete target[prop]; } catch (_) {}
          return true;
        }
        return Reflect.deleteProperty(target, prop);
      },
      has: function (target, prop) { return Reflect.has(target, prop); },
      ownKeys: function (target) { return Reflect.ownKeys(target); },
      getOwnPropertyDescriptor: function (target, prop) {
        return Reflect.getOwnPropertyDescriptor(target, prop);
      }
    });
    Object.defineProperty(process, "env", {
      value: proxy,
      writable: true,
      configurable: true,
      enumerable: true
    });

    // ---------------------------------------------------------------
    // Part B: sidecar spawn E2BIG workaround.
    //
    // Upstream assigns the same ~260KB JSON into the env object it
    // passes to child_process.spawn (see SidecarManager.spawnSidecar
    // and related CLI helpers). Even though Part A keeps the value
    // off libc environ for the main process, spawn() still stuffs it
    // into the argv block of the new process, where MAX_ARG_STRLEN
    // rejects any single 128KB+ entry with E2BIG.
    //
    // We monkey-patch child_process.spawn / spawnSync so that any
    // env entry named ACC_PRODUCT_CONFIG_V3 / _V2 whose value is
    // larger than 100KB is spilled to a private temp file and
    // replaced in the child's env with ACC_PRODUCT_CONFIG_V3_FILE.
    // The sidecar-entry.js shim reads that file back and re-injects
    // the value via a matching Proxy so downstream code sees the
    // same process.env.ACC_PRODUCT_CONFIG_V3 string.
    // ---------------------------------------------------------------
    var cp = require("child_process");
    var fsMod = require("fs");
    var osMod = require("os");
    var pathMod = require("path");
    var cryptoMod = require("crypto");
    var SPILL_KEYS = ["ACC_PRODUCT_CONFIG_V3", "ACC_PRODUCT_CONFIG_V2"];
    var SPILL_THRESHOLD = 100 * 1024; // 100KB; MAX_ARG_STRLEN is 128KB
    var wbTrackedChildren = [];
    var wbTrackedPtys = [];
    var wbTerminatingChildren = false;

    try {
      var electronMod = require("electron");
      var appMod = electronMod && electronMod.app;
    } catch (_) {}
    function wbTrackChild(method, command, child) {
      try {
        if (!child || typeof child.on !== "function") return child;
        var childPid = child.pid || null;
        if (childPid) wbTrackedChildren.push({ method: method, command: String(command), child: child, pid: childPid });
        child.on("exit", function (code, signal) {
          wbTrackedChildren = wbTrackedChildren.filter(function (item) { return item.child !== child; });
        });
        child.on("close", function (code, signal) {
          wbTrackedChildren = wbTrackedChildren.filter(function (item) { return item.child !== child; });
        });
      } catch (_) {}
      return child;
    }
    function wbTrackPty(file, term) {
      try {
        if (!term || typeof term !== "object") return term;
        var termPid = term.pid || null;
        if (termPid && typeof term.kill === "function") {
          wbTrackedPtys.push({ file: String(file), term: term, pid: termPid });
          if (typeof term.onExit === "function") {
            term.onExit(function (event) {
              wbTrackedPtys = wbTrackedPtys.filter(function (item) { return item.term !== term; });
            });
          }
        }
      } catch (_) {}
      return term;
    }
    function wbTerminateTrackedChildren(reason) {
      if (wbTerminatingChildren) return;
      wbTerminatingChildren = true;
      wbTrackedPtys.slice().forEach(function (item) {
        try { item.term.kill("SIGTERM"); } catch (_) {}
      });
      wbTrackedChildren.slice().forEach(function (item) {
        try { item.child.kill("SIGTERM"); } catch (_) {}
      });
      try {
        var timer = setTimeout(function () {
          wbTrackedPtys.slice().forEach(function (item) {
            try { item.term.kill("SIGKILL"); } catch (_) {}
          });
          wbTrackedChildren.slice().forEach(function (item) {
            try { item.child.kill("SIGKILL"); } catch (_) {}
          });
        }, 1500);
        if (timer && typeof timer.unref === "function") timer.unref();
      } catch (_) {}
    }
    try {
      if (typeof appMod !== "undefined" && appMod && appMod.on) {
        appMod.on("before-quit", function () { wbTerminateTrackedChildren("electron-before-quit"); });
        appMod.on("will-quit", function () { wbTerminateTrackedChildren("electron-will-quit"); });
      }
    } catch (_) {}
    process.on("exit", function () { wbTerminateTrackedChildren("process-exit"); });

    function wbSpillPath(prefix, suffix) {
      return pathMod.join(
        spillDir(),
        prefix + "-" + cryptoMod.randomBytes(8).toString("hex") + suffix
      );
    }

    // Clean up stale spill dirs from previous runs
    try {
      var wbTmpDir = osMod.tmpdir();
      var wbEntries = fsMod.readdirSync(wbTmpDir);
      var wbOurPid = String(process.pid);
      var wbNow = Date.now();
      for (var wbI = 0; wbI < wbEntries.length; wbI++) {
        var wbEntry = wbEntries[wbI];
        if (typeof wbEntry === "string" && wbEntry.indexOf("workbuddy-linux-env-") === 0) {
          var wbPidStr = wbEntry.slice("workbuddy-linux-env-".length);
          if (wbPidStr !== wbOurPid && /^\d+$/.test(wbPidStr)) {
            try {
              var wbPath = pathMod.join(wbTmpDir, wbEntry);
              var wbStat = fsMod.statSync(wbPath);
              var wbAlive = true;
              try { process.kill(Number(wbPidStr), 0); } catch (_) { wbAlive = false; }
              if (!wbAlive && wbNow - wbStat.mtimeMs > 24 * 60 * 60 * 1000) {
                fsMod.rmSync(wbPath, { recursive: true, force: true });
              }
            } catch (_) {}
          }
        }
      }
    } catch (_) {}

    // Clean up our own spill dir on process exit
    process.on("exit", function wbCleanOwnSpill() {
      try { fsMod.rmSync(pathMod.join(osMod.tmpdir(), "workbuddy-linux-env-" + process.pid), { recursive: true, force: true }); } catch (_) {}
    });

    var spillDirCache = null;
    function spillDir() {
      if (spillDirCache) return spillDirCache;
      var dir = pathMod.join(osMod.tmpdir(), "workbuddy-linux-env-" + process.pid);
      try { fsMod.mkdirSync(dir, { recursive: true, mode: 0o700 }); } catch (_) {}
      spillDirCache = dir;
      return dir;
    }

    function spillOversizedEnv(originalOpts) {
      if (!originalOpts || typeof originalOpts !== "object") return originalOpts;
      var env = originalOpts.env;
      if (!env || typeof env !== "object") return originalOpts;
      // Build a plain copy so that hidden Proxy keys (ACC_PRODUCT_CONFIG_V3 etc.)
      // are actually enumerable in the child process env. Object.assign across
      // the Proxy only sees the non-hidden keys, so we must re-add them manually.
      var result = Object.assign({}, env);
      var needsReplace = false;
      for (var i = 0; i < SPILL_KEYS.length; i++) {
        var key = SPILL_KEYS[i];
        var value = env[key];
        if (typeof value === "string") {
          if (value.length >= SPILL_THRESHOLD) {
            // Oversized: spill to a temp file and pass _FILE pointer instead.
            // The sidecar-entry.js shim reads the file back.
            try {
              var dir = spillDir();
              var filePath = wbSpillPath(key, ".json");
              fsMod.writeFileSync(filePath, value, { mode: 0o600 });
              delete result[key];
              result[key + "_FILE"] = filePath;
              needsReplace = true;
            } catch (err) {
              try {
                console.error("[wb-linux-shim] failed to spill " + key + ":", err);
              } catch (_) {}
            }
          } else if (!(key in result)) {
            // Non-oversized but missing from the plain copy because the Proxy
            // hides it from ownKeys. Include it directly so the child gets it.
            result[key] = value;
            needsReplace = true;
          }
        }
      }
      if (!needsReplace) return originalOpts;
      return Object.assign({}, originalOpts, { env: result });
    }

    function wrapSpawnLike(name) {
      var orig = cp[name];
      if (typeof orig !== "function" || orig.__wbLinuxShimWrapped) return;
      function wrapped(command, args, options) {
        // Normalize arg shape: spawn(cmd[, args][, options])
        if (!Array.isArray(args) && typeof args === "object" && args !== null) {
          options = args;
          args = undefined;
        }
        var patched = spillOversizedEnv(options);
        if (args === undefined) return wbTrackChild(name, command, orig.call(cp, command, patched));
        return wbTrackChild(name, command, orig.call(cp, command, args, patched));
      }
      wrapped.__wbLinuxShimWrapped = true;
      try { cp[name] = wrapped; } catch (_) {}
    }
    wrapSpawnLike("spawn");
    wrapSpawnLike("spawnSync");
    wrapSpawnLike("execFile");
    wrapSpawnLike("execFileSync");

    // exec/execSync use shell and pass env via options too
    function wrapExecLike(name) {
      var orig = cp[name];
      if (typeof orig !== "function" || orig.__wbLinuxShimWrapped) return;
      function wrapped(command, options, callback) {
        if (typeof options === "function") {
          callback = options;
          options = undefined;
        }
        var patched = spillOversizedEnv(options);
        if (callback) return wbTrackChild(name, command, orig.call(cp, command, patched, callback));
        return wbTrackChild(name, command, orig.call(cp, command, patched));
      }
      wrapped.__wbLinuxShimWrapped = true;
      try { cp[name] = wrapped; } catch (_) {}
    }
    wrapExecLike("exec");
    wrapExecLike("execSync");

    // ---------------------------------------------------------------
    // Part C: receiver side.
    //
    // If our parent handed us a _FILE pointer (i.e. we are a child
    // process spawned after Part B kicked in), read the file back
    // and re-expose the original value on process.env through the
    // same Proxy. The file stays in place because sibling child
    // processes can inherit the same pointer and still need to read it.
    //
    // Additionally, we write a fresh _FILE pointer into the real env
    // so that any child processes we spawn (which inherit process.env
    // via the default behavior) can also pick up the value through
    // their own copy of this shim.
    // ---------------------------------------------------------------
    for (var j = 0; j < SPILL_KEYS.length; j++) {
      var rkey = SPILL_KEYS[j];
      var fkey = rkey + "_FILE";
      var fp = real[fkey];
      if (typeof fp === "string" && fp.length) {
        try {
          store[rkey] = fsMod.readFileSync(fp, "utf8");
          // Don't delete the file — child processes may also need it.
          // Instead, keep the _FILE pointer in the real env so children
          // that inherit process.env can read it too.
        } catch (err) {
          try {
            console.error("[wb-linux-shim] failed to read " + fkey + ":", err);
          } catch (_) {}
        }
      }
    }

    // If we have values in store (either from parent's _FILE or from
    // upstream code setting them via the Proxy), ensure a _FILE pointer
    // exists in the real env for child process inheritance.
    for (var k = 0; k < SPILL_KEYS.length; k++) {
      var skey = SPILL_KEYS[k];
      var sfkey = skey + "_FILE";
      if (store[skey] && typeof store[skey] === "string" && store[skey].length >= SPILL_THRESHOLD) {
        if (!real[sfkey]) {
          try {
            var sfp = wbSpillPath(skey, ".json");
            fsMod.writeFileSync(sfp, store[skey], { mode: 0o600 });
            real[sfkey] = sfp;
          } catch (_) {}
        }
      }
    }

    // ---------------------------------------------------------------
    // Part D: ensure app.asar.unpacked/node_modules is on the
    // module resolution path. The asar-packed require() only sees
    // modules listed in the asar header. Platform-specific optional
    // packages like @lydell/node-pty-linux-x64 are installed into
    // app.asar.unpacked/ by the build script but never registered
    // in the asar header. Adding the unpacked node_modules to
    // Module.globalPaths lets require() find them.
    // ---------------------------------------------------------------
    try {
      var Module = require("module");
      var resourcesPath = typeof process.resourcesPath === "string"
        ? process.resourcesPath
        : pathMod.dirname(process.execPath);
      var unpackedNM = pathMod.join(resourcesPath, "app.asar.unpacked", "node_modules");
      if (fsMod.existsSync(unpackedNM)) {
        if (Module.globalPaths && !Module.globalPaths.includes(unpackedNM)) {
          Module.globalPaths.push(unpackedNM);
        }
      }
    } catch (_) {}

    // ---------------------------------------------------------------
    // Part E: wrap @lydell/node-pty spawn to spill oversized env.
    //
    // The sidecar uses node-pty (not child_process) to spawn the
    // host runtime CLI. node-pty calls forkpty+execve directly in
    // C++, bypassing our child_process monkey-patch. We intercept
    // the JS-level spawn() of the loaded node-pty module to strip
    // oversized env entries before they reach the native layer.
    // ---------------------------------------------------------------
    try {
      var origRequire = Module.prototype.require;
      var ptyPatched = false;
      Module.prototype.require = function wbRequireHook() {
        var result = origRequire.apply(this, arguments);
        var modName = arguments[0];
        if (!ptyPatched && typeof modName === "string" &&
            (modName === "@lydell/node-pty" || modName === "${lydellPlatformPackage}" || modName === "node-pty") &&
            result && typeof result.spawn === "function" && !result.spawn.__wbPtyWrapped) {
          ptyPatched = true;
          // Restore original require immediately to avoid perpetual hook overhead
          Module.prototype.require = origRequire;
          var origSpawn = result.spawn;
          result.spawn = function wbPtySpawn(file, args, opts) {
            if (opts && opts.env && typeof opts.env === "object") {
              var patchedEnv = opts.env;
              var didPatch = false;
              for (var pi = 0; pi < SPILL_KEYS.length; pi++) {
                var pk = SPILL_KEYS[pi];
                var pv = patchedEnv[pk];
                if (typeof pv === "string" && pv.length >= SPILL_THRESHOLD) {
                  try {
                    var pfp = wbSpillPath(pk + "-pty", ".json");
                    fsMod.writeFileSync(pfp, pv, { mode: 0o600 });
                    if (!didPatch) { patchedEnv = Object.assign({}, patchedEnv); didPatch = true; }
                    delete patchedEnv[pk];
                    patchedEnv[pk + "_FILE"] = pfp;
                  } catch (_) {}
                }
              }
              if (didPatch) opts = Object.assign({}, opts, { env: patchedEnv });
            }
            return wbTrackPty(file, origSpawn.call(this, file, args, opts));
          };
          result.spawn.__wbPtyWrapped = true;
        }
        return result;
      };
    } catch (_) {}
  } catch (err) {
    try { console.error("[wb-linux-shim] install failed:", err); } catch (_) {}
  }
})();
`;

if (source.includes(marker)) {
    log('marker already present in main/index.js; skipping source patch');
    markRequired('mainEnvShim', true);
    markOptional('trayContextMenu', true);
    markOptional('trayIconPath', true);
} else {
    const envShimNeeded = FLAGS.forceEnvShim || !CAPS.productConfigSpill;
    if (envShimNeeded) {
        const shim = SHIM_BODY;
        source = shim + source;
        markRequired('mainEnvShim', true);
    } else {
        // 5.9.x：上游把 ~260KB 的产品配置落盘，改用 ACC_PRODUCT_CONFIG_PATH 传给子进程，
        // E2BIG 场景消失（module-base.js 的 workbuddy-product-spill-*）。
        // 继续注入 shim 只会覆盖 process.env，反而有风险，故跳过。
        markUpstream('mainEnvShim', '上游用 ACC_PRODUCT_CONFIG_PATH 落盘传递产品配置，无需 E2BIG shim（--force-env-shim 可强制）', true);
    }

    const trayMarker = 'this.tray = new electron.Tray(trayIcon);';
    const trayIdx = source.indexOf(trayMarker);
    // [loong64] 5.6.2 ships a native TrayController class (same as 5.8.x)
    // and this.tray = new electron.Tray(trayIcon) appears INSIDE a method
    // of it (class declaration precedes the marker). The legacy top-level
    // contextMenu declaration no longer exists, so the Fix 2/3 patches
    // below are obsolete for this layout. Detect that by checking whether
    // 'var TrayController = class' appears BEFORE the tray marker.
    const trayInsideController = (function () {
        const innerLoc = source.indexOf('var TrayController = class');
        return innerLoc >= 0 && trayIdx > innerLoc;
    })();
    if (CAPS.linuxTray) {
        // 5.9.x 的 TrayController 已有 linux 分支：setContextMenu(buildFallbackMenu())
        // 且直接用 tray-linux.png，Fix 2/3 的动机不复存在。
        markUpstream('trayContextMenu', '上游 TrayController 已内置 linux setContextMenu 分支', false);
        markUpstream('trayIconPath', '上游已按 tray-linux.png 构造 Linux 托盘图标', false);
    } else if (trayIdx < 0 || trayInsideController) {
        // tray construction is not in main/index.js at the legacy top-level
        // spot (moved to TrayController, which already ships native Linux
        // tray support); skip the legacy tray patches instead of aborting.
        markAnchorGone('trayContextMenu', '托盘构造不在 main/index.js 顶层（已迁入 TrayController）');
        markAnchorGone('trayIconPath', '同上：托盘构造锚点缺失');
    } else {
    const afterTray = source.slice(trayIdx);
    const contextMenuDeclRe = /const contextMenu = electron\.Menu\.buildFromTemplate\(\[[\s\S]*?\]\);/;
    const m = afterTray.match(contextMenuDeclRe);
    if (!m) {
        console.error('[apply-linux-patches] ERROR: contextMenu declaration not found after tray');
        process.exit(5);
    }
    const insertAt = trayIdx + m.index + m[0].length;
    const trayPatch =
        '\n\t\t\tif (process.platform === "linux") {\n' +
        '\t\t\t\ttry { this.tray.setContextMenu(contextMenu); } catch (_) {}\n' +
        '\t\t\t}';
    source = source.slice(0, insertAt) + trayPatch + source.slice(insertAt);
    markOptional('trayContextMenu', true);

    // Fix 3 (Linux): the tray icon renders as a missing-image placeholder
    // (exclamation mark on Mint/Cinnamon) because upstream hands
    // libayatana-appindicator a resized in-memory NativeImage. The
    // AppIndicator backend wants an on-disk file path it can re-read
    // through GTK. On Linux we construct the Tray from the PNG written
    // by install.sh at <install-dir>/.workbuddy-linux/workbuddy.png
    // (shipped into /opt/<app>/.workbuddy-linux/ by the .deb/.rpm/.pacman
    // builders), falling back to the upstream NativeImage path if that
    // file is missing for any reason.
    const trayConstruct = 'this.tray = new electron.Tray(trayIcon);';
    const trayConstructReplacement =
        'if (process.platform === "linux") {\n' +
        '\t\t\t\ttry {\n' +
        '\t\t\t\t\tconst linuxTrayPath = path.join(path.dirname(process.resourcesPath), ".workbuddy-linux", "workbuddy.png");\n' +
        '\t\t\t\t\tif (fs.existsSync(linuxTrayPath)) {\n' +
        '\t\t\t\t\t\tthis.tray = new electron.Tray(linuxTrayPath);\n' +
        '\t\t\t\t\t}\n' +
        '\t\t\t\t} catch (_) {}\n' +
        '\t\t\t}\n' +
        '\t\t\tif (!this.tray) this.tray = new electron.Tray(trayIcon);';
    // There are two identical Tray constructions in the file in some
    // builds; replace only the first occurrence (the WindowManager one).
    const trayIdx2 = source.indexOf(trayConstruct);
    if (trayIdx2 >= 0) {
        source = source.slice(0, trayIdx2)
            + trayConstructReplacement
            + source.slice(trayIdx2 + trayConstruct.length);
        markOptional('trayIconPath', true);
    } else {
        markOptional('trayIconPath', false);
    }
    }

    // -----------------------------------------------------------------------
    // Fix 5 (Linux): add window control buttons (minimize/maximize/close).
    //
    // Upstream sets `frame: false` on Linux without providing a
    // titleBarOverlay (Windows gets one, macOS uses traffic lights).
    // Electron's titleBarOverlay only works on Wayland, not X11.
    // We inject a small CSS+JS snippet after the renderer loads that
    // draws minimize/maximize/close buttons in the top-right corner,
    // wired to the existing window:minimize/maximize/close RPC channels
    // exposed via the preload script.
    // -----------------------------------------------------------------------
    // Keep frame: false (we draw our own buttons), but remove the
    // titleBarOverlay we added earlier since it doesn't work on X11.
    // (No change needed — the marker is already just { frame: false })

    // Inject window control buttons after ready-to-show
    const readyToShowRe = /windowLog\.info\((?:"\[WindowManager\] Window ready to show"|`\[WindowManager\] Window ready to show[^`]*`)\);/;
    const readyToShowMatch = source.match(readyToShowRe);
    if (readyToShowMatch) {
        const afterReady = readyToShowMatch.index + readyToShowMatch[0].length;
        const windowControlsInjection = `
                        // [wb-linux-patch] Inject window control buttons on Linux
                        if (process.platform === "linux" && this.mainWindow) {
                                this.mainWindow.webContents.once("did-finish-load", () => {
                                        this.mainWindow?.webContents.executeJavaScript(\`
                                                (function() {
                                                        if (document.getElementById('wb-linux-window-controls')) return;
                                                        var css = document.createElement('style');
                                                        css.textContent = \\\`
                                                                #wb-linux-window-controls {
                                                                        position: fixed;
                                                                        top: 0;
                                                                        right: 0;
                                                                        z-index: 99999;
                                                                        display: flex;
                                                                        height: 36px;
                                                                        -webkit-app-region: no-drag;
                                                                }
                                                                #wb-linux-window-controls button {
                                                                        width: 46px;
                                                                        height: 36px;
                                                                        border: none;
                                                                        background: transparent;
                                                                        color: var(--vscode-titleBar-activeForeground, #cccccc);
                                                                        font-size: 16px;
                                                                        cursor: pointer;
                                                                        display: flex;
                                                                        align-items: center;
                                                                        justify-content: center;
                                                                        transition: background 0.1s;
                                                                }
                                                                #wb-linux-window-controls button:hover {
                                                                        background: rgba(255,255,255,0.1);
                                                                }
                                                                #wb-linux-window-controls button.wb-close:hover {
                                                                        background: #e81123;
                                                                        color: white;
                                                                }
                                                                #wb-linux-window-controls button svg {
                                                                        width: 10px;
                                                                        height: 10px;
                                                                        fill: currentColor;
                                                                }
                                                        \\\`;
                                                        document.head.appendChild(css);
                                                        var container = document.createElement('div');
                                                        container.id = 'wb-linux-window-controls';
                                                        container.innerHTML = '<button class="wb-minimize" title="最小化"><svg viewBox="0 0 10 1"><rect width="10" height="1"/></svg></button>'
                                                                + '<button class="wb-maximize" title="最大化"><svg viewBox="0 0 10 10"><path d="M0 0v10h10V0H0zm1 1h8v8H1V1z"/></svg></button>'
                                                                + '<button class="wb-close" title="关闭"><svg viewBox="0 0 10 10"><path d="M1.41 0L5 3.59 8.59 0 10 1.41 6.41 5 10 8.59 8.59 10 5 6.41 1.41 10 0 8.59 3.59 5 0 1.41z"/></svg></button>';
                                                        document.body.appendChild(container);
                                                        container.querySelector('.wb-minimize').onclick = function() {
                                                                window.buddyAPI && window.buddyAPI.minimizeWindow && window.buddyAPI.minimizeWindow();
                                                        };
                                                        container.querySelector('.wb-maximize').onclick = function() {
                                                                window.buddyAPI && window.buddyAPI.maximizeWindow && window.buddyAPI.maximizeWindow();
                                                        };
                                                        container.querySelector('.wb-close').onclick = function() {
                                                                window.buddyAPI && window.buddyAPI.closeWindow && window.buddyAPI.closeWindow();
                                                        };
                                                })();
                                        \`).catch(function() {});
                                });
                        }`;
        source = source.slice(0, afterReady) + windowControlsInjection + source.slice(afterReady);
        markOptional('windowControls', true);
    } else {
        markOptional('windowControls', false);
    }

    // -----------------------------------------------------------------------
    // Fix 6 (Linux): disable the "Check for Updates..." menu item and
    // stub out the updateCheck / updateDownload / updateQuitAndInstall
    // RPCs. The upstream updater talks to the macOS ShipIt / Windows
    // Squirrel / NSIS installers which are not available on Linux, and
    // the downloaded payloads (.dmg / .exe) cannot be applied here. We
    // surface a greyed-out menu entry so users see that auto-update is
    // intentionally unavailable on the Linux port.
    //
    // NOTE (5.3.3+): the menu-item builder `getUpdateMenuItem(texts,
    // updateState)` was moved out of the main-process bundle into the
    // renderer bundle, so it is no longer reachable from this
    // main/index.js patch. We therefore no longer treat the grey-out as
    // a hard requirement: the actual disable is enforced by the
    // `updateRpcDisabled` (stubbed updateCheck/updateDownload/... RPCs)
    // and `updateServiceDisabled` (early-return in
    // UpdateServiceLinux.checkForUpdates) patches below, both of which
    // still anchor on main/index.js. Clicking "Check for Updates" on
    // Linux is thus a harmless no-op. This patch stays best-effort: when
    // the anchor is present (older builds) we still grey it out.
    // -----------------------------------------------------------------------
    const updateMenuMarker = 'function getUpdateMenuItem(texts, updateState) {';
    const updateMenuIdx = source.indexOf(updateMenuMarker);
    if (updateMenuIdx >= 0) {
        const linuxUpdateShim =
            updateMenuMarker + '\n' +
            '\tif (process.platform === "linux") {\n' +
            '\t\treturn {\n' +
            '\t\t\tid: "checkForUpdates",\n' +
            '\t\t\tlabel: (texts.checkForUpdates || "Check for Updates...") + " (Linux 不支持)",\n' +
            '\t\t\tdisabled: true,\n' +
            '\t\t\tcommandId: "menu.checkForUpdates.disabled"\n' +
            '\t\t};\n' +
            '\t}';
        source = source.slice(0, updateMenuIdx)
            + linuxUpdateShim
            + source.slice(updateMenuIdx + updateMenuMarker.length);
        markOptional('updateMenuDisabled', true);
    } else {
        warn('锚点缺失（上游已改写或本版本不存在）: updateMenuDisabled anchor not found; skipping (menu-item builder moved to renderer bundle in 5.3.3; update RPCs/services still stubbed)')
        markOptional('updateMenuDisabled', false);
    }

    // Neutralize updateCheck / updateDownload / updateQuitAndInstall RPCs
    // on Linux so any residual UI button in the renderer becomes a no-op
    // instead of invoking the macOS/Windows updater code paths.
    // v5.2.3+ changed 'registerUpdateHandlers(server, deps)' to
    // 'registerUpdateHandlers(registry, deps)' and 'handleRpc$1' to
    // 'handleRpc'. Try both patterns for forward/backward compat.
    // 5.8.x moved update handling into dedicated modules:
    //   - registerUpdateHandlers() -> main/main-bootstrap.js
    //   - UpdateServiceLinux       -> main/update-service.linux.js (AppImage updater)
    // Patch those files directly when present; otherwise fall back to the
    // legacy main/index.js anchors used by 4.x/5.0-5.3.
    const bootstrapPath = path.join(tmpDir, 'main', 'main-bootstrap.js');
    const updateSvcPath = path.join(tmpDir, 'main', 'update-service.linux.js');
    let updateRpcDone = false;
    let updateRpcDetail = '';
    let updateServiceDone = false;

    // 5.9.x 的主进程是重命名压缩过的：RPC 注册函数不再是 require_netdrive_env_route.Ni，
    // 而是 require_handler_registry.t（同一文件里 50+ 处）。旧版本注入的 Ni(...) 在
    // 5.9.x 上是**静默空转**——try/catch 吞掉 ReferenceError，补丁却报告成功。
    // 这里改为：从目标文件里反查真正的注册函数名，找不到就如实报 anchor-gone。
    function findRpcRegistrar(text, serverArg) {
        const esc = serverArg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const re = new RegExp(
            '([A-Za-z_$][\\w$]*(?:\\.[A-Za-z_$][\\w$]*){0,2})\\(\\s*' + esc + '\\s*,\\s*"updateCheck"'
        );
        const m = text.match(re) || text.match(new RegExp(
            '([A-Za-z_$][\\w$]*(?:\\.[A-Za-z_$][\\w$]*){0,2})\\(\\s*' + esc + '\\s*,\\s*`updateCheck`'
        ));
        return m ? m[1] : '';
    }

    function patchUpdateRpcIn(filePath, text) {
        if (text.includes('[wb-linux-patch] update RPC disabled')) {
            return { ok: true, detail: 'marker 已存在' };
        }
        const decl = text.match(/function registerUpdateHandlers\(([^)]*)\)\s*\{/);
        if (!decl) return { ok: false, detail: '找不到 registerUpdateHandlers 定义' };
        const serverArg = decl[1].split(',')[0].trim();
        const registrar = findRpcRegistrar(text, serverArg);
        if (!registrar) {
            return { ok: false, detail: '找不到 RPC 注册函数（' + serverArg + ', "updateCheck"），拒绝注入空转代码' };
        }
        const inject =
            decl[0] +
            '\n// [wb-linux-patch] update RPC disabled\n' +
            '\tif (process.platform === "linux") {\n' +
            '\t\tconst __wbNoopRpc = async () => {};\n' +
            '\t\tfor (const __wbCh of ["updateCheck","updateDownload","updateArchMismatchDownload","updateArchMismatchInstall","updateQuitAndInstall"]) {\n' +
            '\t\t\ttry { ' + registrar + '(' + serverArg + ', __wbCh, __wbNoopRpc); } catch (_) {}\n' +
            '\t\t}\n' +
            '\t\ttry { ' + registrar + '(' + serverArg + ', "updateGetState", async () => ({ state: "idle" })); } catch (_) {}\n' +
            '\t\treturn;\n' +
            '\t}';
        fs.writeFileSync(filePath, text.replace(decl[0], inject));
        return { ok: true, detail: 'registrar=' + registrar };
    }

    if (fs.existsSync(bootstrapPath)) {
        const r = patchUpdateRpcIn(bootstrapPath, fs.readFileSync(bootstrapPath, 'utf8'));
        updateRpcDone = r.ok;
        updateRpcDetail = 'main-bootstrap.js: ' + r.detail;
    }

    // linux 更新服务：5.9.x 自带 update-service.linux.js（AppImage 自更新，且由
    // linuxSelfUpdateSupported 门控）。deb/rpm 安装下它本来就不会真的更新，
    // 强行插 early-return 只会让"检查更新"彻底失去语义，故跳过。
    if (CAPS.linuxUpdateService) {
        markUpstream('updateServiceDisabled', '上游已有 main/update-service.linux.js 且按 linuxSelfUpdateSupported 门控', false);
        updateServiceDone = true;
    } else if (fs.existsSync(updateSvcPath)) {
        let svc = fs.readFileSync(updateSvcPath, 'utf8');
        if (svc.includes('[wb-linux-patch] auto-update disabled')) {
            updateServiceDone = true;
        } else {
            const decl = svc.match(/checkForUpdates\(([^)]*)\)\{/);
            if (decl) {
                svc = svc.replace(
                    decl[0],
                    decl[0] + '\n/* [wb-linux-patch] auto-update disabled */return;'
                );
                fs.writeFileSync(updateSvcPath, svc);
                updateServiceDone = true;
            }
        }
    }

    if (!updateRpcDone) {
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
                '\t\t' + rpcFn + ' "updateDownload", async () => {});\n' +
                '\t\t' + rpcFn + ' "updateArchMismatchDownload", async () => {});\n' +
                '\t\t' + rpcFn + ' "updateArchMismatchInstall", async () => {});\n' +
                '\t\t' + rpcFn + ' "updateQuitAndInstall", async () => {});\n' +
                '\t\t' + rpcFn + ' "updateGetState", async () => ({ state: "idle" }));\n' +
                '\t\treturn;\n' +
                '\t}';
            source = source.slice(0, updateRpcIdx)
                + linuxRpcShim
                + source.slice(updateRpcIdx + marker.length);
            updateRpcDone = true;
        }
    }
    if (updateRpcDone) {
        setPatch('updateRpcDisabled', STATUS.APPLIED, updateRpcDetail || 'registerUpdateHandlers 已打桩', true);
    } else {
        markAnchorGone('updateRpcDisabled', updateRpcDetail || '未找到 registerUpdateHandlers / RPC 注册函数');
    }

    if (!updateServiceDone) {
        const linuxUpdateClassMarker = 'UpdateServiceLinux = class extends AbstractUpdateService {';
        const linuxUpdateClassIdx = source.indexOf(linuxUpdateClassMarker);
        if (linuxUpdateClassIdx >= 0) {
            const checkMethodMarker = 'async checkForUpdates(explicit = false) {';
            const checkMethodIdx = source.indexOf(checkMethodMarker, linuxUpdateClassIdx);
            if (checkMethodIdx >= 0) {
                const afterCheck = checkMethodIdx + checkMethodMarker.length;
                const earlyReturn = '\n\t\t\t\t\t// [wb-linux-patch] Auto-update disabled on Linux port\n\t\t\t\t\treturn;\n';
                source = source.slice(0, afterCheck) + earlyReturn + source.slice(afterCheck);
                updateServiceDone = true;
            }
        }
    }
    if (!CAPS.linuxUpdateService) {
        if (updateServiceDone) markOptional('updateServiceDisabled', true);
        else markAnchorGone('updateServiceDisabled', '未找到 UpdateServiceLinux.checkForUpdates / main/update-service.linux.js');
    }

    // -----------------------------------------------------------------------
    // Fix 7 (Linux stability): wrap several main-process awaits with a
    // race-against-timeout fallback. None of these are functional changes
    // upstream relies on; they exist purely to keep the UI thread from
    // wedging on Linux when child_process.exec timeouts misfire or when
    // BinaryManager.doInitialize() ends up in a permanently pending state.
    //
    // Symptoms observed on Linux Mint 22.3 / CachyOS that motivated each
    // sub-patch:
    //
    //   * BinaryManager.doInitialize() occasionally stays pending forever
    //     (registry.json 24h cache hit still blocks). prepareNodeRuntimeEnv()
    //     awaits the same initPromise, so every connect() that needs Node
    //     runtime injection (cloudbase / tcb / etc.) hits the upstream 122s
    //     stdio-MCP connect timeout before ever spawning the server.
    //
    //   * child_process.exec()'s `timeout` option sometimes does NOT fire on
    //     Electron+Linux for hung children. We've measured `which 'tcb'` not
    //     returning for 80s+, blocking the connector preAuth flow and the
    //     entire stdio MCP startup sequence (UI shows "connecting" forever).
    //
    //   * userPromptComposer / runtimeConfigResolver wait on remote
    //     "collectors / waitConfiguration" RPCs that can hang on first launch
    //     before the renderer has registered its handlers. Without a race
    //     fallback the very first chat message blocks indefinitely.
    //
    // All patches are markOptional (graceful degradation: if the upstream
    // shape changes between WorkBuddy releases, we log a warning, fall back
    // to the unpatched behaviour, and let the rest of the patches continue).
    // -----------------------------------------------------------------------

    // Patch 7A: ConnectorMcpProxy.maybeInjectNodeRuntime — 5s race so a
    // hung BinaryManager.ensure() can't block stdio MCP startup. On timeout
    // we fall through to the existing "inherited PATH" path that the catch
    // block already implements.
    const mcpInjectFrom =
        '\t\t\ttry {\n' +
        '\t\t\t\tconst prepared = await prepareNodeRuntimeEnv(this.binaryManager, {\n' +
        '\t\t\t\t\tversionRange: runtime?.version ?? "*",\n' +
        '\t\t\t\t\tregistry: serverConfig.npmRegistries?.[0] ?? serverConfig.npmRegistry\n' +
        '\t\t\t\t}, this.logger, { silent });\n' +
        '\t\t\t\tapplyNodeRuntimeEnv(env, prepared);\n' +
        '\t\t\t\tthis.logger.info(`[ConnectorMcpProxy] stdio MCP ${configId} Node runtime injected: command=${command} version=${prepared.nodeInfo.version} source=${prepared.nodeInfo.source}`);\n' +
        '\t\t\t} catch (err) {\n' +
        '\t\t\t\tthis.logger.warn(`[ConnectorMcpProxy] stdio MCP ${configId} Node runtime preparation failed; falling back to inherited PATH: ${err instanceof Error ? err.message : String(err)}`);\n' +
        '\t\t\t}';
    const mcpInjectTo =
        '\t\t\ttry {\n' +
        '\t\t\t\t// [wb-linux] BinaryManager.doInitialize() 在某些环境会永远 pending\n' +
        '\t\t\t\t// （registry.json 1440min cache 命中也照样阻塞），后续 ensure() 会一直 await\n' +
        '\t\t\t\t// 同一个 pending initPromise，把 stdio 启动卡到 connect timeout 122s。\n' +
        '\t\t\t\t// 5s race 后兜底走继承 PATH（系统 node 已在 PATH 上），跟原有 catch 语义一致。\n' +
        '\t\t\t\tconst wbStart = Date.now();\n' +
        '\t\t\t\tconst wbPrepP = prepareNodeRuntimeEnv(this.binaryManager, {\n' +
        '\t\t\t\t\tversionRange: runtime?.version ?? "*",\n' +
        '\t\t\t\t\tregistry: serverConfig.npmRegistries?.[0] ?? serverConfig.npmRegistry\n' +
        '\t\t\t\t}, this.logger, { silent });\n' +
        '\t\t\t\tlet wbTimer;\n' +
        '\t\t\t\tconst wbTimeoutP = new Promise((res) => { wbTimer = setTimeout(() => res({ __wbTimeout: true }), 5000); });\n' +
        '\t\t\t\tconst wbResult = await Promise.race([wbPrepP, wbTimeoutP]);\n' +
        '\t\t\t\tclearTimeout(wbTimer);\n' +
        '\t\t\t\tif (wbResult && wbResult.__wbTimeout) {\n' +
        '\t\t\t\t\ttry { this.logger.warn(`[wb-linux][ConnectorMcpProxy] stdio MCP ${configId} prepareNodeRuntimeEnv timeout 5s; falling back to inherited PATH (command=${command})`); } catch {}\n' +
        '\t\t\t\t\twbPrepP.then(() => {}, () => {});\n' +
        '\t\t\t\t\treturn;\n' +
        '\t\t\t\t}\n' +
        '\t\t\t\tapplyNodeRuntimeEnv(env, wbResult);\n' +
        '\t\t\t\tthis.logger.info(`[ConnectorMcpProxy] stdio MCP ${configId} Node runtime injected in ${Date.now() - wbStart}ms: command=${command} version=${wbResult.nodeInfo.version} source=${wbResult.nodeInfo.source}`);\n' +
        '\t\t\t} catch (err) {\n' +
        '\t\t\t\tthis.logger.warn(`[ConnectorMcpProxy] stdio MCP ${configId} Node runtime preparation failed; falling back to inherited PATH: ${err instanceof Error ? err.message : String(err)}`);\n' +
        '\t\t\t}';
    {
        const idx = source.indexOf(mcpInjectFrom);
        if (idx >= 0) {
            source = source.slice(0, idx) + mcpInjectTo + source.slice(idx + mcpInjectFrom.length);
            markOptional('mcpInjectNodeRuntimeTimeout', true);
        } else {
            warn('锚点缺失（上游已改写或本版本不存在）: mcpInjectNodeRuntimeTimeout anchor not found; skipping (stdio MCP startup may stall on hung BinaryManager)')
            markOptional('mcpInjectNodeRuntimeTimeout', false);
        }
    }

    // Patch 7B: ConnectorCliExecutor.buildCommandEnv — same 5s race for
    // the CLI preAuth path (tcb / cnpm etc.). Without this, runPreCliAuth()
    // blocks for the upstream 122s connect timeout when BinaryManager is
    // wedged.
    const cliBuildEnvFrom =
        '\t\t\tapplyNodeRuntimeEnv(env, await prepareNodeRuntimeEnv(this.binaryManager, {\n' +
        '\t\t\t\tversionRange: cliConfig.runtime.version ?? "*",\n' +
        '\t\t\t\tregistry: registry ?? cliConfig.npmRegistry\n' +
        '\t\t\t}, this.logger, { silent: options.silent === true }));\n' +
        '\t\t\tapplyCliConfigEnv(env, cliConfig.env);\n' +
        '\t\t\treturn env;';
    const cliBuildEnvTo =
        '\t\t\t// [wb-linux] 同 ConnectorMcpProxy.maybeInjectNodeRuntime：BinaryManager\n' +
        '\t\t\t// 初始化偶发永久 pending，会让 preAuth CLI 路径（tcb 等）卡到上游 connect timeout。\n' +
        '\t\t\t// 5s race 兜底走继承 PATH（系统 node 已就绪）。\n' +
        '\t\t\tconst wbPrepP = prepareNodeRuntimeEnv(this.binaryManager, {\n' +
        '\t\t\t\tversionRange: cliConfig.runtime.version ?? "*",\n' +
        '\t\t\t\tregistry: registry ?? cliConfig.npmRegistry\n' +
        '\t\t\t}, this.logger, { silent: options.silent === true });\n' +
        '\t\t\tlet wbTimer;\n' +
        '\t\t\tconst wbTimeoutP = new Promise((res) => { wbTimer = setTimeout(() => res({ __wbTimeout: true }), 5000); });\n' +
        '\t\t\tconst wbResult = await Promise.race([wbPrepP, wbTimeoutP]);\n' +
        '\t\t\tclearTimeout(wbTimer);\n' +
        '\t\t\tif (wbResult && wbResult.__wbTimeout) {\n' +
        '\t\t\t\ttry { this.logger.warn("[wb-linux][CliExecutor] prepareNodeRuntimeEnv timeout 5s; falling back to inherited PATH"); } catch {}\n' +
        '\t\t\t\twbPrepP.then(() => {}, () => {});\n' +
        '\t\t\t\tapplyCliConfigEnv(env, cliConfig.env);\n' +
        '\t\t\t\treturn env;\n' +
        '\t\t\t}\n' +
        '\t\t\tapplyNodeRuntimeEnv(env, wbResult);\n' +
        '\t\t\tapplyCliConfigEnv(env, cliConfig.env);\n' +
        '\t\t\treturn env;';
    {
        const idx = source.indexOf(cliBuildEnvFrom);
        if (idx >= 0) {
            source = source.slice(0, idx) + cliBuildEnvTo + source.slice(idx + cliBuildEnvFrom.length);
            markOptional('cliBuildCommandEnvTimeout', true);
        } else {
            warn('锚点缺失（上游已改写或本版本不存在）: cliBuildCommandEnvTimeout anchor not found; skipping (CLI preAuth may stall on hung BinaryManager)')
            markOptional('cliBuildCommandEnvTimeout', false);
        }
    }

    // Patch 7C: CliExecutor.isCliInstalled — 6s hard timeout via
    // Promise.race because child_process.exec()'s own `timeout` option does
    // not always fire on Electron+Linux for processes stuck in syscalls
    // (observed: `which 'tcb'` not returning for 80s+, freezing the UI).
    // We treat the timeout as "not installed" so the upper layer falls
    // through to the install path or surfaces a friendly error instead of
    // wedging the connector pipeline.
    const cliIsInstalledFrom =
        '\t\t\ttry {\n' +
        '\t\t\t\tconst env = await this.buildCommandEnv(cliConfig, options);\n' +
        '\t\t\t\tthis.logger.info(`[CliExecutor] isCliInstalled: platform=${(0, os.platform)()} checkCmd=${checkCmd} windowsHide=true`);\n' +
        '\t\t\t\tawait execAsync$1(checkCmd, {\n' +
        '\t\t\t\t\ttimeout: 5e3,\n' +
        '\t\t\t\t\tenv,\n' +
        '\t\t\t\t\twindowsHide: true\n' +
        '\t\t\t\t});\n' +
        '\t\t\t\treturn true;\n' +
        '\t\t\t} catch {\n' +
        '\t\t\t\treturn false;\n' +
        '\t\t\t}';
    const cliIsInstalledTo =
        '\t\t\ttry {\n' +
        '\t\t\t\tconst env = await this.buildCommandEnv(cliConfig, options);\n' +
        '\t\t\t\tthis.logger.info(`[CliExecutor] isCliInstalled: platform=${(0, os.platform)()} checkCmd=${checkCmd} windowsHide=true`);\n' +
        '\t\t\t\t// [wb-linux] 在某些 Electron + Linux 环境下 child_process.exec 的 timeout\n' +
        '\t\t\t\t// 对 hang 住的子进程不生效（已观察到 which \'tcb\' 80s+ 不返回，UI 卡死）。\n' +
        '\t\t\t\t// 用 Promise.race 兜底：6s 还没结果就当成"未安装"，让上层走 install 路径\n' +
        '\t\t\t\t// 或直接报错，绝不阻塞 UI。\n' +
        '\t\t\t\tconst wbExecP = execAsync$1(checkCmd, { timeout: 5e3, env, windowsHide: true });\n' +
        '\t\t\t\tlet wbTimer;\n' +
        '\t\t\t\tconst wbTimeoutP = new Promise((_, rej) => { wbTimer = setTimeout(() => rej(new Error("[wb-linux] isCliInstalled hard timeout 6s")), 6000); });\n' +
        '\t\t\t\ttry {\n' +
        '\t\t\t\t\tawait Promise.race([wbExecP, wbTimeoutP]);\n' +
        '\t\t\t\t} finally {\n' +
        '\t\t\t\t\tclearTimeout(wbTimer);\n' +
        '\t\t\t\t\twbExecP.then(() => {}, () => {});\n' +
        '\t\t\t\t}\n' +
        '\t\t\t\treturn true;\n' +
        '\t\t\t} catch (err) {\n' +
        '\t\t\t\ttry { if (err && /wb-linux/.test(String(err.message ?? err))) this.logger.warn(`[wb-linux][CliExecutor] isCliInstalled hard timeout for ${checkCmd}; treating as not installed`); } catch {}\n' +
        '\t\t\t\treturn false;\n' +
        '\t\t\t}';
    {
        const idx = source.indexOf(cliIsInstalledFrom);
        if (idx >= 0) {
            source = source.slice(0, idx) + cliIsInstalledTo + source.slice(idx + cliIsInstalledFrom.length);
            markOptional('cliIsCliInstalledTimeout', true);
        } else {
            warn('锚点缺失（上游已改写或本版本不存在）: cliIsCliInstalledTimeout anchor not found; skipping (which/where check may hang indefinitely on Linux)')
            markOptional('cliIsCliInstalledTimeout', false);
        }
    }

    // Patch 7D: ConnectorService.connect — wrap runPreCliAuth() in a 30s
    // race so a hung CLI auth flow can't block stdio MCP startup. preAuth
    // is only used to prime CLI login state; the stdio MCP server does
    // not strictly depend on it, so on timeout we proceed with startup
    // anyway. The function name `connect` is too common for a direct
    // anchor, so we pin on the unique runPreCliAuth call site and walk
    // back to the enclosing `if (connectorConfig?.cliConfig)`.
    {
        const preAuthCall = 'await this.runPreCliAuth(configId, connectorConfig, signal);';
        const callIdx = source.indexOf(preAuthCall);
        if (callIdx >= 0) {
            // Walk back to find the enclosing `if (connectorConfig?.cliConfig) {`
            const ifMarker = 'if (connectorConfig?.cliConfig) {';
            const ifIdx = source.lastIndexOf(ifMarker, callIdx);
            // Walk forward to find the matching close `}` of that if block.
            // Within an esbuild minified-but-pretty output the body is exactly:
            //   if (connectorConfig?.cliConfig) {\n
            //   \t...const preAuthResult = await this.runPreCliAuth(...);\n
            //   \t...if (!preAuthResult.success) return preAuthResult;\n
            //   \t...}\n
            // so we look for the next `if (!preAuthResult.success) return preAuthResult;`
            // and the closing brace that follows it on the next line.
            const successCheck = 'if (!preAuthResult.success) return preAuthResult;';
            const successIdx = source.indexOf(successCheck, callIdx);
            if (ifIdx >= 0 && successIdx >= 0 && successIdx - callIdx < 200) {
                // Find the closing `}` after successCheck (skip whitespace + newline).
                let endIdx = successIdx + successCheck.length;
                while (endIdx < source.length && /[\s]/.test(source[endIdx])) endIdx++;
                if (source[endIdx] === '}') endIdx++;
                else endIdx = -1;
                if (endIdx > 0) {
                    // Detect the indentation prefix used on the `if (...)` line so
                    // the replacement uses the same level (works for both `\t\t\t\t`
                    // and `\t\t\t` and arbitrary tab depth).
                    let indentStart = ifIdx;
                    while (indentStart > 0 && (source[indentStart - 1] === '\t' || source[indentStart - 1] === ' ')) indentStart--;
                    const indent = source.slice(indentStart, ifIdx);
                    const replacement =
                        indent + 'if (connectorConfig?.cliConfig) {\n' +
                        indent + '\t// [wb-linux] runPreCliAuth 内部 child_process.exec 在 Electron+Linux\n' +
                        indent + '\t// 偶发 hang 不响应 timeout（已观察到 which \'tcb\' 80s+ 不返回，UI 卡死）。\n' +
                        indent + '\t// 整体 race 30s 超时；超时后跳过 preAuth 继续 stdio MCP 启动 ——\n' +
                        indent + '\t// preAuth 仅为 CLI 登录态准备，stdio MCP server 自身不强依赖。\n' +
                        indent + '\tconst wbPreP = this.runPreCliAuth(configId, connectorConfig, signal);\n' +
                        indent + '\tlet wbTimer;\n' +
                        indent + '\tconst wbTimeoutP = new Promise((res) => { wbTimer = setTimeout(() => res({ __wbTimeout: true }), 30000); });\n' +
                        indent + '\tconst preAuthResult = await Promise.race([wbPreP, wbTimeoutP]);\n' +
                        indent + '\tclearTimeout(wbTimer);\n' +
                        indent + '\tif (preAuthResult && preAuthResult.__wbTimeout) {\n' +
                        indent + '\t\ttry { this.logger.warn(`[wb-linux][ConnectorService] runPreCliAuth(${configId}) timeout 30s; skipping preAuth and continuing with stdio MCP startup`); } catch {}\n' +
                        indent + '\t\twbPreP.then(() => {}, () => {});\n' +
                        indent + '\t} else if (!preAuthResult.success) return preAuthResult;\n' +
                        indent + '}';
                    source = source.slice(0, indentStart) + replacement + source.slice(endIdx);
                    markOptional('connectorPreAuthTimeout', true);
                } else {
                    warn('锚点缺失（上游已改写或本版本不存在）: connectorPreAuthTimeout end-brace not found; skipping')
                    markOptional('connectorPreAuthTimeout', false);
                }
            } else {
                warn('锚点缺失（上游已改写或本版本不存在）: connectorPreAuthTimeout if/successCheck not found near runPreCliAuth call; skipping')
                markOptional('connectorPreAuthTimeout', false);
            }
        } else {
            warn('锚点缺失（上游已改写或本版本不存在）: connectorPreAuthTimeout runPreCliAuth call not found; skipping (CLI preAuth may stall the connect pipeline)')
            markOptional('connectorPreAuthTimeout', false);
        }
    }

    // Patch 7E: SessionManager.composePromptForBackend — 5s race + raw
    // prompt fallback so the very first chat message can't hang on the
    // remote userPromptComposer (collectors / waitConfiguration).
    //
    // Upstream 5.x changed desiredConfig from cloneDesiredConfig(...) to
    // session.desiredConfig.
    const composeFrom =
        '\tasync composePromptForBackend(session, prompt, _meta) {\n' +
        '\t\tif (!this.userPromptComposer || !Array.isArray(prompt) || prompt.length === 0) return prompt;\n' +
        '\t\tawait this.userPromptComposerReady;\n' +
        '\t\treturn this.userPromptComposer.composeUserPrompt({\n' +
        '\t\t\tsessionId: session.sessionId,\n' +
        '\t\t\tcwd: session.cwd,\n' +
        '\t\t\tdesiredConfig: session.desiredConfig,\n' +
        '\t\t\tprompt: structuredClone(prompt),\n' +
        '\t\t\t_meta: _meta ? structuredClone(_meta) : void 0,\n' +
        '\t\t\thasPriorUserMessages: sessionHasPriorUserMessages(session)\n' +
        '\t\t});\n' +
        '\t}';
    const composeTo =
        '\tasync composePromptForBackend(session, prompt, _meta) {\n' +
        '\t\tif (!this.userPromptComposer || !Array.isArray(prompt) || prompt.length === 0) return prompt;\n' +
        '\t\tawait this.userPromptComposerReady;\n' +
        '\t\t// [wb-linux] 5s race + fallback to original prompt to avoid hang in user prompt composition (collectors / waitConfiguration)\n' +
        '\t\tconst wbStart = Date.now();\n' +
        '\t\tconst wbComposeP = this.userPromptComposer.composeUserPrompt({\n' +
        '\t\t\tsessionId: session.sessionId,\n' +
        '\t\t\tcwd: session.cwd,\n' +
        '\t\t\tdesiredConfig: session.desiredConfig,\n' +
        '\t\t\tprompt: structuredClone(prompt),\n' +
        '\t\t\t_meta: _meta ? structuredClone(_meta) : void 0,\n' +
        '\t\t\thasPriorUserMessages: sessionHasPriorUserMessages(session)\n' +
        '\t\t});\n' +
        '\t\tlet wbTimer;\n' +
        '\t\tconst wbTimeoutP = new Promise((res) => { wbTimer = setTimeout(() => res({ __wbTimeout: true }), 5000); });\n' +
        '\t\tconst wbResult = await Promise.race([wbComposeP, wbTimeoutP]);\n' +
        '\t\tclearTimeout(wbTimer);\n' +
        '\t\tif (wbResult && wbResult.__wbTimeout) {\n' +
        '\t\t\ttry { console.warn(`[wb-linux] composePromptForBackend timeout 5s sessionId=${session.sessionId}, falling back to raw prompt`); } catch {}\n' +
        '\t\t\twbComposeP.then(() => {}, () => {});\n' +
        '\t\t\treturn prompt;\n' +
        '\t\t}\n' +
        '\t\ttry { console.log(`[wb-linux] composePromptForBackend done in ${Date.now() - wbStart}ms sessionId=${session.sessionId}`); } catch {}\n' +
        '\t\treturn wbResult;\n' +
        '\t}';
    {
        const idx = source.indexOf(composeFrom);
        if (idx >= 0) {
            source = source.slice(0, idx) + composeTo + source.slice(idx + composeFrom.length);
            markOptional('composePromptForBackendTimeout', true);
        } else {
            warn('锚点缺失（上游已改写或本版本不存在）: composePromptForBackendTimeout anchor not found; skipping (first chat message may hang)')
            markOptional('composePromptForBackendTimeout', false);
        }
    }

    // Patch 7F: SessionManager.resolveRuntimeConfig — 5s race + local
    // desiredConfig fallback so first launch doesn't block on a remote
    // runtimeConfigResolver that hasn't booted yet.
    const resolveFrom =
        '\tasync resolveRuntimeConfig(args) {\n' +
        '\t\tif (!this.runtimeConfigResolver) return buildFallbackRuntimeConfig(args.desiredConfig);\n' +
        '\t\treturn cloneResolvedRuntimeConfig(await this.runtimeConfigResolver.resolveConfig({\n' +
        '\t\t\tsessionId: args.sessionId,\n' +
        '\t\t\tcwd: args.cwd,\n' +
        '\t\t\tdesiredConfig: cloneDesiredConfig(args.desiredConfig),\n' +
        '\t\t\tcurrentRuntimeConfig: args.currentRuntimeConfig ?? null\n' +
        '\t\t}));\n' +
        '\t}';
    const resolveTo =
        '\tasync resolveRuntimeConfig(args) {\n' +
        '\t\tif (!this.runtimeConfigResolver) return buildFallbackRuntimeConfig(args.desiredConfig);\n' +
        '\t\t// [wb-linux] 5s race + fallback to avoid hang in resolveConfig (collectors / waitConfiguration)\n' +
        '\t\tconst wbStart = Date.now();\n' +
        '\t\tconst wbResolveP = this.runtimeConfigResolver.resolveConfig({\n' +
        '\t\t\tsessionId: args.sessionId,\n' +
        '\t\t\tcwd: args.cwd,\n' +
        '\t\t\tdesiredConfig: cloneDesiredConfig(args.desiredConfig),\n' +
        '\t\t\tcurrentRuntimeConfig: args.currentRuntimeConfig ?? null\n' +
        '\t\t});\n' +
        '\t\tlet wbTimer;\n' +
        '\t\tconst wbTimeoutP = new Promise((res) => { wbTimer = setTimeout(() => res({ __wbTimeout: true }), 5000); });\n' +
        '\t\tconst wbResult = await Promise.race([wbResolveP, wbTimeoutP]);\n' +
        '\t\tclearTimeout(wbTimer);\n' +
        '\t\tif (wbResult && wbResult.__wbTimeout) {\n' +
        '\t\t\ttry { console.warn(`[wb-linux] resolveConfig timeout 5s sessionId=${args.sessionId} cwd=${args.cwd}, falling back to local desiredConfig`); } catch {}\n' +
        '\t\t\t// fire-and-forget the original promise to avoid unhandled rejection\n' +
        '\t\t\twbResolveP.then(() => {}, () => {});\n' +
        '\t\t\treturn buildFallbackRuntimeConfig(args.desiredConfig);\n' +
        '\t\t}\n' +
        '\t\ttry { console.log(`[wb-linux] resolveConfig done in ${Date.now() - wbStart}ms sessionId=${args.sessionId}`); } catch {}\n' +
        '\t\treturn cloneResolvedRuntimeConfig(wbResult);\n' +
        '\t}';
    {
        const idx = source.indexOf(resolveFrom);
        if (idx >= 0) {
            source = source.slice(0, idx) + resolveTo + source.slice(idx + resolveFrom.length);
            markOptional('resolveRuntimeConfigTimeout', true);
        } else {
            warn('锚点缺失（上游已改写或本版本不存在）: resolveRuntimeConfigTimeout anchor not found; skipping (first session start may hang)')
            markOptional('resolveRuntimeConfigTimeout', false);
        }
    }

    const clawRuntimePluginRegistrationReplayFrom =
        '\t\tthis.runtime = new ClawRuntime(host, this.telemetryService, logger, this.channelTracingService);\n' +
        '\t\tthis.ensureBuiltinPluginsRegistered();\n' +
        '\t\tthis.configureReplyResolver();';
    const clawRuntimePluginRegistrationReplayTo =
        '\t\tthis.runtime = new ClawRuntime(host, this.telemetryService, logger, this.channelTracingService);\n' +
        '\t\tthis.ensureBuiltinPluginsRegistered();\n' +
        '\t\tsetTimeout(async () => {\n' +
        '\t\t\ttry {\n' +
        '\t\t\t\tconst wbWechatmpConfig = this.store?.getChannelConfigs?.()["wechatmp"];\n' +
        '\t\t\t\tconst wbWechatmpEnabled = this.getWechatmpEnabled() || !!(wbWechatmpConfig && wbWechatmpConfig.enabled !== false);\n' +
        '\t\t\t\tthis.logger.info(`[wb-linux][ClawService] plugin registration replay check: apiEnabled=${this.getWechatmpEnabled()} configEnabled=${!!(wbWechatmpConfig && wbWechatmpConfig.enabled !== false)}`);\n' +
        '\t\t\t\tif (wbWechatmpEnabled) {\n' +
        '\t\t\t\t\tthis.logger.info("[wb-linux][ClawService] plugin registration replay enabled wechatmp integration");\n' +
        '\t\t\t\t\tthis.enableWechatmpChannel();\n' +
        '\t\t\t\t\tawait this.registerChannelConfig({ channelType: "wechatmp" });\n' +
        '\t\t\t\t\tthis.startCentrifugo().catch((error) => {\n' +
        '\t\t\t\t\t\tthis.logger.warn(`[wb-linux][ClawService] plugin registration replay Centrifugo start failed: ${error}`);\n' +
        '\t\t\t\t\t});\n' +
        '\t\t\t\t}\n' +
        '\t\t\t} catch (error) {\n' +
        '\t\t\t\tthis.logger.warn(`[wb-linux][ClawService] plugin registration replay failed: ${error instanceof Error ? error.message : String(error)}`);\n' +
        '\t\t\t}\n' +
        '\t\t}, 1000).unref?.();\n' +
        '\t\tthis.configureReplyResolver();';
    {
        const idx = source.indexOf(clawRuntimePluginRegistrationReplayFrom);
        if (idx >= 0) {
            source = source.slice(0, idx) + clawRuntimePluginRegistrationReplayTo + source.slice(idx + clawRuntimePluginRegistrationReplayFrom.length);
            markOptional('wechatmpPluginRegistrationReplay', true);
        } else {
            warn('锚点缺失（上游已改写或本版本不存在）: wechatmpPluginRegistrationReplay anchor not found; skipping (registered wechatmp plugin may not trigger remote replay)')
            markOptional('wechatmpPluginRegistrationReplay', false);
        }
    }

    const networkDiagnosticsRunFrom =
        '\t\tconst [proxy, hosts, service, tcp, packetLoss] = await Promise.all([\n' +
        '\t\t\tthis.runProxyDiagnostics(proxyInfo),\n' +
        '\t\t\tthis.runHostsDiagnostics(host, hostsFilePath),\n' +
        '\t\t\tthis.runServiceDiagnostics(runtimeConfig.endpoint),\n' +
        '\t\t\tthis.runTcpDiagnostics(host, port, proxyInfo),\n' +
        '\t\t\tthis.runPacketLossDiagnostics(host)\n' +
        '\t\t]);';
    const networkDiagnosticsRunTo =
        '\t\tconst [proxy, hosts, service, tcp, packetLoss] = await Promise.all([\n' +
        '\t\t\tthis.runCheckWithTimeout("proxy", () => this.runProxyDiagnostics(proxyInfo), 5000),\n' +
        '\t\t\tthis.runCheckWithTimeout("hosts", () => this.runHostsDiagnostics(host, hostsFilePath), 5000),\n' +
        '\t\t\tthis.runCheckWithTimeout("service", () => this.runServiceDiagnostics(runtimeConfig.endpoint), 7000),\n' +
        '\t\t\tthis.runCheckWithTimeout("tcp", () => this.runTcpDiagnostics(host, port, proxyInfo), 5000),\n' +
        '\t\t\tthis.runCheckWithTimeout("packetLoss", () => this.runPacketLossDiagnostics(host), 35000)\n' +
        '\t\t]);';
    const networkDiagnosticsMethodFrom =
        '\tasync measureTcpConnection(host, port, timeoutMs) {';
    const networkDiagnosticsMethodTo =
        '\tasync runCheckWithTimeout(name, task, timeoutMs) {\n' +
        '\t\tlet timer;\n' +
        '\t\ttry {\n' +
        '\t\t\treturn await Promise.race([\n' +
        '\t\t\t\ttask(),\n' +
        '\t\t\t\tnew Promise((resolve) => {\n' +
        '\t\t\t\t\ttimer = setTimeout(() => resolve({\n' +
        '\t\t\t\t\t\tstatus: "warning",\n' +
        '\t\t\t\t\t\tsummary: `${name}-timeout`,\n' +
        '\t\t\t\t\t\tdetail: `Check timed out after ${timeoutMs}ms.`,\n' +
        '\t\t\t\t\t\terrorType: "timeout"\n' +
        '\t\t\t\t\t}), timeoutMs);\n' +
        '\t\t\t\t})\n' +
        '\t\t\t]);\n' +
        '\t\t} finally {\n' +
        '\t\t\tclearTimeout(timer);\n' +
        '\t\t}\n' +
        '\t}\n' +
        '\tasync measureTcpConnection(host, port, timeoutMs) {';
    {
        const runIdx = source.indexOf(networkDiagnosticsRunFrom);
        const methodIdx = source.indexOf(networkDiagnosticsMethodFrom, runIdx >= 0 ? runIdx : 0);
        if (runIdx >= 0 && methodIdx >= 0 && !source.includes('async runCheckWithTimeout(name, task, timeoutMs)')) {
            source = source.slice(0, runIdx) + networkDiagnosticsRunTo + source.slice(runIdx + networkDiagnosticsRunFrom.length);
            const updatedMethodIdx = source.indexOf(networkDiagnosticsMethodFrom, runIdx);
            source = source.slice(0, updatedMethodIdx) + networkDiagnosticsMethodTo + source.slice(updatedMethodIdx + networkDiagnosticsMethodFrom.length);
            markOptional('networkDiagnosticsTimeouts', true);
        } else if (source.includes('async runCheckWithTimeout(name, task, timeoutMs)')) {
            markOptional('networkDiagnosticsTimeouts', true);
        } else {
            warn('锚点缺失（上游已改写或本版本不存在）: networkDiagnosticsTimeouts anchor not found; network diagnostics may stay stuck on a hung DNS/ping/probe task')
            markOptional('networkDiagnosticsTimeouts', false);
        }
    }

    fs.writeFileSync(indexPath, source);
    log('patched main/index.js (env shim + tray context menu + tray icon path + disabled updater + linux stability timeouts + wechatmp plugin registration replay)');
}

if (!patchReport.required.networkDiagnosticsTimeouts && !patchReport.optional?.networkDiagnosticsTimeouts) {
    const runFrom =
        '\t\tconst [proxy, hosts, service, tcp, packetLoss] = await Promise.all([\n' +
        '\t\t\tthis.runProxyDiagnostics(proxyInfo),\n' +
        '\t\t\tthis.runHostsDiagnostics(host, hostsFilePath),\n' +
        '\t\t\tthis.runServiceDiagnostics(runtimeConfig.endpoint),\n' +
        '\t\t\tthis.runTcpDiagnostics(host, port, proxyInfo),\n' +
        '\t\t\tthis.runPacketLossDiagnostics(host)\n' +
        '\t\t]);';
    const runTo =
        '\t\tconst [proxy, hosts, service, tcp, packetLoss] = await Promise.all([\n' +
        '\t\t\tthis.runCheckWithTimeout("proxy", () => this.runProxyDiagnostics(proxyInfo), 5000),\n' +
        '\t\t\tthis.runCheckWithTimeout("hosts", () => this.runHostsDiagnostics(host, hostsFilePath), 5000),\n' +
        '\t\t\tthis.runCheckWithTimeout("service", () => this.runServiceDiagnostics(runtimeConfig.endpoint), 7000),\n' +
        '\t\t\tthis.runCheckWithTimeout("tcp", () => this.runTcpDiagnostics(host, port, proxyInfo), 5000),\n' +
        '\t\t\tthis.runCheckWithTimeout("packetLoss", () => this.runPacketLossDiagnostics(host), 35000)\n' +
        '\t\t]);';
    const methodFrom = '\tasync measureTcpConnection(host, port, timeoutMs) {';
    const methodTo =
        '\tasync runCheckWithTimeout(name, task, timeoutMs) {\n' +
        '\t\tlet timer;\n' +
        '\t\ttry {\n' +
        '\t\t\treturn await Promise.race([\n' +
        '\t\t\t\ttask(),\n' +
        '\t\t\t\tnew Promise((resolve) => {\n' +
        '\t\t\t\t\ttimer = setTimeout(() => resolve({\n' +
        '\t\t\t\t\t\tstatus: "warning",\n' +
        '\t\t\t\t\t\tsummary: `${name}-timeout`,\n' +
        '\t\t\t\t\t\tdetail: `Check timed out after ${timeoutMs}ms.`,\n' +
        '\t\t\t\t\t\terrorType: "timeout"\n' +
        '\t\t\t\t\t}), timeoutMs);\n' +
        '\t\t\t\t})\n' +
        '\t\t\t]);\n' +
        '\t\t} finally {\n' +
        '\t\t\tclearTimeout(timer);\n' +
        '\t\t}\n' +
        '\t}\n' +
        '\tasync measureTcpConnection(host, port, timeoutMs) {';
    const runIdx = source.indexOf(runFrom);
    const methodIdx = source.indexOf(methodFrom, runIdx >= 0 ? runIdx : 0);
    if (runIdx >= 0 && methodIdx >= 0 && !source.includes('async runCheckWithTimeout(name, task, timeoutMs)')) {
        source = source.slice(0, runIdx) + runTo + source.slice(runIdx + runFrom.length);
        const updatedMethodIdx = source.indexOf(methodFrom, runIdx);
        source = source.slice(0, updatedMethodIdx) + methodTo + source.slice(updatedMethodIdx + methodFrom.length);
        fs.writeFileSync(indexPath, source);
        log('patched main/index.js (network diagnostics per-check timeouts)');
        markOptional('networkDiagnosticsTimeouts', true);
    } else if (source.includes('async runCheckWithTimeout(name, task, timeoutMs)')) {
        markOptional('networkDiagnosticsTimeouts', true);
    } else {
        warn('锚点缺失（上游已改写或本版本不存在）: networkDiagnosticsTimeouts anchor not found; network diagnostics may stay stuck on a hung DNS/ping/probe task')
        markOptional('networkDiagnosticsTimeouts', false);
    }
}

{
    const oldPacketLossTimeout = 'this.runCheckWithTimeout("packetLoss", () => this.runPacketLossDiagnostics(host), 12000)';
    const newPacketLossTimeout = 'this.runCheckWithTimeout("packetLoss", () => this.runPacketLossDiagnostics(host), 35000)';
    if (source.includes(oldPacketLossTimeout)) {
        source = source.split(oldPacketLossTimeout).join(newPacketLossTimeout);
        fs.writeFileSync(indexPath, source);
        log('patched main/index.js (network diagnostics packet loss timeout threshold)');
    }
}

{
    const oldPacketLossMeasure = 'const result = await this.measurePacketLoss(host, 18, 3e4);';
    const newPacketLossMeasure = 'const result = await this.measurePacketLoss(host, 4, 8e3);';
    if (source.includes(oldPacketLossMeasure)) {
        source = source.split(oldPacketLossMeasure).join(newPacketLossMeasure);
        fs.writeFileSync(indexPath, source);
        log('patched main/index.js (network diagnostics packet loss sample size)');
    }
}

{
    const oldLinuxPingArgs =
        '\t\t\t"-c",\n' +
        '\t\t\tString(count),\n' +
        '\t\t\t"-n",\n' +
        '\t\t\thost\n';
    const newLinuxPingArgs =
        '\t\t\t"-c",\n' +
        '\t\t\tString(count),\n' +
        '\t\t\t"-W",\n' +
        '\t\t\t"2",\n' +
        '\t\t\t"-n",\n' +
        '\t\t\thost\n';
    if (source.includes(oldLinuxPingArgs) && !source.includes('"-W",\n\t\t\t"2",\n\t\t\t"-n",')) {
        source = source.replace(oldLinuxPingArgs, newLinuxPingArgs);
        fs.writeFileSync(indexPath, source);
        log('patched main/index.js (network diagnostics linux ping wait)');
    }
}

{
    const runPingFrom =
        '\tasync runPing(args, timeoutMs, isWindows) {\n' +
        '\t\treturn new Promise((resolve) => {\n' +
        '\t\t\tif (isWindows) (0, child_process.execFile)("ping", args, {\n' +
        '\t\t\t\ttimeout: timeoutMs,\n' +
        '\t\t\t\twindowsHide: true,\n' +
        '\t\t\t\tencoding: "buffer"\n' +
        '\t\t\t}, (err, stdout, stderr) => {\n' +
        '\t\t\t\tthis.decodeWindowsOutput(stdout, stderr).then((output) => {\n' +
        '\t\t\t\t\tresolve({\n' +
        '\t\t\t\t\t\toutput,\n' +
        '\t\t\t\t\t\terror: err\n' +
        '\t\t\t\t\t});\n' +
        '\t\t\t\t});\n' +
        '\t\t\t});\n' +
        '\t\t\telse (0, child_process.execFile)("ping", args, {\n' +
        '\t\t\t\ttimeout: timeoutMs,\n' +
        '\t\t\t\twindowsHide: true\n' +
        '\t\t\t}, (err, stdout, stderr) => {\n' +
        '\t\t\t\tresolve({\n' +
        '\t\t\t\t\toutput: `${stdout || ""}${stderr ? `\\n${stderr}` : ""}`.trim(),\n' +
        '\t\t\t\t\terror: err\n' +
        '\t\t\t\t});\n' +
        '\t\t\t});\n' +
        '\t\t});\n' +
        '\t}\n';
    const runPingTo =
        '\tasync runPing(args, timeoutMs, isWindows) {\n' +
        '\t\treturn new Promise((resolve) => {\n' +
        '\t\t\tlet settled = false;\n' +
        '\t\t\tlet child;\n' +
        '\t\t\tconst finish = (result) => {\n' +
        '\t\t\t\tif (settled) return;\n' +
        '\t\t\t\tsettled = true;\n' +
        '\t\t\t\tclearTimeout(timer);\n' +
        '\t\t\t\tresolve(result);\n' +
        '\t\t\t};\n' +
        '\t\t\tconst timer = setTimeout(() => {\n' +
        '\t\t\t\ttry {\n' +
        '\t\t\t\t\tchild?.kill();\n' +
        '\t\t\t\t} catch {}\n' +
        '\t\t\t\tfinish({\n' +
        '\t\t\t\t\toutput: "",\n' +
        '\t\t\t\t\terror: new Error(`Ping command timed out after ${timeoutMs}ms.`)\n' +
        '\t\t\t\t});\n' +
        '\t\t\t}, timeoutMs + 1000);\n' +
        '\t\t\tif (isWindows) child = (0, child_process.execFile)("ping", args, {\n' +
        '\t\t\t\ttimeout: timeoutMs,\n' +
        '\t\t\t\twindowsHide: true,\n' +
        '\t\t\t\tencoding: "buffer"\n' +
        '\t\t\t}, (err, stdout, stderr) => {\n' +
        '\t\t\t\tthis.decodeWindowsOutput(stdout, stderr).then((output) => {\n' +
        '\t\t\t\t\tfinish({\n' +
        '\t\t\t\t\t\toutput,\n' +
        '\t\t\t\t\t\terror: err\n' +
        '\t\t\t\t\t});\n' +
        '\t\t\t\t});\n' +
        '\t\t\t});\n' +
        '\t\t\telse child = (0, child_process.execFile)("ping", args, {\n' +
        '\t\t\t\ttimeout: timeoutMs,\n' +
        '\t\t\t\twindowsHide: true\n' +
        '\t\t\t}, (err, stdout, stderr) => {\n' +
        '\t\t\t\tfinish({\n' +
        '\t\t\t\t\toutput: `${stdout || ""}${stderr ? `\\n${stderr}` : ""}`.trim(),\n' +
        '\t\t\t\t\terror: err\n' +
        '\t\t\t\t});\n' +
        '\t\t\t});\n' +
        '\t\t});\n' +
        '\t}\n';
    if (source.includes(runPingFrom)) {
        source = source.replace(runPingFrom, runPingTo);
        fs.writeFileSync(indexPath, source);
        log('patched main/index.js (network diagnostics ping hard timeout)');
    }
}

{
    const linuxChineseAnchor =
        '\t\tconst unixDetailedMatch = /(\\d+)\\s+packets transmitted,\\s*(\\d+)\\s+(?:packets )?received.*?(\\d+(?:\\.\\d+)?)%\\s+packet loss/i.exec(output);\n';
    const linuxChinesePatch =
        '\t\tconst unixChineseMatch = /已发送\\s*(\\d+)\\s*个包[，,]\\s*已接收\\s*(\\d+)\\s*个包.*?(\\d+(?:\\.\\d+)?)%\\s*packet loss/i.exec(output);\n' +
        '\t\tif (unixChineseMatch) return {\n' +
        '\t\t\ttransmitted: Number(unixChineseMatch[1]),\n' +
        '\t\t\treceived: Number(unixChineseMatch[2]),\n' +
        '\t\t\tlossPercentage: Number(unixChineseMatch[3])\n' +
        '\t\t};\n';
    if (source.includes(linuxChineseAnchor) && !source.includes('const unixChineseMatch =')) {
        source = source.replace(linuxChineseAnchor, linuxChinesePatch + linuxChineseAnchor);
        fs.writeFileSync(indexPath, source);
        log('patched main/index.js (network diagnostics linux chinese ping parser)');
    }
}

// ---------------------------------------------------------------------------
// Linux quit fix (patch group "linuxQuit")
//
// On Linux the app can never exit:
//  - The "退出 WorkBuddy" menu calls app.quit(), but the before-quit handler
//    (main/index.js) enters an async confirmation branch — active-task quit
//    confirmation (promptActiveTasksQuitConfirmation) or Tencent-docs-preview
//    quit confirmation (promptDocumentPreviewQuitConfirmation) — that awaits a
//    promise (daemonSessionQueries.getActiveSessions() /
//    releaseTencentDocsPreviewContextsWithPrompt) which never resolves on
//    Linux. event.preventDefault() was already called, so app.quit() is never
//    re-triggered and the process hangs forever.
//  - The X button hits the window close handler's `isMac || this.trayActive`
//    branch, which preventDefaults and hides the window to the tray instead of
//    closing it (and window-all-closed then returns early because the tray is
//    active), so the process also never quits from X.
//
// On Linux we skip both async confirmation branches (they are non-essential on
// a port where the daemon / Tencent-docs-preview features do not function) and
// let the close / window-all-closed handlers actually quit the app. The
// injected `process.platform !== "linux"` guards keep Windows/macOS behavior
// unchanged.
// ---------------------------------------------------------------------------
{
    const from = 'if (!isQuittingForUpdate && !userConfirmedActiveTasksQuit && mainBootstrap !== null && windowManager !== null) {';
    const to = 'if (!isQuittingForUpdate && !userConfirmedActiveTasksQuit && mainBootstrap !== null && windowManager !== null && process.platform !== "linux") {';
    if (source.includes(from)) {
        source = source.replace(from, to);
        fs.writeFileSync(indexPath, source);
        log('patched main/index.js (linux quit: skip active-tasks quit confirmation on linux)');
        markOptional('linuxQuitActiveTasksConfirm', true);
    } else {
        markOptional('linuxQuitActiveTasksConfirm', false);
    }
}
{
    const from = 'if (!isQuittingForUpdate && !userConfirmedDocumentPreviewQuit) {';
    const to = 'if (!isQuittingForUpdate && !userConfirmedDocumentPreviewQuit && process.platform !== "linux") {';
    if (source.includes(from)) {
        source = source.replace(from, to);
        fs.writeFileSync(indexPath, source);
        log('patched main/index.js (linux quit: skip document-preview quit confirmation on linux)');
        markOptional('linuxQuitDocPreviewConfirm', true);
    } else {
        markOptional('linuxQuitDocPreviewConfirm', false);
    }
}
{
    const from = '\t\t\tif (isMac || this.trayActive) {';
    const to = '\t\t\tif (isMac) {';
    if (source.includes(from)) {
        source = source.replace(from, to);
        fs.writeFileSync(indexPath, source);
        log('patched main/index.js (linux quit: X closes window instead of hiding to tray)');
        markOptional('linuxQuitCloseToTray', true);
    } else {
        markOptional('linuxQuitCloseToTray', false);
    }
}
{
    const from = '\tif (windowManager?.isTrayActive) {';
    const to = '\tif (windowManager?.isTrayActive && process.platform !== "linux") {';
    if (source.includes(from)) {
        source = source.replace(from, to);
        fs.writeFileSync(indexPath, source);
        log('patched main/index.js (linux quit: window-all-closed quits even with tray on linux)');
        markOptional('linuxQuitWindowAllClosed', true);
    } else {
        markOptional('linuxQuitWindowAllClosed', false);
    }
}

assertRequiredPatches();

// ---------------------------------------------------------------------------
// Also patch sidecar-entry.js so the sidecar process, spawned with
// ELECTRON_RUN_AS_NODE=1 and its own Node bootstrap, receives the same
// env Proxy / _FILE receiver installed in main/index.js. Without this
// the sidecar would boot without ACC_PRODUCT_CONFIG_V3 set (because
// the parent spilled it to a file) and every downstream call through
// getWorkbuddyBootstrapProductConfigurationEnv() would fall back to
// a stale bootstrap value.
// ---------------------------------------------------------------------------
const sidecarEntryPath = path.join(tmpDir, 'main', 'sidecar-entry.js');
if (CAPS.productConfigSpill && !FLAGS.forceEnvShim) {
    // 上游既然用 ACC_PRODUCT_CONFIG_PATH 传配置，sidecar 侧没有 _FILE 指针要 reclaim，
    // 再注入 shim 反而会遮蔽上游的 env 读取逻辑。
    markUpstream('sidecarEnvShim', '上游 config spill 走 _PATH，sidecar 无需 shim', true);
} else if (fs.existsSync(sidecarEntryPath)) {
    let sidecarSource = fs.readFileSync(sidecarEntryPath, 'utf8');
    if (!sidecarSource.includes(marker)) {
        sidecarSource = SHIM_BODY + sidecarSource;
        fs.writeFileSync(sidecarEntryPath, sidecarSource);
        log('patched main/sidecar-entry.js (env shim)');
        markRequired('sidecarEnvShim', true);
    } else {
        log('marker already present in main/sidecar-entry.js; skipping');
        markRequired('sidecarEnvShim', true);
    }
} else {
    markRequired('sidecarEnvShim', false);
}

function patchCliDistCodebuddy() {
    const codebuddyPath = path.join(unpackedSiblingDir, 'cli', 'dist', 'codebuddy.js');
    if (!fs.existsSync(codebuddyPath)) {
        markOptional('cliExtensionPathObjectCompat', false);
        return;
    }

    let cliSource = fs.readFileSync(codebuddyPath, 'utf8');
    const exactReplacements = [
        {
            from: 'for(let eg of ec){let ec=(0,AF.join)(eA,eg);if(!await this.pathExists(ec)){this.logger.warn(`Agent path not found: ${ec}`);continue}',
            to: 'for(let eg of ec){let e$="string"==typeof eg?eg:eg&&"string"==typeof eg.path?eg.path:eg&&"string"==typeof eg.source?eg.source:void 0;if(!e$){this.logger.warn(`Invalid agent path entry: ${JSON.stringify(eg)}`);continue}let ec=(0,AF.join)(eA,e$);if(!await this.pathExists(ec)){this.logger.warn(`Agent path not found: ${ec}`);continue}'
        },
        {
            from: 'for(let eg of ec){let ec=(0,AF.join)(eA,eg);if(!await this.pathExists(ec)){this.logger.warn(`Command path not found: ${ec}`);continue}',
            to: 'for(let eg of ec){let e$="string"==typeof eg?eg:eg&&"string"==typeof eg.path?eg.path:eg&&"string"==typeof eg.source?eg.source:void 0;if(!e$){this.logger.warn(`Invalid command path entry: ${JSON.stringify(eg)}`);continue}let ec=(0,AF.join)(eA,e$);if(!await this.pathExists(ec)){this.logger.warn(`Command path not found: ${ec}`);continue}'
        },
        {
            from: 'for(let eg of ec){let ec=(0,AF.join)(eA,eg);if(!await this.pathExists(ec)){this.logger.warn(`Skill path not found: ${ec}`);continue}',
            to: 'for(let eg of ec){let e$="string"==typeof eg?eg:eg&&"string"==typeof eg.path?eg.path:eg&&"string"==typeof eg.source?eg.source:void 0;if(!e$){this.logger.warn(`Invalid skill path entry: ${JSON.stringify(eg)}`);continue}let ec=(0,AF.join)(eA,e$);if(!await this.pathExists(ec)){this.logger.warn(`Skill path not found: ${ec}`);continue}'
        },
        {
            from: 'async deserializeSessionFromJsonl(eA,el){let ec=this.getSessionFilePath(eA),eu=await this.deserializeSessionFromPath(ec,el);if(eu)return eu;if(eA.startsWith("agent-")){let ec=this.getStorageDir();try{for(let ed of(await tE.readdir(ec,{withFileTypes:!0}))){if(!ed.isDirectory())continue;let eg=tC.join(ec,ed.name,"subagents"),ep=tC.join(eg,`${eA}.jsonl`);try{if(await tE.access(ep),eu=await this.deserializeSessionFromPath(ep,el))return eu}catch{continue}}}catch{}}}async deserializeSessionFromPath',
            to: 'async deserializeSessionFromJsonl(eA,el){let ec=this.getSessionFilePath(eA),eu=await this.deserializeSessionFromPath(ec,el);if(eu)return eu;if(eA.startsWith("agent-")){let ec=this.getStorageDir();try{for(let ed of(await tE.readdir(ec,{withFileTypes:!0}))){if(!ed.isDirectory())continue;let eg=tC.join(ec,ed.name,"subagents"),ep=tC.join(eg,`${eA}.jsonl`);try{if(await tE.access(ep),eu=await this.deserializeSessionFromPath(ep,el))return eu}catch{continue}}}catch{}}try{let ec=tp.PathUtils.getHomeProjectsDir();for(let ed of await tE.readdir(ec,{withFileTypes:!0})){if(!ed.isDirectory())continue;let eg=tC.join(ec,ed.name,`${eA}.jsonl`);try{if(await tE.access(eg),eu=await this.deserializeSessionFromPath(eg,el))return eu}catch{continue}}}catch{}}async deserializeSessionFromPath'
        },
        // Linux fix: McpManager.getConnectedServers always applies a timeout
        // (not just in non-interactive mode). Otherwise a stuck MCP server
        // makes Agent.buildMcpServers() (called on every prompt) hang forever
        // and the UI stays at "preparing". The original code only races with
        // a timeout when isNonInteractiveMode() is true.
        {
            from: 'async getConnectedServers(){if(this.isNonInteractiveMode())try{await A$.McpUtils.raceWithTimeout(this.allServersSettledDeferred.promise,()=>{this.logger.warn("MCP servers did not settle within timeout, proceeding with available servers"),this.allServersSettledDeferred.resolve()})}catch(eA){this.logger.debug("Failed to wait for servers to settle:",eA.message)}return this.connectedServersCache}',
            to: 'async getConnectedServers(){try{await A$.McpUtils.raceWithTimeout(this.allServersSettledDeferred.promise,()=>{this.logger.warn("[wb-linux] MCP servers did not settle within timeout, proceeding with available servers"),this.allServersSettledDeferred.resolve()})}catch(eA){this.logger.debug("Failed to wait for servers to settle:",eA.message)}return this.connectedServersCache}'
        }
    ];

    let patched = 0;
    let pathCompatPatched = 0;
    for (const { from, to } of exactReplacements) {
        if (cliSource.includes(to)) {
            patched++;
            if (to.includes('Invalid agent path entry') || to.includes('Invalid command path entry') || to.includes('Invalid skill path entry')) pathCompatPatched++;
            continue;
        }
        if (cliSource.includes(from)) {
            cliSource = cliSource.replace(from, to);
            patched++;
            if (to.includes('Invalid agent path entry') || to.includes('Invalid command path entry') || to.includes('Invalid skill path entry')) pathCompatPatched++;
        }
    }

    const pathObjectHelpers = 'let e$="string"==typeof eA?eA:eA&&"string"==typeof eA.path?eA.path:eA&&"string"==typeof eA.source?eA.source:void 0;if(!e$){ep.push(`Invalid agent path entry: ${JSON.stringify(eA)}`);continue}let el=(0,tZ.join)(eu,e$);(0,tW.existsSync)(el)||ep.push(`Agent path not found: ${e$}`)';
    const pathObjectReplacements = [
        {
            from: 'if(el.agents)for(let eA of"string"==typeof el.agents?[el.agents]:el.agents){let el=(0,tZ.join)(eu,eA);(0,tW.existsSync)(el)||ep.push(`Agent path not found: ${eA}`)}',
            to: 'if(el.agents)for(let eA of"string"==typeof el.agents?[el.agents]:el.agents){let e$="string"==typeof eA?eA:eA&&"string"==typeof eA.path?eA.path:eA&&"string"==typeof eA.source?eA.source:void 0;if(!e$){ep.push(`Invalid agent path entry: ${JSON.stringify(eA)}`);continue}let el=(0,tZ.join)(eu,e$);(0,tW.existsSync)(el)||ep.push(`Agent path not found: ${e$}`)}'
        },
        {
            from: 'if(el.commands)for(let eA of"string"==typeof el.commands?[el.commands]:el.commands){let el=(0,tZ.join)(eu,eA);(0,tW.existsSync)(el)||ep.push(`Command path not found: ${eA}`)}',
            to: 'if(el.commands)for(let eA of"string"==typeof el.commands?[el.commands]:el.commands){let e$="string"==typeof eA?eA:eA&&"string"==typeof eA.path?eA.path:eA&&"string"==typeof eA.source?eA.source:void 0;if(!e$){ep.push(`Invalid command path entry: ${JSON.stringify(eA)}`);continue}let el=(0,tZ.join)(eu,e$);(0,tW.existsSync)(el)||ep.push(`Command path not found: ${e$}`)}'
        },
        {
            from: 'if(el.skills)for(let eA of el.skills){let el=(0,tZ.join)(eu,eA);(0,tW.existsSync)(el)||ep.push(`Skill path not found: ${eA}`)}',
            to: 'if(el.skills)for(let eA of"string"==typeof el.skills?[el.skills]:el.skills){let e$="string"==typeof eA?eA:eA&&"string"==typeof eA.path?eA.path:eA&&"string"==typeof eA.source?eA.source:void 0;if(!e$){ep.push(`Invalid skill path entry: ${JSON.stringify(eA)}`);continue}let el=(0,tZ.join)(eu,e$);(0,tW.existsSync)(el)||ep.push(`Skill path not found: ${e$}`)}'
        }
    ];
    if (cliSource.includes(pathObjectHelpers)) {
        pathCompatPatched = Math.max(pathCompatPatched, 3);
    } else {
        for (const { from, to } of pathObjectReplacements) {
            if (cliSource.includes(to)) {
                pathCompatPatched++;
            } else if (cliSource.includes(from)) {
                cliSource = cliSource.replace(from, to);
                pathCompatPatched++;
            }
        }
    }

    const sessionReplayPatched = cliSource.includes('findSessionAcrossProjects') || cliSource.includes('getHomeProjectsDir();for(let ed of await');
    if (sessionReplayPatched && !exactReplacements[3].to.includes('findSessionAcrossProjects')) patched = Math.max(patched, pathCompatPatched + 1);

    const mcpNewFrom = 'eA&&!this.allServersSettled()&&await this.serverCollectionSubject.pipe((0,AG.filter)(()=>this.allServersSettled()),(0,AH.take)(1),(0,Aj.timeout)(AZ.McpUtils.getMcpTimeout()??3e4),(0,AK.catchError)(()=>(this.logger.warn("MCP servers did not settle within timeout, proceeding with available servers"),(0,AU.of)(void 0)))).toPromise()';
    const mcpNewTo = '!this.allServersSettled()&&await this.serverCollectionSubject.pipe((0,AG.filter)(()=>this.allServersSettled()),(0,AH.take)(1),(0,Aj.timeout)(AZ.McpUtils.getMcpTimeout()??3e4),(0,AK.catchError)(()=>(this.logger.warn("[wb-linux] MCP servers did not settle within timeout, proceeding with available servers"),(0,AU.of)(void 0)))).toPromise()';
    let mcpPatched = cliSource.includes(mcpNewTo) || cliSource.includes('[wb-linux] MCP servers did not settle within timeout');
    if (!mcpPatched && cliSource.includes(mcpNewFrom)) {
        cliSource = cliSource.replace(mcpNewFrom, mcpNewTo);
        mcpPatched = true;
    }

    patched = Math.max(patched, pathCompatPatched + (sessionReplayPatched ? 1 : 0) + (mcpPatched ? 1 : 0));

    if (pathCompatPatched === 3 && sessionReplayPatched && mcpPatched) {
        fs.writeFileSync(codebuddyPath, cliSource);
        log('patched cli/dist/codebuddy.js (extension path object compatibility, session replay fallback, MCP settle timeout in interactive mode)');
        markOptional('cliExtensionPathObjectCompat', true);
        markOptional('cliSessionReplayAcrossProjectsFallback', true);
        markOptional('cliMcpSettleTimeoutInteractive', true);
    } else {
        markOptional('cliExtensionPathObjectCompat', false);
        markOptional('cliSessionReplayAcrossProjectsFallback', false);
        markOptional('cliMcpSettleTimeoutInteractive', false);
        console.warn('[apply-linux-patches] failed to patch all cli compatibility points: ' + patched + '/5');
    }
}

patchCliDistCodebuddy();

// ---------------------------------------------------------------------------
// Ensure the Linux @lydell/node-pty platform package is present in the asar's node_modules
// so that require("@lydell/node-pty-linux-*") resolves from within the
// asar. The package lives on disk in app.asar.unpacked/node_modules/ but
// was never registered in the original macOS asar header. We copy it into
// the tmpDir so the repack step includes it as an unpacked entry.
// ---------------------------------------------------------------------------
const lydellPackageBasename = lydellPlatformPackage.split('/')[1];
if (!lydellPackageBasename) {
    console.error('[apply-linux-patches] ERROR: could not extract package basename from ' + lydellPlatformPackage);
    process.exit(2);
}
const lydellLinuxSrc = path.join(unpackedSiblingDir, 'node_modules', '@lydell', lydellPackageBasename);
const lydellLinuxDst = path.join(tmpDir, 'node_modules', '@lydell', lydellPackageBasename);
if (fs.existsSync(lydellLinuxSrc) && !fs.existsSync(lydellLinuxDst)) {
    fs.cpSync(lydellLinuxSrc, lydellLinuxDst, { recursive: true });
    log('copied ' + lydellPlatformPackage + ' into asar source for repack');
    markOptional('lydellPlatformPackageRegistered', true);
} else if (fs.existsSync(lydellLinuxDst)) {
    markOptional('lydellPlatformPackageRegistered', true);
} else {
    // On architectures without a prebuilt @lydell/node-pty platform package
    // (e.g. loong64), node-pty is rebuilt from source and the platform-
    // package-specific require() hook is irrelevant. Mark optional so the
    // build can proceed with source-built node-pty.
    markOptional('lydellPlatformPackageRegistered', false);
}

// ---------------------------------------------------------------------------
// 3. Repack.
//
// @electron/asar's glob-based --unpack matcher has O(2^n) behaviour on a
// brace list the size of ours (~850 entries). Instead we build a Set of
// the original unpacked paths, use a catch-all minimatch pattern that
// accepts everything, and pass a `dot: true` pattern per directory. But
// the cleanest route with the public API is: pass a minimatch function
// that is fast. Turns out the simplest workable approach is to use the
// pattern scheme once per "class" of entry. On inspection, the original
// header's unpacked set is exactly:
//     cli/**   +   resources/**   +   a specific subset of node_modules/**
//
// For node_modules, the unpacked subset is always a whole package tree
// (better-sqlite3, @lydell/*, node-pty, nunjucks, @tencent/docs-engine).
//
// We compute that per-top-level-dir unpacked set dynamically from the
// original header and emit an asar `--unpack=…` pattern that names each
// top-level directory that must be fully unpacked. That's small enough
// for minimatch to handle in microseconds.
// ---------------------------------------------------------------------------
function collectFullyUnpackedDirs() {
    // Find every directory where 100% of its immediate children are unpacked
    // (recursively). Start from each top-level dir.
    const dirs = [];
    function visit(node, relPath) {
        if (!node.files) return { total: 0, unpacked: 0 };
        let total = 0, unpacked = 0;
        for (const [name, entry] of Object.entries(node.files)) {
            const child = relPath ? relPath + '/' + name : name;
            if (entry.files) {
                const sub = visit(entry, child);
                total += sub.total;
                unpacked += sub.unpacked;
            } else if (entry.link) {
                // links aren't packed or unpacked; ignore for the ratio
            } else {
                total++;
                if (entry.unpacked) unpacked++;
            }
        }
        if (total > 0 && total === unpacked && relPath) {
            dirs.push(relPath);
        }
        return { total, unpacked };
    }
    visit(header, '');
    // Only keep maximal directories (drop any dir whose parent is also in
    // the set), so the asar glob pattern stays minimal.
    const set = new Set(dirs);
    return dirs.filter(d => {
        const parts = d.split('/');
        for (let i = 1; i < parts.length; i++) {
            const parent = parts.slice(0, i).join('/');
            if (set.has(parent)) return false;
        }
        return true;
    });
}

const fullyUnpackedDirs = collectFullyUnpackedDirs();
// Also include any Linux platform packages we injected into the tmpDir
// that weren't in the original macOS header.
const extraUnpackDirs = ['node_modules/@lydell/' + lydellPackageBasename];
for (const d of extraUnpackDirs) {
    if (fs.existsSync(path.join(tmpDir, d)) && !fullyUnpackedDirs.includes(d)) {
        fullyUnpackedDirs.push(d);
    }
}
log('Fully-unpacked top directories: ' + fullyUnpackedDirs.length);

// Also compute any individual unpacked files that live in partially-packed
// directories (e.g. a single file under node_modules/foo/ where only that
// one file is unpacked).
const partialUnpackedFiles = [];
function findPartialFiles(node, relPath) {
    if (!node.files) return;
    if (fullyUnpackedDirs.includes(relPath)) return; // covered by unpackDir
    for (const [name, entry] of Object.entries(node.files)) {
        const child = relPath ? relPath + '/' + name : name;
        if (entry.files) {
            if (!fullyUnpackedDirs.includes(child)) {
                findPartialFiles(entry, child);
            }
        } else if (entry.unpacked && !entry.link) {
            // Is the child's directory already in the fully-unpacked set?
            const parent = child.split('/').slice(0, -1).join('/');
            if (!fullyUnpackedDirs.some(d => parent === d || parent.startsWith(d + '/'))) {
                partialUnpackedFiles.push(child);
            }
        }
    }
}
findPartialFiles(header, '');
log('Partially-unpacked individual files: ' + partialUnpackedFiles.length);

// ---------------------------------------------------------------------------
// 关键修正（5.9.x）：部分解包的文件**不能**用 options.unpack 表达。
//
// @electron/asar 的 shouldUnpackPath() 对文件分支传的是
// path.relative(src, path.dirname(filename))，也就是**父目录**，
// 再用 minimatch(parentDir, pattern, { matchBase: true }) 去比。
// 因此过去那种 "{renderer/assets/a.woff,main/qimei-helper.js,...}" 的文件级
// brace glob 一次都匹配不上——5.9.3 实测有 323 个原本 unpacked 的文件被静默
// 塞进 asar（asar 反而涨了 16MB），其中包含 .node 与渲染资源。
//
// 只有 unpackDir（目录级）能真正生效。这里把"部分解包文件"的父目录并进
// unpackDir 集合：语义上会多解包几个同目录的兄弟文件，所以 pack 之后要把
// staging sidecar 合并回真实 app.asar.unpacked，保证每个 unpacked 条目在
// 磁盘上都有实体文件，否则运行期会 ENOENT。
// ---------------------------------------------------------------------------
const escGlob = p => p.replace(/[{}(),*?[\]!|+@\\]/g, ch => '\\' + ch);
const partialDirs = [...new Set(partialUnpackedFiles.map(p => p.split('/').slice(0, -1).join('/')))];
for (const d of partialDirs) {
    if (d && !fullyUnpackedDirs.includes(d)) fullyUnpackedDirs.push(d);
}
log('Unpack directories (fully-unpacked + partial parents): ' + fullyUnpackedDirs.length);

// Drop any dir whose ancestor is already in the set: the asar matcher treats a
// matched dir as "everything below it", so children are redundant.
const unpackDirSet = new Set(fullyUnpackedDirs);
const minimalUnpackDirs = fullyUnpackedDirs.filter(d => {
    const parts = d.split('/');
    for (let i = 1; i < parts.length; i++) {
        if (unpackDirSet.has(parts.slice(0, i).join('/'))) return false;
    }
    return true;
});
const unpackDirPattern = '{' + minimalUnpackDirs.map(escGlob).join(',') + '}';
const unpackPattern = undefined; // 见上：文件级 unpack glob 无效
log('unpackDir 条目: ' + minimalUnpackDirs.length + '（pattern 长度 ' + unpackDirPattern.length + '）');

assertRequiredPatches();

// ---------------------------------------------------------------------------
// Pack.
//
// We only edit main/index.js, which lives inside the asar (packed). The
// sibling <asar>.unpacked/ sidecar directory therefore does not need to
// change — and we explicitly avoid touching it so that any files the
// install.sh step already placed there (e.g. rebuilt native modules,
// Linux ripgrep binary, the original resources/icon.png) stay as-is.
//
// The repack produces its own sidecar directory matching the header's
// unpack set. We throw that output away.
// ---------------------------------------------------------------------------
(async () => {
    if (FLAGS.dryRun) {
        summarizeReport();
        log('--dry-run：只分析不落盘，app.asar 保持原样');
        const dryReport = path.join(os.tmpdir(), 'wb-patch-report.' + Date.now() + '.json');
        fs.writeFileSync(dryReport, JSON.stringify(patchReport, null, 2));
        log('dry-run 报告：' + dryReport);
        return;
    }
    const outPath = asarPath + '.new';
    const stagingSidecar = outPath + '.unpacked';
    try { fs.rmSync(outPath, { force: true }); } catch (_) {}
    try { fs.rmSync(stagingSidecar, { recursive: true, force: true }); } catch (_) {}

    await asar.createPackageWithOptions(tmpDir, outPath, {
        unpackDir: unpackDirPattern,
        unpack: unpackPattern,
    });
    log('wrote ' + path.basename(outPath) + ' (' + fs.statSync(outPath).size + ' bytes)');

    // Atomically replace app.asar only. Leave app.asar.unpacked alone.
    fs.renameSync(asarPath, asarPath + '.prepatch');
    try {
        fs.renameSync(outPath, asarPath);
    } catch (err) {
        // Roll back on failure.
        try { fs.renameSync(asarPath + '.prepatch', asarPath); } catch (_) {}
        throw err;
    }
    try { fs.rmSync(asarPath + '.prepatch'); } catch (_) {}

    // 合并 repack 的 sidecar 到真实 app.asar.unpacked。
    //
    // 新 header 里 unpacked=true 的条目必须能在磁盘上找到实体文件，否则
    // require()/dlopen() 会 ENOENT。pack 阶段因为用了目录级 unpackDir，
    // 解包范围是原始集合的超集，多出来的兄弟文件需要补到 sidecar 里。
    //
    // 覆盖策略：tmpDir 才是权威副本（它由原 sidecar + 本脚本的改动合成），
    // 因此按 tmpDir 覆写 sidecar。否则像 main/main-bootstrap.js 这种"原本就在
    // sidecar 里、又被补丁改过"的文件会保留旧版本，补丁静默丢失。
    const mergeSidecar = (srcDirAbs, dstDirAbs) => {
        if (!fs.existsSync(srcDirAbs)) return { synced: 0 };
        let synced = 0;
        const walkMerge = (src, rel) => {
            for (const e of fs.readdirSync(src, { withFileTypes: true })) {
                const s = path.join(src, e.name);
                const r = rel ? rel + '/' + e.name : e.name;
                const d = path.join(dstDirAbs, r);
                if (e.isDirectory()) {
                    fs.mkdirSync(d, { recursive: true });
                    walkMerge(s, r);
                    continue;
                }
                try {
                    fs.mkdirSync(path.dirname(d), { recursive: true });
                    fs.cpSync(s, d, { force: true });
                    synced++;
                } catch (_) {}
            }
        };
        walkMerge(srcDirAbs, '');
        return { synced };
    };
    try {
        const merged = mergeSidecar(stagingSidecar, asarPath + '.unpacked');
        log('synced unpacked entries into app.asar.unpacked: ' + merged.synced);
    } catch (err) {
        console.warn('[apply-linux-patches] sidecar merge failed: ' + err.message);
    }
    try { fs.rmSync(stagingSidecar, { recursive: true, force: true }); } catch (_) {}

    const reportPath = path.join(path.dirname(asarPath), '..', '.workbuddy-linux', 'patch-report.json');
    summarizeReport();
    try {
        fs.mkdirSync(path.dirname(reportPath), { recursive: true });
        fs.writeFileSync(reportPath, JSON.stringify(patchReport, null, 2));
        log('patch report: ' + reportPath);
    } catch (err) {
        console.warn('[apply-linux-patches] failed to write patch report: ' + err.message);
    }

    const retired = Object.entries(patchReport.patches)
        .filter(([, p]) => p.status === STATUS.UPSTREAM)
        .map(([n]) => n);
    if (retired.length) {
        log('可退役补丁（上游已原生实现）: ' + retired.join(', '));
    }

    log('replaced app.asar in place (app.asar.unpacked left untouched)');
})().catch(err => {
    console.error('[apply-linux-patches] pack failed:', err);
    process.exit(6);
});
