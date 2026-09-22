import { act, renderHook } from "@testing-library/react";

import {
  BURST_MS,
  HOME_BUSY_MS,
  HOT_MS,
  IDLE_MS,
  SUPERSEDE_MS,
  intervalFor,
  type PollIntent,
  usePolling,
} from "./use-polling";
import { beginLongUpload, endLongUpload } from "@/lib/connection-health";
import { isCatchingUp, resetIdleLock, setLocked } from "@/lib/idle";
import {
  BURST_MIN_POLLS,
  markPollResult,
  resetPollIntent,
  setFollowing,
  stampSend,
  stampTopology,
} from "@/lib/poll-intent";
import type { HomeData } from "@/lib/loaders";
import type { AgentView, UpdateInfo, UpdateRun } from "@/lib/types";

// usePolling reads useRevalidator(); drive its state/revalidate directly (hoisted so the vi.mock
// factory can close over the holder). intervalFor is pure and doesn't touch it.
interface RevalidatorState {
  state: "idle" | "loading";
  revalidate: ReturnType<typeof vi.fn>;
}
const rr = vi.hoisted((): RevalidatorState => ({
  state: "idle",
  revalidate: vi.fn(() => Promise.resolve()),
}));
vi.mock("react-router", () => ({
  useRevalidator: () => ({ state: rr.state, revalidate: rr.revalidate }),
}));

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeAgent(paneId: string, status: AgentView["status"]): AgentView {
  return {
    paneId,
    workspaceId: "w1",
    workspaceLabel: "test",
    workspaceNumber: 1,
    tabId: "w1:t1",
    agent: "claude",
    status,
    cwd: "/",
    focused: false,
  };
}

function makeShell(paneId: string): AgentView {
  return {
    paneId,
    workspaceId: "w1",
    workspaceLabel: "test",
    workspaceNumber: 1,
    tabId: "w1:t1",
    agent: "shell",
    status: "unknown",
    cwd: "/",
    focused: false,
    kind: "shell",
  };
}

function makeData(agents: AgentView[], shellPanes: AgentView[] = []): HomeData {
  return {
    bridge: "connected",
    device: undefined,
    agents,
    shellPanes,
    workspaces: [],
    tabs: [],
    sessions: [],
    servers: [],
    ts: 0,
    scope: {},
    viewAll: false,
    snoozedUntil: null,
    update: undefined,
    error: false,
    authError: false,
  };
}

// The cadence tests read the constants, never a copy of their values: the numbers are a judgement
// call that may be re-tuned (issue #156), and what must not change is the BEHAVIOUR around them.
const HOT = HOT_MS;

