/**
 * Scenario tests for GraphCanvas draw paths, DPR scaling, and theme token reads.
 */
import { describe, expect, it } from "bun:test";
import {
  drawGraphCanvas,
  type GraphCanvasVisibleRow,
  type GraphDrawInputs,
} from "../../../../../../../src/renderer/components/files/git/history/graph/canvas";
import {
  initialLaneState,
  type LaneCommit,
  reduceLanes,
} from "../../../../../../../src/renderer/components/files/git/history/graph/lane-assign";
import type { LogEntry } from "../../../../../../../src/shared/types/git";

const ROW_HEIGHT_PX = 24;
const LANE_WIDTH_PX = 18;

interface CanvasCall {
  readonly name: string;
  readonly args: readonly unknown[];
}

/** Records the Canvas 2D API surface that GraphCanvas uses. */
class CanvasContextSpy {
  readonly calls: CanvasCall[] = [];

  private _lineCap: CanvasLineCap = "butt";
  private _lineJoin: CanvasLineJoin = "miter";
  private _lineWidth = 1;
  private _strokeStyle: string | CanvasGradient | CanvasPattern = "#000";
  private _fillStyle: string | CanvasGradient | CanvasPattern = "#000";

  set lineCap(value: CanvasLineCap) {
    this._lineCap = value;
    this.record("setLineCap", value);
  }

  get lineCap(): CanvasLineCap {
    return this._lineCap;
  }

  set lineJoin(value: CanvasLineJoin) {
    this._lineJoin = value;
    this.record("setLineJoin", value);
  }

  get lineJoin(): CanvasLineJoin {
    return this._lineJoin;
  }

  set lineWidth(value: number) {
    this._lineWidth = value;
    this.record("setLineWidth", value);
  }

  get lineWidth(): number {
    return this._lineWidth;
  }

  set strokeStyle(value: string | CanvasGradient | CanvasPattern) {
    this._strokeStyle = value;
    this.record("setStrokeStyle", value);
  }

  get strokeStyle(): string | CanvasGradient | CanvasPattern {
    return this._strokeStyle;
  }

  set fillStyle(value: string | CanvasGradient | CanvasPattern) {
    this._fillStyle = value;
    this.record("setFillStyle", value);
  }

  get fillStyle(): string | CanvasGradient | CanvasPattern {
    return this._fillStyle;
  }

  clearRect(...args: Parameters<CanvasRenderingContext2D["clearRect"]>): void {
    this.record("clearRect", ...args);
  }

  setTransform(...args: Parameters<CanvasRenderingContext2D["setTransform"]>): void {
    this.record("setTransform", ...args);
  }

  save(): void {
    this.record("save");
  }

  restore(): void {
    this.record("restore");
  }

  beginPath(): void {
    this.record("beginPath");
  }

  moveTo(...args: Parameters<CanvasRenderingContext2D["moveTo"]>): void {
    this.record("moveTo", ...args);
  }

  lineTo(...args: Parameters<CanvasRenderingContext2D["lineTo"]>): void {
    this.record("lineTo", ...args);
  }

  quadraticCurveTo(...args: Parameters<CanvasRenderingContext2D["quadraticCurveTo"]>): void {
    this.record("quadraticCurveTo", ...args);
  }

  stroke(): void {
    this.record("stroke");
  }

  fill(): void {
    this.record("fill");
  }

  arc(...args: Parameters<CanvasRenderingContext2D["arc"]>): void {
    this.record("arc", ...args);
  }

  private record(name: string, ...args: readonly unknown[]): void {
    this.calls.push({ name, args });
  }
}

interface CanvasSpy {
  readonly element: HTMLCanvasElement;
  readonly context: CanvasContextSpy;
  readonly cssReads: string[];
}

