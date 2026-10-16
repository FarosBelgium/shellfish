# Shellfish

A desktop SSH/SFTP client for saved hosts. Click a host to open a terminal, or open a two-pane SFTP browser: your computer on the left, the server on the right.

## Install

Download the installer from the [latest release](https://github.com/FarosBelgium/shellfish/releases/latest):

| System | File | Data folder |
|---|---|---|
| Ubuntu / Debian | `shellfish_<version>_amd64.deb` | `~/.config/shellfish/data/` |
| Windows 10/11 | `Shellfish-Setup-<version>.exe` | `%APPDATA%\shellfish\data\` |
| macOS, Apple Silicon (M1 or newer) | `Shellfish-<version>-mac-arm64.dmg` | `~/Library/Application Support/shellfish/data/` |
| macOS, Intel | `Shellfish-<version>-mac-x64.dmg` | same |

Installing a newer version replaces the old one; you never end up with two versions side by side. Uninstalling or updating keeps your saved hosts.

### Ubuntu / Debian

```bash
sudo apt install ./shellfish_<version>_amd64.deb
```

Shellfish then appears in your applications menu. You can also start it with `shellfish` from a terminal. The installer sets up the AppArmor sandbox profile itself.

### Windows

Run `Shellfish-Setup-<version>.exe`. No administrator rights are needed: it installs for the current user only. The installer isn't code-signed, so Windows SmartScreen shows "Windows protected your PC". Click **More info**, then **Run anyway**.

To open another drive in the SFTP left pane, type it in the path bar (e.g. `D:\`) and press Enter.

### macOS

Open the `.dmg` and drag **Shellfish** to **Applications**. The app isn't notarized by Apple, so the first time macOS says it can't verify the developer. Open **System Settings → Privacy & Security**, scroll down and click **Open Anyway** next to Shellfish. You only need to do this once.

macOS may also ask whether Shellfish may use its keychain item "shellfish Safe Storage". That's where the key for your saved passwords is kept. Click **Always Allow**.

### Updates

The installed app checks for updates at startup and every 6 hours. At the bottom of the sidebar it shows the current version, with a button to check now.

- **Windows**: the update downloads in the background. Click **Restart to update**, or it installs the next time you close Shellfish.
- **Linux**: the update downloads in the background. Click **Install & restart**; it asks for your password, because a `.deb` installs system-wide.
- **macOS**: the app tells you a new version exists. **Download** opens the release page. macOS only lets apps signed with an Apple Developer certificate replace themselves.

Updates come from this repository's [Releases](https://github.com/FarosBelgium/shellfish/releases). Every download is checked against the SHA-512 checksum published with the release, and rejected if it doesn't match.

### Publishing a new version

1. Raise `version` in `package.json` and commit.
2. Tag and push: `git tag v1.3.1 && git push origin main v1.3.1`
3. GitHub Actions tests and builds on Linux, Windows and macOS, installs each installer and tests the installed app. Only if everything passes does it publish a GitHub Release with the installers; installed apps pick it up from there. No extra setup or tokens are needed: the workflow uses GitHub's built-in token.

### Tests

```bash
npm test
```

(On Linux, `npm run test:headless` runs the same tests on a virtual display, so no windows pop up.)

This runs the end-to-end tests in Electron, against SSH servers the tests start themselves (two jump hosts and a target server): jump host chains, password prompts per hop, host key checks, SFTP through a tunnel, the local terminal and the UI. GitHub Actions runs them on Linux, Windows and macOS, on every push. It also tests the installed apps: the local terminal, and the updater against a local update feed, including rejecting a tampered download.

### Building the installers

```bash
npm run dist                  # Linux .deb
npm run dist:win              # Windows installer (on Linux this needs Wine)
npm run dist:mac-from-linux   # macOS zips, unsigned (built on Linux)
npm run dist:mac              # macOS .dmg + .zip for Apple Silicon and Intel (only works on a Mac)
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
- **Jump hosts / SSH tunnel**: under **Connect via** in the host editor, pick another saved host to tunnel through (like `ssh -J`). Chains work too: a jump host can have its own jump host (A → B → server). SSH and SFTP both go through the tunnel. Every hop gets its own host key check and password prompt. The sidebar shows the route (`↳ via bastion → internal`).
- **Saved commands**: save frequently used commands per host (host editor → **Saved commands**, or **+** in the terminal's command bar, which fills in the selected terminal text). They show as buttons above the terminal. A click pastes the command, so you can review it and press Enter yourself. Tick **Run** for a command to press Enter for you. Right-click a button to edit the host's commands.
- **Import** hosts with the **Import** button: from Termius, from an OpenSSH config file (`~/.ssh/config` with one click), or from a CSV file. A preview shows what will be added. Hosts you already have are skipped, and jump hosts (`ProxyJump`, `ProxyCommand ssh -W`) are linked automatically. See [Importing from Termius](#importing-from-termius).
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

## Importing from Termius

Termius no longer has an export function and keeps your hosts encrypted on disk. The open-source tool [termius-export](https://github.com/y01and3/termius-export) (MIT) reads that data on your own computer, offline, and writes it to files Shellfish can import:

1. Close Termius and run termius-export (see its README). It writes `hosts.csv`, `sshconfig` and a `keys/` folder.
2. In Shellfish, click **Import → Choose a file…** and pick `hosts.csv`. This includes saved passwords and key passphrases, which Shellfish stores encrypted right away. (`sshconfig` works too, but without passwords.)
3. Check the preview, optionally choose a group, and click **Import**.
4. Delete the exported files afterwards: they contain your passwords and keys in plain text. If you deleted the `keys/` folder, first copy the keys you use to `~/.ssh` and update the key path in the host editor.

What's imported: name, address, port, user, password or key file (+ passphrase), group (`Group/Subgroup` becomes `Group / Subgroup`) and tags (into the notes). Not supported, and reported in the preview: telnet/mosh hosts, SOCKS/HTTP proxies, port forwards and `Match` blocks.

From an OpenSSH config, Shellfish reads `Host`, `HostName`, `User`, `Port`, `IdentityFile`, `ProxyJump`, `ProxyCommand ssh -W %h:%p …`, `Include`, and defaults from `Host *`. Hosts without an `IdentityFile` use your default key (`~/.ssh/id_ed25519`, `id_ecdsa` or `id_rsa`), just like `ssh`.

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
      "jumpHostId": "",
      "commands": [
        { "name": "Disk usage", "command": "df -h", "run": true },
        { "name": "Restart app", "command": "sudo systemctl restart myapp", "run": false }
      ],
      "password": "",
      "privateKeyPath": "~/.ssh/id_ed25519",
      "passphrase": "enc:djExE8xQTafSNaelqU6/XVUDJg==",
      "notes": ""
    }
  ]
}
```

You can edit this file by hand. To add a host, leave `id` out and one is generated. `authType` is `"password"` or `"key"`. `label` and `color` (`#rrggbb`) are optional. `jumpHostId` is the `id` of the host to connect through (empty = direct). In `commands`, `run: true` means Enter is pressed after pasting.

## Security

- **Secrets are encrypted.** Passwords and passphrases are encrypted with your OS keychain (GNOME Keyring / KWallet, macOS Keychain, Windows DPAPI) and stored as `enc:…`. Everything else stays readable. If you type a plaintext password into the JSON, it's encrypted the next time the app starts. Encrypted values only work for this user on this machine. If you give your `hosts.json` to a colleague, the hosts work for them, but they're asked for each password once on connect. If no keychain is available, the sidebar warns you and secrets are stored in plain text. In that case, use key authentication or leave passwords empty so you're asked each time.
- **Private keys are never copied.** Only the path to your key file is saved.
- **File permissions:** `data/` is `0700` and the JSON files are `0600`, written atomically. `data/` is in `.gitignore`.
- **Host key verification:** the first time you connect to a server, you're shown its key fingerprint and asked whether to trust it. If the key changes later, you get a man-in-the-middle warning, and the connection is cancelled unless you explicitly accept the new key.
- **Isolated UI:** the window can't access your files or the network directly. Secrets never reach it, and it loads no remote content.

Set `SHELLFISH_DATA_DIR=/some/path` to keep the data folder somewhere else.
