# Codex Desktop — Simplified Chinese UI

> **Codex Desktop on Windows has an English UI. This tool makes it Chinese.**
> Download → extract → double-click → done. Fully reversible.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Platform](https://img.shields.io/badge/platform-Windows%2010%2F11-0078d4.svg)](#windows-localization)
[![macOS](https://img.shields.io/badge/macOS-install%20only-000000.svg?logo=apple)](#macos-install-only)

**GitHub**：https://github.com/Nooonnneee/codex-zh-cn　·　**Gitee**：https://gitee.com/Flower_ly/codex-zh-cn

---

## What it does

| | Windows | macOS |
| --- | --- | --- |
| Chinese UI | ✅ | ❌ not supported |
| Installs Codex for you | ✅ | ✅ |
| Fully reversible | ✅ | — |

**macOS cannot be localized here.** The Windows build is Electron, so swapping internal
resource files works; the macOS build is a native app with no equivalent to patch. On macOS this
tool **only installs Codex**.

## Windows localization

- ✅ Turns Codex's **menus, buttons and messages** into Simplified Chinese
- ✅ **Works even if Codex isn't installed** — it can install Codex for you
  (the app store often fails to download it in mainland China)
- ✅ **Fully reversible** — restore English from the menu, nothing is broken
- ✅ No extra software, no account required

## How to use

### 1. Download

From the **Releases** page:

- GitHub: https://github.com/Nooonnneee/codex-zh-cn/releases
- Gitee: https://gitee.com/Flower_ly/codex-zh-cn/releases

### 2. Extract

**Extract the whole archive** to a folder (e.g. `D:\codex-zh-CN\`).

> ⚠️ Don't double-click inside the zip preview — extract first, or it will fail.

### 3. Run

Double-click **`install-windows.bat`**. A console window opens:

1. Accept the UAC prompt if one appears
2. Follow the on-screen hints:
   - **Codex not installed yet** → type `6` and press Enter (downloads ~950 MB, takes a while)
   - **Codex already installed** → type `1` and press Enter
3. Codex restarts automatically with a Chinese UI

> Still English? Open Codex **Settings → General → Language** and pick **Chinese (China)**.

## Menu options

| Key | Action |
| --- | --- |
| **1** | Install localization (use this if Codex is already installed) |
| **2** | Restore English / reset |
| **3** | Verify the localization |
| **4** | Re-detect the environment |
| **5** | Manually specify the Codex install path |
| **6** | Install Codex (shown only when Codex isn't found) |
| **Q** | Quit |

## FAQ

**"Codex Desktop installation not found"**
Codex isn't installed on this machine. Type `6` in the menu and it will install it for you.

**Download is slow or stuck**
The package is large (~950 MB). Give it time; if it stalls completely, close and start again.

**Codex updated and the UI is English again**
Expected — updates overwrite the localized files. Re-run `install-windows.bat` and pick `1`.

**How do I uninstall?**
Pick `2` to restore English, then delete the extracted folder.

**Windows 10 / 11?**
Both. x64 and ARM64 are supported.

## macOS (install only)

On macOS this tool does one thing: **installs the official Codex**. The UI stays English.

1. Download and **fully extract** the release archive
2. Double-click **`install-macos.command`**
3. It detects your chip (Apple Silicon / Intel) and downloads ~750 MB
4. Open ChatGPT from Launchpad or Applications when it finishes

> **"Cannot be opened because the developer cannot be verified"?**
> Right-click `install-macos.command` → Open → Open again.
> Or run once in Terminal: `chmod +x install-macos.command`

**Why no Chinese on macOS?** The Windows build is Electron and its internal resources can be
swapped; the macOS build is native with no equivalent to patch.

**Requires macOS 13.0 or later.**

## Requirements

- **Windows**: 10 or 11, x64 or ARM64, nothing to pre-install
- **macOS**: 13.0 or later, Apple Silicon or Intel

---

<details>
<summary><b>For developers</b></summary>

```powershell
# Check whether Codex is installed
.\runtime\node.exe .\scripts\install-codex.mjs --check

# Download and install Codex
.\runtime\node.exe .\scripts\install-codex.mjs

# Install from a local MSIX
.\runtime\node.exe .\scripts\install-codex.mjs --msix "D:\OpenAI.Codex.msix"

# Localization: status / install / reset
powershell -File scripts\install_windows.ps1 -Action status
powershell -File scripts\install_windows.ps1 -Action install -CodexPath "D:\path\to\Codex"
powershell -File scripts\install_windows.ps1 -Action uninstall -CodexPath "D:\path\to\Codex"
```

```bash
# macOS (install only, no localization)
node scripts/install-codex-mac.mjs --check
node scripts/install-codex-mac.mjs
node scripts/install-codex-mac.mjs --dmg ~/Downloads/Codex-mac-arm64.dmg
```

```bash
npm install
npm test        # 100+ unit tests
```

A one-line related-project hint is printed after a successful install; disable it with
`$env:CODEX_ZH_NO_PROMO = "1"`.

### Differences from upstream

Forked from [xqnode/codex-zh-CN](https://github.com/xqnode/codex-zh-CN) (MIT):

- **Language-pack chain decoupled** — the bootstrap inlines this tool's own `runtime/` path instead of a
  client-owned directory resolved by version number. Fixes the silent "install succeeded but nothing
  was translated" failure.
- **Status moved to `~/.codex/zh-cn-runtime-status.json`**; verification and uninstall are self-contained.
- **Hard-coded version check removed** — no longer reports "unverified" after a language-pack bump.
- **Runtime presence validated before any write**, so a half-localized state can't be produced.
- **Path fallback** `~/.codex/zh-cn-runtime-path.txt` if the tool folder is moved.
- **Internal signals renamed** `[fmkj-*]` → `[codex-zh-cn-*]`.

The copy package name stays `OpenAI.Codex.FMKJ` — it is part of the MSIX identity.

### Installer source

This tool does **not** host the installer. It downloads the official Microsoft Store MSIX relayed
through [Wangnov/codex-app-mirror](https://github.com/Wangnov/codex-app-mirror) (MIT): verbatim mirror,
no repacking, Microsoft's signature still validated. Change `MIRROR_ORIGIN` to switch sources.

</details>

---

## Related project

This tool fixes "**I can't read the UI**". If your problem is "**too many accounts, too many tools**" —
switching accounts, signing in and managing configs across Codex / Claude Code / WorkBuddy:

**👉 [Fanmeng Ai Copilot — download for Windows](https://app.fmkj.top/download?utm_source=github&utm_medium=readme&utm_campaign=codex-zh-cn)**

_If all you want is a Chinese UI, this repo is enough._

## Credits

- [xqnode/codex-zh-CN](https://github.com/xqnode/codex-zh-CN) (MIT) — origin of the localization patch
- [Wangnov/codex-app-mirror](https://github.com/Wangnov/codex-app-mirror) (MIT) — official installer mirror

## Disclaimer

Unofficial patch. It modifies local resource files of your own Codex Desktop installation and is not
affiliated with OpenAI. The installer is relayed by a third-party mirror; Microsoft's signature is still
validated at install time. Use at your own risk.

## License

[MIT](LICENSE) — original copyright [xqnode](https://github.com/xqnode/codex-zh-CN).
