import type { StyledLine } from "../../blocks";
import { draftGhost, isBlank, lineText, rstrip } from "./markers";

const TOP_DOCK_STATUS_ROWS = 2;
const MAX_DRAFT_ROWS = 100;
const TOP_DOCK_PROMPT = /^❯(?: ([\s\S]*))?$/;
const TOP_DOCK_CONTINUATION = /^ {2}([\s\S]*)$/;

export interface TopDockComposer {
  statusStart: number;
  promptStart: number;
  promptEnd: number;
}

/**
 * OMP's extension-defined `top-dock` shape has no border to anchor a composer. Its only positive
 * evidence is the widget's two opaque, theme-background rows immediately above the column-zero `❯`
 * prompt. Keep this grammar structural: provider/model/cwd text is user-configurable and is not an
 * anchor. A missing or partially styled widget is unknown and must stay fail-closed.
 */
export function locateTopDockComposer(lines: StyledLine[]): TopDockComposer | null {
  let promptEnd = lines.length - 1;
  let continuationRows = 0;
  while (promptEnd >= 0 && isBlank(lineText(lines[promptEnd]!))) {
    continuationRows++;
    if (continuationRows > MAX_DRAFT_ROWS) return null;
    promptEnd--;
  }
  if (promptEnd < 0) return null;

  let promptStart = promptEnd;
  while (promptStart >= 0) {
    const text = rstrip(lineText(lines[promptStart]!));
    if (!isBlank(text) && !TOP_DOCK_CONTINUATION.test(text)) break;
    continuationRows++;
    if (continuationRows > MAX_DRAFT_ROWS) return null;
    promptStart--;
  }

  if (promptStart < 0 || !TOP_DOCK_PROMPT.test(rstrip(lineText(lines[promptStart]!)))) return null;

  const statusStart = promptStart - TOP_DOCK_STATUS_ROWS;
  if (statusStart < 0) return null;
  if (statusStart > 0 && !isBlank(lineText(lines[statusStart - 1]!))) return null;

  const firstBg = opaqueBackground(lines[statusStart]!);
  const secondBg = opaqueBackground(lines[statusStart + 1]!);
  if (firstBg === null || secondBg === null || firstBg !== secondBg) return null;

  return { statusStart, promptStart, promptEnd };
}

/** Return the two status rows belonging to a located top-dock composer. */
export function extractTopDockStatusLines(
  lines: StyledLine[],
  composer: TopDockComposer,
): StyledLine[] {
  return lines.slice(composer.statusStart, composer.promptStart);
}

/** Remove the top-dock status widget and prompt tail, retaining transcript rows above it. */
export function stripTopDockChrome(lines: StyledLine[], composer: TopDockComposer): StyledLine[] {
  let end = composer.statusStart;
  while (end > 0 && isBlank(lineText(lines[end - 1]!))) end--;
  return lines.slice(0, end);
}

/** Recover the draft from the prompt and two-space continuation rows, excluding a final inline ghost. */
export function extractTopDockDraft(lines: StyledLine[], composer: TopDockComposer): string | null {
  const parts: string[] = [];
  for (let row = composer.promptStart; row <= composer.promptEnd; row++) {
    const text = rstrip(lineText(lines[row]!));
    if (row > composer.promptStart && isBlank(text)) {
      parts.push("");
      continue;
    }
    const match = row === composer.promptStart ? TOP_DOCK_PROMPT.exec(text) : TOP_DOCK_CONTINUATION.exec(text);
    if (match === null) return null;
    parts.push(match[1] ?? "");
  }

  const last = parts.length - 1;
  const tail = parts[last]!;
  const ghost = draftGhost(lines[composer.promptEnd]!, 2, 2 + tail.length);
  if (ghost.length > 0 && tail.endsWith(ghost)) parts[last] = tail.slice(0, -ghost.length);

  const draft = parts
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .join(" ");
  return draft.length === 0 ? null : draft;
}

/** Return the literal prompt/continuation region used to bind a destructive pre-clear sweep. */
export function topDockComposerPrompt(lines: StyledLine[], composer: TopDockComposer): string {
  return lines
    .slice(composer.promptStart, composer.promptEnd + 1)
    .map((line) => rstrip(lineText(line)))
    .join("\n");
}

/** A status row is opaque only when every visible segment carries one parsed background. */
function opaqueBackground(line: StyledLine): string | null {
  const text = lineText(line);
  if (isBlank(text) || !text.startsWith(" ")) return null;

  let background: string | undefined;
  for (const segment of line.segments) {
    if (segment.text.length === 0 || segment.bg === undefined) return null;
    if (background === undefined) background = segment.bg;
    else if (segment.bg !== background) return null;
  }
  return background ?? null;
}
