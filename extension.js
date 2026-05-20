// Discord Rich Presence extension - reference implementation.
//
// Demonstrates the v1 extension API:
//   - `contribute.settings([...])` declares a toggle that auto-renders in
//     Settings - Extensions.
//   - `settings.onChange("enabled", ...)` reacts to the user flipping it.
//   - `app.onContextChange(...)` receives live workspace/file/terminal
//     state pushed by the App.
//   - `invoke()` is permission-gated against the manifest's
//     `invoke:discord_rpc_*` entries.
//
// State machine: idle - connecting - connected - retrying. The retry loop
// is the same as the inlined hook had pre-port: 15s back-off so a closed
// Discord client doesn't get hammered every workspace switch.
//
// Plug-and-play caveat: core TEDI does NOT ship `discord_rpc_*` Tauri
// commands - the codebase intentionally has no Discord ties (see
// extensions/README.md). If those commands aren't found at runtime the
// extension switches into "backend unavailable" mode: install, toggle,
// disable, and uninstall stay safe; we just don't publish to Discord.

const RETRY_DELAY_MS = 15_000;
const BACKEND_MISSING_HINTS = [
  "not found",
  "not allowed",
  "permissiondenied",
  "permission denied",
  "command discord_rpc",
];

/** @type {import("@/modules/extensions/host").ExtensionContext | null} */
let ctx = null;
let enabled = false;
let connected = false;
/** Latest payload waiting to be pushed (newer wins). */
let pendingPayload = null;
let retryTimer = null;
let draining = false;
/** Bumped on every teardown so an in-flight retry knows to bail. */
let sessionGen = 0;
let lastContext = { workspaceCwd: null, activeFileName: null, terminalCount: 0 };
/** Latched once we discover the Rust `discord_rpc_*` commands aren't
 *  registered in this build of TEDI. Stops the 15s retry loop from
 *  hammering a missing command indefinitely. Cleared on extension
 *  reload (a fresh `activate` call gets a fresh module instance). */
let backendUnavailable = false;

function looksLikeMissingBackend(err) {
  const msg = String(err ?? "").toLowerCase();
  return BACKEND_MISSING_HINTS.some((hint) => msg.includes(hint));
}

function clearRetry() {
  if (retryTimer !== null) {
    clearTimeout(retryTimer);
    retryTimer = null;
  }
}

function folderName(p) {
  if (!p) return "";
  const trimmed = String(p).replace(/[\\/]+$/, "");
  const parts = trimmed.split(/[\\/]/);
  return parts[parts.length - 1] || "";
}

function buildPayload(c) {
  const folder = folderName(c.workspaceCwd);
  const details = folder ? `Working in ${folder}` : "Idle";
  let state = "";
  if (c.activeFileName) {
    state = `Editing ${c.activeFileName}`;
  } else if (c.terminalCount > 0) {
    state = `${c.terminalCount} terminal${c.terminalCount === 1 ? "" : "s"} open`;
  }
  return { details, state };
}

async function ensureConnected() {
  if (connected) return true;
  if (backendUnavailable) return false;
  try {
    await ctx.invoke("discord_rpc_connect");
    connected = true;
    return true;
  } catch (err) {
    if (looksLikeMissingBackend(err)) {
      backendUnavailable = true;
      ctx.logger.warn(
        "discord_rpc_* commands not registered in this TEDI build; presence is a no-op",
        err,
      );
      ctx.ui.toast(
        "Discord backend not available in this build of TEDI. The extension installed cleanly but won't publish presence.",
        { variant: "warning" },
      );
    } else {
      ctx.logger.warn("discord connect failed", err);
    }
    return false;
  }
}

async function sendUpdate(payload) {
  try {
    await ctx.invoke("discord_rpc_update", { payload });
    return true;
  } catch (err) {
    if (looksLikeMissingBackend(err)) {
      backendUnavailable = true;
      connected = false;
      ctx.logger.warn(
        "discord_rpc_update missing; presence will stay idle until next reload",
        err,
      );
      return false;
    }
    ctx.logger.warn("discord update failed - dropping client", err);
    connected = false;
    try {
      await ctx.invoke("discord_rpc_disconnect");
    } catch {
      /* best-effort */
    }
    return false;
  }
}

function scheduleRetry(payload) {
  if (retryTimer !== null) return;
  if (pendingPayload === null) pendingPayload = payload;
  retryTimer = setTimeout(() => {
    retryTimer = null;
    void drain();
  }, RETRY_DELAY_MS);
}

async function drain() {
  if (draining) return;
  draining = true;
  const myGen = sessionGen;
  try {
    while (pendingPayload !== null) {
      const next = pendingPayload;
      pendingPayload = null;
      const ok = await ensureConnected();
      if (myGen !== sessionGen) return;
      // Permanent failure (no Rust backend) - drop the queue silently so
      // we don't keep firing retries every 15s for nothing.
      if (backendUnavailable) {
        pendingPayload = null;
        clearRetry();
        return;
      }
      if (!ok) {
        scheduleRetry(next);
        return;
      }
      const sent = await sendUpdate(next);
      if (myGen !== sessionGen) return;
      if (backendUnavailable) {
        pendingPayload = null;
        clearRetry();
        return;
      }
      if (!sent) {
        scheduleRetry(next);
        return;
      }
    }
  } finally {
    draining = false;
  }
}

function schedulePush(payload) {
  pendingPayload = payload;
  if (retryTimer !== null) return;
  void drain();
}

async function teardown() {
  // Bumping the gen first means any in-flight drain still inside an
  // `await` will short-circuit on its next gen check. Without this,
  // disable/uninstall could race a pending invoke and accidentally
  // reconnect after we've torn down.
  sessionGen += 1;
  clearRetry();
  pendingPayload = null;
  if (connected) {
    connected = false;
    try {
      await ctx.invoke("discord_rpc_disconnect");
    } catch {
      // best-effort - if the backend is gone (uninstall / disabled) or
      // Discord crashed, there's nothing to disconnect from.
    }
  }
}

function refresh() {
  if (!enabled) {
    void teardown();
    return;
  }
  schedulePush(buildPayload(lastContext));
}

export async function activate(context) {
  ctx = context;

  // Declare the user-facing toggle. Auto-rendered under this extension's
  // card in Settings - Extensions.
  ctx.contribute.settings([
    {
      id: "enabled",
      type: "boolean",
      label: "Publish presence",
      description:
        "Connect to the Discord desktop app and start broadcasting your activity. Toggle off to disconnect.",
      default: false,
    },
  ]);

  const initial = await ctx.settings.get("enabled");
  enabled = Boolean(initial);

  ctx.settings.onChange("enabled", (value) => {
    const next = Boolean(value);
    if (next === enabled) return;
    enabled = next;
    refresh();
  });

  ctx.app.onContextChange((next) => {
    lastContext = next;
    if (enabled) {
      schedulePush(buildPayload(next));
    }
  });

  refresh();
}

export async function deactivate() {
  await teardown();
}
