// Drawing a presentation's slides, as pptxtojson reads them, into DOM
// elements: each slide a box of its own size in points, its elements
// placed on it as the file places them.
//
// Text is drawn from sanitizeRichText's tree, never parsed as HTML, and
// pictures only from data URLs out of the file, so nothing in it runs or
// loads from elsewhere. Charts, video and audio are marked, not drawn.

import { type RichNode, sanitizeRichText } from "../../../services/editor/preview/rich-text";

type Presentation = Awaited<ReturnType<typeof import("pptxtojson")["parse"]>>;
type Slide = Presentation["slides"][number];
type SlideElement = Slide["elements"][number];
type Fill = Slide["fill"];
type TableElement = Extract<SlideElement, { type: "table" }>;
type Border = NonNullable<TableElement["borders"]["top"]>;

export interface SlideLabels {
  /** The slide's number, as its caption reads. */
  slide(number: number, count: number): string;
  chart: string;
  media: string;
}

/** The pages' styles, for the shadow root they are drawn in. */
export const SLIDE_STYLE = `
:host { display: block; color: #000; }
.deck { display: flex; flex-direction: column; align-items: safe center; gap: 8px; padding: 16px; }
.caption { align-self: stretch; max-width: 100%; color: var(--surface-island-fg); opacity: 0.6; font: 12px system-ui, sans-serif; }
.slide { zoom: var(--slide-zoom, 1); position: relative; overflow: hidden; background: #fff; box-shadow: 0 1px 4px rgb(0 0 0 / 0.35); margin-bottom: 16px; font-family: Calibri, Arial, sans-serif; }
.slide * { box-sizing: border-box; }
.slide p, .notes p { margin: 0; }
.slide ul, .slide ol { margin: 0; padding-left: 1.5em; }
.box { position: absolute; }
.text { display: flex; flex-direction: column; overflow: hidden; word-wrap: break-word; }
.text.nowrap { white-space: nowrap; }
.text.vertical { writing-mode: vertical-rl; }
.placeholder { display: flex; align-items: center; justify-content: center; border: 1px dashed rgb(0 0 0 / 0.35); color: rgb(0 0 0 / 0.55); font: 12px system-ui, sans-serif; }
.notes { align-self: stretch; color: var(--surface-island-fg); opacity: 0.75; font: 12px system-ui, sans-serif; margin: -8px 0 16px; }
.slide table { border-collapse: collapse; table-layout: fixed; }
.slide td { overflow: hidden; padding: 2pt 4pt; }
`;

/** The deck: each slide under its number, with its notes below it. */
export function drawPresentation(presentation: Presentation, labels: SlideLabels): HTMLElement {
  const deck = element("div", "deck");
  const { width, height } = presentation.size;
  presentation.slides.forEach((slide, index) => {
    const caption = element("div", "caption");
    caption.textContent = labels.slide(index + 1, presentation.slides.length);
    const page = element("section", "slide");
    page.style.width = `${width}pt`;
    page.style.height = `${height}pt`;
    applyFill(page.style, slide.fill);
    for (const item of [...slide.layoutElements, ...slide.elements]) {
      const drawn = drawElement(item, labels);
      if (drawn) page.append(drawn);
    }
    deck.append(caption, page);
    const note = sanitizeRichText(slide.note);
    if (note.length > 0) {
      const notes = element("div", "notes");
      notes.append(...richNodes(note));
      deck.append(notes);
    }
  });
  return deck;
}

function drawElement(item: SlideElement, labels: SlideLabels): HTMLElement | null {
  const box = element("div", "box");
  place(box, item);
  switch (item.type) {
    case "text":
    case "shape": {
      if (item.type === "shape" && item.path && item.pathViewBox) {
        if (item.width === 0) box.style.width = "1pt";
        if (item.height === 0) box.style.height = "1pt";
        box.append(shapeSvg(item));
      } else {
        applyFill(box.style, item.fill);
        applyBorder(box.style, item);
      }
      if (item.content.trim() !== "") box.append(textBody(item));
      return box;
    }
    case "image": {
      if (!isImageData(item.base64)) return null;
      box.style.overflow = "hidden";
      applyBorder(box.style, item);
      box.append(croppedImage(item.base64, item.rect));
      return box;
    }
    case "math": {
      if (!isImageData(item.picBase64)) return null;
      box.append(croppedImage(item.picBase64, undefined));
      return box;
    }
    case "table":
      box.append(table(item));
      return box;
    case "group":
    case "diagram": {
      for (const child of item.elements as SlideElement[]) {
        const drawn = drawElement(child, labels);
        if (drawn) box.append(drawn);
      }
      return box;
    }
    case "chart":
      return placeholder(box, labels.chart);
    case "video":
    case "audio":
      return placeholder(box, labels.media);
  }
}

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  return node;
}

