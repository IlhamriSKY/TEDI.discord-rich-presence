// Platform / binary resolution. Picks the sidecar helper binary for the
// current OS / arch from the install layout
// (`sidecar/<platform>-<arch>/tedi-discord-helper`). Pure helpers, no shared
// state — given `ctx.os` + `ctx.installPath` they return a path string.

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

export function helperPathFor(installPath, os) {
  if (typeof installPath !== "string" || !installPath) return null;
  if (!os || typeof os.platform !== "string") return null;
  const dir = platformDir(os);
  if (!dir) return null;
  const exe = os.platform === "windows" ? "tedi-discord-helper.exe" : "tedi-discord-helper";
  return `${installPath.replace(/\\/g, "/")}/sidecar/${dir}/${exe}`;
}
