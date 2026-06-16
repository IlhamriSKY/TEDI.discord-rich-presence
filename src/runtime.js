// Discord Rich Presence — runtime module. Bundled into extension.js by
// build.mjs. Shared constants + mutable module-level singletons (the sidecar
// handle / port / ctx / drain bookkeeping). Other modules import the live
// bindings for reads and call the setters here for writes (esbuild preserves
// ESM live-binding semantics across the bundle), mirroring sql-explorer's
// runtime.js. Keep this the ONE owner of the state so no module duplicates it.

export const READ_PORT_TIMEOUT_MS = 5000;
export const READ_PORT_POLL_MS = 100;
export const RETRY_DELAY_MS = 15_000;

export let ctx = null;
/** Background process handle returned by `shell_bg_spawn_direct`. */
export let helperBgId = null;
/** localhost port the helper is listening on. */
export let helperPort = null;
/** Most recently requested payload (newer wins). */
export let pendingPayload = null;
export let connected = false;
export let draining = false;
export let retryTimer = null;
/** Bumped on every teardown so an in-flight retry knows to bail. */
export let sessionGen = 0;
export let lastContext = {
  workspaceCwd: null,
  activeFileName: null,
  terminalCount: 0,
  activeTabKind: null,
  // TEDI >= 0.2.27 ships these on every onContextChange snapshot. Older
  // hosts simply omit them; the build below treats `undefined` the same
  // as zero so the presence still renders.
  workspaceCount: 1,
  terminalCountAll: 0,
};
/** Latched on teardown so any late drain calls become no-ops. */
export let active = false;

export function setCtx(value) {
  ctx = value;
}
export function setHelperBgId(value) {
  helperBgId = value;
}
export function setHelperPort(value) {
  helperPort = value;
}
export function setPendingPayload(value) {
  pendingPayload = value;
}
export function setConnected(value) {
  connected = value;
}
export function setDraining(value) {
  draining = value;
}
export function setRetryTimer(value) {
  retryTimer = value;
}
export function setSessionGen(value) {
  sessionGen = value;
}
export function setLastContext(value) {
  lastContext = value;
}
export function setActive(value) {
  active = value;
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
