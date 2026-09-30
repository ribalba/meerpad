# meerpad desktop (Electron) build & run helpers.
#
# The app points at the hosted https://meerpad.com unless MEERPAD_URL says
# otherwise (see main.js). Override it on the command line, e.g.
#   make start MEERPAD_URL=http://localhost:8050
# meerpic's Makefile, plus meerato's registration of the URL scheme: sign-in
# on the desktop arrives as a meerpad:// link, and the desktop has to know
# that this app opens those.

MEERPAD_URL ?= https://meerpad.com
export MEERPAD_URL

NPM ?= npm

# Where `distinstall` puts things. Everything lands under the user's own dirs,
# so no root is needed. Override e.g. with  make distinstall XDG_DATA_HOME=/opt/share
BIN_DIR       := $(HOME)/.local/bin

# Linux: an AppImage plus an XDG desktop entry.
XDG_DATA_HOME ?= $(HOME)/.local/share
APP_HOME      := $(XDG_DATA_HOME)/meerpad
APP_IMAGE     := $(APP_HOME)/meerpad.AppImage
DESKTOP_DIR   := $(XDG_DATA_HOME)/applications
DESKTOP_FILE  := $(DESKTOP_DIR)/meerpad.desktop
ICON_DIR      := $(XDG_DATA_HOME)/icons/hicolor/512x512/apps

# macOS: the .app bundle itself is the install. ~/Applications rather than
# /Applications keeps it to this user and needs no sudo; Spotlight, Launchpad
# and the Dock all index it just the same. The bundle registers meerpad:// on
# its own (Info.plist, from "protocols" in package.json).
MAC_APP_DIR   ?= $(HOME)/Applications
MAC_APP       := $(MAC_APP_DIR)/meerpad.app

# `distinstall` means something different per desktop, so it is one name in
# front of two recipes rather than a Linux-only target that fails everywhere
# else with a puzzling "no AppImage in dist/".
ifeq ($(shell uname -s),Darwin)
INSTALL_KIND := macos
else
INSTALL_KIND := linux
endif

.PHONY: help install start pack dist clean distinstall distuninstall \
        distinstall-linux distuninstall-linux distinstall-macos distuninstall-macos

