# 0086: omp beacons come from an in-process extension

- **Status:** Accepted
- **Date:** 2026-10-06
- **Shipped in:** unreleased
- **Amends:** [ADR 0024](./0024-a-beacon-is-a-hint-never-a-control-channel.md) in scope only: the beacon record, the reader and
  the decorator are unchanged; a second harness gains an emitter.
- **Trail:** `cli/omp-extension.ts` (`ompExtensionSource`) · `cli/beacon.ts` (`OMP_BEACON_STATES`,
  `beaconStatusOf`) · `cli/hooks.ts` (`ompExtensionPath`, `ompExtensionState`) ·
  `bridge/beacon-io.ts` (`hooksInstalledProbe`) · `cli/doctor.ts` (`beacon-hooks-omp`) · Herdr's
  `herdr-omp-agent-state.ts` (integration v8), whose state machine the extension follows

## Context

Under tern, tmux and zellij a pane is a shell until its agent names itself, and only Claude Code
could: `collie hooks install claude` registers `collie beacon emit` as a shell-command hook, and
Claude runs it as a direct child, so `process.ppid` is the agent and the beacon's liveness check
holds.

omp has no shell-command hooks. Its integration point is a TypeScript module in
`<agent dir>/extensions/` that omp loads in-process and that subscribes to lifecycle events
(`agent_start`, `tool_approval_requested`, `agent_end`, …). There is no event table to register a
command against, and the states a beacon needs (working, waiting, idle) have to be derived from
several events, the way Herdr's omp integration already does.

## Decision

**Collie ships an omp extension, and the extension spawns the existing emitter directly.**

1. `collie hooks install omp` writes `<agent dir>/extensions/collie-beacon.ts` (`PI_CODING_AGENT_DIR`
   or `~/.omp/agent`). Its first line is `// # collie-beacon v<N> omp`; that line is ownership, so a
   file without it is never overwritten or removed. The collie binary is pinned by the same
   `resolveHookCommand` rule the Claude hooks use.
2. The extension derives the state with Herdr's state machine (blocked ⇒ `waiting`) in the main,
   non-subagent session only, and only when a multiplexer pane marker is in the environment.
3. On each state change it spawns `[<collie>, "beacon", "emit", "omp"]` as an argv array, without a
   shell, and writes `{hook_event_name: <state>, session_id}` to stdin. Without a shell in between the
   emitter's parent is omp, so the beacon's pid is the agent's, as it is for Claude. The last report,
   at `session_shutdown`, runs synchronously, because an emitter that outlives omp is re-parented and
   would name the wrong pid; the emitter also refuses pid 1 for the same reason.
4. `beacon emit` takes the harness as an optional argument, `claude` by default, so every installed
   Claude hook command stays byte-identical. omp's table is the identity over the three states.
5. "Installed" means Claude's marked settings OR the marked extension — in `hooks status`, in
   `hooks status --check`, in `doctor`, and in the bridge's capability probe — so an omp-only host
   gets sight.
6. The extension is installed byte for byte. A file whose bytes differ from what this build writes
   for the binary it pins is behind, with no marker bump.

## Consequences

- Running omp sessions must be restarted to load the extension; omp reads extensions at startup.
- Each state change costs one process spawn. Spawns are serialised, latest state wins, so a late
  child cannot land an older state last.
- Any change to the extension text makes every installed copy behind until `hooks install omp` runs.
