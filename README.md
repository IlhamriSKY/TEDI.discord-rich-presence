# TEDI Discord Rich Presence

Reference extension for [TEDI](https://github.com/IlhamriSKY/TEDI) that
publishes your current workspace as a Discord Rich Presence status.

<p align="center">
  <img src="logo.png" alt="Discord Rich Presence" width="128" />
</p>

> [!NOTE]
> This extension depends on Discord IPC Tauri commands
> (`discord_rpc_connect`, `discord_rpc_update`, `discord_rpc_disconnect`).
> The mainline TEDI binary does not ship those commands; see the
> [Backend caveat](#backend-caveat) below. The extension still installs,
> configures, and uninstalls cleanly without them. It simply won't
> publish to Discord until the backend exists.

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
validation, fingerprint), and activates the extension. The card with
this README's logo appears in Settings → Extensions with a
**Publish presence** toggle.

### Updating

The same Settings → Extensions screen has a **Check updates** button.
TEDI compares the `tag_name` of the latest GitHub release against the
installed `manifest.version`. If newer, an **Update** button appears
and re-runs the install pipeline against the new release. No manual
download.

---

## What it does

When **Publish presence** is on, the extension subscribes to TEDI's
live app-context bridge and forwards three things to your local Discord
client:

| Discord field | Source                                                                       |
| ------------- | ---------------------------------------------------------------------------- |
| **Details**   | `Working in <workspace folder name>` (or `Idle` if no workspace is open).    |
| **State**     | `Editing <active filename>` (editor leaf), or `<N> terminals open` otherwise. |
| **Started**   | Time of the first successful connect, so the card shows elapsed-since-launch rather than elapsed-since-last-switch. |
| **Large art** | TEDI logo, hosted in the Discord Developer Portal under app ID `1506303762418110505`. |

Discord's `details` and `state` are capped at 128 code points (not
bytes). Anything longer is silently rejected by Discord, so the
extension truncates on the JS side to keep activity updates from being
dropped.

The retry loop kicks in when Discord isn't running: the extension waits
15 s between attempts so a closed Discord client doesn't get hammered
on every workspace switch.

---

## Permissions

Declared in `manifest.json`:

```json
"permissions": [
  "invoke:discord_rpc_connect",
  "invoke:discord_rpc_update",
  "invoke:discord_rpc_disconnect",
  "settings:read",
  "settings:write",
  "ui:toast"
]
```

| Permission                          | What it lets the extension do                                  |
| ----------------------------------- | -------------------------------------------------------------- |
| `invoke:discord_rpc_connect`        | Open a Discord IPC connection.                                 |
| `invoke:discord_rpc_update`         | Send a presence payload.                                       |
| `invoke:discord_rpc_disconnect`     | Close the IPC connection.                                      |
| `settings:read`, `settings:write`   | Persist the **Publish presence** toggle under `ext:tedi.discord-rich-presence:enabled` (namespaced; can't reach core settings). |
| `ui:toast`                          | Surface one warning when the Discord backend isn't available.  |

No filesystem, shell, or secret-keychain permissions are requested.

---

## Backend caveat

This extension calls three Tauri commands that must exist in the host
binary for actual Discord IPC to happen:

- `discord_rpc_connect(state: Tauri::State<DiscordState>) -> Result<(), String>`
- `discord_rpc_update(state, payload: { details: String, state: String }) -> Result<(), String>`
- `discord_rpc_disconnect(state) -> Result<(), String>`

The mainline TEDI repo intentionally does not ship these commands, so
the core binary stays free of integration-specific dependencies.

The extension handles the missing-backend case gracefully:

1. The first `invoke()` call after toggling on fails with a "command
   not found" / "not allowed" error.
2. The error string is matched against `BACKEND_MISSING_HINTS` in
   `extension.js`.
3. A `backendUnavailable` latch is set.
4. The user sees a single warning toast.
5. The 15 s retry loop is suppressed so we don't burn CPU on a
   permanently failing invoke.
6. Toggling off, disabling, or uninstalling still does the right thing
   (idempotent teardown).

If you want this extension to actually publish to Discord, there are
two practical paths:

1. **Fork the TEDI source** and add a `discord` Tauri module wrapping
   the [`discord-rich-presence`](https://crates.io/crates/discord-rich-presence)
   crate. Register the three commands. Rebuild.
2. **Ship a sidecar** inside this extension's `.zip` (a Tauri plugin or
   a native binary the extension spawns via `shell_bg_spawn`) that
   exposes the same three commands over an IPC the extension can reach.
   This route keeps host TEDI clean.

Either way, no change is required to this extension's `extension.js`
once the commands are reachable. The `BACKEND_MISSING_HINTS` detection
short-circuits in the first `ensureConnected()` and never trips.

---

## Local development

```bash
git clone https://github.com/IlhamriSKY/TEDI.discord-rich-presence.git
cd TEDI.discord-rich-presence
# Edit manifest.json or extension.js. There is no build step. The
# extension ships as plain ES module JavaScript.

# Package locally to test against TEDI:
zip -j tedi.discord-rich-presence-dev.zip manifest.json extension.js logo.png

# In TEDI: Settings -> Extensions -> From file -> select the .zip
```

---

## License

[Apache-2.0](./LICENSE), IlhamriSKY.