/** Puts `box` where the element is, turned and flipped as it is. */
function place(box: HTMLElement, item: SlideElement): void {
  box.style.left = `${item.left}pt`;
  box.style.top = `${item.top}pt`;
  box.style.width = `${item.width}pt`;
  box.style.height = `${item.height}pt`;
  const turns: string[] = [];
  if ("rotate" in item && item.rotate) turns.push(`rotate(${item.rotate}deg)`);
  if ("isFlipH" in item && item.isFlipH) turns.push("scaleX(-1)");
  if ("isFlipV" in item && item.isFlipV) turns.push("scaleY(-1)");
  if (turns.length > 0) box.style.transform = turns.join(" ");
}

function placeholder(box: HTMLElement, label: string): HTMLElement {
  box.classList.add("placeholder");
  box.textContent = label;
  return box;
}

const VERTICAL_ALIGN: Record<string, string> = {
  up: "flex-start",
  mid: "center",
  down: "flex-end",
};

function textBody(item: Extract<SlideElement, { type: "text" | "shape" }>): HTMLElement {
  const body = element("div", "box text");
  body.style.inset = "0";
  body.style.justifyContent = VERTICAL_ALIGN[item.vAlign] ?? "flex-start";
  if (!item.wrap) body.classList.add("nowrap");
  if (item.type === "text" && item.isVertical) body.classList.add("vertical");
  const inset = item.textInset;
  if (inset) body.style.padding = `${inset.t}pt ${inset.r}pt ${inset.b}pt ${inset.l}pt`;
  const scale = item.autoFit?.type === "text" ? (item.autoFit.fontScale ?? 1) : 1;
  body.append(...richNodes(sanitizeRichText(item.content), scale));
  return body;
}

/** DOM nodes for the rich text tree, its point font sizes times `fontScale`. */
export function richNodes(nodes: readonly RichNode[], fontScale = 1): Node[] {
  return nodes.map((node) => {
    if (typeof node === "string") return document.createTextNode(node);
    const el = document.createElement(node.tag);
    for (const [property, value] of Object.entries(node.style)) {
      el.style.setProperty(property, styleValue(property, value, fontScale));
    }
    el.append(...richNodes(node.children, fontScale));
    return el;
  });
}

function styleValue(property: string, value: string, fontScale: number): string {
  if (property === "font-size" && fontScale !== 1) {
    const pt = /^([\d.]+)pt$/.exec(value);
    if (pt) return `${Number(pt[1]) * fontScale}pt`;
  }
  if (property === "margin-top" || property === "margin-bottom") {
    // pptxtojson writes space before or after a paragraph given as a
    // share of a line (20% as 20000) as that many thousandths of an em,
    // a hundred times too much: 20em for 0.2em.
    const em = /^([\d.]+)em$/.exec(value);
    if (em) return `${Number(em[1]) / 100}em`;
  }
  return value;
}

/** CSS pixels in a point. */
const PX_PER_PT = 4 / 3;

function shapeSvg(item: Extract<SlideElement, { type: "shape" }>): SVGSVGElement {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  const view = item.pathViewBox as NonNullable<typeof item.pathViewBox>;
  // A straight line has no width or no height, which a viewBox cannot.
  svg.setAttribute(
    "viewBox",
    `${view.x} ${view.y} ${Math.max(view.width, 1)} ${Math.max(view.height, 1)}`,
  );
  svg.setAttribute("preserveAspectRatio", "none");
  svg.setAttribute("width", "100%");
  svg.setAttribute("height", "100%");
  svg.style.overflow = "visible";
  const path = document.createElementNS(ns, "path");
  path.setAttribute("d", item.path ?? "");
  // A connector or a line is its stroke alone, whatever fill its style has.
  const lineOnly = item.strokeOnly || /connector|^line$/i.test(item.shapType);
  path.setAttribute("fill", lineOnly ? "none" : (fillColor(item.fill) ?? "none"));
  const stroke = safeColor(item.borderColor);
  // pptxtojson gives a connector its color but not always its width, which
  // its style sets; it is drawn a hairline rather than not at all.
  const strokeWidth = item.borderWidth > 0 ? item.borderWidth : lineOnly ? 1 : 0;
  if (stroke && strokeWidth > 0) {
    path.setAttribute("stroke", stroke);
    // A stroke that does not scale is as wide as it says in CSS pixels;
    // the file gives it in points.
    path.setAttribute("stroke-width", String(strokeWidth * PX_PER_PT));
    path.setAttribute("vector-effect", "non-scaling-stroke");
    if (item.borderType !== "solid" && /^[\d.\s,]+$/.test(item.borderStrokeDasharray)) {
      path.setAttribute("stroke-dasharray", item.borderStrokeDasharray);
    }
  }
  svg.append(path);
  return svg;
}

/** A picture cropped as the file crops it: `rect` takes percentages off each side. */
function croppedImage(
  src: string,
  rect: { t?: number; b?: number; l?: number; r?: number } | undefined,
): HTMLImageElement {
  const img = element("img");
  img.src = src;
  img.alt = "";
  img.draggable = false;
  img.style.position = "absolute";
  const { t = 0, b = 0, l = 0, r = 0 } = rect ?? {};
  const shownWidth = 100 - l - r;
  const shownHeight = 100 - t - b;
  if (shownWidth <= 0 || shownHeight <= 0) return img;
  img.style.width = `${(100 * 100) / shownWidth}%`;
  img.style.height = `${(100 * 100) / shownHeight}%`;
  img.style.left = `${(-l * 100) / shownWidth}%`;
  img.style.top = `${(-t * 100) / shownHeight}%`;
  return img;
}

