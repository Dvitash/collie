import { useEffect, useRef } from "react";
import { useRevalidator } from "react-router";

import { refreshNow } from "@/lib/api";
import { isLongUpload, useLongUpload } from "@/lib/connection-health";
import { beginCatchUp, endCatchUp, isLocked, useLocked } from "@/lib/idle";
import {
  burstAppliesTo,
  consumeTopologyPoll,
  useBurstPaneId,
  useFollowing,
  useSendCount,
  useTopologyBursting,
} from "@/lib/poll-intent";
import type { HomeData } from "@/lib/loaders";
import { crewMoving, runInFlight } from "@/lib/update-ribbon";
import type { Scope } from "@/lib/scope";

// Adaptive polling, the React Router way: a timer starts `revalidator.revalidate()`, which
// re-runs every active loader (snapshot + the open pane) — our equivalent of a refetch interval.
// The timer is completion-driven rather than an interval: `revalidate()` returns a promise that
// settles when React Router's revalidation settles, and only then do we arm the next timer. That
// matters for the 1ms visible cadence — a millisecond interval would otherwise spin while a fetch
// is in flight.
//
//  - the gap is resolved from what the OPERATOR is doing, not from what the herd is doing: a burst
//    right after a send, a fast gap while they follow a known pane at its live tail, a slow one when
//    they are on the dashboard or scrolled back (see `intervalFor` for the ordered rules);
//  - skipped while the tab is hidden, idle-locked, or carrying a long upload (battery/uplink);
//    focus/online/visibility and the upload's reactive store wake it back up.
//
// WHY IT IS SHAPED THIS WAY (#156). The cadence used to be one dial with two positions — 1.5s while
// anything anywhere was working or a pane was open, 4s otherwise — and both positions were a guess
// about the operator. The guess was wrong in both directions at once: a key you just pressed still
// waited up to 1.5s to show its effect, while a pane nobody was looking at was polled every 4s
// forever. The dial is gone. What replaced it is resolved from what is actually observable — did you
// just send something, is the mirror still changing, are you still on the live tail.
//
// Every constant is exported so the tests can pin the CADENCE BEHAVIOUR against it rather than
// against a number typed twice.
//
/** The gap during a burst — the few beats after a send, while the operator is watching their own
 *  keystroke land. Short enough that a key reads as immediate; spent only on the open pane, and only
 *  for the handful of polls the burst rules allow (lib/poll-intent.ts). */
export const BURST_MS = 1;
/** The gap while the operator follows a known pane at its live tail. */
export const HOT_MS = 1;
/** The home screen while an agent somewhere is working or blocked. Nobody is on a mirror, so there
 *  is nothing to keep smooth; the herd's row still has to reflect a status change without feeling
 *  stuck. */
export const HOME_BUSY_MS = 1000;
/** The gap when nothing says anybody is watching: the dashboard is quiet or a pane is scrolled back.
 *  Short enough to notice a newly interesting pane promptly; bursts and topology writes still get
 *  the 1ms path. */
export const IDLE_MS = 1500;

/**
 * Everything the cadence needs that the snapshot cannot tell us, as plain values.
 *
 * Passed in rather than read here so `intervalFor` stays pure and directly testable: the hook reads
 * the store (lib/poll-intent.ts) and hands over primitives.
 */
export interface PollIntent {
  /** A burst is running AND it belongs to the pane currently open (see `burstApplies`). */
  bursting: boolean;
  /** The pane view is pinned to the live tail. True when no pane is open. */
  following: boolean;
  /** A create or a close just went through and hasn't yet spent its catch-up polls — see
   *  `lib/poll-intent.ts` → `stampTopology`. Unlike `bursting`, this applies wherever the operator
   *  is looking, not only on the pane a send went to. */
  topologyBursting?: boolean;
}

// Self-heal a wedged revalidation. A normal poll waits for its returned promise rather than ticking
// while loading, but a black-holed fetch can stay `loading` forever (its timeout aside — the timer
// itself can freeze while the phone sleeps). Once a revalidation has been loading for longer than
// this — just past GET_TIMEOUT_MS (10s) as a belt-and-braces margin — a watchdog kicks a fresh
// revalidate() anyway: React Router aborts/supersedes the hung one (loaders treat that AbortError as
// "superseded"). We compare against wall-clock (Date.now), not a polling interval, precisely because
// timers can stop advancing during sleep — the age we care about is real elapsed time since the load
// began.
export const SUPERSEDE_MS = 12_000;

