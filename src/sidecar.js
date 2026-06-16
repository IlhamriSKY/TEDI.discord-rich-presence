// Sidecar lifecycle. Spawns the native helper via `shell_bg_spawn_direct`
// (direct spawn so the tracked PID is the helper itself — `shell_bg_kill`
// actually terminates it), polls its stdout for the `PORT=<n>` announcement,
// and tears it back down (best-effort /shutdown POST, then kill).

import { helperPathFor } from "./platform.js";
import {
  READ_PORT_POLL_MS,
  READ_PORT_TIMEOUT_MS,
  active,
  ctx,
  helperBgId,
  helperPort,
  setConnected,
  setHelperBgId,
  setHelperPort,
  sleep,
} from "./runtime.js";
import { safeStatusBarRemove } from "./statusbar.js";

export async function spawnHelper() {
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
        setHelperBgId(null);
        setHelperPort(null);
        setConnected(false);
      } else {
        return true;
      }
    } catch (err) {
      ctx.logger.warn("alive check failed; respawning", err);
      setHelperBgId(null);
      setHelperPort(null);
      setConnected(false);
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
    setHelperBgId(await ctx.invoke("shell_bg_spawn_direct", {
      program: path,
      args: [],
      cwd: null,
    }));
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
        setHelperPort(Number(match[1]));
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

export async function killHelper() {
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
  setHelperBgId(null);
  setHelperPort(null);
  setConnected(false);
  safeStatusBarRemove("presence");
}
