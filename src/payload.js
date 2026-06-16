// Presence payload builder. Turns an app-context snapshot
// (workspace / active file / terminal counts / tab kind) into the
// `{ details, state, small_image, small_text }` object sent to the sidecar.

import { lookupLangAsset } from "./assets.js";
import { ctx } from "./runtime.js";

function folderName(p) {
  if (!p) return "";
  const trimmed = String(p).replace(/[\\/]+$/, "");
  const parts = trimmed.split(/[\\/]/);
  return parts[parts.length - 1] || "";
}

function smallImageFor(c) {
  try {
    switch (c?.activeTabKind) {
      case "terminal":
        return { key: "tab_terminal", text: "Terminal" };
      case "ssh":
        return { key: "tab_ssh", text: "SSH session" };
      case "diff":
        return { key: "tab_diff", text: "Reviewing diff" };
      case "preview":
        return { key: "tab_preview", text: "Browser preview" };
      case "editor": {
        const key = lookupLangAsset(c.activeFileName) || "tab_editor";
        const text = c.activeFileName ? `Editing ${c.activeFileName}` : "Editing file";
        return { key, text };
      }
      default:
        return null;
    }
  } catch (err) {
    ctx?.logger?.warn?.("smallImageFor failed; dropping badge", err);
    return null;
  }
}

export function buildPayload(c) {
  const folder = folderName(c.workspaceCwd);
  const workspaceCount = Math.max(0, Number(c.workspaceCount ?? 0) || 0);
  const terminalCountAll = Math.max(0, Number(c.terminalCountAll ?? c.terminalCount ?? 0) || 0);

  const details = folder || "Idle";

  const parts = [];
  if (workspaceCount > 0) {
    parts.push(`${workspaceCount} workspace${workspaceCount === 1 ? "" : "s"}`);
  }
  if (terminalCountAll > 0) {
    parts.push(`${terminalCountAll} terminal${terminalCountAll === 1 ? "" : "s"}`);
  }
  const state = parts.join(", ");

  const small = smallImageFor(c);
  return {
    details,
    state,
    small_image: small?.key ?? "",
    small_text: small?.text ?? "",
  };
}