/**
 * Pure cadence resolver — exported so it can be unit-tested in isolation.
 *
 * The question is not "is anything happening anywhere" but "is the operator watching something
 * happen", answered by ordered rules:
 *   0. a topology burst → BURST_MS;
 *   1. a burst is running on the open pane → BURST_MS;
 *   2. a known pane is open and followed at its live tail → HOT_MS;
 *   3. an update run on this machine, or a crew run on its peers, is still moving → HOT_MS;
 *   4. no pane is open and some agent in the herd is working/blocked → HOME_BUSY_MS;
 *   5. otherwise → IDLE_MS.
 * Being hidden is not a rule here: the scheduler refuses to fetch behind a hidden tab.
 *
 * `intent` is optional so a caller that only wants the herd-shaped answer (rules 4 and 5) can ask
 * without holding the store; an absent intent simply reads as no burst and not following.
 */
export function intervalFor(
  data: HomeData | undefined,
  paneId?: string | null,
  intent?: PollIntent,
): number {
  // 0. A create or a close just went through, wherever you're looking: catch the list up.
  if (intent?.topologyBursting) return BURST_MS;

  // 1. A send just happened on the pane you are looking at: watch it land.
  if (intent?.bursting) return BURST_MS;

  // 2. A known pane that the operator follows is active screen time even when its agent is idle and
  // its last poll was unchanged. The live tail is the signal; status and ETag changes must not make
  // the visible pane wait on the dashboard cadence.
  if (paneId && intent?.following && paneIsOpen(data, paneId)) return HOT_MS;

  // 3. AN UPDATE IS RUNNING ON THIS MACHINE (M20/08). Measured on 2026-09-08: `/settings/updates`
  // opens no pane, so with an idle herd this fell through to rule 5 and polled the snapshot at the
  // idle cadence for the whole update — over a run whose four sentences already change perhaps four
  // times in as many minutes. The one screen where the operator is provably watching something
  // happen was the slowest screen in the app.
  //
  // Above the herd rule, because a herd that happens to be busy is not the reason to be fast here,
  // and below the pane rules, because a pane the operator is looking at still outranks a page they
  // may have left open. The state set comes from `lib/update-ribbon.ts`, never a copy.
  if (runInFlight(data?.update?.run) || crewMoving(data?.update)) return HOT_MS;

  // 4. Nobody is on a mirror, but the herd is not resting. The dashboard row is the thing being
  // watched now, and a status that flips there should not sit a full IDLE_MS behind.
  if (!paneId && herdBusy(data)) return HOME_BUSY_MS;

  // 5. Nothing says anybody is watching this.
  return IDLE_MS;
}

/** Whether any agent anywhere in the herd is working or blocked. */
function herdBusy(data: HomeData | undefined): boolean {
  return data?.agents.some((a) => a.status === "working" || a.status === "blocked") ?? false;
}

/** Whether the open pane is one the snapshot still knows about — an agent or a shell. A pane that
 *  has gone has nothing left to poll for. */
function paneIsOpen(data: HomeData | undefined, paneId: string): boolean {
  const allPanes = [...(data?.agents ?? []), ...(data?.shellPanes ?? [])];
  return allPanes.some((p) => p.paneId === paneId);
}

/**
 * Come back to a fresh herd, not to whatever was true when the phone was put down.
 *
 * THE TWO MOMENTS THIS COVERS ARE THE SAME MOMENT to an operator: the page becoming visible again,
 * and the idle pause being released. Both are "I am looking at this now", and both previously did
 * nothing but revalidate — which re-reads the BRIDGE's snapshot, and the bridge's snapshot is only
 * as fresh as the multiplexer census behind it. Under an adapter that censuses, a tab opened while
 * the phone was in a pocket could therefore be up to its declared bound old at the very instant the
 * operator looked (ADR 0031).
 *
 * The refresh is fired and NOT awaited before the revalidation, deliberately. Awaiting it would make
 * every foreground a two-round-trip wait before anything on screen moved, to save a fraction of one
 * poll interval — the revalidation that follows the refresh's own poke is the one that carries the
 * change, and it arrives on its own. What the operator sees is the current data at once and the
 * corrected data a beat later, rather than a blank beat and then both.
 */
function lookNow(scope: Scope | undefined): void {
  void refreshNow(scope);
}

