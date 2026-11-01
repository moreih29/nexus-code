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
import type { LogEntry } from "../../../../../../../src/shared/git/types";

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
  private _globalCompositeOperation: GlobalCompositeOperation = "source-over";

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

  set globalCompositeOperation(value: GlobalCompositeOperation) {
    this._globalCompositeOperation = value;
    this.record("setGlobalCompositeOperation", value);
  }

  get globalCompositeOperation(): GlobalCompositeOperation {
    return this._globalCompositeOperation;
  }

  createLinearGradient(...args: Parameters<CanvasRenderingContext2D["createLinearGradient"]>) {
    this.record("createLinearGradient", ...args);
    return {
      addColorStop: (offset: number, color: string) =>
        this.record("addColorStop", offset, color),
    } as unknown as CanvasGradient;
  }

  fillRect(...args: Parameters<CanvasRenderingContext2D["fillRect"]>): void {
    this.record("fillRect", ...args);
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

  bezierCurveTo(...args: Parameters<CanvasRenderingContext2D["bezierCurveTo"]>): void {
    this.record("bezierCurveTo", ...args);
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

/**
 * Builds a minimal HTMLCanvasElement replacement with theme and DPR hooks.
 * `backgrounds` are the computed background colors of its ancestors, nearest first.
 */
function createCanvasSpy(
  options: { dpr?: number; cssVars?: Record<string, string>; backgrounds?: readonly string[] } = {},
): CanvasSpy {
  const context = new CanvasContextSpy();
  const cssReads: string[] = [];
  const cssVars = options.cssVars ?? defaultLaneCssVars();
  const parentElement = (options.backgrounds ?? []).reduceRight<object | null>(
    (parent, backgroundColor) => ({ parentElement: parent, backgroundColor }),
    null,
  );
  const element = {
    width: 0,
    height: 0,
    style: {} as CSSStyleDeclaration,
    parentElement,
    ownerDocument: {
      defaultView: {
        devicePixelRatio: options.dpr ?? 1,
        getComputedStyle: (target: { backgroundColor?: string }) => ({
          backgroundColor: target.backgroundColor ?? "",
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
  return {
    ...Object.fromEntries(
      Array.from({ length: 8 }, (_, index) => [`--color-git-lane-${index}`, `theme-lane-${index}`]),
    ),
    "--background": "theme-background",
  };
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
function entry(
  sha: string,
  parents: readonly string[] = [],
  refs: LogEntry["refs"] = [],
): LogEntry {
  return {
    sha,
    shortSha: sha.slice(0, 7),
    parents: [...parents],
    authorName: "A. U. Thor",
    authorEmail: "author@example.invalid",
    authoredAt: "2026-05-11T00:00:00.000Z",
    subject: `Commit ${sha}`,
    body: "",
    refs,
  };
}

/** Returns all recorded calls with a given operation name. */
function calls(context: CanvasContextSpy, name: string): readonly CanvasCall[] {
  return context.calls.filter((call) => call.name === name);
}

/** Returns the fill or stroke style that paints the arc at x, y with the given radius. */
function paintOfArc(context: CanvasContextSpy, x: number, y: number, radius: number): string {
  const arcIndex = context.calls.findIndex(
    (call) =>
      call.name === "arc" && call.args[0] === x && call.args[1] === y && call.args[2] === radius,
  );
  if (arcIndex < 0) throw new Error(`Missing arc at ${x},${y} r${radius}`);

  let fillStyle: unknown;
  let strokeStyle: unknown;
  for (const call of context.calls.slice(arcIndex + 1)) {
    if (call.name === "beginPath") break;
    if (call.name === "setFillStyle") fillStyle = call.args[0];
    if (call.name === "setStrokeStyle") strokeStyle = call.args[0];
    if (call.name === "fill") return `fill:${String(fillStyle)}`;
    if (call.name === "stroke") return `stroke:${String(strokeStyle)}`;
  }

  throw new Error(`Missing paint operation after arc at ${x},${y} r${radius}`);
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
    // Each node is a ring of background, then the dot.
    expect(calls(canvas.context, "arc").map((call) => call.args.slice(0, 3))).toEqual([
      [9, 12, 6],
      [9, 12, 4],
      [9, 36, 6],
      [9, 36, 4],
      [9, 60, 6],
      [9, 60, 4],
    ]);
    expect(paintOfArc(canvas.context, 9, 12, 6)).toBe("fill:theme-background");
    expect(paintOfArc(canvas.context, 9, 12, 4)).toBe("fill:theme-lane-5");
    expect(calls(canvas.context, "fill")).toHaveLength(6);
    expect(calls(canvas.context, "stroke")).toHaveLength(2);
  });

  it("keeps the mainline's color off branches when the colors come round again", () => {
    const canvas = createCanvasSpy();
    // Eight merges, so the branches take colors 1 to 8.
    const entries = Array.from({ length: 8 }, (_, index) => [
      entry(`M${index}`, [`M${index + 1}`, `B${index}`]),
      entry(`B${index}`, [`M${index + 1}`]),
    ]).flat();
    entries.push(entry("M8"));

    drawGraphCanvas(canvas.element, drawInputs(entries));

    const rowY = (row: number) => row * ROW_HEIGHT_PX + ROW_HEIGHT_PX / 2;
    const branchX = LANE_WIDTH_PX + LANE_WIDTH_PX / 2;
    expect(paintOfArc(canvas.context, 9, rowY(16), 4)).toBe("fill:theme-lane-5");
    // The first branch's color, not the mainline's.
    expect(paintOfArc(canvas.context, branchX, rowY(15), 4)).toBe("fill:theme-lane-0");
  });

  it("curves a merged branch into its own lane and back into its parent's lane", () => {
    const canvas = createCanvasSpy();
    const entries = [entry("M", ["A", "B"]), entry("A", ["R"]), entry("B", ["R"]), entry("R")];

    drawGraphCanvas(canvas.element, drawInputs(entries));

    // M to B leaves lane 0 within M's row and runs down lane 1; B joins R's lane 0 within B's row.
    expect(calls(canvas.context, "bezierCurveTo").map((call) => call.args)).toEqual([
      [9, 27, 27, 21, 27, 36],
      [27, 75, 9, 69, 9, 84],
    ]);
    expect(calls(canvas.context, "lineTo").map((call) => call.args)).toEqual([
      [9, 36],
      [27, 60],
      [9, 84],
    ]);
    // The merge commit gets the smaller dot.
    expect(calls(canvas.context, "arc").map((call) => call.args.slice(0, 3))).toEqual([
      [9, 12, 5],
      [9, 12, 3],
      [9, 36, 6],
      [9, 36, 4],
      [27, 60, 6],
      [27, 60, 4],
      [9, 84, 6],
      [9, 84, 4],
    ]);
    expect(paintOfArc(canvas.context, 9, 12, 3)).toBe("fill:theme-lane-5");
    expect(paintOfArc(canvas.context, 27, 60, 4)).toBe("fill:theme-lane-0");
    expect(calls(canvas.context, "setLineWidth").map((call) => call.args[0])).toEqual([1.75]);
  });

  it("keeps a branch on its own lane until the row above the commit it started from", () => {
    const canvas = createCanvasSpy();
    const entries = [
      entry("M", ["A", "F2"]),
      entry("A", ["P"]),
      entry("F2", ["F1"]),
      entry("F1", ["P"]),
      entry("P"),
    ];

    drawGraphCanvas(canvas.element, drawInputs(entries));

    // F1 to P stays in lane 1 and curves into lane 0 within F1's row, right above P.
    expect(calls(canvas.context, "bezierCurveTo").at(-1)?.args).toEqual([27, 99, 9, 93, 9, 108]);
    // A to P runs straight down lane 0.
    expect(calls(canvas.context, "lineTo").map((call) => call.args)).toContainEqual([9, 108]);
  });

  it("stops lines to parents not loaded yet at the bottom of the last row", () => {
    const canvas = createCanvasSpy();

    drawGraphCanvas(canvas.element, drawInputs([entry("M", ["A", "B"])]));

    expect(calls(canvas.context, "lineTo").map((call) => call.args)).toEqual([[9, 24]]);
    expect(calls(canvas.context, "bezierCurveTo").map((call) => call.args)).toEqual([
      [9, 19.5, 27, 16.5, 27, 24],
    ]);
  });

  it("fades the graph out at its right edge when lanes past it are cut off", () => {
    const canvas = createCanvasSpy();
    const entries = [entry("M", ["A", "B"]), entry("A"), entry("B")];

    drawGraphCanvas(canvas.element, drawInputs(entries, { width: 20, fadeRightEdge: true }));

    expect(calls(canvas.context, "createLinearGradient")[0]?.args).toEqual([8, 0, 20, 0]);
    expect(calls(canvas.context, "setGlobalCompositeOperation")[0]?.args).toEqual([
      "destination-out",
    ]);
    expect(calls(canvas.context, "fillRect")[0]?.args).toEqual([8, 0, 12, 72]);
  });

  it("leaves the right edge alone when the whole graph fits", () => {
    const canvas = createCanvasSpy();

    drawGraphCanvas(canvas.element, drawInputs([entry("A")]));

    expect(calls(canvas.context, "fillRect")).toHaveLength(0);
  });

  it("rings the commit HEAD points at", () => {
    const canvas = createCanvasSpy();
    const entries = [
      entry("A", ["B"], [{ name: "HEAD", kind: "head", isHead: true }]),
      entry("B"),
    ];

    drawGraphCanvas(canvas.element, drawInputs(entries));

    expect(calls(canvas.context, "arc").map((call) => call.args.slice(0, 3))).toEqual([
      [9, 12, 9.75],
      [9, 12, 7],
      [9, 12, 4],
      [9, 36, 6],
      [9, 36, 4],
    ]);
    expect(paintOfArc(canvas.context, 9, 12, 7)).toBe("stroke:theme-lane-5");
  });

  it("takes the node gap from the first opaque background behind the canvas", () => {
    const canvas = createCanvasSpy({
      backgrounds: ["rgba(0, 0, 0, 0)", "rgba(255, 255, 255, 0.04)", "rgb(1, 2, 3)"],
    });

    drawGraphCanvas(canvas.element, drawInputs([entry("A")]));

    expect(paintOfArc(canvas.context, 9, 12, 6)).toBe("fill:rgb(1, 2, 3)");
    expect(canvas.cssReads).not.toContain("--background");
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

  it("reads theme lane CSS variables on every redraw and spreads lines across them", () => {
    const canvas = createCanvasSpy({
      cssVars: {
        "--color-git-lane-0": "red-lane",
        "--color-git-lane-1": "lane-1",
        "--color-git-lane-2": "lane-2",
        "--color-git-lane-3": "lane-3",
        "--color-git-lane-4": "lane-4",
        "--color-git-lane-5": "blue-lane",
        "--color-git-lane-6": "lane-6",
        "--color-git-lane-7": "lane-7",
        "--background": "theme-background",
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
      "--background",
    ]);
    // The mainline takes the blue token; the merged branch, the next line, takes the red one.
    expect(paintOfArc(canvas.context, 9, 12, 3)).toBe("fill:blue-lane");
    expect(paintOfArc(canvas.context, 27, 60, 4)).toBe("fill:red-lane");
    expect(calls(canvas.context, "setStrokeStyle").map((call) => call.args[0])).toEqual([
      "blue-lane",
      "red-lane",
    ]);
  });
});
