import { act, renderHook } from "@testing-library/react";

import {
  capturedTerminalColumns,
  fitMirrorFontSize,
  mirrorContentWidth,
  useMirrorFontSize,
} from "./use-mirror-font-size";

describe("capturedTerminalColumns", () => {
  it("measures parsed display cells, including padding, wide glyphs, and combining marks", () => {
    const ansi = "\u001b[31mabc  \u001b[0m\n界e\u0301";
    expect(capturedTerminalColumns(ansi)).toBe(5);
  });

  it("returns zero for an empty capture", () => {
    expect(capturedTerminalColumns("")).toBe(0);
  });
});

describe("fitMirrorFontSize", () => {
  it("keeps the fractional fit so a 45-column phone pane fills without rounding overflow", () => {
    const size = fitMirrorFontSize({
      availableWidth: 371,
      columns: 45,
      cellWidth: 6.0009765625,
    });
    expect(size / 10 * 6.0009765625 * 45).toBeCloseTo(371, 6);
  });

  it("bounds wide and narrow captures and stays finite for empty measurements", () => {
    expect(fitMirrorFontSize({ availableWidth: 1, columns: 200, cellWidth: 6 })).toBe(9);
    expect(fitMirrorFontSize({ availableWidth: 2000, columns: 1, cellWidth: 6 })).toBe(16);
    expect(fitMirrorFontSize({ availableWidth: 371, columns: 0, cellWidth: 6 })).toBe(10);
    expect(Number.isFinite(fitMirrorFontSize({ availableWidth: 371, columns: 45, cellWidth: 0 }))).toBe(true);
  });
});

describe("mirrorContentWidth", () => {
  it("subtracts the scrollport gutters while clientWidth already excludes its scrollbar", () => {
    const element = document.createElement("div");
    element.style.paddingLeft = "8px";
    element.style.paddingRight = "8px";
    Object.defineProperty(element, "clientWidth", { configurable: true, value: 387 });
    expect(mirrorContentWidth(element)).toBe(371);
  });
});

describe("useMirrorFontSize — resize transitions", () => {
  let resize: ResizeObserverCallback | undefined;
  let cellWidth = 6;

  class TestResizeObserver {
    constructor(callback: ResizeObserverCallback) {
      resize = callback;
    }
    observe() {}
    disconnect() {}
  }

  beforeEach(() => {
    resize = undefined;
    cellWidth = 6;
    vi.stubGlobal("ResizeObserver", TestResizeObserver);
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(
      () => ({
        font: "",
        measureText: () => ({ width: cellWidth }),
      }) as unknown as CanvasRenderingContext2D,
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("recomputes from the one scrollport when its available width changes", () => {
    const scrollElement = document.createElement("div");
    scrollElement.style.paddingLeft = "8px";
    scrollElement.style.paddingRight = "8px";
    Object.defineProperty(scrollElement, "clientWidth", { configurable: true, value: 387 });

    const { result } = renderHook(() =>
      useMirrorFontSize({
        display: "x".repeat(45),
        manualFontSize: 10,
        fitWidth: true,
        scrollElement,
        fontFamilyKey: "system",
      }),
    );
    expect(result.current / 10 * cellWidth * 45).toBeCloseTo(371, 6);

    Object.defineProperty(scrollElement, "clientWidth", { configurable: true, value: 287 });
    act(() => resize?.([], {} as ResizeObserver));
    expect(result.current).toBeCloseTo(10.037, 3);

    cellWidth = 5;
    act(() => resize?.([], {} as ResizeObserver));
    expect(result.current).toBeCloseTo(12.044, 3);
  });
});