function table(item: TableElement): HTMLTableElement {
  const grid = element("table");
  grid.style.width = `${item.width}pt`;
  const columns = element("colgroup");
  for (const width of item.colWidths) {
    const col = element("col");
    col.style.width = `${width}pt`;
    columns.append(col);
  }
  grid.append(columns);
  const body = element("tbody");
  item.data.forEach((row, r) => {
    const tr = element("tr");
    const rowHeight = item.rowHeights[r];
    if (rowHeight) tr.style.height = `${rowHeight}pt`;
    for (const cell of row) {
      // A cell another spans over has no cell of its own.
      if (cell.hMerge || cell.vMerge) continue;
      const td = element("td");
      if (cell.rowSpan && cell.rowSpan > 1) td.rowSpan = cell.rowSpan;
      if (cell.colSpan && cell.colSpan > 1) td.colSpan = cell.colSpan;
      const background = safeColor(cell.fillColor);
      if (background) td.style.backgroundColor = background;
      const color = safeColor(cell.fontColor);
      if (color) td.style.color = color;
      if (cell.fontBold) td.style.fontWeight = "bold";
      td.style.verticalAlign =
        cell.vAlign === "mid" ? "middle" : cell.vAlign === "down" ? "bottom" : "top";
      for (const side of ["top", "bottom", "left", "right"] as const) {
        const border = cell.borders[side] ?? item.borders[side];
        if (border) td.style.setProperty(`border-${side}`, borderCss(border) ?? "none");
      }
      td.append(...richNodes(sanitizeRichText(cell.text)));
      tr.append(td);
    }
    body.append(tr);
  });
  grid.append(body);
  return grid;
}

function borderCss(border: Border): string | null {
  const color = safeColor(border.borderColor);
  if (!color || border.borderWidth <= 0) return null;
  return `${border.borderWidth}pt ${border.borderType} ${color}`;
}

function applyBorder(
  style: CSSStyleDeclaration,
  item: { borderColor: string; borderWidth: number; borderType: Border["borderType"] },
): void {
  const css = borderCss(item);
  if (css) style.border = css;
}

/** Paints a box's fill: a color, a gradient, or a picture from the file. */
export function applyFill(style: CSSStyleDeclaration, fill: Fill | undefined): void {
  if (!fill) return;
  switch (fill.type) {
    case "color": {
      const color = safeColor(fill.value);
      if (color) style.backgroundColor = color;
      return;
    }
    case "gradient": {
      const css = gradientCss(fill.value);
      if (css) style.backgroundImage = css;
      return;
    }
    case "image":
      if (isImageData(fill.value.base64)) {
        style.backgroundImage = `url("${fill.value.base64}")`;
        style.backgroundSize = "100% 100%";
      }
      return;
    case "pattern": {
      const color = safeColor(fill.value.backgroundColor);
      if (color) style.backgroundColor = color;
      return;
    }
  }
}

/** One color for a fill an SVG path takes: a gradient's first, a pattern's ground. */
function fillColor(fill: Fill | undefined): string | null {
  switch (fill?.type) {
    case "color":
      return safeColor(fill.value);
    case "gradient":
      return safeColor(fill.value.colors[0]?.color);
    case "pattern":
      return safeColor(fill.value.backgroundColor);
    default:
      return null;
  }
}

/** A gradient's stops as CSS, or null when one of them is not a color. */
export function gradientCss(value: Extract<Fill, { type: "gradient" }>["value"]): string | null {
  const stops: string[] = [];
  for (const { color, pos } of value.colors) {
    const safe = safeColor(color);
    const at = stopPosition(pos);
    if (!safe || at === null) return null;
    stops.push(`${safe} ${at}%`);
  }
  if (stops.length === 0) return null;
  return value.path === "line"
    ? `linear-gradient(${(value.rot ?? 0) + 90}deg, ${stops.join(", ")})`
    : `radial-gradient(${stops.join(", ")})`;
}

/** A stop's place as a percentage: "40%", or OOXML's thousandths of one. */
function stopPosition(pos: string): number | null {
  const m = /^([\d.]+)(%?)$/.exec(pos.trim());
  if (!m) return null;
  const n = Number(m[1]);
  return m[2] === "%" || n <= 100 ? n : n / 1000;
}

/** A CSS color the file gave, or null for anything that is not one. */
export function safeColor(value: string | undefined): string | null {
  if (!value) return null;
  const v = value.trim();
  return /^#[0-9a-f]{3,8}$/i.test(v) ||
    /^(rgba?|hsla?)\([\d\s.,%+-]+\)$/i.test(v) ||
    /^[a-z]{3,20}$/i.test(v)
    ? v
    : null;
}

/** Whether `src` is a picture's data URL, which loads nothing from elsewhere. */
export function isImageData(src: string | undefined): src is string {
  return !!src && /^data:image\/[a-z0-9.+-]+;base64,[a-z0-9+/=\s]*$/i.test(src);
}
