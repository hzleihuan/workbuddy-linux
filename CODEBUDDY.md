# CODEBUDDY.md This file provides guidance to CodeBuddy when working with code in this repository.

## Commands

### Install system dependencies (first time)
```bash
bash scripts/install-deps.sh
```
Auto-detects package manager (apt/dnf/pacman/zypper), installs Node.js 22+, 7zip, C++ toolchain, X11/libsecret/krb5 dev headers, and packaging tools. Supports `NODEJS_MAJOR=22` override.

### Build the Linux app from a DMG
```bash
make build-app
# or with explicit DMG path:
make build-app DMG=/path/to/WorkBuddy.dmg
```
Expects exactly one official macOS Intel/x64 DMG in `downloads/` unless explicitly passed. Runs the full pipeline: DMG extraction → Electron runtime download → app payload copy → native module rebuild → asar runtime patching → launcher + desktop entry generation.

### Quick run (without packaging)
```bash
make run-app
```
Launches the built app via `workbuddy-app/start.sh`. Useful for testing before creating installable packages.

### Package for the current distro
```bash
make package           # auto-detect format (deb/rpm/pacman/appimage)
PACKAGE_FORMAT=appimage make package  # force a specific format
make deb               # Debian/Ubuntu
make rpm               # Fedora/RHEL
make pacman            # Arch Linux
make appimage          # Portable AppImage
```

### Install the built package
```bash
make install
```
Finds the latest artifact in `dist/` and installs via the native package manager.

### Run portability checks
```bash
make check
```
Runs `bash -n` syntax checks on all shell scripts, `node --check` on the patcher, and `check-portability.sh` which asserts that critical Linux fixes (Unity XDG_CURRENT_DESKTOP injection, MCP_TIMEOUT, patch-report.json generation, version sync) are present and correctly wired.

### Clean build artifacts
```bash
make clean
```
Removes `workbuddy-app/`, `dist/`, and temporary asar extraction directories.

## Architecture

This project is a **macOS-to-Linux Electron app converter** — it takes a user-provided official WorkBuddy macOS DMG and transforms it into a fully functional Linux Electron application. It does NOT redistribute WorkBuddy binaries; users must supply their own DMG.

### High-level pipeline

```
DMG (user-provided)
  → 7z extraction → .app bundle
    → detect Electron version from plist
    → download matching Linux Electron runtime
    → copy app.asar + app.asar.unpacked to workbuddy-app/
    → 4-phase native module rebuild
    → asar runtime patching (11+ Linux-specific fixes)
    → launcher script + desktop entry generation
  → per-distro packaging (deb/rpm/pacman/appimage)
  → local installation
```

### Key files and their roles

**`install.sh`** — The orchestrator. Sources all library modules from `scripts/lib/` and drives the entire build pipeline. Key entry points: `parse_args`, `resolve_input_path`, `resolve_app_bundle`, `main`. Writes launcher scripts (`start.sh`, `start-local.sh`), desktop entries, and build metadata (`build-info.json`). Has a `--fresh` flag to force clean rebuild.

**`scripts/lib/dmg.sh`** — DMG discovery and metadata extraction. `resolve_input_path()` finds the DMG (from explicit path, `downloads/`, or already-extracted `.app` fallback). `resolve_app_bundle()` extracts DMG with `7z`/`7zz` (requires v21+). `detect_electron_version()` reads Electron version from `Electron Framework.framework` plist, falls back to `package.json` devDependencies. `read_app_version()` / `read_app_full_version()` extract upstream version strings from `Info.plist` for version tracking.

**`scripts/lib/electron.sh`** — Downloads the Linux Electron runtime matching the DMG's Electron version from GitHub Releases. Implements file-based locking (`mkdir` as mutex) for cache safety and supports custom mirrors via `ELECTRON_MIRROR` env var.

**`scripts/lib/native-modules.sh`** — The 4-phase native module rebuild system (~520 lines):