/** An intent with no burst or topology write — each test names only what it changes. */
function on(over: Partial<PollIntent> = {}): PollIntent {
  return { bursting: false, following: true, ...over };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

// The cadence rules, in the order `intervalFor` applies them. The question is whether the operator
// is on a live pane, watching the dashboard, or reading backscroll.
describe("intervalFor", () => {
  const idlePane = makeData([makeAgent("w1:p1", "idle")]);
  const workingPane = makeData([makeAgent("w1:p1", "working")]);
  const blockedPane = makeData([makeAgent("w1:p1", "blocked")]);
  const shell = makeData([], [makeShell("w1:s1")]);
  const elsewhere = makeData([makeAgent("w1:p1", "idle"), makeAgent("w1:p9", "working")]);

  it("rule 0 — a topology burst wins even on the home screen with an idle herd", () => {
    expect(intervalFor(idlePane, null, on({ topologyBursting: true }))).toBe(BURST_MS);
    expect(intervalFor(undefined, undefined, on({ topologyBursting: true }))).toBe(BURST_MS);
  });

  it("rule 1 — a burst on the open pane wins over everything else", () => {
    expect(intervalFor(idlePane, "w1:p1", on({ bursting: true }))).toBe(BURST_MS);
    // Even scrolled up, and even with nothing changing: you just typed, so watch it land.
    expect(intervalFor(idlePane, "w1:p1", on({ bursting: true, following: false }))).toBe(BURST_MS);
  });

  it("rule 2 — any known, followed pane stays hot", () => {
    expect(intervalFor(workingPane, "w1:p1", on())).toBe(HOT);
    expect(intervalFor(blockedPane, "w1:p1", on())).toBe(HOT);
  });

  it("rule 2 — an idle pane stays hot when the operator follows it", () => {
    // The live tail is active screen time even when the agent and the last ETag read are quiet.
    expect(intervalFor(elsewhere, "w1:p1", on())).toBe(HOT);
  });

  it("rule 3 — a known, followed shell stays hot without status or ETag changes", () => {
    expect(intervalFor(shell, "w1:s1", on())).toBe(HOT);
  });

  it("rule 4 — the home screen over a busy herd polls at HOME_BUSY_MS", () => {
    // Nobody is on a mirror, so nothing needs to be smooth; the dashboard row still has to show a
    // status flip without feeling stuck.
    expect(intervalFor(elsewhere, null, on())).toBe(HOME_BUSY_MS);
    expect(intervalFor(elsewhere, undefined, on())).toBe(HOME_BUSY_MS);
    expect(intervalFor(blockedPane, null, on())).toBe(HOME_BUSY_MS);
    // An absent intent is a legitimate caller (CrewProvider asks for the gap alone).
    expect(intervalFor(elsewhere, null)).toBe(HOME_BUSY_MS);
  });

  it("rule 5 — the home screen over an idle herd backs off to IDLE_MS", () => {
    expect(intervalFor(idlePane, null, on())).toBe(IDLE_MS);
    expect(intervalFor(makeData([makeAgent("w1:p1", "idle"), makeAgent("w1:p2", "done")]))).toBe(
      IDLE_MS,
    );
    expect(intervalFor(undefined)).toBe(IDLE_MS);
  });

  it("rule 5 — a scrolled-up pane and a quiet idle pane back off", () => {
    expect(intervalFor(workingPane, "w1:p1", on({ following: false }))).toBe(IDLE_MS);
    expect(intervalFor(shell, "w1:s1", on({ following: false }))).toBe(IDLE_MS);
    expect(intervalFor(idlePane, "w1:p1", on({ following: false }))).toBe(IDLE_MS);
  });

  it("a pane the snapshot no longer knows about is not 'open'", () => {
    expect(intervalFor(idlePane, "w99:phantom", on())).toBe(IDLE_MS);
  });
});

// The self-heal: a revalidation wedged in "loading" has no normal completion to arm another poll.
// Once it has been loading past SUPERSEDE_MS, the one-shot watchdog kicks a fresh revalidate() to
// supersede the hung one.
describe("usePolling — superseding a wedged revalidation", () => {
  // The hot scenario, stated the way the cadence states it: the operator is on this pane, pinned to
  // its tail (the store's default), and its own agent is working. That is rule 2 → HOT_MS.
  const HOT_PANE = "w1:p1";
  const hotData = () => makeData([makeAgent(HOT_PANE, "working")]);

  beforeEach(() => {
    vi.useFakeTimers();
    rr.state = "idle";
    rr.revalidate.mockReset();
    rr.revalidate.mockResolvedValue(undefined);
    resetPollIntent();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("does NOT revalidate before the SUPERSEDE_MS watchdog fires", () => {
    rr.state = "loading"; // stuck loading from the very first render
    renderHook(() => usePolling(hotData(), HOT_PANE));
    vi.advanceTimersByTime(SUPERSEDE_MS - 1);
    expect(rr.revalidate).not.toHaveBeenCalled();
  });

  it("DOES revalidate once the SUPERSEDE_MS watchdog fires", () => {
    rr.state = "loading";
    renderHook(() => usePolling(hotData(), HOT_PANE));
    vi.advanceTimersByTime(SUPERSEDE_MS);
    expect(rr.revalidate).toHaveBeenCalled();
  });

  it("starts the visible cadence when the revalidator is idle", () => {
    rr.state = "idle";
    renderHook(() => usePolling(hotData(), HOT_PANE));
    vi.advanceTimersByTime(HOT_MS);
    expect(rr.revalidate).toHaveBeenCalled();
  });

  // The idle lock pauses polling rather than unmounting the route tree, so the tick is the only thing
  // holding the socket off while the cover is up — and releasing it must refetch AT ONCE, since no
  // loader re-runs on its own with the tree still mounted.
  it("does not tick while idle-locked", () => {
    rr.state = "idle";
    setLocked(true);
    try {
      renderHook(() => usePolling(hotData(), HOT_PANE));
      vi.advanceTimersByTime(HOT_MS * 5); // several HOT intervals behind the cover
      expect(rr.revalidate).not.toHaveBeenCalled();
    } finally {
      resetIdleLock();
    }
  });

  it("revalidates immediately when the lock is released", () => {
    rr.state = "idle";
    setLocked(true);
    try {
      const { rerender } = renderHook(() => usePolling(hotData(), HOT_PANE));
      expect(rr.revalidate).not.toHaveBeenCalled();
      act(() => setLocked(false));
      rerender();
      expect(rr.revalidate).toHaveBeenCalled(); // no waiting out an interval
    } finally {
      resetIdleLock();
    }
  });

  // The cover outlives the lock by exactly one refetch: releasing enters the catch-up beat, and only
  // the revalidator coming to rest ends it. Without this the cover would drop straight back onto the
  // frozen screen it just warned about.
  it("holds the catch-up beat from release until the revalidation settles", () => {
    rr.state = "idle";
    setLocked(true);
    try {
      const { rerender } = renderHook(() => usePolling(hotData(), HOT_PANE));
      act(() => setLocked(false));
      rerender();
      expect(isCatchingUp()).toBe(true);

      rr.state = "loading"; // the refetch is in flight — still covered
      rerender();
      expect(isCatchingUp()).toBe(true);

      rr.state = "idle"; // settled — the cover can go
      rerender();
      expect(isCatchingUp()).toBe(false);
    } finally {
      resetIdleLock();
    }
  });

  // Regression: some phones report navigator.onLine === false even when the network is fine (it stuck
  // false after an airplane-mode toggle). The tick must NOT gate on it — otherwise polling wedges
  // forever and the app can never discover the connection came back. A stuck-false flag still polls.
  it("keeps polling even when navigator.onLine reports false (the flag can lie — never wedge)", () => {
    rr.state = "idle";
    Object.defineProperty(navigator, "onLine", { configurable: true, get: () => false });
    try {
      renderHook(() => usePolling(hotData(), HOT_PANE));
      vi.advanceTimersByTime(HOT_MS); // one HOT tick with the flag stuck false
      expect(rr.revalidate).toHaveBeenCalled();
    } finally {
      Reflect.deleteProperty(navigator, "onLine"); // restore the prototype getter
    }
  });
});

describe("usePolling — completion-driven scheduling", () => {
  const HOT_PANE = "w1:p1";
  const hotData = () => makeData([makeAgent(HOT_PANE, "working")]);

  beforeEach(() => {
    vi.useFakeTimers();
    rr.state = "idle";
    rr.revalidate.mockReset();
    rr.revalidate.mockResolvedValue(undefined);
    resetPollIntent();
  });
  afterEach(() => {
    vi.useRealTimers();
    resetPollIntent();
  });

  it("waits for a revalidation to settle before the next 1ms hot poll", async () => {
    let resolve!: () => void;
    const request = new Promise<void>((done) => {
      resolve = done;
    });
    rr.revalidate.mockReturnValue(request);
    renderHook(() => usePolling(hotData(), HOT_PANE));

    act(() => vi.advanceTimersByTime(HOT_MS));
    expect(rr.revalidate).toHaveBeenCalledTimes(1);

    act(() => vi.advanceTimersByTime(HOT_MS * 100));
    expect(rr.revalidate).toHaveBeenCalledTimes(1);

    act(() => resolve());
    await act(async () => {
      await request;
    });

    act(() => vi.advanceTimersByTime(HOT_MS - 1));
    expect(rr.revalidate).toHaveBeenCalledTimes(1);
    act(() => vi.advanceTimersByTime(1));
    expect(rr.revalidate).toHaveBeenCalledTimes(2);
  });

  it("backs off a rejected hot poll instead of retrying at 1ms", async () => {
    let reject!: (error: Error) => void;
    const request = new Promise<void>((_resolve, fail) => {
      reject = fail;
    });
    rr.revalidate.mockReturnValue(request);
    renderHook(() => usePolling(hotData(), HOT_PANE));

    act(() => vi.advanceTimersByTime(HOT_MS));
    expect(rr.revalidate).toHaveBeenCalledTimes(1);
    act(() => reject(new Error("offline")));
    await act(async () => {
      await request.catch(() => undefined);
    });

    act(() => vi.advanceTimersByTime(IDLE_MS - 1));
    expect(rr.revalidate).toHaveBeenCalledTimes(1);
    act(() => vi.advanceTimersByTime(1));
    expect(rr.revalidate).toHaveBeenCalledTimes(2);
  });

  it("does not retain a timer while hidden or while a long upload is active", () => {
    const hidden = Object.getOwnPropertyDescriptor(document, "hidden");
    Object.defineProperty(document, "hidden", { configurable: true, value: true });
    const { unmount } = renderHook(() => usePolling(hotData(), HOT_PANE));
    try {
      expect(vi.getTimerCount()).toBe(0);
      act(() => vi.advanceTimersByTime(HOT_MS * 100));
      expect(rr.revalidate).not.toHaveBeenCalled();
    } finally {
      if (hidden) Object.defineProperty(document, "hidden", hidden);
      else Reflect.deleteProperty(document, "hidden");
    }

    act(() => beginLongUpload());
    try {
      expect(vi.getTimerCount()).toBe(0);
      act(() => vi.advanceTimersByTime(HOT_MS * 100));
      expect(rr.revalidate).not.toHaveBeenCalled();
    } finally {
      act(() => endLongUpload());
      unmount();
    }
  });

  it("cleans the pending timer on unmount", () => {
    const { unmount } = renderHook(() => usePolling(hotData(), HOT_PANE));
    expect(vi.getTimerCount()).toBe(1);
    unmount();
    expect(vi.getTimerCount()).toBe(0);
    act(() => vi.advanceTimersByTime(HOT_MS * 2));
    expect(rr.revalidate).not.toHaveBeenCalled();
  });
});


// The hook half: the intent is read from lib/poll-intent, and a send must not have to wait out a
// gap that was timed for an idle pane.
describe("usePolling — bursts and the follow intent", () => {
  const openPane = () => makeData([makeAgent("w1:p1", "idle")]);

  beforeEach(() => {
    vi.useFakeTimers();
    rr.state = "idle";
    rr.revalidate.mockReset();
    rr.revalidate.mockResolvedValue(undefined);
    resetPollIntent();
  });
  afterEach(() => {
    vi.useRealTimers();
    resetPollIntent();
  });

  it("backs off to IDLE_MS on a scrolled-up pane", () => {
    renderHook(() => usePolling(openPane(), "w1:p1", undefined, false));
    vi.advanceTimersByTime(IDLE_MS - 1);
    expect(rr.revalidate).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(rr.revalidate).toHaveBeenCalledTimes(1);
  });

  it("polls at BURST_MS after a send to the open pane", () => {
    renderHook(() => usePolling(openPane(), "w1:p1"));
    act(() => stampSend("w1:p1"));

    vi.advanceTimersByTime(BURST_MS - 1);
    expect(rr.revalidate).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(rr.revalidate).toHaveBeenCalledTimes(1);
  });

  it("reschedules from the tap — a send never waits out the old gap", () => {
    renderHook(() => usePolling(openPane(), "w1:p1", undefined, false));
    // Most of the way through the idle gap…
    vi.advanceTimersByTime(IDLE_MS - 1000);
    expect(rr.revalidate).not.toHaveBeenCalled();
    // …the operator taps a key. The next poll is BURST_MS from HERE, not 1000ms from here.
    act(() => stampSend("w1:p1"));
    vi.advanceTimersByTime(BURST_MS);
    expect(rr.revalidate).toHaveBeenCalledTimes(1);
  });

  it("restarts the burst gap on a second send inside the burst", () => {
    renderHook(() => usePolling(openPane(), "w1:p1"));
    act(() => stampSend("w1:p1"));
    vi.advanceTimersByTime(BURST_MS - 1); // one millisecond short of the poll this send bought
    act(() => stampSend("w1:p1")); // a second tap: the gap starts over
    vi.advanceTimersByTime(BURST_MS - 1);
    expect(rr.revalidate).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(rr.revalidate).toHaveBeenCalledTimes(1);
  });

  it("lets the burst go after its quiet polls and returns to the idle gap", async () => {
    const { rerender } = renderHook(() => usePolling(openPane(), "w1:p1", undefined, false));
    act(() => stampSend("w1:p1"));
    act(() => {
      for (let i = 0; i < 5; i += 1) markPollResult(false); // BURST_MIN_POLLS quiet reads
    });
    rerender();
    rr.revalidate.mockClear();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(BURST_MS * 4);
    });
    expect(rr.revalidate).not.toHaveBeenCalled(); // back on the slow gap
    await act(async () => {
      await vi.advanceTimersByTimeAsync(IDLE_MS);
    });
    expect(rr.revalidate).toHaveBeenCalledTimes(1);
  });

  it("does not spend a burst on a pane the operator has left", () => {
    renderHook(() => usePolling(openPane(), null)); // home screen
    act(() => stampSend("w1:p1"));
    vi.advanceTimersByTime(BURST_MS * 4);
    expect(rr.revalidate).not.toHaveBeenCalled();
  });

  it("polls at BURST_MS after a topology write, even on the home screen", () => {
    renderHook(() => usePolling(openPane(), null)); // home screen — no pane open
    act(() => stampTopology());

    vi.advanceTimersByTime(BURST_MS - 1);
    expect(rr.revalidate).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(rr.revalidate).toHaveBeenCalledTimes(1);
  });

  it("a topology write reschedules from the stamp, like a send does", () => {
    renderHook(() => usePolling(openPane(), null));
    vi.advanceTimersByTime(IDLE_MS - 1000);
    expect(rr.revalidate).not.toHaveBeenCalled();
    act(() => stampTopology());
    vi.advanceTimersByTime(BURST_MS);
    expect(rr.revalidate).toHaveBeenCalledTimes(1);
  });

  it("the topology burst spends itself after BURST_MIN_POLLS polls and backs off", async () => {
    renderHook(() => usePolling(openPane(), null));
    act(() => stampTopology());
    // Each tick updates (consumeTopologyPoll), then the scheduler re-arms its completion-driven
    // timeout; nothing spins while a read is loading.
    for (let i = 0; i < BURST_MIN_POLLS; i += 1) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(BURST_MS);
      });
    }
    expect(rr.revalidate).toHaveBeenCalledTimes(BURST_MIN_POLLS);
    rr.revalidate.mockClear();
    // Spent — the herd is idle and no pane is open, so the gap is back to IDLE_MS.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(BURST_MS * 4);
    });
    expect(rr.revalidate).not.toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(IDLE_MS);
    });
    expect(rr.revalidate).toHaveBeenCalledTimes(1);
  });

  it("reads the follow intent the pane view publishes", () => {
    const working = makeData([makeAgent("w1:p1", "working")]);
    const { rerender } = renderHook(() => usePolling(working, "w1:p1"));
    vi.advanceTimersByTime(HOT); // following (the default): the working pane is hot
    expect(rr.revalidate).toHaveBeenCalledTimes(1);

    rr.revalidate.mockClear();
    act(() => setFollowing(false)); // scrolled up to read backscroll
    rerender();
    vi.advanceTimersByTime(HOT * 3);
    expect(rr.revalidate).not.toHaveBeenCalled(); // frozen mirror, slow poll
  });

});