export function usePolling(
  data: HomeData | undefined,
  paneId?: string | null,
  scope?: Scope,
  following?: boolean,
): number {
  const revalidator = useRevalidator();
  // Held in a ref for the same reason the revalidator is: the scheduler callbacks must not
  // re-subscribe every time the viewed host or session changes identity.
  const scopeRef = useRef(scope);
  scopeRef.current = scope;
  // Hold the revalidator in a ref so the scheduler only re-subscribes when the cadence changes,
  // not on every revalidation (its identity flips each cycle).
  const ref = useRef(revalidator);
  ref.current = revalidator;

  // Wall-clock timestamp of when the current revalidation began, or null when idle. Stamped on the
  // idle→loading edge and cleared on →idle, so the watchdog can tell how long a load has been in
  // flight. A ref, not state — it must not trigger re-renders.
  const loadingSince = useRef<number | null>(null);
  if (revalidator.state === "loading") {
    if (loadingSince.current === null) loadingSince.current = Date.now();
  } else {
    loadingSince.current = null;
  }

  // A request can start before React has rendered the router's loading state. Keep this guard
  // separate from `revalidator.state` so focus, visibility, and send wakes cannot start a second
  // normal revalidation in that render-sized window.
  const pollInFlight = useRef(false);
  const pendingRequest = useRef<Promise<void> | null>(null);
  const scheduler = useRef<{
    wake: () => void;
    onState: () => void;
    onSettled: () => void;
  } | null>(null);
  const wakeAfterRelease = useRef(false);
  // A rejected/aborted revalidation must not immediately re-enter the 1ms hot path while the root
  // is disconnected. Its next attempt uses at least the existing IDLE_MS cadence, then a success
  // clears this flag and returns to the visible target.
  const retrySlowly = useRef(false);

  // The cadence's inputs, read from the store the composer and the pane loader write to.
  const burstPane = useBurstPaneId();
  const storeFollowing = useFollowing();
  const sendKick = useSendCount();
  const topoBursting = useTopologyBursting();
  const longUpload = useLongUpload();
  const ms = intervalFor(data, paneId, {
    bursting: burstAppliesTo(burstPane, paneId),
    // The caller may own the flag directly (the tests do); otherwise the pane view's own follow
    // intent, published to lib/poll-intent, answers — and it is true whenever no pane is open.
    following: following ?? storeFollowing,
    topologyBursting: topoBursting,
  });

  const locked = useLocked();
  const wasLocked = useRef(locked);
  useEffect(() => {
    const released = wasLocked.current && !locked;
    wasLocked.current = locked;
    if (!released) return;
    beginCatchUp(); // holds the cover through the refetch — see the settle effect below
    lookNow(scopeRef.current);
    // The scheduler owns the in-flight guard and promise completion. If React is replacing its
    // effect during this release, leave a one-shot wake for the new scheduler setup.
    if (scheduler.current) scheduler.current.wake();
    else wakeAfterRelease.current = true;
  }, [locked]);

  // End the catch-up beat when the revalidator comes to rest. Keyed on the state itself, so it can't
  // fire on the loading edge: at release the state is still "idle" for one render, but `beginCatchUp`
  // has already run by the time this effect's dependency changes to "loading" and back.
  useEffect(() => {
    if (revalidator.state === "idle") endCatchUp();
  }, [revalidator.state]);

  useEffect(() => {
    let disposed = false;
    let timer: number | null = null;
    let watchdog: number | null = null;

    const blocked = (): boolean => document.hidden || isLocked() || isLongUpload();
    const clearTimer = (): void => {
      if (timer === null) return;
      window.clearTimeout(timer);
      timer = null;
    };
    const clearWatchdog = (): void => {
      if (watchdog === null) return;
      window.clearTimeout(watchdog);
      watchdog = null;
    };
    const stopTimers = (): void => {
      clearTimer();
      clearWatchdog();
    };
    const retryDelay = (): number => Math.max(ms, IDLE_MS);

    const schedule = (delay = retrySlowly.current ? retryDelay() : ms): void => {
      if (disposed || blocked() || timer !== null) return;
      timer = window.setTimeout(() => {
        timer = null;
        tick();
      }, delay);
    };

    const onSettled = (): void => {
      clearWatchdog();
      if (ref.current.state === "idle") loadingSince.current = null;
      if (disposed) return;
      if (ref.current.state === "idle") {
        schedule(retrySlowly.current ? retryDelay() : ms);
      } else if (!blocked()) {
        armWatchdog();
      }
    };

    const finish = (request: Promise<void> | null, failed: boolean): void => {
      if (request !== null) {
        if (pendingRequest.current !== request) return;
        pendingRequest.current = null;
      } else if (pendingRequest.current !== null) {
        return;
      }
      pollInFlight.current = false;
      retrySlowly.current = failed;
      scheduler.current?.onSettled();
    };

    function invokeRevalidation(allowLoading = false): void {
      if (disposed || blocked()) {
        stopTimers();
        return;
      }
      const r = ref.current;
      if (!allowLoading && (pollInFlight.current || r.state !== "idle")) {
        if (r.state === "loading") armWatchdog();
        return;
      }
      if (allowLoading && r.state !== "loading") return;

      pollInFlight.current = true;
      // A watchdog supersede starts a new age window. For a normal call this is the
      // idle→loading timestamp, and the render below will retain it.
      loadingSince.current = Date.now();

      let request: Promise<void>;
      try {
        request = r.revalidate();
      } catch {
        finish(null, true);
        return;
      }

      if (pendingRequest.current !== request) {
        pendingRequest.current = request;
        request.then(
          () => finish(request, false),
          () => finish(request, true),
        );
      }

      if (allowLoading || r.state === "loading") armWatchdog();
    }

    function armWatchdog(): void {
      clearWatchdog();
      if (disposed || blocked() || ref.current.state !== "loading") return;
      const since = loadingSince.current ?? Date.now();
      loadingSince.current = since;
      const delay = Math.max(0, SUPERSEDE_MS - (Date.now() - since));
      watchdog = window.setTimeout(() => {
        watchdog = null;
        if (disposed || blocked()) return;
        if (ref.current.state !== "loading") {
          onState();
          return;
        }
        const age = Date.now() - (loadingSince.current ?? Date.now());
        if (age >= SUPERSEDE_MS) invokeRevalidation(true);
        else armWatchdog();
      }, delay);
    }

    function tick(): void {
      if (disposed) return;
      if (blocked()) {
        stopTimers();
        return;
      }
      if (pollInFlight.current || ref.current.state !== "idle") {
        if (ref.current.state === "loading") armWatchdog();
        return;
      }
      consumeTopologyPoll();
      invokeRevalidation();
    }

    function onState(): void {
      if (disposed) return;
      if (blocked()) {
        stopTimers();
        return;
      }
      clearTimer();
      if (ref.current.state === "loading") {
        armWatchdog();
        return;
      }
      clearWatchdog();
      if (pollInFlight.current) return;
      schedule();
    }

    const currentScheduler = {
      wake: () => {
        clearTimer();
        tick();
      },
      onState,
      onSettled,
    };
    scheduler.current = currentScheduler;
    if (wakeAfterRelease.current) {
      wakeAfterRelease.current = false;
      currentScheduler.wake();
    } else {
      onState();
    }

    const onWake = () => currentScheduler.wake();
    const onVisible = () => {
      if (document.hidden) {
        stopTimers();
        return;
      }
      // Coming back to the foreground is the operator saying "show me now" — see lookNow. `focus`
      // and `online` are deliberately NOT given one: a focus fires on every tap into the window and
      // `online` fires on a flag that is known to lie (see the tick), so either would spend a
      // listing on something that is not somebody returning to the app.
      lookNow(scopeRef.current);
      currentScheduler.wake();
    };
    window.addEventListener("focus", onWake);
    window.addEventListener("online", onWake);
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      disposed = true;
      stopTimers();
      window.removeEventListener("focus", onWake);
      window.removeEventListener("online", onWake);
      document.removeEventListener("visibilitychange", onVisible);
      if (scheduler.current === currentScheduler) scheduler.current = null;
    };
    // `sendKick`, the cadence, the lock, and the upload each rebuild this one scheduler. A send
    // therefore restarts its gap from the tap, while blocked states retain no timer to spin.
  }, [ms, sendKick, locked, longUpload]);

  // External actions can start a revalidation without going through this hook. State transitions
  // cancel any pending normal timer, arm the one-shot watchdog, and start the next gap only after
  // the router reports idle again.
  useEffect(() => {
    scheduler.current?.onState();
  }, [revalidator.state]);

  return ms;
}
