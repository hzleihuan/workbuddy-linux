SHELL := /bin/bash

.PHONY: help deps download build-app run-app deb rpm pacman appimage package install check clean all port

help:
	@echo "Targets:"
	@echo "  make all [ARGS=\"...\"]      # 一条命令：下载 -> 解压 -> 补丁/转换 -> 打包"
	@echo "  make port ARGS=\"...\"       # 同上，显式按 loong64 构建"
	@echo "  make deps"
	@echo "  make download              # fetch latest WorkBuddy DMG via official API"
	@echo "  make build-app"
	@echo "  make build-app DMG=/path/to/WorkBuddy.dmg"
	@echo "  make run-app"
	@echo "  make deb"
	@echo "  make rpm"
	@echo "  make pacman"
	@echo "  make appimage"
	@echo "  make package               # auto-detect: deb / rpm / pacman / appimage"
	@echo "  make install"
	@echo "  make check"
	@echo "  make clean"

deps:
	bash scripts/install-deps.sh

build-app:
	@if [ -n "$(DMG)" ]; then bash install.sh "$(DMG)"; else bash install.sh; fi

run-app:
	bash workbuddy-app/start.sh

deb:
	bash scripts/build-deb.sh

rpm:
	bash scripts/build-rpm.sh

pacman:
	bash scripts/build-pacman.sh

appimage:
	bash scripts/build-appimage.sh

package:
	bash scripts/package.sh

download:
	bash scripts/download-dmg.sh

# 一条命令完成：下载 -> 解压 -> 打补丁/转换 -> 打包（-> 可选安装）
# 示例：
#   make all                        # 自动下载/使用 downloads/ 里的 DMG，按本机架构构建并打包
#   make all ARGS="--dmg /path/to/WorkBuddy.dmg --format deb"
#   make all ARGS="--runtime-from /opt/WorkBuddy --install"
all:
	bash scripts/pipeline.sh $(ARGS)

# 显式 loong64 变体（需要 loong64 参考运行时，见 docs/build-from-dmg-loong64.md）
port:
	bash scripts/pipeline.sh --arch loong64 $(ARGS)

install:
	bash scripts/install-package.sh

check:
	bash -n install.sh scripts/*.sh scripts/lib/*.sh
	node --check scripts/lib/apply-linux-patches.js
	bash scripts/check-portability.sh

clean:
	rm -rf workbuddy-app workbuddy-app-next dist dist-next
	rm -rf .asar-tool .asar-extract .test-repack.asar .test-repack.asar.unpacked
	rm -f .tmp-asar-tool.js .tmp-asar-repack.js
	rm -rf dist/AppDir dist/deb-root
