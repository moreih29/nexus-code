// docx-preview draws a list item's number or bullet as its paragraph's
// ::before content, ending in a tab: `content: "1.\9"`. A browser sets a
// tab at the next multiple of its tab size from the line's start, where
// Word sets it at the paragraph's indent, past the hanging number. The
// item's first line so began wherever the tab fell, not where the lines
// after it begin. The tab is taken out here, and the marker is given the
// hanging indent's width, which brings the text to the indent as Word's
// tab does.

/** A rule's selector and declarations. */
const RULE = /([^{}]*)\{([^{}]*)\}/g;

/** Space after a marker wider than its hanging indent, where Word goes on to a tab stop. */
const GAP = "0.5em";

/**
 * Each list level's hanging indent, by its class: docx-preview writes it
 * as the level's paragraphs' negative text-indent.
 */
export function hangingIndents(css: string): Map<string, string> {
  const hanging = new Map<string, string>();
  for (const [, selector = "", body = ""] of css.matchAll(RULE)) {
    const level = /^\s*p\.(docx-num-\d+-\d+)\s*$/.exec(selector)?.[1];
    const indent = /(?:^|;)\s*text-indent\s*:\s*-(\d*\.?\d+)([a-z]*)/.exec(body);
    if (level && indent && Number(indent[1]) > 0) hanging.set(level, `${indent[1]}${indent[2]}`);
  }
  return hanging;
}

/**
 * The stylesheet with each list marker that ends in a tab set as a box as
 * wide as its level's hanging indent, the tab taken out. A marker followed
 * by a space or by nothing is left as it is, as is one with no hanging
 * indent, which Word takes on to a tab stop.
 */
export function listMarkerCss(css: string, hanging: Map<string, string>): string {
  return css.replace(RULE, (rule, selector: string, body: string) => {
    const level = /^\s*p\.(docx-num-\d+-\d+):before\s*$/.exec(selector)?.[1];
    const width = level ? hanging.get(level) : undefined;
    if (!width) return rule;
    // The tab ends the content's last string, which ends the declaration.
    const next = body.replace(/\\9\s?"(\s*;)/, '"$1');
    if (next === body) return rule;
    return `${selector}{${next} display: inline-block; box-sizing: border-box; min-width: ${width}; padding-right: ${GAP}; text-indent: 0; }`;
  });
}

/** Sets a drawn document's list markers as Word sets them, in its stylesheets. */
export function wordListMarkers(styles: ParentNode): void {
  const sheets = Array.from(styles.querySelectorAll("style"));
  const hanging = new Map(sheets.flatMap((sheet) => [...hangingIndents(sheet.textContent ?? "")]));
  if (hanging.size === 0) return;
  for (const sheet of sheets) {
    const css = sheet.textContent ?? "";
    const next = listMarkerCss(css, hanging);
    if (next !== css) sheet.textContent = next;
  }
}
