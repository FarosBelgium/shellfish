# Shellfish

A desktop SSH/SFTP client for saved hosts. Click a host to open a terminal, or open a two-pane SFTP browser: your computer on the left, the server on the right.

## Install

| System | File | Data folder |
|---|---|---|
| Ubuntu / Debian | `dist/shellfish_1.2.1_amd64.deb` | `~/.config/shellfish/data/` |
| Windows 10/11 | `dist/Shellfish-Setup-1.2.1.exe` | `%APPDATA%\shellfish\data\` |
| macOS (Apple Silicon: M1 or newer) | `dist/Shellfish-1.2.1-mac-arm64.zip` | `~/Library/Application Support/shellfish/data/` |
| macOS (Intel) | `dist/Shellfish-1.2.1-mac-x64.zip` | same |

Installing a newer version replaces the old one; you never end up with two versions side by side. Uninstalling or updating keeps your saved hosts.

### Ubuntu / Debian

```bash
sudo apt install ./dist/shellfish_1.2.1_amd64.deb
```

Shellfish then appears in your applications menu. You can also start it with `shellfish` from a terminal. The installer sets up the AppArmor sandbox profile itself.

### Windows

Run `Shellfish-Setup-1.2.1.exe`. No administrator rights are needed: it installs for the current user only. The installer isn't code-signed, so Windows SmartScreen shows "Windows protected your PC". Click **More info**, then **Run anyway**.

To open another drive in the SFTP left pane, type it in the path bar (e.g. `D:\`) and press Enter.

### macOS

Unzip the file and drag **Shellfish.app** to **Applications**. The app isn't signed with an Apple Developer certificate, so macOS blocks it the first time. Run this once in Terminal:

```bash
xattr -cr /Applications/Shellfish.app && codesign --force --deep --sign - /Applications/Shellfish.app
```

After that it opens normally.

### Building the installers

```bash
npm run dist                  # Linux .deb
npm run dist:win              # Windows installer (on Linux this needs Wine)
npm run dist:mac-from-linux   # macOS zips, unsigned (built on Linux)
npm run dist:mac              # macOS .dmg, Intel + Apple Silicon in one (only works on a Mac)
```

All icons are generated from `src/renderer/assets/shell.svg`, the same shell shown in the app. After changing it, run `npm run icons`.

## Run from source

```bash
npm install
npm start
```

### Linux: "The SUID sandbox helper binary was found, but is not configured correctly"

Ubuntu 23.10+ blocks the kernel feature Electron uses for its security sandbox. Run this once (it asks for sudo) to add an AppArmor profile that allows it for this app only:

```bash
npm run setup:linux
```

Don't use `--no-sandbox`: it switches off a layer of protection. Re-run the setup if you move the project folder.

## Features

- **Saved hosts** in the sidebar, with search and optional groups. Click a host to open an SSH terminal; hover it for **SSH**, **SFTP**, **⧉ duplicate** and **✎ edit**.
- **Duplicate** a host (⧉ in the sidebar, or **Duplicate** in the editor) to create a similar one. Everything is copied, including the saved password, so you only change what's different (e.g. the IP address).
- **Environment colours**: give a host a colour and label (presets: Development, Test, Acceptance, Production, or pick your own). The terminal gets a coloured frame, a banner with the label and a tinted background. The tab, the sidebar entry and the SFTP server pane are coloured too, so you can see at a glance whether you're on production.
- **Authentication** with username + password, or username + private key (with an optional passphrase). If a password or passphrase isn't saved, or is wrong, you're asked for it when you connect, and that one isn't saved.
- **Local terminal**: **Local terminal** at the top of the sidebar, or `Ctrl+Shift+T`, opens a terminal on your own computer in a tab next to your SSH sessions. It uses your default shell (`$SHELL`; a login shell on macOS; PowerShell on Windows) and starts in your home folder. Typing `exit` closes the tab.
- **Terminal**: full xterm (colors, vim, htop, …), several tabs at once, reconnect button. Copy/paste with `Ctrl+Shift+C` / `Ctrl+Shift+V`. Right-click copies the selection, or pastes if nothing is selected.
- **SFTP**: local on the left, remote on the right.
  - Browse any folder: double-click, `Backspace` for the parent folder, or type a path and press Enter. Back, home and refresh buttons. Click a column to sort.
  - Upload/download with the middle buttons, by double-clicking a file, or by dragging between the panes. You can also drag files in from your file manager. Folders are copied recursively.
  - New folder, rename (`F2`), delete (`Del`). Local deletes go to the trash. Remote deletes are permanent and ask for confirmation first.
  - Asks before overwriting. The transfer panel shows progress.
- Tabs: `Ctrl+Shift+T` for a new local terminal, `Ctrl+Tab` to cycle, `Ctrl+Shift+W` or middle-click to close.

## Where your data is stored

Everything stays on this machine. When running from source it is in the tool's own `data/` folder; the installed app uses `~/.config/shellfish/data/`:

| File | Contents |
|---|---|
| `data/hosts.json` | Your saved hosts |
| `data/known_hosts.json` | Server key fingerprints you have trusted |

Example `hosts.json`:

```json
{
  "version": 1,
  "hosts": [
    {
      "id": "29fada6b-e62c-4929-b25a-3e1af6e8fac8",
      "name": "Web server",
      "group": "Customer A",
      "label": "PROD",
      "color": "#e5604f",
      "host": "192.168.1.10",
      "port": 22,
      "username": "deploy",
      "authType": "key",
      "password": "",
      "privateKeyPath": "~/.ssh/id_ed25519",
      "passphrase": "enc:djExE8xQTafSNaelqU6/XVUDJg==",
      "notes": ""
    }
  ]
}
```

You can edit this file by hand. To add a host, leave `id` out and one is generated. `authType` is `"password"` or `"key"`. `label` and `color` (`#rrggbb`) are optional.

## Security

- **Secrets are encrypted.** Passwords and passphrases are encrypted with your OS keychain (GNOME Keyring / KWallet, macOS Keychain, Windows DPAPI) and stored as `enc:…`. Everything else stays readable. If you type a plaintext password into the JSON, it's encrypted the next time the app starts. Encrypted values only work for this user on this machine. If you give your `hosts.json` to a colleague, the hosts work for them, but they're asked for each password once on connect. If no keychain is available, the sidebar warns you and secrets are stored in plain text. In that case, use key authentication or leave passwords empty so you're asked each time.
- **Private keys are never copied.** Only the path to your key file is saved.
- **File permissions:** `data/` is `0700` and the JSON files are `0600`, written atomically. `data/` is in `.gitignore`.
- **Host key verification:** the first time you connect to a server, you're shown its key fingerprint and asked whether to trust it. If the key changes later, you get a man-in-the-middle warning, and the connection is cancelled unless you explicitly accept the new key.
- **Isolated UI:** the window can't access your files or the network directly. Secrets never reach it, and it loads no remote content.

Set `SHELLFISH_DATA_DIR=/some/path` to keep the data folder somewhere else.
