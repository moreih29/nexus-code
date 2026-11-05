// MermaidDiagram — a ```mermaid block of the Markdown preview drawn as its
// diagram.
//
// mermaid is loaded with the first diagram, not with the app. It draws the
// diagram as SVG markup, which shows in an <img> from a blob URL as the SVG
// preview does: as an image, the SVG runs no script and loads nothing, so a
// diagram in a workspace file cannot reach the app whatever it holds.
// securityLevel "strict" escapes the labels' HTML too. Labels are SVG text
// rather than HTML, which an image could not show.
//
// A diagram follows edits to its source a moment after typing stops, keeping
// the last one drawn meanwhile. One that does not parse shows its source and
// mermaid's message.

import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { THEME_SOURCE_BY_ID } from "../../../../shared/design-tokens";
import { useThemeStore } from "../../../state/stores/theme";
import { useSvgBlobUrl } from "./svg-preview";

type Mermaid = typeof import("mermaid")["default"];

let loading: Promise<Mermaid> | null = null;
function loadMermaid(): Promise<Mermaid> {
  loading ??= import("mermaid").then((m) => m.default);
  return loading;
}

/** How long after an edit a diagram is drawn again, in ms. */
const REDRAW_DELAY_MS = 300;

/** A font both the page, which lays the diagram out, and the image have. */
const FONT = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif";

let nextId = 0;

type Drawn = { svg: string; width: number | null } | { error: string };

export function MermaidDiagram({ code }: { code: string }) {
  const { t } = useTranslation();
  const base = useThemeStore((s) => THEME_SOURCE_BY_ID[s.resolved].base);
  const [drawn, setDrawn] = useState<Drawn | null>(null);
  const [broken, setBroken] = useState(false);
  /** Whether a diagram has been drawn: the first is drawn at once. */
  const drawnOnce = useRef(false);

  useEffect(() => {
    let cancelled = false;
    const timer = setTimeout(
      () => {
        void draw(code, base).then((result) => {
          if (cancelled) return;
          drawnOnce.current = true;
          setDrawn(result);
          setBroken(false);
        });
      },
      drawnOnce.current ? REDRAW_DELAY_MS : 0,
    );
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [code, base]);

  const url = useSvgBlobUrl(drawn && "svg" in drawn ? drawn.svg : null);

  if (drawn && "error" in drawn) {
    return <Failed code={code} message={t("markdown.mermaid_error", { message: drawn.error })} />;
  }
  if (broken) return <Failed code={code} message={t("markdown.mermaid_unshown")} />;
  return (
    <div className="md-mermaid" aria-busy={url === null}>
      {url && drawn && "svg" in drawn && (
        <img
          src={url}
          alt={t("markdown.mermaid_alt")}
          style={drawn.width ? { width: drawn.width } : undefined}
          onError={() => setBroken(true)}
        />
      )}
    </div>
  );
}

function Failed({ code, message }: { code: string; message: string }) {
  return (
    <div className="md-mermaid-failed">
      <p role="status">{message}</p>
      <pre>
        <code>{code}</code>
      </pre>
    </div>
  );
}

async function draw(code: string, base: "dark" | "light"): Promise<Drawn> {
  try {
    const mermaid = await loadMermaid();
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      theme: base === "dark" ? "dark" : "default",
      fontFamily: FONT,
      htmlLabels: false,
      flowchart: { htmlLabels: false },
      suppressErrorRendering: true,
    });
    nextId += 1;
    const { svg } = await mermaid.render(`nexus-mermaid-${nextId}`, code);
    return { svg, width: naturalWidth(svg) };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

/** The diagram's own width, from its viewBox: it otherwise fills its block. */
function naturalWidth(svg: string): number | null {
  const match = /viewBox="[-\d.]+[\s,]+[-\d.]+[\s,]+([\d.]+)[\s,]+[\d.]+"/.exec(svg);
  const width = match ? Number(match[1]) : Number.NaN;
  return Number.isFinite(width) && width > 0 ? Math.ceil(width) : null;
}