help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | \
		awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-14s\033[0m %s\n", $$1, $$2}'

install: ## Install dependencies
	$(NPM) install

start: ## Run the app against $(MEERPAD_URL)
	env -u ELECTRON_RUN_AS_NODE $(NPM) start

pack: ## Build an unpacked app into dist/ (no installer)
	$(NPM) run pack

dist: ## Build distributable installers into dist/
	$(NPM) run dist

distinstall: distinstall-$(INSTALL_KIND) ## Build and install the app for this desktop (macOS or Linux)

distuninstall: distuninstall-$(INSTALL_KIND) ## Remove what distinstall put in place

# The desktop entry names the scheme (MimeType) and `%u` hands the link to the
# app; xdg-mime then makes this entry the handler, which is the step that
# lets a click on the sign-in mail reach the window.
distinstall-linux: dist
	@set -e; \
	src=$$(ls -t dist/*.AppImage 2>/dev/null | head -n 1); \
	if [ -z "$$src" ]; then echo "No AppImage in dist/; is 'linux' a build target?" >&2; exit 1; fi; \
	echo "Installing $$src -> $(APP_IMAGE)"; \
	mkdir -p "$(APP_HOME)" "$(BIN_DIR)" "$(DESKTOP_DIR)" "$(ICON_DIR)"; \
	install -m 0755 "$$src" "$(APP_IMAGE)"; \
	install -m 0644 build/icon.png "$(ICON_DIR)/meerpad.png"; \
	ln -sfn "$(APP_IMAGE)" "$(BIN_DIR)/meerpad"; \
	printf '%s\n' \
		'[Desktop Entry]' \
		'Type=Application' \
		'Name=meerpad' \
		'GenericName=Notes' \
		'Comment=Notes, docs and wikis that are yours. Offline first, open source.' \
		'Exec=env MEERPAD_URL=$(MEERPAD_URL) $(APP_IMAGE) %u' \
		'TryExec=$(APP_IMAGE)' \
		'Icon=meerpad' \
		'Terminal=false' \
		'Categories=Office;TextEditor;' \
		'Keywords=notes;wiki;docs;notion;meerpad;' \
		'MimeType=x-scheme-handler/meerpad;' \
		'StartupNotify=true' \
		'StartupWMClass=meerpad' \
		> "$(DESKTOP_FILE)"; \
	chmod 0644 "$(DESKTOP_FILE)"; \
	command -v desktop-file-validate >/dev/null 2>&1 && desktop-file-validate "$(DESKTOP_FILE)" || true; \
	command -v update-desktop-database >/dev/null 2>&1 && update-desktop-database "$(DESKTOP_DIR)" || true; \
	command -v xdg-mime >/dev/null 2>&1 && xdg-mime default meerpad.desktop x-scheme-handler/meerpad || true; \
	command -v gtk-update-icon-cache  >/dev/null 2>&1 && gtk-update-icon-cache -f -t "$(XDG_DATA_HOME)/icons/hicolor" >/dev/null 2>&1 || true; \
	for k in kbuildsycoca6 kbuildsycoca5; do command -v $$k >/dev/null 2>&1 && $$k >/dev/null 2>&1 && break; done; true; \
	echo "Installed. Launch from your app menu, or run 'meerpad' (needs $(BIN_DIR) on PATH)."

distuninstall-linux:
	@rm -f "$(DESKTOP_FILE)" "$(ICON_DIR)/meerpad.png" "$(BIN_DIR)/meerpad" "$(APP_IMAGE)"
	@rmdir "$(APP_HOME)" 2>/dev/null || true
	@command -v update-desktop-database >/dev/null 2>&1 && update-desktop-database "$(DESKTOP_DIR)" || true
	@command -v gtk-update-icon-cache  >/dev/null 2>&1 && gtk-update-icon-cache -f -t "$(XDG_DATA_HOME)/icons/hicolor" >/dev/null 2>&1 || true
	@for k in kbuildsycoca6 kbuildsycoca5; do command -v $$k >/dev/null 2>&1 && $$k >/dev/null 2>&1 && break; done; true
	@echo "Uninstalled."

# The .dmg is for handing to someone else; installing here means the bundle
# electron-builder already staged. Copied with ditto rather than cp, which is
# the one that carries a bundle's symlinks, extended attributes and code
# signature across intact: an arm64 build is ad-hoc signed and will not launch
# if the copy breaks that.
distinstall-macos: dist
	@set -e; \
	src=$$(ls -td dist/mac*/meerpad.app 2>/dev/null | head -n 1); \
	if [ -z "$$src" ]; then echo "No meerpad.app in dist/; is 'mac' a build target?" >&2; exit 1; fi; \
	echo "Installing $$src -> $(MAC_APP)"; \
	mkdir -p "$(MAC_APP_DIR)" "$(BIN_DIR)"; \
	rm -rf "$(MAC_APP)"; \
	ditto "$$src" "$(MAC_APP)"; \
	ln -sfn "$(MAC_APP)/Contents/MacOS/meerpad" "$(BIN_DIR)/meerpad"; \
	echo "Installed. Launch from Spotlight or Launchpad, or run 'meerpad' (needs $(BIN_DIR) on PATH)."; \
	if [ "$(MEERPAD_URL)" != "https://meerpad.com" ]; then \
		echo; \
		echo "Note: MEERPAD_URL is not baked into the bundle. macOS does not give a"; \
		echo "      Finder launch your shell environment, so the app menu starts it on"; \
		echo "      the default https://meerpad.com. To reach $(MEERPAD_URL),"; \
		echo "      run 'meerpad' from a shell that has MEERPAD_URL set."; \
	fi

distuninstall-macos:
	@rm -rf "$(MAC_APP)"
	@rm -f "$(BIN_DIR)/meerpad"
	@rmdir "$(MAC_APP_DIR)" 2>/dev/null || true
	@echo "Uninstalled."

clean: ## Remove build output
	rm -rf dist