/** Builds a minimal HTMLCanvasElement replacement with theme and DPR hooks. */
function createCanvasSpy(
  options: { dpr?: number; cssVars?: Record<string, string> } = {},
): CanvasSpy {
  const context = new CanvasContextSpy();
  const cssReads: string[] = [];
  const cssVars = options.cssVars ?? defaultLaneCssVars();
  const element = {
    width: 0,
    height: 0,
    style: {} as CSSStyleDeclaration,
    ownerDocument: {
      defaultView: {
        devicePixelRatio: options.dpr ?? 1,
        getComputedStyle: () => ({
          getPropertyValue: (name: string) => {
            cssReads.push(name);
            return cssVars[name] ?? "";
          },
        }),
      },
    },
    getContext: (kind: string) => (kind === "2d" ? context : null),
  } as unknown as HTMLCanvasElement;

  return { element, context, cssReads };
}

/** Creates default lane CSS tokens so tests assert theme values, not fallbacks. */
function defaultLaneCssVars(): Record<string, string> {
  return Object.fromEntries(
    Array.from({ length: 8 }, (_, index) => [`--color-git-lane-${index}`, `theme-lane-${index}`]),
  );
}

/** Builds a draw input object matching HistoryList's fixed-row virtual geometry. */
function drawInputs(entries: readonly LogEntry[], overrides: Partial<GraphDrawInputs> = {}) {
  const laneState = reduceLanes(
    initialLaneState(),
    entries.map(({ sha, parents }) => c(sha, parents)),
  );

  return {
    entries,
    laneState,
    scrollElement: scrollElement(overrides.height ?? entries.length * ROW_HEIGHT_PX),
    visibleRows: visibleRows(entries.length),
    rowHeight: ROW_HEIGHT_PX,
    laneWidth: LANE_WIDTH_PX,
    width: undefined,
    height: entries.length * ROW_HEIGHT_PX,
    viewportOffset: 0,
    pinToScrollOffset: true,
    ...overrides,
  } satisfies GraphDrawInputs;
}

/** Creates a minimal scroll element for sizing and scroll-offset calculations. */
function scrollElement(clientHeight: number, scrollTop = 0): HTMLElement {
  return { clientHeight, scrollTop } as HTMLElement;
}

/** Creates visible virtual rows with the same 24px row height used in production. */
function visibleRows(count: number): GraphCanvasVisibleRow[] {
  return Array.from({ length: count }, (_, index) => ({
    index,
    start: index * ROW_HEIGHT_PX,
    size: ROW_HEIGHT_PX,
  }));
}

/** Creates a lane reducer commit fixture. */
function c(sha: string, parents: readonly string[] = []): LaneCommit {
  return { sha, parents: [...parents] };
}

/** Creates the LogEntry subset used by GraphCanvas. */
function entry(sha: string, parents: readonly string[] = []): LogEntry {
  return {
    sha,
    shortSha: sha.slice(0, 7),
    parents: [...parents],
    authorName: "A. U. Thor",
    authorEmail: "author@example.invalid",
    authoredAt: "2026-05-11T00:00:00.000Z",
    subject: `Commit ${sha}`,
    body: "",
    refs: [],
  };
}

/** Returns all recorded calls with a given operation name. */
function calls(context: CanvasContextSpy, name: string): readonly CanvasCall[] {
  return context.calls.filter((call) => call.name === name);
}

/** Returns the operation that paints a specific node arc. */
function paintAfterArc(context: CanvasContextSpy, x: number, y: number): string {
  const arcIndex = context.calls.findIndex(
    (call) => call.name === "arc" && call.args[0] === x && call.args[1] === y,
  );
  if (arcIndex < 0) throw new Error(`Missing arc at ${x},${y}`);

  for (const call of context.calls.slice(arcIndex + 1)) {
    if (call.name === "beginPath") break;
    if (call.name === "fill" || call.name === "stroke") return call.name;
  }

  throw new Error(`Missing paint operation after arc at ${x},${y}`);
}

