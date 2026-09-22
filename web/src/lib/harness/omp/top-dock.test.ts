import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseAnsi } from "../../ansi";
import { splitLines } from "../../blocks";
import {
  composerPrompt,
  extractInputDraft,
  extractStatusLines,
  hasComposer,
  stripChrome,
} from "./index";
import {
  extractTopDockDraft,
  locateTopDockComposer,
} from "./top-dock";

const FIXTURES_DIR = join(import.meta.dirname, "../../../fixtures/omp-top-dock");
const PANES_DIR = join(import.meta.dirname, "../../../fixtures/panes");
const parse = (text: string) => splitLines(parseAnsi(text));
const fixture = (name: string) => readFileSync(join(FIXTURES_DIR, name), "utf8");
const pane = (name: string) => readFileSync(join(PANES_DIR, name), "utf8");

const TOP_DOCK_BG = "\x1b[48;2;12;24;36m";
const TOP_DOCK_FG = "\x1b[38;2;90;180;255m";
const topDockStatus = (text: string) => `\x1b[0m${TOP_DOCK_BG} ${TOP_DOCK_FG}${text}\x1b[0m${TOP_DOCK_BG} \x1b[49m`;
const topDockFrame = (prompt: string, continuationRows: string[] = []) =>
  ["", topDockStatus("usage"), topDockStatus("model"), prompt, ...continuationRows].join("\n");

describe("OMP extension top-dock composer", () => {
  it.each([
    ["top-dock-idle.ansi", null],
    ["top-dock-wrapped.ansi", "collie top dock wrapped draft text with enough characters to wrap across this narrow terminal viewport safely"],
  ])("recognises the owned %s capture and strips its chrome", (name, draft) => {
    const lines = parse(fixture(name));
    const composer = locateTopDockComposer(lines);

    expect(composer).not.toBeNull();
    expect(hasComposer(lines)).toBe(true);
    expect(extractInputDraft(lines)).toBe(draft);
    expect(extractStatusLines(lines)).toHaveLength(2);
    expect(stripChrome(lines)).toEqual([]);
    expect(composerPrompt(lines)).toBe(draft === null
      ? "❯"
      : "❯ collie top dock wrapped draft text with\n  enough characters to wrap across this narrow\n  terminal viewport safely");
  });

  it("uses draftGhost on the final input span and tolerates blank continuation padding", () => {
    const ghost = "\x1b[38;2;100;100;100mcompletion\x1b[0m";
    const lines = parse(topDockFrame("❯ first", ["", "  ", `  typed ${ghost}`]));
    const composer = locateTopDockComposer(lines);

    expect(composer).not.toBeNull();
    expect(extractTopDockDraft(lines, composer!)).toBe("first typed");
    expect(extractInputDraft(lines)).toBe("first typed");
  });

  it("matches a differently themed status widget without an RGB anchor", () => {
    const source = fixture("top-dock-idle.ansi");
    const themed = source.replaceAll("48;2;42;48;56", "48;2;7;61;83");
    const lines = parse(themed);
    expect(hasComposer(lines)).toBe(true);
    expect(extractInputDraft(lines)).toBeNull();
    expect(stripChrome(lines)).toEqual([]);
  });

  it("rejects bare prompts, unstyled/mismatched pairs, and stale top-dock rows under modals", () => {
    const idle = fixture("top-dock-idle.ansi");
    const rows = idle.split("\n");
    const unstyledSecondRow = rows.map((row, index) => (index === 2 ? row.replace(/\x1b\[[0-9;]*m/g, "") : row)).join("\n");
    const mismatchedSecondRow = rows.map((row, index) => (index === 2 ? row.replaceAll("48;2;42;48;56", "48;2;42;48;57") : row)).join("\n");

    expect(hasComposer(parse("❯"))).toBe(false);
    expect(hasComposer(parse(unstyledSecondRow))).toBe(false);
    expect(hasComposer(parse(mismatchedSecondRow))).toBe(false);

    for (const modal of ["omp--menu-model.txt", "omp--approval-bash.txt"]) {
      expect(hasComposer(parse(`${idle}\n${pane(modal)}`))).toBe(false);
    }
  });
});
