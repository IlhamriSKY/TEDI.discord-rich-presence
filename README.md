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
Discord desktop client          (named pipe / Unix socket - OS-level)
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
| **Button**    | "Visit TEDI" → `https://tedi.ilhamriski.com` (only visible to other users viewing your profile - Discord hides Rich Presence buttons from the owner's own client). |

Discord caps `details` / `state` at 128 code points. The helper
truncates server-side; the extension never has to worry.

### Asset keys (small badge)

The small-image badge resolves a TEDI tab into a Discord asset key. Every
key the extension may send must exist as a Rich Presence asset on the
Discord Developer Portal for app id `1506303762418110505` (Settings →
Rich Presence → Art Assets). Three layers of defensive handling keep the
presence stable when keys are missing or invalid:

1. **Extension JS** - file resolution walks whole-filename map (Makefile,
   Dockerfile, LICENSE, ...) → compound-prefix specials (`.env.*`) →
   plain extension → `tab_editor` fallback.
2. **Sidecar Rust** - validates the key against Discord's format
   (lowercase alphanumeric + underscore, ≤32 chars) before calling
   `set_activity`. Invalid keys are silently dropped (logged via
   `eprintln`) so a malformed payload never wipes the entire presence.
3. **Discord** - unknown keys are silently dropped server-side. The big
   image stays as the TEDI logo; only the badge disappears.

The full machine-readable mapping lives in `LANG_ASSET_BY_EXT` +
`LANG_ASSET_BY_FILENAME` inside `extension.js`. All 27 icons come from
the same **HugeIcons free set** that `TabBar.tsx` uses, keeping the
badge style consistent with TEDI's UI.

**Tab kinds (5)** - exact match with `TabBar.tsx`:
`tab_terminal` (computer-terminal-02), `tab_ssh` (cloud-server),
`tab_diff` (git-compare), `tab_preview` (globe-02),
`tab_editor` (pencil-edit-02).

**Brand-specific languages (12)** - HugeIcons has dedicated icons:
`lang_php`, `lang_js` (also JSX / CoffeeScript), `lang_ts` (also TSX),
`lang_python`, `lang_java`, `lang_html`, `lang_css` (also SCSS / SASS /
LESS / Stylus), `lang_sql`, `lang_shell` (all shell scripting incl.
PowerShell), `lang_dart`, `lang_csv` (also TSV), `lang_xml` (also XSD /
XSL / plist).

**Semantic generic (10)** - HugeIcons `File*` family for media + fallback
groups:

| Key | HugeIcons | Captures |
| --- | --------- | -------- |
| `lang_code` | `file-code` | Languages without brand icon (Rust, Go, Kotlin, Swift, C/C++, C#, Ruby, Lua, Vue, Svelte, Elixir, Haskell, Clojure, Scala, F#, OCaml, Perl, R, Julia, Solidity, Zig, Nim, Makefile, CMake, Terraform, Nix, Vim, Proto, Jupyter, Dockerfile, ...) |
| `lang_json` | `file-braces` | `.json` / `.jsonc` / `.json5` / `.jsonl` / `.ndjson` |
| `lang_config` | `file-sliders` | TOML / YAML / INI / CONF / properties / editorconfig / dotfile configs |
| `lang_markdown` | `file-edit` | Markdown, reStructuredText, AsciiDoc, LaTeX |
| `lang_text` | `file-empty-02` | `.txt` / `.log` / LICENSE / README / CHANGELOG / AUTHORS |
| `lang_env` | `file-key` | `.env*` |
| `lang_image` | `file-image` | `.png` / `.jpg` / `.gif` / `.webp` / `.svg` / `.ico` / `.bmp` / `.tiff` / `.avif` / `.heic` |
| `lang_video` | `file-video` | `.mp4` / `.webm` / `.mov` / `.avi` / `.mkv` / `.flv` / `.m4v` / `.mpg` |
| `lang_audio` | `file-audio` | `.mp3` / `.wav` / `.ogg` / `.flac` / `.m4a` / `.aac` / `.opus` / `.mid` |
| `lang_archive` | `file-zip` | `.zip` / `.tar` / `.gz` / `.7z` / `.rar` / `.bz2` / `.xz` / `.zst` |

See `icons-upload/README.md` (gitignored staging folder) for the full
extension → key mapping, the upload checklist, and the Iconify URLs the
download script uses.

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
