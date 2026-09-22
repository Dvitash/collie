import { useLayoutEffect, useMemo, useState } from "react";

import { hasDocument, hasResizeObserver } from "@/lib/env";
import { parseAnsi } from "@/lib/ansi";
import { lineText, splitLines } from "@/lib/blocks";
import { displayWidth } from "@/lib/text-width";
import { FONT_MAX, FONT_MIN } from "@/hooks/use-display-prefs";

/** The stable reference size used when measuring a terminal's monospace cell. */
export const MIRROR_REFERENCE_FONT_PX = 10;

/**
 * The mirror's captured terminal width, in display cells.
 *
 * Herdr returns the rendered grid, including the padding that establishes the pane width. Measuring
 * the parsed visible rows (rather than UTF-16 length or a phone-width constant) preserves that width
 * for CJK and combining marks too. Parsing is intentionally a pure, memoized render computation in
 * {@link useMirrorFontSize}; resize callbacks never touch the buffer.
 */
export function capturedTerminalColumns(display: string): number {
  if (display === "") return 0;
  const lines = splitLines(parseAnsi(display));
  let columns = 0;
  for (const line of lines) columns = Math.max(columns, displayWidth(lineText(line)));
  return columns;
}

/** Clamp a rendered size without rounding away the fractional fit. */
export function clampMirrorFontSize(size: number): number {
  if (!Number.isFinite(size)) return MIRROR_REFERENCE_FONT_PX;
  return Math.max(FONT_MIN, Math.min(FONT_MAX, size));
}

/**
 * Compute the fractional font size that makes the captured terminal width fill the measured mirror.
 * Invalid/empty measurements intentionally fall back to the reference size, avoiding NaN/Infinity
 * and a divide-by-zero on an empty buffer or a first paint before layout exists.
 */
export function fitMirrorFontSize({
  availableWidth,
  columns,
  cellWidth,
  referenceFontSize = MIRROR_REFERENCE_FONT_PX,
}: {
  availableWidth: number;
  columns: number;
  cellWidth: number;
  referenceFontSize?: number;
}): number {
  if (
    !Number.isFinite(availableWidth) ||
    !Number.isFinite(columns) ||
    !Number.isFinite(cellWidth) ||
    !Number.isFinite(referenceFontSize) ||
    availableWidth <= 0 ||
    columns <= 0 ||
    cellWidth <= 0 ||
    referenceFontSize <= 0
  ) {
    return clampMirrorFontSize(referenceFontSize);
  }
  return clampMirrorFontSize((availableWidth / (columns * cellWidth)) * referenceFontSize);
}

/** The content-box width of the ChatMessageList scrollport. `clientWidth` already excludes a scrollbar. */
export function mirrorContentWidth(element: HTMLElement): number {
  const style = getComputedStyle(element);
  const paddingLeft = Number.parseFloat(style.paddingLeft) || 0;
  const paddingRight = Number.parseFloat(style.paddingRight) || 0;
  return Math.max(0, element.clientWidth - paddingLeft - paddingRight);
}

/**
 * Measure one terminal cell at the reference size using the mirror's computed font family.
 * Canvas follows the actual font stack after a webfont load; the DOM fallback covers older or
 * restricted canvases without making the fit unbounded.
 */
export function measureMirrorCellWidth(element: HTMLElement, fontSize = MIRROR_REFERENCE_FONT_PX): number {
  if (!hasDocument()) return 0;
  const style = getComputedStyle(element);
  const family = style.fontFamily || "monospace";
  const weight = style.fontWeight || "400";
  const fontStyle = style.fontStyle || "normal";
  const letterSpacing = Number.parseFloat(style.letterSpacing);
  const spacing = Number.isFinite(letterSpacing) ? letterSpacing : 0;
  const font = `${fontStyle} ${weight} ${fontSize}px ${family}`;

  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d");
  if (context) {
    context.font = font;
    const width = context.measureText("0").width + spacing;
    if (Number.isFinite(width) && width > 0) return width;
  }

  const probe = document.createElement("span");
  probe.textContent = "0";
  probe.style.position = "absolute";
  probe.style.visibility = "hidden";
  probe.style.whiteSpace = "pre";
  probe.style.font = font;
  probe.style.letterSpacing = style.letterSpacing;
  document.body?.appendChild(probe);
  const width = probe.getBoundingClientRect().width;
  probe.remove();
  return Number.isFinite(width) && width > 0 ? width : 0;
}

interface UseMirrorFontSizeOptions {
  display: string;
  manualFontSize: number;
  fitWidth: boolean;
  /** The ChatMessageList scroll element, not a per-line child or outer page wrapper. */
  scrollElement: HTMLElement | null;
  /** Changes whenever the selected family changes, even when the element remains mounted. */
  fontFamilyKey: string;
}

/**
 * Own the one mirror resize measurement. The text-column parse is memoized by display identity;
 * ResizeObserver/font loading only re-measure geometry and font metrics.
 */
export function useMirrorFontSize({
  display,
  manualFontSize,
  fitWidth,
  scrollElement,
  fontFamilyKey,
}: UseMirrorFontSizeOptions): number {
  const columns = useMemo(() => fitWidth ? capturedTerminalColumns(display) : 0, [display, fitWidth]);
  const [fittedSize, setFittedSize] = useState(MIRROR_REFERENCE_FONT_PX);

  useLayoutEffect(() => {
    if (!fitWidth || !scrollElement) return;

    let disposed = false;
    const measure = () => {
      if (disposed) return;
      const availableWidth = mirrorContentWidth(scrollElement);
      // The scrollport inherits the app font; the terminal pre owns the monospace face.
      const terminal = scrollElement.querySelector<HTMLElement>("pre.font-mono")
        ?? scrollElement.querySelector<HTMLElement>(".font-mono")
        ?? scrollElement;
      const cellWidth = measureMirrorCellWidth(terminal);
      setFittedSize(fitMirrorFontSize({ availableWidth, columns, cellWidth }));
    };

    measure();

    const resizeObserver = hasResizeObserver()
      ? new ResizeObserver(measure)
      : null;
    resizeObserver?.observe(scrollElement);

    const fonts = hasDocument() ? document.fonts : undefined;
    const onFontChange = () => measure();
    fonts?.addEventListener("loadingdone", onFontChange);
    fonts?.addEventListener("loadingerror", onFontChange);
    if (fonts) void fonts.ready.then(onFontChange).catch(() => undefined);

    return () => {
      disposed = true;
      resizeObserver?.disconnect();
      fonts?.removeEventListener("loadingdone", onFontChange);
      fonts?.removeEventListener("loadingerror", onFontChange);
    };
  }, [columns, fitWidth, fontFamilyKey, scrollElement]);

  return fitWidth ? fittedSize : clampMirrorFontSize(manualFontSize);
}