1. **Phase 1 — Purge**: Deletes all non-Linux platform packages (darwin/win32 `@lydell/node-pty-*`, `fsevents`, Windows-only VS Code modules, `@tencent/docs-engine` darwin-arm64 binaries, sandbox DLLs/EXEs).
2. **Phase 2 — Deep scan**: Uses `file` command to detect and remove any remaining Mach-O or PE binaries missed in Phase 1.
3. **Phase 3 — Rebuild**: For each critical module (`node-pty`, `better-sqlite3`), reads the exact version from the DMG's `package.json`, installs full npm source in a temp directory, then runs `@electron/rebuild` against the target Electron headers. Optional modules (`native-keymap`, `native-watchdog`, `@vscode/spdlog`, `@vscode/sqlite3`, `kerberos`) are rebuilt with `allow_fail=1`. After rebuild, re-runs Phase 1+2 to clean any platform-specific artifacts the rebuild may have introduced.
4. **Phase 4 — Install Linux packages**: Installs `@lydell/node-pty-linux-{x64,arm64}` prebuilt package (architecture-aware via `lydell_node_pty_linux_package()`), refreshes `@vscode/ripgrep` and `@parcel/watcher` from npm, and copies the Linux `rg` binary into `cli/vendor/ripgrep/`.

Critical design decision: every rebuild happens in isolated temp directories under `$WORK_DIR`, never polluting the project tree. The function `build_native_module_fresh()` is the workhorse — it creates a mini npm project, installs Electron + the module, runs `@electron/rebuild`, verifies `.node` output, then copies the result back.

**`scripts/lib/linux-patches.sh`** — Thin shell wrapper that installs `@electron/asar` into a per-build temp dir and invokes the Node.js patcher. The patcher requires the `@lydell/node-pty` platform package name as an argument for architecture correctness.

**`scripts/lib/apply-linux-patches.js`** — The asar runtime patcher (~1500+ lines). Extracts `app.asar` to a temp directory, edits `main/index.js` (and optionally `cli/dist/codebuddy.js`), then repacks. Key patches applied:

