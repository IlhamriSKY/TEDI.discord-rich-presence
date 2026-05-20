// Discord Rich Presence extension - sidecar architecture.
//
// The TEDI binary itself has no Discord-specific code. This extension
// ships a small native helper (`sidecar/<platform>-<arch>/tedi-discord-helper`)
// that owns the Discord IPC connection. The extension JS layer:
//
//   1. picks the binary for the current OS / arch from `ctx.os`
//   2. spawns it via `shell_bg_spawn` (long-running bg process)
//   3. reads its stdout via `shell_bg_logs` to learn the localhost port
//      the helper bound to
//   4. talks to it over plain HTTP on 127.0.0.1
//
// The sidecar lifecycle is bound to the "Publish presence" toggle: on
// flips spawn it, off flips POST /shutdown + kill the process. Disable
// or uninstall does the same teardown via `deactivate()`.

const READ_PORT_TIMEOUT_MS = 5000;
const READ_PORT_POLL_MS = 100;
const RETRY_DELAY_MS = 15_000;

let ctx = null;
let enabled = false;
/** Background process id returned by `shell_bg_spawn`. */
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

function platformDir(os) {
  // CI builds the sidecar under sidecar/<platform>-<arch>/ to keep the
  // naming aligned with `rustc` triples. The shorthand here matches
  // what `.github/workflows/release.yml` produces.
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
  const dir = platformDir(os);
  if (!dir) return null;
  const exe = os.platform === "windows" ? "tedi-discord-helper.exe" : "tedi-discord-helper";
  return `${installPath.replace(/\\/g, "/")}/sidecar/${dir}/${exe}`;
}

/**
 * Build the shell command string `shell_bg_spawn` expects. TEDI wraps
 * the input with `pwsh -NoProfile -Command` on Windows and `$SHELL -lc`
 * on Unix, so we have to quote the path defensively for the host
 * shell. PowerShell needs the `&` call operator before a quoted path;
 * POSIX shells just need the path single-quoted.
 */
function spawnCommandFor(path, os) {
  const escaped = path.replace(/'/g, "''");
  return os.platform === "windows" ? `& '${escaped}'` : `'${escaped}'`;
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
  if (helperBgId !== null) return true;
  const path = helperPathFor(ctx.installPath, ctx.os);
  if (!path) {
    ctx.ui.toast(
      `Discord Rich Presence: no sidecar binary for ${ctx.os.platform}/${ctx.os.arch} in this release.`,
      { variant: "warning" },
    );
    return false;
  }
  try {
    // shell_bg_spawn returns the handle (u32) directly. The command is
    // run through the host shell, so we need to quote the binary path
    // for the host platform.
    helperBgId = await ctx.invoke("shell_bg_spawn", {
      command: spawnCommandFor(path, ctx.os),
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
  // Bounded poll for `PORT=<n>` on the helper's stdout. A misbehaving
  // helper that never prints would otherwise hang the extension; the
  // 5 s budget is intentionally short.
  const deadline = Date.now() + READ_PORT_TIMEOUT_MS;
  let logOffset = 0;
  while (Date.now() < deadline) {
    try {
      const logs = await ctx.invoke("shell_bg_logs", {
        handle: helperBgId,
        sinceOffset: logOffset,
      });
      const bytes = logs && typeof logs === "object" ? (logs.bytes ?? "") : String(logs ?? "");
      if (typeof logs === "object" && logs && typeof logs.next_offset === "number") {
        logOffset = logs.next_offset;
      }
      const match = String(bytes).match(/^PORT=(\d+)/m);
      if (match) {
        helperPort = Number(match[1]);
        ctx.logger.info("sidecar port", helperPort);
        return true;
      }
      // Bail early if the helper already exited (e.g. bind error).
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
    "Discord Rich Presence: sidecar did not announce a port within 5 s. Aborting.",
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
      // Give the helper a chance to clear its Discord activity first.
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
}

async function ensureConnected() {
  if (connected) return true;
  if (!(await spawnHelper())) return false;
  try {
    const resp = await fetch(`http://127.0.0.1:${helperPort}/connect`, { method: "POST" });
    if (!resp.ok) {
      const body = await resp.text();
      ctx.logger.warn("connect failed", resp.status, body);
      return false;
    }
    connected = true;
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
      if (!ok) {
        scheduleRetry(next);
        return;
      }
      const sent = await sendUpdate(next);
      if (myGen !== sessionGen) return;
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
  // Bump first so any in-flight retry / drain bails out.
  sessionGen += 1;
  clearRetry();
  pendingPayload = null;
  await killHelper();
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

  ctx.contribute.settings([
    {
      id: "enabled",
      type: "boolean",
      label: "Publish presence",
      description:
        "Spawn the bundled Discord IPC helper and start broadcasting your activity. Toggle off to disconnect and stop the helper process.",
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
