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

When **Publish presence** is on, the extension:

1. Picks the right helper binary for the current OS / arch (e.g.
   `sidecar/windows-x86_64/tedi-discord-helper.exe`).
2. Spawns it via `shell_bg_spawn`. The helper binds
   `127.0.0.1:0` (kernel-assigned ephemeral port), prints
   `PORT=<n>` to stdout, then services HTTP.
3. The extension polls `shell_bg_logs` for up to 5 s waiting for
   `PORT=`. Once it has the port it `fetch()`'s `/connect`,
   `/update`, `/disconnect` as needed.
4. Toggle off / disable / uninstall → `POST /shutdown` (helper clears
   activity, closes IPC, exits) then `shell_bg_kill` for safety.

The payload the helper sends to Discord:

| Discord field | Source                                                                       |
| ------------- | ---------------------------------------------------------------------------- |
| **Details**   | `Working in <workspace folder name>` (or `Idle` if no workspace is open).    |
| **State**     | `Editing <active filename>`, or `<N> terminals open` otherwise.              |
| **Started**   | Time of the first successful connect, so the card shows elapsed-since-launch. |
| **Large art** | TEDI logo, hosted in the Discord Developer Portal under app ID `1506303762418110505`. |

Discord caps `details` / `state` at 128 code points. The helper
truncates server-side; the extension never has to worry.

The retry loop kicks in when Discord isn't running: the extension
waits 15 s between attempts so a closed Discord client doesn't get
hammered on every workspace switch.

---

## Permissions

Declared in `manifest.json`:

```json
"permissions": [
  "settings:read",
  "settings:write",
  "ui:toast",
  "invoke:shell_bg_spawn",
  "invoke:shell_bg_logs",
  "invoke:shell_bg_kill"
]
```

| Permission                          | What it lets the extension do                                  |
| ----------------------------------- | -------------------------------------------------------------- |
| `settings:read`, `settings:write`   | Persist the **Publish presence** toggle under `ext:tedi.discord-rich-presence:enabled` (namespaced; can't reach core settings). |
| `ui:toast`                          | Surface failure modes (no binary for this platform, helper crashed, etc). |
| `invoke:shell_bg_spawn`             | Start the bundled sidecar binary as a long-running background process. |
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

---

## License

[Apache-2.0](./LICENSE), IlhamriSKY.
