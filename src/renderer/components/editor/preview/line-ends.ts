// The ends a line on a slide can have: PowerPoint's arrowheads, a
// triangle, a stealth arrow, an open arrow, a diamond or an oval, each
// sized in line widths. pptxtojson reads them off the line but draws a
// line as its path alone, so they are worked out here from the path: where
// it starts and ends, and which way it runs there.

export interface LineEnd {
  type?: string;
  width?: string;
  length?: string;
}

export interface Point {
  x: number;
  y: number;
}

export type EndMark =
  | { kind: "polygon"; points: Point[] }
  | { kind: "polyline"; points: Point[] }
  | { kind: "ellipse"; center: Point; rx: number; ry: number; angle: number };

/** Line widths in an end's width or length, small, medium or large. */
const SIZES: Record<string, number> = { sm: 2, med: 3, lg: 5 };

/**
 * The width, in points, that a thinner line's ends are sized by, as
 * LibreOffice sizes them, so that a hairline's arrow still shows.
 */
const MIN_BASE_PT = 2;

/**
 * How far into a filled head the line stops, as a share of its length:
 * far enough that the line's square end is under the head, not past its
 * sides.
 */
const SHORTEN: Record<string, number> = { triangle: 0.6, stealth: 0.5 };

const KINDS = new Set(["triangle", "stealth", "arrow", "diamond", "oval"]);

const ARITY = { M: 2, L: 2, C: 6, Q: 4 } as const;
type Op = keyof typeof ARITY;

interface Command {
  op: Op;
  nums: number[];
}

/**
 * The path's commands, if it is an open one of absolute moves, lines and
 * curves: a closed shape has no ends, and anything else is not read.
 */
function parsePath(d: string): Command[] | null {
  const tokens = d.match(/[A-Za-z]|[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/g) ?? [];
  const commands: Command[] = [];
  let op: Op | null = null;
  let nums: number[] = [];
  for (const token of tokens) {
    if (/^[A-Za-z]$/.test(token)) {
      if (!(token in ARITY) || nums.length > 0) return null;
      op = token as Op;
      continue;
    }
    if (!op) return null;
    nums.push(Number(token));
    if (nums.length === ARITY[op]) {
      commands.push({ op, nums });
      nums = [];
      // Pairs after a move's first are lines to them.
      if (op === "M") op = "L";
    }
  }
  if (nums.length > 0 || commands[0]?.op !== "M") return null;
  return commands;
}

function pointsOf(command: Command): Point[] {
  const points: Point[] = [];
  for (let i = 0; i + 1 < command.nums.length; i += 2) {
    points.push({ x: command.nums[i] ?? 0, y: command.nums[i + 1] ?? 0 });
  }
  return points;
}

function distance(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/** The first point in `points` away from `from`, which gives the way the path leaves it. */
function firstApart(from: Point, points: Point[]): Point | undefined {
  return points.find((point) => distance(point, from) > 1e-6);
}

/**
 * The mark drawn at `tip` for an end of a line `width` points wide that
 * reaches the tip from `from`'s side, and how far back the line stops.
 */
export function endMark(
  end: LineEnd,
  tip: Point,
  from: Point,
  width: number,
): { mark: EndMark; shorten: number } | null {
  const kind = end.type ?? "none";
  if (!KINDS.has(kind)) return null;
  const run = distance(tip, from);
  if (run === 0) return null;
  // u points out of the line at its tip; n across it.
  const u = { x: (tip.x - from.x) / run, y: (tip.y - from.y) / run };
  const n = { x: -u.y, y: u.x };
  const base = Math.max(width, MIN_BASE_PT);
  const long = base * (SIZES[end.length ?? "med"] ?? 3);
  const wide = base * (SIZES[end.width ?? "med"] ?? 3);
  const at = (along: number, across: number): Point => ({
    x: tip.x + u.x * along + n.x * across,
    y: tip.y + u.y * along + n.y * across,
  });
  const shorten = Math.min((SHORTEN[kind] ?? 0) * long, 0.9 * run);
  switch (kind) {
    case "triangle":
      return {
        mark: { kind: "polygon", points: [tip, at(-long, wide / 2), at(-long, -wide / 2)] },
        shorten,
      };
    case "stealth":
      return {
        mark: {
          kind: "polygon",
          points: [tip, at(-long, wide / 2), at(-0.7 * long, 0), at(-long, -wide / 2)],
        },
        shorten,
      };
    case "arrow":
      return {
        mark: { kind: "polyline", points: [at(-long, wide / 2), tip, at(-long, -wide / 2)] },
        shorten,
      };
    case "diamond":
      return {
        mark: {
          kind: "polygon",
          points: [at(long / 2, 0), at(0, wide / 2), at(-long / 2, 0), at(0, -wide / 2)],
        },
        shorten,
      };
    default:
      return {
        mark: {
          kind: "ellipse",
          center: tip,
          rx: long / 2,
          ry: wide / 2,
          angle: (Math.atan2(u.y, u.x) * 180) / Math.PI,
        },
        shorten,
      };
  }
}

/**
 * A line's path with its ends drawn: the path, shortened where a head
 * covers its end, and the marks to draw over it; null when the line has
 * no ends to draw, or a path they cannot be put on.
 */
export function lineEnds(
  d: string,
  width: number,
  head: LineEnd | undefined,
  tail: LineEnd | undefined,
): { path: string; marks: EndMark[] } | null {
  if (!KINDS.has(head?.type ?? "none") && !KINDS.has(tail?.type ?? "none")) return null;
  const commands = parsePath(d);
  if (!commands) return null;
  const points = commands.flatMap(pointsOf);
  const start = points[0];
  const finish = points.at(-1);
  if (!start || !finish || points.length < 2) return null;
  const marks: EndMark[] = [];
  const first = commands[0] as Command;
  const last = commands.at(-1) as Command;

  const tailFrom = firstApart(finish, points.slice(0, -1).reverse());
  const tailMark = tail && tailFrom ? endMark(tail, finish, tailFrom, width) : null;
  const headFrom = firstApart(start, points.slice(1));
  const headMark = head && headFrom ? endMark(head, start, headFrom, width) : null;

  if (tailMark && tailFrom) {
    marks.push(tailMark.mark);
    const moved = toward(finish, tailFrom, tailMark.shorten);
    last.nums.splice(-2, 2, moved.x, moved.y);
  }
  if (headMark && headFrom) {
    marks.push(headMark.mark);
    const moved = toward(start, headFrom, headMark.shorten);
    first.nums.splice(0, 2, moved.x, moved.y);
  }
  if (marks.length === 0) return null;
  const path = commands
    .map(({ op, nums }) => `${op} ${nums.map((n) => Number(n.toFixed(3))).join(" ")}`)
    .join(" ");
  return { path, marks };
}

function toward(point: Point, to: Point, by: number): Point {
  const run = distance(point, to);
  if (by <= 0 || run === 0) return point;
  return { x: point.x + ((to.x - point.x) * by) / run, y: point.y + ((to.y - point.y) * by) / run };
}
