// Status-bar / header UI. The single "presence" status-bar item is the only
// chrome this extension shows; these helpers swap its connecting/connected
// tone and remove it on teardown. All reads go through the live `ctx` binding.

import { ctx } from "./runtime.js";

function safeStatusBarSet(item) {
  try {
    if (ctx?.statusBar?.setItem) ctx.statusBar.setItem(item);
  } catch (err) {
    ctx?.logger?.warn?.("statusBar.setItem failed", err);
  }
}

export function safeStatusBarRemove(id) {
  try {
    if (ctx?.statusBar?.removeItem) ctx.statusBar.removeItem(id);
  } catch (err) {
    ctx?.logger?.warn?.("statusBar.removeItem failed", err);
  }
}

export function showConnectingIcon() {
  safeStatusBarSet({
    id: "presence",
    icon: "discord.svg",
    tooltip: "Discord Rich Presence: connecting…",
    tone: "warning",
  });
}

export function showConnectedIcon() {
  safeStatusBarSet({
    id: "presence",
    icon: "discord.svg",
    tooltip: "Discord Rich Presence: connected",
    tone: "success",
  });
}
