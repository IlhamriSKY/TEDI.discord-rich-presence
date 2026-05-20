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

const READ_PORT_TIMEOUT_MS = 5000;
const READ_PORT_POLL_MS = 100;
const RETRY_DELAY_MS = 15_000;

let ctx = null;
/** Background process handle returned by `shell_bg_spawn_direct`. */
let helperBgId = null;
/** localhost port the helper is listening on. */
let helperPort = null;
/** Most recently requested payload (newer wins). */
let pendingPayload = null;
let connected = false;
let draining = false;
let retryTimer = null;
/** Bumped on every teardown so an in-flight retry knows to bail. */
let sessionGen = 0;
let lastContext = { workspaceCwd: null, activeFileName: null, terminalCount: 0 };
/** Latched on teardown so any late drain calls become no-ops. */
let active = false;

function platformDir(os) {
  const platform = os.platform;
  const arch = os.arch;
  if (platform === "windows") {
    return arch === "aarch64" ? "windows-aarch64" : "windows-x86_64";
  }
  if (platform === "macos") {
    return arch === "aarch64" ? "macos-aarch64" : "macos-x86_64";
  }
  if (platform === "linux") {
    return arch === "aarch64" ? "linux-aarch64" : "linux-x86_64";
  }
  return null;
}

function helperPathFor(installPath, os) {
  if (typeof installPath !== "string" || !installPath) return null;
  if (!os || typeof os.platform !== "string") return null;
  const dir = platformDir(os);
  if (!dir) return null;
  const exe = os.platform === "windows" ? "tedi-discord-helper.exe" : "tedi-discord-helper";
  return `${installPath.replace(/\\/g, "/")}/sidecar/${dir}/${exe}`;
}

function safeStatusBarSet(item) {
  try {
    if (ctx?.statusBar?.setItem) ctx.statusBar.setItem(item);
  } catch (err) {
    ctx?.logger?.warn?.("statusBar.setItem failed", err);
  }
}

function safeStatusBarRemove(id) {
  try {
    if (ctx?.statusBar?.removeItem) ctx.statusBar.removeItem(id);
  } catch (err) {
    ctx?.logger?.warn?.("statusBar.removeItem failed", err);
  }
}

function showConnectingIcon() {
  safeStatusBarSet({
    id: "presence",
    icon: "discord.svg",
    tooltip: "Discord Rich Presence: connecting…",
    tone: "warning",
  });
}

