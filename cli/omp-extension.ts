import { MUX_ENV_MARKERS } from "./beacon.ts";

// The omp extension `collie hooks install omp` writes — the source as ONE function of the pinned binary.
//
// omp has no shell-command hooks: an integration is a TypeScript module in `<agent dir>/extensions/`
// that omp loads in-process and that subscribes to its lifecycle events (.adr/0086). So the state
// machine that Claude Code's hook table expresses as five events lives here instead, and the module
// reports each CHANGE by spawning `collie beacon emit omp` directly — an argv array, no shell — so the
// emitter's parent pid is omp itself, which is what the beacon's liveness check needs.
//
// The state machine is Herdr's omp integration (`herdr-omp-agent-state.ts`, integration v8), reduced
// to the three words a beacon carries: blocked ⇒ `waiting`. Main-session gating (hasUI, the subagent
// session-path shape, OMP_SUBAGENT / ctx.isSubagent) is the union of Herdr's and Orca's.
//
// Installed BYTE FOR BYTE: `hooks status` and `hooks status --check` compare the file on disk with
// what this function returns for the binary the file already pins, so any change to this text makes
// every installed copy "behind" until `hooks install omp` rewrites it. No marker bump is needed for
// that — the bytes are the version.

/**
 * The extension's full source, with `binary` pinned in and `marker` (`# collie-beacon v1`) on its
 * first line — the line ownership is decided by.
 */