// ── An update run is the cadence's business (M20/08) ────────────────────────

describe("an update in flight is the fastest thing on the screen it is on", () => {
  const run = (state: UpdateRun["state"], over: Partial<UpdateRun> = {}): UpdateRun => ({
    schema: 1,
    state,
    from: "1.5.0",
    to: "1.6.0",
    startedAt: 1_000,
    updatedAt: 2_000,
    pid: 42,
    attempt: 0,
    ...over,
  });

  /** The everyday shape of the block, with only what the case is about changed. */
  const withRun = (over: Partial<UpdateInfo>): HomeData => ({
    ...makeData([]),
    update: {
      current: "1.5.0",
      latest: "1.6.0",
      latestUrl: null,
      releaseAvailable: false,
      majorAvailable: null,
      majorUrl: null,
      bridgeStale: false,
      checkedAt: null,
      ...over,
    },
  });

  it("a run somebody is still driving polls at HOT_MS, on a page with no pane and an idle herd", () => {
    // Measured on 2026-09-08: `/settings/updates` opens no pane, so with an idle herd this page fell
    // to rule 5 and polled at the idle cadence for the whole update. The one screen where the operator
    // is provably watching something happen was the slowest screen in the app.
    for (const state of ["preflight", "staging", "restarting", "verifying"] as const) {
      expect(intervalFor(withRun({ run: run(state) }), null)).toBe(HOT_MS);
    }
  });

  it("a terminal run does not — a finished update is not a reason to keep the radio warm", () => {
    for (const state of ["done", "rolled-back", "stuck", "interrupted", "idle"] as const) {
      expect(intervalFor(withRun({ run: run(state) }), null)).toBe(IDLE_MS);
    }
    expect(intervalFor(withRun({}), null)).toBe(IDLE_MS);
  });

  it("a PEERS-ONLY run counts too, and it has no local record at all (M20/09)", () => {
    // "Retry crew update" writes nothing to `update.json`, so a rule that read only `run` would poll
    // that whole run at the idle cadence.
    expect(intervalFor(withRun({ peers: [{ name: "minibuch", state: "updating" }] }), null)).toBe(HOT_MS);
    // And it stops when the lead says the run settled, not when a timer says so.
    expect(
      intervalFor(
        withRun({ peers: [{ name: "minibuch", state: "done" }], settledAt: 5_000 }),
        null,
      ),
    ).toBe(IDLE_MS);
  });

  it("a pane the operator is actually on still outranks it", () => {
    // The rule sits BELOW the pane rules on purpose: a page left open on Updates must not out-argue
    // a mirror somebody is reading.
    const data = withRun({ run: run("staging") });
    expect(intervalFor(data, "w1:p1", { bursting: true, following: true })).toBe(BURST_MS);
  });
});