- **Patch 1 (E2BIG shim)**: A Proxy over `process.env` that stores `ACC_PRODUCT_CONFIG_V3`/`_V2` (~260KB JSON) in a private JS slot, hiding them from libc environ enumeration. This prevents Chromium's internal `/proc/self/exe` spawns from failing with E2BIG due to exceeding Linux's 128KB `MAX_ARG_STRLEN` per env string.
- **Patch 2 (Tray menu)**: On Linux, calls `tray.setContextMenu()` after tray construction because `libayatana-appindicator` never emits `click`/`right-click` events.
- **Patch 3 (Tray icon)**: Constructs Tray from an on-disk PNG path instead of in-memory NativeImage because AppIndicator cannot render NativeImage bytes.
- **Patch 4 (Disable auto-update)**: Stubs out update menu items and RPC handlers — macOS ShipIt / Windows Squirrel don't apply on Linux.
- **Patch 4b (Sidecar spawn E2BIG)**: Monkey-patches `child_process.spawn/spawnSync` and `node-pty` to spill env entries >100KB to temp files, passing `*_FILE` pointers instead. A sidecar-entry shim reads the file back and re-injects via Proxy.
- **Patch 5 (Window buttons)**: Injects CSS+JS for minimize/maximize/close buttons on X11 (Wayland has native `titleBarOverlay`, X11 doesn't).
- **Patch 6 (Disable update menu)**: Greys out the "Check for Updates" menu entry.
- **Patches 7A-7F (Timeout races)**: Wraps `prepareNodeRuntimeEnv` (5s), `composePromptForBackend` (5s), `resolveRuntimeConfig` (5s), `runPreCliAuth` (30s), `isCliInstalled` (6s), and `buildCommandEnv` (5s) with `Promise.race` timeouts. These prevent the UI from blocking indefinitely when `BinaryManager.doInitialize()` hangs or remote RPCs are slow on first launch.
- **Patch 9 (WeChat/Mini Program reconnect)**: Delays and replays `wechatmp` integration registration after Claw lifecycle startup so remote control survives app restarts.
- **Patch 10 (Env copy fix)**: Ensures `spillOversizedEnv()` always builds a plain object copy of env, explicitly adding hidden `ACC_PRODUCT_CONFIG_V3/V2` keys to child processes.
- **Patch 11 (5.1.1 anchor update)**: Updates anchor strings for `composePromptForBackend` to match 5.x code structure changes.

Each patch is either **required** (build fails if anchor not matched) or **optional** (anchor mismatch is a warning, patch is skipped). Results are written to `patch-report.json`. The patcher also injects `@lydell/node-pty-linux-{x64,arm64}` into the repacked asar as an unpacked entry so the sidecar process can find it.

**`scripts/install-deps.sh`** — Multi-distro dependency installer. Detects `apt`/`dnf5`/`dnf`/`pacman`/`zypper`, installs system packages, ensures Node.js 20+ (installs from NodeSource on apt if needed). Supports `NODEJS_MAJOR` override.

**`scripts/package.sh`** — Detects available package builder (`dpkg-deb`/`rpmbuild`/`makepkg`/`curl` for AppImage) and dispatches to the format-specific build script. Supports `PACKAGE_FORMAT` override.

**`scripts/check-portability.sh`** — Assertion-based portability checker run by `make check`. Verifies that start.sh templates inject `Unity` into `XDG_CURRENT_DESKTOP` and set `MCP_TIMEOUT=3000`, that `write_package_version` and `PACKAGE_VERSION` exports exist, that AppImage builder is registered, and that the native module flow uses architecture-aware package mapping rather than hard-coded `node-pty-linux-x64`.

### Generated outputs

- `workbuddy-app/` — The built Linux app directory containing `electron` binary, `resources/app.asar` (patched), `resources/app.asar.unpacked` (rebuilt native modules), `start.sh` launcher, `.workbuddy-linux/` (icon, desktop entry, build-info.json, patch-report.json, native-cleanup-report.json, version file).
- `dist/` — Per-distro packages (`workbuddy_*.deb`, `workbuddy-*.rpm`, `workbuddy-*.pkg.tar.zst`, `WorkBuddy-*.AppImage`).
- `build/` — Extracted DMG cache (reused across builds).

### Versioning and compatibility

The project tracks upstream DMG versions in `CHANGELOG.md` using `<upstream-version>+wb<iteration>` format. Currently verified against DMG versions 4.22.10, 5.0.3, and 5.1.1. When a new upstream DMG is released, patch anchors in `apply-linux-patches.js` may break — the build will fail on missing required patches or warn on missing optional ones. Upgraders should check `patch-report.json` after building and adjust anchor strings in the patcher.

### Architecture support

All scripts detect the host CPU via `uname -m` and map it to the appropriate platform naming conventions:

| Host arch (`uname -m`) | Electron arch | `@lydell/node-pty` package | Notes |
|---|---|---|---|
| `x86_64` | `x64` | `@lydell/node-pty-linux-x64` | Fully supported, prebuilt packages available |
| `aarch64` | `arm64` | `@lydell/node-pty-linux-arm64` | Fully supported, prebuilt packages available |
| `armv7l` | `armv7l` | *(source build only)* | Community support, no prebuilt pty package |
| `loongarch64` | `loong64` | *(source build only)* | Loongson/LoongArch. Electron requires community build via `ELECTRON_MIRROR`. `node-pty` is rebuilt from source via Phase 3 of the native module pipeline; the `@lydell/node-pty-linux-loong64` prebuilt does not exist on npm. AppImage is not supported (no loong64 appimagetool); use `make deb` for Loongnix/Debian-based systems.

### Environment variables that affect behavior

- `WORKBUDDY_APP_ID` / `WORKBUDDY_APP_DISPLAY_NAME` — Customize app identity
- `WORKBUDDY_INSTALL_DIR` — Override output directory (default: `./workbuddy-app`)
- `ELECTRON_MIRROR` — Custom Electron download mirror
- `ELECTRON_HEADERS_URL` — Custom Electron headers dist URL for native rebuilds
- `ELECTRON_LOCAL_ZIP` — Path to local Electron zip file (for architectures without official binaries, e.g. loong64). Version is auto-detected from the filename pattern `electron-vX.Y.Z-*.zip`.
- `ELECTRON_VERSION` — Override Electron version (normally auto-detected from DMG)
- `PACKAGE_FORMAT` — Force package format (`deb`/`rpm`/`pacman`/`appimage`)
- `WORKBUDDY_DISABLE_SANDBOX` — Set to 1 to disable Chromium sandbox (debug only)
- `WORKBUDDY_LOCAL_MODE` — Set to 1 to start local CLI Web UI instead of Desktop
- `MCP_TIMEOUT` — Override MCP server settle timeout (default: 3000ms in generated launcher)
