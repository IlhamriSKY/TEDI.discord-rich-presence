// HTTP / IPC client. Talks to the running sidecar over plain HTTP on
// 127.0.0.1:<port>. `ensureConnected` spawns the helper (if needed) and opens
// the Discord IPC link; `sendUpdate` pushes a presence payload, demoting the
// status icon back to "connecting" on any failure.

import { active, connected, ctx, helperPort, setConnected } from "./runtime.js";
import { showConnectedIcon, showConnectingIcon } from "./statusbar.js";
import { spawnHelper } from "./sidecar.js";

export async function ensureConnected() {
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
    setConnected(true);
    showConnectedIcon();
    return true;
  } catch (err) {
    ctx.logger.warn("connect fetch failed", err);
    return false;
  }
}

export async function sendUpdate(payload) {
  if (helperPort === null) return false;
  try {
    const resp = await fetch(`http://127.0.0.1:${helperPort}/update`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!resp.ok) {
      ctx.logger.warn("update failed", resp.status, await resp.text());
      setConnected(false);
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
    setConnected(false);
    showConnectingIcon();
    return false;
  }
}
