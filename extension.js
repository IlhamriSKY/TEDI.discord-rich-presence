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
let lastContext = {
  workspaceCwd: null,
  activeFileName: null,
  terminalCount: 0,
  activeTabKind: null,
};
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

// File extension -> Discord asset key for the small-image badge. Keys must
// match assets uploaded to the Discord Developer Portal under app id
// 1506303762418110505 (see README "Asset keys"). Unknown extensions fall
// back to `tab_editor` so the badge still tells the viewer "this is a
// file" rather than disappearing.
//
// The 22 lang_* keys (12 brand + 10 semantic) all source from the same
// HugeIcons free set as TabBar.tsx to keep the visual style coherent.
// Many languages share `lang_code` because HugeIcons doesn't carry their
// brand mark - one generic code badge beats sending an asset key that
// silently fails on Discord's side.
const LANG_ASSET_BY_EXT = {
  // ===== Brand-specific (HugeIcons free has dedicated icons) =====
  // PHP
  php: "lang_php",
  // JavaScript family (incl. CoffeeScript which transpiles to JS)
  js: "lang_js",
  mjs: "lang_js",
  cjs: "lang_js",
  jsx: "lang_js",
  coffee: "lang_js",
  litcoffee: "lang_js",
  // TypeScript
  ts: "lang_ts",
  tsx: "lang_ts",
  // Python
  py: "lang_python",
  pyw: "lang_python",
  pyi: "lang_python",
  // Java
  java: "lang_java",
  // HTML
  html: "lang_html",
  htm: "lang_html",
  xhtml: "lang_html",
  // CSS family (incl. preprocessors)
  css: "lang_css",
  scss: "lang_css",
  sass: "lang_css",
  less: "lang_css",
  styl: "lang_css",
  // SQL
  sql: "lang_sql",
  // Shells (all terminal-y scripting goes here for visual coherence)
  sh: "lang_shell",
  bash: "lang_shell",
  zsh: "lang_shell",
  fish: "lang_shell",
  ps1: "lang_shell",
  psm1: "lang_shell",
  bat: "lang_shell",
  cmd: "lang_shell",
  // Dart
  dart: "lang_dart",
  // CSV / TSV
  csv: "lang_csv",
  tsv: "lang_csv",
  // XML family
  xml: "lang_xml",
  xsd: "lang_xml",
  xsl: "lang_xml",
  xslt: "lang_xml",
  svg: "lang_image", // SVG is rendered as image despite XML-being
  plist: "lang_xml",

  // ===== Semantic generic code (FileCode) =====
  // Systems / native
  rs: "lang_code",
  go: "lang_code",
  kt: "lang_code",
  kts: "lang_code",
  swift: "lang_code",
  c: "lang_code",
  h: "lang_code",
  cpp: "lang_code",
  cc: "lang_code",
  cxx: "lang_code",
  hpp: "lang_code",
  hxx: "lang_code",
  cs: "lang_code",
  rb: "lang_code",
  lua: "lang_code",
  // Frontend frameworks
  vue: "lang_code",
  svelte: "lang_code",
  astro: "lang_code",
  // Functional / niche
  ex: "lang_code",
  exs: "lang_code",
  erl: "lang_code",
  hrl: "lang_code",
  hs: "lang_code",
  lhs: "lang_code",
  clj: "lang_code",
  cljs: "lang_code",
  cljc: "lang_code",
  edn: "lang_code",
  scala: "lang_code",
  sc: "lang_code",
  fs: "lang_code",
  fsx: "lang_code",
  fsi: "lang_code",
  ml: "lang_code",
  mli: "lang_code",
  pl: "lang_code",
  pm: "lang_code",
  pod: "lang_code",
  r: "lang_code",
  rmd: "lang_code",
  jl: "lang_code",
  groovy: "lang_code",
  gradle: "lang_code",
  sol: "lang_code",
  zig: "lang_code",
  nim: "lang_code",
  nims: "lang_code",
  asm: "lang_code",
  s: "lang_code",
  // Build / infra DSL
  mk: "lang_code",
  mak: "lang_code",
  cmake: "lang_code",
  graphql: "lang_code",
  gql: "lang_code",
  prisma: "lang_code",
  tf: "lang_code",
  tfvars: "lang_code",
  hcl: "lang_code",
  nix: "lang_code",
  // Templating
  pug: "lang_code",
  jade: "lang_code",
  // Editor scripting
  vim: "lang_code",
  vimrc: "lang_code",
  el: "lang_code",
  // Data schema
  proto: "lang_code",
  ipynb: "lang_code",
  // Pseudo-extension for Dockerfile (see `fileExt`)
  dockerfile: "lang_code",

  // ===== JSON-style data =====
  json: "lang_json",
  jsonc: "lang_json",
  json5: "lang_json",
  jsonl: "lang_json",
  ndjson: "lang_json",

  // ===== Generic config =====
  toml: "lang_config",
  yaml: "lang_config",
  yml: "lang_config",
  ini: "lang_config",
  conf: "lang_config",
  cfg: "lang_config",
  properties: "lang_config",
  editorconfig: "lang_config",
  // .env files use a dedicated key for the key/lock icon
  env: "lang_env",

  // ===== Markdown / docs =====
  md: "lang_markdown",
  mdx: "lang_markdown",
  markdown: "lang_markdown",
  rst: "lang_markdown",
  adoc: "lang_markdown",
  asciidoc: "lang_markdown",
  tex: "lang_markdown",
  sty: "lang_markdown",
  cls: "lang_markdown",

  // ===== Plain text =====
  txt: "lang_text",
  text: "lang_text",
  log: "lang_text",
  rtf: "lang_text",
  nfo: "lang_text",

  // ===== Images =====
  png: "lang_image",
  jpg: "lang_image",
  jpeg: "lang_image",
  gif: "lang_image",
  webp: "lang_image",
  ico: "lang_image",
  bmp: "lang_image",
  tiff: "lang_image",
  tif: "lang_image",
  avif: "lang_image",
  heic: "lang_image",
  heif: "lang_image",
  apng: "lang_image",

  // ===== Video =====
  mp4: "lang_video",
  webm: "lang_video",
  mov: "lang_video",
  avi: "lang_video",
  mkv: "lang_video",
  flv: "lang_video",
  wmv: "lang_video",
  m4v: "lang_video",
  "3gp": "lang_video",
  mpg: "lang_video",
  mpeg: "lang_video",

  // ===== Audio =====
  mp3: "lang_audio",
  wav: "lang_audio",
  ogg: "lang_audio",
  flac: "lang_audio",
  m4a: "lang_audio",
  aac: "lang_audio",
  opus: "lang_audio",
  wma: "lang_audio",
  mid: "lang_audio",
  midi: "lang_audio",

  // ===== Archives =====
  zip: "lang_archive",
  tar: "lang_archive",
  gz: "lang_archive",
  tgz: "lang_archive",
  "7z": "lang_archive",
  rar: "lang_archive",
  bz2: "lang_archive",
  xz: "lang_archive",
  zst: "lang_archive",
  lz: "lang_archive",
  lzma: "lang_archive",
};