export function ompExtensionSource(binary: string, marker: string): string {
  const muxPairs = JSON.stringify(MUX_ENV_MARKERS.map((source) => [source.paneVar, source.scopeVar]));
  return `// ${marker} omp
// Managed by collie: \`collie hooks install omp\` rewrites this file and \`collie hooks uninstall omp\` removes it.
// Put your own extensions beside it rather than editing it.
// @ts-nocheck
import { spawn, spawnSync } from "node:child_process";
import path from "node:path";

const COLLIE_BIN = ${JSON.stringify(binary)};
const EMIT_ARGS = ["beacon", "emit", "omp"];
const MUX_ENV = ${muxPairs};
const IDLE_DEBOUNCE_MS = 250;
const RETRY_GRACE_MS = 2500;
const RETRYABLE_ERROR =
  /overloaded|provider.?returned.?error|rate.?limit|too many requests|429|500|502|503|504|service.?unavailable|server.?error|internal.?error|network.?error|connection.?error|connection.?refused|connection.?lost|websocket.?closed|websocket.?error|other side closed|fetch failed|upstream.?connect|reset before headers|socket hang up|ended without|http2 request did not get a response|timed? out|timeout|terminated|retry delay/i;

function isMainSession(ctx) {
  try {
    if (ctx?.hasUI !== true) return false;
    if (ctx.isSubagent === true || ctx.isAdvisor === true) return false;
    if (ctx.session?.isSubagent === true || ctx.session?.isAdvisor === true) return false;
    const file = ctx.sessionManager?.getSessionFile?.();
    // A subagent's session lives in a directory named for its parent's timestamp (2026-01-02T…).
    return !(typeof file === "string" && /^\\d{4}-\\d{2}-\\d{2}T[0-9A-Za-z_-]+/.test(path.basename(path.dirname(file))));
  } catch {
    return false;
  }
}

function sessionIdOf(ctx) {
  try {
    const id = ctx?.sessionManager?.getSessionId?.();
    return typeof id === "string" && id.length > 0 ? id : undefined;
  } catch {
    return undefined;
  }
}

function payload(state, sessionId) {
  return JSON.stringify({ hook_event_name: state, session_id: sessionId });
}

// One emitter at a time, latest state wins: two children racing could land an older state last.
let emitting = false;
let queued;

function drain() {
  if (emitting || queued === undefined) return;
  const next = queued;
  queued = undefined;
  emitting = true;
  let settled = false;
  const done = () => {
    if (settled) return;
    settled = true;
    emitting = false;
    try {
      drain();
    } catch {}
  };
  try {
    const child = spawn(COLLIE_BIN, EMIT_ARGS, { stdio: ["pipe", "ignore", "ignore"], windowsHide: true });
    child.on("error", done);
    child.on("close", done);
    child.stdin?.on("error", () => {});
    child.stdin?.end(payload(next.state, next.sessionId));
    child.unref?.();
  } catch {
    done();
  }
}

function emit(state, sessionId) {
  if (!sessionId) return;
  queued = { state, sessionId };
  try {
    drain();
  } catch {}
}

// At shutdown omp is about to exit, and an emitter it outlives is re-parented — its beacon would name
// the wrong pid. So the last word is said synchronously, on a short budget.
function emitBeforeExit(state, sessionId) {
  if (!sessionId) return;
  try {
    spawnSync(COLLIE_BIN, EMIT_ARGS, {
      input: payload(state, sessionId),
      stdio: ["pipe", "ignore", "ignore"],
      timeout: 1500,
      windowsHide: true,
    });
  } catch {}
}

function lastAssistantMessage(messages) {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message && typeof message === "object" && message.role === "assistant") return message;
  }
  return undefined;
}

function isRetryableError(event) {
  const messages = Array.isArray(event?.messages) ? event.messages : [];
  const assistant = lastAssistantMessage(messages);
  return assistant?.stopReason === "error" && RETRYABLE_ERROR.test(String(assistant.errorMessage ?? ""));
}

export default function (pi) {
  if (process.env.OMP_SUBAGENT === "1" || process.env.PI_SUBAGENT === "1") return;
  // Outside a multiplexer Collie can join a beacon to there is nothing to say — the emitter's own gate.
  if (!MUX_ENV.some(([pane, scope]) => !!process.env[pane]?.trim() && !!process.env[scope]?.trim())) return;

  let rootSession = false;
  let sessionId;
  let agentActive = false;
  let retryHoldActive = false;
  let failureBlocked = false;
  let blockedCount = 0;
  let lastState;
  let idleTimer;
  let retryTimer;

  function clearPendingTimers() {
    clearTimeout(idleTimer);
    clearTimeout(retryTimer);
    idleTimer = undefined;
    retryTimer = undefined;
  }

  function clearFailureState() {
    retryHoldActive = false;
    failureBlocked = false;
  }

  function desiredState(ctx) {
    if (blockedCount > 0 || failureBlocked) return "waiting";
    let running = false;
    let streaming = false;
    try {
      running = (ctx?.getAsyncJobSnapshot?.()?.running?.length ?? 0) > 0;
      streaming = ctx?.isIdle?.() === false;
    } catch {}
    return agentActive || retryHoldActive || streaming || running ? "working" : "idle";
  }

  function publishState(ctx, force = false) {
    const next = desiredState(ctx);
    if (!force && next === lastState) return;
    lastState = next;
    emit(next, sessionId);
  }

  function scheduleIdle(ctx) {
    clearPendingTimers();
    clearFailureState();
    idleTimer = setTimeout(() => {
      try {
        idleTimer = undefined;
        publishState(ctx);
      } catch {}
    }, IDLE_DEBOUNCE_MS);
    idleTimer.unref?.();
  }

  function holdForRetry() {
    clearPendingTimers();
    retryHoldActive = true;
    failureBlocked = false;
    publishState();
    retryTimer = setTimeout(() => {
      try {
        retryTimer = undefined;
        retryHoldActive = false;
        failureBlocked = true;
        publishState();
      } catch {}
    }, RETRY_GRACE_MS);
    retryTimer.unref?.();
  }

  function activateRootSession(ctx) {
    if (!isMainSession(ctx)) return false;
    rootSession = true;
    sessionId = sessionIdOf(ctx) ?? sessionId;
    return true;
  }

  function resetSessionState() {
    clearPendingTimers();
    clearFailureState();
    agentActive = false;
    blockedCount = 0;
  }

  function activateBlocked() {
    clearPendingTimers();
    blockedCount += 1;
    publishState();
  }

  function deactivateBlocked() {
    blockedCount = Math.max(0, blockedCount - 1);
    publishState();
  }

  // Every handler is wrapped: an exception out of an extension handler is omp's problem, and one out
  // of a timer ends the session.
  function on(name, handler) {
    pi.on(name, (event, ctx) => {
      try {
        handler(event, ctx);
      } catch {}
    });
  }

  function mainTurn(ctx) {
    if (!rootSession && !activateRootSession(ctx)) return false;
    return isMainSession(ctx);
  }

  on("session_start", (_event, ctx) => {
    if (!activateRootSession(ctx)) return;
    agentActive = ctx?.isIdle?.() === false;
    publishState(ctx, true);
  });

  on("session_switch", (_event, ctx) => {
    if (!activateRootSession(ctx)) return;
    resetSessionState();
    publishState(ctx, true);
  });

  on("agent_start", (_event, ctx) => {
    if (!mainTurn(ctx)) return;
    sessionId = sessionIdOf(ctx) ?? sessionId;
    clearPendingTimers();
    clearFailureState();
    agentActive = true;
    publishState(ctx);
  });

  on("tool_approval_requested", (_event, ctx) => {
    if (!mainTurn(ctx)) return;
    activateBlocked();
  });

  on("tool_approval_resolved", (_event, ctx) => {
    if (!mainTurn(ctx)) return;
    deactivateBlocked();
  });

  on("tool_execution_start", (event, ctx) => {
    if (!mainTurn(ctx)) return;
    clearPendingTimers();
    agentActive = true;
    if (event?.toolName === "ask") activateBlocked();
    else publishState(ctx);
  });

  on("tool_execution_end", (event, ctx) => {
    if (!mainTurn(ctx)) return;
    if (event?.toolName === "ask") deactivateBlocked();
  });

  on("agent_end", (event, ctx) => {
    if (!rootSession || !isMainSession(ctx)) return;
    // A duplicate or late end while a retry already holds the pane must not publish a false idle.
    if (!agentActive) return;
    // The turn continues once its tool calls settle.
    if (event?.willContinue === true) return;
    if ((ctx?.getAsyncJobSnapshot?.()?.running?.length ?? 0) > 0) return;
    agentActive = false;
    if (isRetryableError(event)) {
      holdForRetry();
      return;
    }
    scheduleIdle(ctx);
  });

  on("session_shutdown", (_event, ctx) => {
    if (!rootSession || !isMainSession(ctx)) return;
    clearPendingTimers();
    queued = undefined;
    emitBeforeExit("idle", sessionId);
  });
}
`;
}
