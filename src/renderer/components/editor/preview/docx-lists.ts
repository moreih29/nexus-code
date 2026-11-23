const RULE = /([^{}]*)\{([^{}]*)\}/g;

const GAP = "0.5em";

export function hangingIndents(css: string): Map<string, string> {
  const hanging = new Map<string, string>();
  for (const [, selector = "", body = ""] of css.matchAll(RULE)) {
    const level = /^\s*p\.(docx-num-\d+-\d+)\s*$/.exec(selector)?.[1];
    const indent = /(?:^|;)\s*text-indent\s*:\s*-(\d*\.?\d+)([a-z]*)/.exec(body);
    if (level && indent && Number(indent[1]) > 0) hanging.set(level, `${indent[1]}${indent[2]}`);
  }
  return hanging;
}

export function listMarkerCss(css: string, hanging: Map<string, string>): string {
  return css.replace(RULE, (rule, selector: string, body: string) => {
    const level = /^\s*p\.(docx-num-\d+-\d+):before\s*$/.exec(selector)?.[1];
    const width = level ? hanging.get(level) : undefined;
    if (!width) return rule;
    const next = body.replace(/\\9\s?"(\s*;)/, '"$1');
    if (next === body) return rule;
    return `${selector}{${next} display: inline-block; box-sizing: border-box; min-width: ${width}; padding-right: ${GAP}; text-indent: 0; }`;
  });
}

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
