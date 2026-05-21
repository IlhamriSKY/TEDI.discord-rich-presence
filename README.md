# TEDI Discord Rich Presence

Reference extension for [TEDI](https://github.com/IlhamriSKY/TEDI) that
publishes your current workspace as a Discord Rich Presence status.

<p align="center">
  <img src="logo.png" alt="Discord Rich Presence" width="128" />
</p>

> [!NOTE]
> The extension ships its own native sidecar binary, so the TEDI core
> binary stays free of any Discord-specific code. The first time it
> runs on Windows you'll see a SmartScreen prompt and on macOS a
> Gatekeeper warning; both are expected for an unsigned helper. See
> [Trust prompts](#trust-prompts) below.

---

## Install

In TEDI:

1. Open **Settings → Extensions**.
2. Switch to the **From GitHub** tab.
3. Paste `IlhamriSKY/TEDI.discord-rich-presence` (or the full URL).
4. Click **Review → Install**.

TEDI hits `releases/latest` on this repo, downloads the `.zip` asset
produced by the [release workflow](.github/workflows/release.yml), runs
its standard install pipeline (size cap, path-traversal guard, manifest
validation, fingerprint), `chmod +x`'s the bundled sidecar binaries on
Unix, and activates the extension. The card with this README's logo
appears in Settings → Extensions with a **Publish presence** toggle.

### Updating

The same Settings → Extensions screen has a **Check updates** button.
TEDI compares `tag_name` of the latest GitHub release against the
installed `manifest.version`. If newer, an **Update** button re-runs
the install pipeline against the new release. No manual download.

---

## How it works

```
Discord desktop client          (named pipe / Unix socket — OS-level)
        ▲
        │  discord-rich-presence IPC
        │
+----------------------------+
| sidecar/<platform>-<arch>/ |   tedi-discord-helper
| tedi-discord-helper        |   - HTTP server on 127.0.0.1:<rand>
+----------------------------+   - JSON in / out
        ▲
        │  fetch("http://127.0.0.1:<port>/...")
        │
+----------------------------+
| extension.js (in webview)  |   - spawns the helper via shell_bg_spawn
|                            |   - reads PORT=<n> from stdout via shell_bg_logs
|                            |   - drives /connect /update /disconnect
+----------------------------+
```

The card-level Switch in *Settings → Extensions* is the single on /
off control. Enabling the extension starts the broadcast, disabling
stops it. When the Switch flips on the extension:

1. Picks the right helper binary for the current OS / arch (e.g.
   `sidecar/windows-x86_64/tedi-discord-helper.exe`).
2. Spawns it via `shell_bg_spawn_direct`. Direct spawn means TEDI
   tracks the helper PID itself (no `pwsh` / `bash` wrapper that
   would leak the real child), so disabling the extension actually
   kills the helper instead of a shell that already exited.
3. Reads `PORT=<n>` from the helper's stdout via `shell_bg_logs`.
4. `fetch()`s `/connect`, then `/update` on every workspace change.

Disabling, uninstalling, or closing TEDI tears the helper down through
three independent paths:

- **Disable / uninstall** → the extension's `deactivate()` posts
  `/shutdown` (the helper clears Discord activity and closes IPC) and
  then calls `shell_bg_kill` for safety.
- **TEDI crash / force-quit** → the helper's parent-PID watchdog
  notices TEDI is gone within ~10 seconds and exits on its own.
- **Long idle (4 h)** → the helper's idle timeout fires as a final
  backstop in case both above paths somehow miss.

The payload the helper sends to Discord:

| Discord field | Source                                                                       |
| ------------- | ---------------------------------------------------------------------------- |
| **Details**   | `Working in <workspace folder name>` (or `Idle` if no workspace is open).    |
| **State**     | `Editing <active filename>`, or `<N> terminals open` otherwise.              |
| **Started**   | Time of the first successful connect, so the card shows elapsed-since-launch. |
| **Large art** | TEDI logo, hosted in the Discord Developer Portal under app ID `1506303762418110505`. |
| **Small art** | Badge for the focused tab (terminal / SSH / diff / preview / language icon). Falls back to no badge when the host predates `activeTabKind`. |
| **Button**    | "Visit TEDI" → `https://tedi.ilhamriski.com` (only visible to other users viewing your profile — Discord hides Rich Presence buttons from the owner's own client). |

Discord caps `details` / `state` at 128 code points. The helper
truncates server-side; the extension never has to worry.

### Asset keys (small badge)

The small-image badge resolves a TEDI tab into a Discord asset key. Every
key in the table below must exist as a Rich Presence asset on the Discord
Developer Portal for app id `1506303762418110505` (Settings → Rich
Presence → Art Assets). Discord silently drops unknown keys, so the
extension stays safe even if a key is missing — the badge just won't
render.

| Asset key       | When it's used                                              |
| --------------- | ----------------------------------------------------------- |
| `tab_terminal`  | Active leaf is a local terminal.                            |
| `tab_ssh`       | Active leaf is an SSH-backed terminal.                      |
| `tab_diff`      | Active tab is an AI diff or a git diff.                     |
| `tab_preview`   | Active tab is the in-app browser preview.                   |
| `tab_editor`    | Editor leaf with an unrecognised file extension (fallback). |
| `lang_php`      | `.php`                                                      |
| `lang_js`       | `.js` / `.mjs` / `.cjs` / `.jsx`                            |
| `lang_ts`       | `.ts` / `.tsx`                                              |
| `lang_python`   | `.py`                                                       |
| `lang_rust`     | `.rs`                                                       |
| `lang_go`       | `.go`                                                       |
| `lang_java`     | `.java`                                                     |
| `lang_kotlin`   | `.kt`                                                       |
| `lang_swift`    | `.swift`                                                    |
| `lang_c`        | `.c` / `.h`                                                 |
| `lang_cpp`      | `.cpp` / `.cc` / `.hpp`                                     |
| `lang_csharp`   | `.cs`                                                       |
| `lang_ruby`     | `.rb`                                                       |
| `lang_shell`    | `.sh` / `.bash` / `.zsh`                                    |
| `lang_powershell` | `.ps1`                                                    |
| `lang_html`     | `.html` / `.htm`                                            |
| `lang_css`      | `.css` / `.scss` / `.sass` / `.less`                        |
| `lang_json`     | `.json` / `.jsonc`                                          |
| `lang_yaml`     | `.yaml` / `.yml`                                            |
| `lang_toml`     | `.toml`                                                     |
| `lang_xml`      | `.xml`                                                      |
| `lang_markdown` | `.md` / `.mdx`                                              |
| `lang_sql`      | `.sql`                                                      |
| `lang_vue`      | `.vue`                                                      |
| `lang_svelte`   | `.svelte`                                                   |
| `lang_dart`     | `.dart`                                                     |
| `lang_lua`      | `.lua`                                                      |
| `lang_docker`   | `Dockerfile` / `.dockerfile`                                |
| `lang_env`      | `.env`                                                      |
| `lang_text`     | `.txt` / `.log`                                             |

Assets are 512×512 PNG. The full mapping lives in `LANG_ASSET_BY_EXT`
inside `extension.js` — add new entries there and re-release if you want
to cover more languages.

The retry loop kicks in when Discord isn't running: the extension
waits 15 s between attempts so a closed Discord client doesn't get
hammered on every workspace switch.

---

## Permissions

Declared in `manifest.json`:

```json
"permissions": [
  "ui:toast",
  "statusbar:write",
  "invoke:shell_bg_spawn_direct",
  "invoke:shell_bg_logs",
  "invoke:shell_bg_kill"
]
```

| Permission                          | What it lets the extension do                                  |
| ----------------------------------- | -------------------------------------------------------------- |
| `ui:toast`                          | Surface failure modes (no binary for this platform, helper crashed, etc). |
| `statusbar:write`                   | Show the Discord icon in TEDI's bottom-right status bar (dim while connecting, full colour when connected). |
| `invoke:shell_bg_spawn_direct`      | Start the bundled sidecar binary as a long-running background process. **Direct** = no shell wrapper, so the tracked PID is the helper itself and `shell_bg_kill` actually terminates it. |
| `invoke:shell_bg_logs`              | Read the helper's stdout to discover the auto-assigned port. |
| `invoke:shell_bg_kill`              | Stop the helper on disable / uninstall.                       |

No filesystem, secret-keychain, or one-shot shell permissions are
requested. Network access is implicit: the extension only `fetch()`'s
`127.0.0.1:<helperPort>` so no outbound traffic ever leaves the
machine.

---

## Trust prompts

The sidecar binary is built by GitHub Actions and unsigned. First
launch on each platform:

- **Windows**: SmartScreen warning ("Windows protected your PC").
  Click **More info → Run anyway**. SmartScreen remembers the choice
  for that exact binary.
- **macOS**: the file is downloaded by TEDI, so it gets the
  `com.apple.quarantine` xattr. The first invocation may show
  "tedi-discord-helper can't be opened". Fix once with:
  ```bash
  xattr -dr com.apple.quarantine ~/Library/Application\ Support/<TEDI app id>/extensions/tedi.discord-rich-presence/sidecar
  ```
  Replace `<TEDI app id>` with the bundle identifier of your TEDI
  install (default: `id.ilhamrisky.tedi`).
- **Linux**: nothing. TEDI's install pipeline already `chmod 0755`'s
  everything under `sidecar/` after extraction.

---

## Local development

```bash
git clone https://github.com/IlhamriSKY/TEDI.discord-rich-presence.git
cd TEDI.discord-rich-presence

# Build the sidecar for your host platform (debug profile is fine for
# development; release is what CI produces).
cd sidecar-src
cargo build --release

# Stage the binary where extension.js expects it. Pick the dir that
# matches your host - e.g. for Linux x86_64:
mkdir -p ../sidecar/linux-x86_64
cp target/release/tedi-discord-helper ../sidecar/linux-x86_64/
chmod +x ../sidecar/linux-x86_64/tedi-discord-helper
cd ..

# Package + install into TEDI to test:
zip -r dev.zip manifest.json extension.js logo.png sidecar
# In TEDI: Settings → Extensions → From file → dev.zip
```

The first install will spawn the helper, you should see `PORT=<n>` in
TEDI's dev-tools console (`[ext:tedi.discord-rich-presence] sidecar
port <n>`) and Discord should reflect your workspace within a second.