describe("drawGraphCanvas — visible graph scenarios", () => {
  it("draws a linear visible history as same-lane edges with filled commit nodes", () => {
    const canvas = createCanvasSpy();
    const entries = [entry("A", ["B"]), entry("B", ["C"]), entry("C")];

    drawGraphCanvas(canvas.element, drawInputs(entries));

    expect(calls(canvas.context, "setTransform")[0]?.args).toEqual([1, 0, 0, 1, 0, 0]);
    expect(calls(canvas.context, "clearRect")[0]?.args).toEqual([0, 0, 18, 72]);
    expect(calls(canvas.context, "moveTo").map((call) => call.args)).toEqual([
      [9, 12],
      [9, 36],
    ]);
    expect(calls(canvas.context, "lineTo").map((call) => call.args)).toEqual([
      [9, 36],
      [9, 60],
    ]);
    expect(calls(canvas.context, "arc").map((call) => call.args.slice(0, 3))).toEqual([
      [9, 12, 4.5],
      [9, 36, 4.5],
      [9, 60, 4.5],
    ]);
    expect(calls(canvas.context, "fill")).toHaveLength(3);
    expect(calls(canvas.context, "stroke")).toHaveLength(2);
  });

  it("draws merge topology with curved cross-lane edges and a hollow merge node", () => {
    const canvas = createCanvasSpy();
    const entries = [entry("M", ["A", "B"]), entry("A", ["R"]), entry("B", ["R"]), entry("R")];

    drawGraphCanvas(canvas.element, drawInputs(entries));

    expect(calls(canvas.context, "quadraticCurveTo").map((call) => call.args)).toEqual([
      [9, 36, 27, 36],
      [27, 72, 9, 72],
    ]);
    expect(calls(canvas.context, "arc").map((call) => call.args.slice(0, 3))).toEqual([
      [9, 12, 4.5],
      [9, 36, 4.5],
      [27, 60, 4.5],
      [9, 84, 4.5],
    ]);
    expect(paintAfterArc(canvas.context, 9, 12)).toBe("stroke");
    expect(paintAfterArc(canvas.context, 9, 36)).toBe("fill");
    expect(paintAfterArc(canvas.context, 27, 60)).toBe("fill");
    expect(calls(canvas.context, "setLineWidth").map((call) => call.args[0])).toContain(1.8);
  });

  it("scales the backing store and transform for DPR 1, 2, and 3", () => {
    for (const dpr of [1, 2, 3]) {
      const canvas = createCanvasSpy({ dpr });
      const entries = [entry("A", ["B"]), entry("B")];

      drawGraphCanvas(canvas.element, drawInputs(entries, { width: 36, height: 48 }));

      expect(canvas.element.width).toBe(36 * dpr);
      expect(canvas.element.height).toBe(48 * dpr);
      expect(canvas.element.style.width).toBe("36px");
      expect(canvas.element.style.height).toBe("48px");
      expect(calls(canvas.context, "setTransform")[0]?.args).toEqual([dpr, 0, 0, dpr, 0, 0]);
    }
  });

  it("reads theme lane CSS variables on every redraw and uses them for lane paint", () => {
    const canvas = createCanvasSpy({
      cssVars: {
        "--color-git-lane-0": "red-lane",
        "--color-git-lane-1": "blue-lane",
        "--color-git-lane-2": "lane-2",
        "--color-git-lane-3": "lane-3",
        "--color-git-lane-4": "lane-4",
        "--color-git-lane-5": "lane-5",
        "--color-git-lane-6": "lane-6",
        "--color-git-lane-7": "lane-7",
      },
    });
    const entries = [entry("M", ["A", "B"]), entry("A"), entry("B")];

    drawGraphCanvas(canvas.element, drawInputs(entries));

    expect(canvas.cssReads).toEqual([
      "--color-git-lane-0",
      "--color-git-lane-1",
      "--color-git-lane-2",
      "--color-git-lane-3",
      "--color-git-lane-4",
      "--color-git-lane-5",
      "--color-git-lane-6",
      "--color-git-lane-7",
    ]);
    expect(calls(canvas.context, "setStrokeStyle").map((call) => call.args[0])).toContain(
      "red-lane",
    );
    expect(calls(canvas.context, "setFillStyle").map((call) => call.args[0])).toContain(
      "blue-lane",
    );
  });
});
