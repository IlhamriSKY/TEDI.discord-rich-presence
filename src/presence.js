// Presence scheduler. Owns the "newest payload wins" drain loop: a push sets
// the pending payload and kicks `drain`, which connects + sends; failures
// schedule a single retry timer. `teardown` bumps the session generation so any
// in-flight drain / retry bails, clears state, and kills the sidecar.

import { ensureConnected, sendUpdate } from "./client.js";
import { killHelper } from "./sidecar.js";
import {
  RETRY_DELAY_MS,
  active,
  draining,
  pendingPayload,
  retryTimer,
  sessionGen,
  setActive,
  setDraining,
  setPendingPayload,
  setRetryTimer,
  setSessionGen,
} from "./runtime.js";

export function clearRetry() {
  if (retryTimer !== null) {
    clearTimeout(retryTimer);
    setRetryTimer(null);
  }
}

function scheduleRetry(payload) {
  if (retryTimer !== null || !active) return;
  if (pendingPayload === null) setPendingPayload(payload);
  setRetryTimer(setTimeout(() => {
    setRetryTimer(null);
    if (active) void drain();
  }, RETRY_DELAY_MS));
}

async function drain() {
  if (draining || !active) return;
  setDraining(true);
  const myGen = sessionGen;
  try {
    while (pendingPayload !== null && active) {
      const next = pendingPayload;
      setPendingPayload(null);
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
    setDraining(false);
  }
}

export function schedulePush(payload) {
  if (!active) return;
  setPendingPayload(payload);
  if (retryTimer !== null) return;
  void drain();
}

export async function teardown() {
  // Bump generation FIRST so any in-flight drain bails on its next
  // gen check, and any retry timer no-ops on fire.
  setSessionGen(sessionGen + 1);
  setActive(false);
  clearRetry();
  setPendingPayload(null);
  await killHelper();
}
