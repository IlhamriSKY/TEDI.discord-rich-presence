// Discord Rich Presence extension - sidecar architecture.
//
// The TEDI binary itself has no Discord-specific code. This extension
// ships a small native helper (`sidecar/<platform>-<arch>/tedi-discord-helper`)
// that owns the Discord IPC connection. The extension JS layer:
//
//   1. picks the binary for the current OS / arch from `ctx.os`
//   2. spawns it via `shell_bg_spawn_direct` (no shell wrapper - the
//      tracked PID is the helper itself so kill actually terminates it)
//   3. reads its stdout via `shell_bg_logs` to learn the localhost port
//      the helper bound to
//   4. talks to it over plain HTTP on 127.0.0.1
//
// The extension uses a SINGLE switch (the card-level Switch in
// Settings -> Extensions): enable = start broadcasting, disable =
// teardown sidecar + clear presence. No separate "Publish presence"
// inner toggle. Uninstall / TEDI close also tears the sidecar down
// (the helper has its own parent-pid watchdog as a final backstop).
//
// This file is the thin entry: it wires the cohesive modules together and
// exports activate / deactivate (the host imports the bundled single file and
// reads those two exports). The actual work lives in:
//   runtime.js   - shared state singletons + constants + setters
//   platform.js  - OS/arch -> sidecar binary path
//   assets.js    - file name -> Discord asset key tables + lookup
//   statusbar.js - the "presence" status-bar item
//   payload.js   - app-context snapshot -> presence payload
//   sidecar.js   - spawn / kill the native helper
//   client.js    - HTTP/IPC connect + update
//   presence.js  - drain / retry scheduler + teardown

import { buildPayload } from "./payload.js";
import { schedulePush, teardown } from "./presence.js";
import { active, ctx, lastContext, setActive, setCtx, setLastContext } from "./runtime.js";
import { showConnectingIcon } from "./statusbar.js";

/** @param {import("../tedi").ExtensionContext} context */
export async function activate(context) {
  setCtx(context);
  setActive(true);

  // No `contribute.settings` here - the card-level Switch in
  // Settings -> Extensions is the only on/off control. Enabling the
  // extension means publishing presence, disabling means stop.

  // Show the icon in a "connecting" state immediately so the user
  // sees the extension is doing something while we spawn the sidecar
  // and wait for Discord IPC.
  showConnectingIcon();

  try {
    if (ctx.app && typeof ctx.app.onContextChange === "function") {
      ctx.app.onContextChange((next) => {
        if (!active) return;
        setLastContext(next);
        schedulePush(buildPayload(next));
      });
    } else {
      ctx.logger?.warn?.("ctx.app missing; presence will use static payload");
      schedulePush(buildPayload(lastContext));
    }
  } catch (err) {
    ctx.logger?.warn?.("ctx.app.onContextChange failed", err);
    schedulePush(buildPayload(lastContext));
  }
}

export async function deactivate() {
  await teardown();
}