function showConnectedIcon() {
  safeStatusBarSet({
    id: "presence",
    icon: "discord.svg",
    tooltip: "Discord Rich Presence: connected",
    tone: "success",
  });
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

async function spawnHelper() {
  // Re-spawn if the previous handle's process has exited (idle timeout,
  // crash, etc.). Asks TEDI's shell-bg supervisor for the latest state.
  if (helperBgId !== null) {
    try {
      const logs = await ctx.invoke("shell_bg_logs", {
        handle: helperBgId,
        sinceOffset: 0,
      });
      if (logs && typeof logs === "object" && logs.exited) {
        ctx.logger.info("sidecar exited; respawning", logs.exit_code ?? null);
        helperBgId = null;
        helperPort = null;
        connected = false;
      } else {
        return true;
      }
    } catch (err) {
      ctx.logger.warn("alive check failed; respawning", err);
      helperBgId = null;
      helperPort = null;
      connected = false;
    }
  }
  const path = helperPathFor(ctx.installPath, ctx.os);
  if (!path) {
    ctx.ui.toast(
      `Discord Rich Presence: no sidecar binary for ${ctx.os?.platform}/${ctx.os?.arch} in this release.`,
      { variant: "warning" },
    );
    return false;
  }
  try {
    // Direct spawn - TEDI tracks the helper PID itself (no pwsh / bash
    // wrapper), so `shell_bg_kill` later actually terminates the
    // helper and Discord stops showing presence the moment we ask.
    helperBgId = await ctx.invoke("shell_bg_spawn_direct", {
      program: path,
      args: [],
      cwd: null,
    });
    ctx.logger.info("sidecar spawned", { handle: helperBgId, path });
  } catch (err) {
    ctx.ui.toast(
      `Discord Rich Presence: could not start the sidecar (${err}).`,
      { variant: "error" },
    );
    ctx.logger.error("spawn failed", err);
    return false;
  }
  // Bounded poll for `PORT=<n>` on the helper's stdout.
  const deadline = Date.now() + READ_PORT_TIMEOUT_MS;
  let logOffset = 0;
  while (Date.now() < deadline) {
    if (!active) return false;
    try {
      const logs = await ctx.invoke("shell_bg_logs", {
        handle: helperBgId,
        sinceOffset: logOffset,
      });
      const bytes =
        typeof logs === "object" && logs ? (logs.bytes ?? "") : String(logs ?? "");
      if (typeof logs === "object" && logs && typeof logs.next_offset === "number") {
        logOffset = logs.next_offset;
      }
      const match = String(bytes).match(/^PORT=(\d+)/m);
      if (match) {
        helperPort = Number(match[1]);
        ctx.logger.info("sidecar port", helperPort);
        return true;
      }
      if (logs && typeof logs === "object" && logs.exited) {
        ctx.logger.error("sidecar exited before announcing port", logs);
        break;
      }
    } catch (err) {
      ctx.logger.warn("shell_bg_logs read failed", err);
    }
    await sleep(READ_PORT_POLL_MS);
  }
  ctx.ui.toast(
    "Discord Rich Presence: sidecar did not announce a port within 5 s.",
    { variant: "error" },
  );
  await killHelper();
  return false;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function killHelper() {
  if (helperBgId !== null) {
    try {
      // Ask the helper to clear Discord activity + close its IPC before
      // we kill the process, so Discord doesn't show a stale card for a
      // few seconds after teardown.
      if (helperPort !== null) {
        try {
          await fetch(`http://127.0.0.1:${helperPort}/shutdown`, { method: "POST" });
        } catch {
          // best-effort
        }
      }
      await ctx.invoke("shell_bg_kill", { handle: helperBgId });
    } catch (err) {
      ctx.logger.warn("shell_bg_kill failed", err);
    }
  }
  helperBgId = null;
  helperPort = null;
  connected = false;
  safeStatusBarRemove("presence");
}

async function ensureConnected() {
  if (connected) return true;
  showConnectingIcon();
  if (!(await spawnHelper())) return false;
  if (!active) return false;
  try {
    const resp = await fetch(`http://127.0.0.1:${helperPort}/connect`, { method: "POST" });
    if (!resp.ok) {
      const body = await resp.text();
      ctx.logger.warn("connect failed", resp.status, body);
      return false;
    }
    connected = true;
    showConnectedIcon();
    return true;
  } catch (err) {
    ctx.logger.warn("connect fetch failed", err);
    return false;
  }
}

async function sendUpdate(payload) {
  if (helperPort === null) return false;
  try {
    const resp = await fetch(`http://127.0.0.1:${helperPort}/update`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!resp.ok) {
      ctx.logger.warn("update failed", resp.status, await resp.text());
      connected = false;
      showConnectingIcon();
      try {
        await fetch(`http://127.0.0.1:${helperPort}/disconnect`, { method: "POST" });
      } catch {
        // best-effort
      }
      return false;
    }
    return true;
  } catch (err) {
    ctx.logger.warn("update fetch failed", err);
    connected = false;
    showConnectingIcon();
    return false;
  }
}

function scheduleRetry(payload) {
  if (retryTimer !== null || !active) return;
  if (pendingPayload === null) pendingPayload = payload;
  retryTimer = setTimeout(() => {
    retryTimer = null;
    if (active) void drain();
  }, RETRY_DELAY_MS);
}

async function drain() {
  if (draining || !active) return;
  draining = true;
  const myGen = sessionGen;
  try {
    while (pendingPayload !== null && active) {
      const next = pendingPayload;
      pendingPayload = null;
      const ok = await ensureConnected();
      if (myGen !== sessionGen || !active) return;
      if (!ok) {
        scheduleRetry(next);
        return;
      }
      const sent = await sendUpdate(next);
      if (myGen !== sessionGen || !active) return;
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
  if (!active) return;
  pendingPayload = payload;
  if (retryTimer !== null) return;
  void drain();
}

async function teardown() {
  // Bump generation FIRST so any in-flight drain bails on its next
  // gen check, and any retry timer no-ops on fire.
  sessionGen += 1;
  active = false;
  clearRetry();
  pendingPayload = null;
  await killHelper();
}

export async function activate(context) {
  ctx = context;
  active = true;

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
        lastContext = next;
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