// Exact-filename mapping (case-insensitive, no extension or compound name).
// Wins over the extension table — checked first so `Dockerfile.prod` maps
// the same as bare `Dockerfile` and `LICENSE` doesn't get the empty-ext
// fallback.
const LANG_ASSET_BY_FILENAME = {
  dockerfile: "lang_code",
  makefile: "lang_code",
  gnumakefile: "lang_code",
  rakefile: "lang_code",
  gemfile: "lang_code",
  brewfile: "lang_code",
  vagrantfile: "lang_code",
  pipfile: "lang_code",
  procfile: "lang_text",
  "cmakelists.txt": "lang_code",
  license: "lang_text",
  "license.md": "lang_markdown",
  "license.txt": "lang_text",
  readme: "lang_text",
  "readme.md": "lang_markdown",
  "readme.txt": "lang_text",
  changelog: "lang_text",
  "changelog.md": "lang_markdown",
  authors: "lang_text",
  contributors: "lang_text",
  ".gitignore": "lang_config",
  ".gitattributes": "lang_config",
  ".dockerignore": "lang_config",
  ".npmignore": "lang_config",
  ".prettierrc": "lang_config",
  ".eslintrc": "lang_config",
  ".env": "lang_env",
};

function fileExt(name) {
  if (!name) return "";
  const lower = String(name).toLowerCase();
  // Special-case Dockerfile-style names (no real extension or compound).
  if (lower === "dockerfile" || lower.endsWith(".dockerfile")) return "dockerfile";
  const dot = lower.lastIndexOf(".");
  if (dot <= 0 || dot === lower.length - 1) return "";
  return lower.slice(dot + 1);
}

function lookupLangAsset(name) {
  if (!name) return null;
  const lower = String(name).toLowerCase();
  // 1. Whole-filename match first (Makefile, Cargo.toml-like specials).
  if (LANG_ASSET_BY_FILENAME[lower]) return LANG_ASSET_BY_FILENAME[lower];
  // 2. Compound multi-dot stems (e.g. .env.local, .env.production) - try
  //    progressively stripping leading components until something matches.
  if (lower.startsWith(".env.")) return "lang_env";
  // 3. Plain extension.
  const ext = fileExt(name);
  return LANG_ASSET_BY_EXT[ext] || null;
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

function buildPayload(c) {
  const folder = folderName(c.workspaceCwd);
  const details = folder ? `Working in ${folder}` : "Idle";
  let state = "";
  if (c.activeFileName) {
    state = `Editing ${c.activeFileName}`;
  } else if (c.terminalCount > 0) {
    state = `${c.terminalCount} terminal${c.terminalCount === 1 ? "" : "s"} open`;
  }
  const small = smallImageFor(c);
  return {
    details,
    state,
    small_image: small?.key ?? "",
    small_text: small?.text ?? "",
  };
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
