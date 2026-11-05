// FontPreview — a font file set in sample text: its letters, digits and
// punctuation, then a line of text, which can be typed over, at a range of
// sizes. The font loads from the file's `nexus-workspace://` URL as a web
// font of a family name of its own, so it never stands in for a font the app
// uses, and is taken off the page with the preview. A character the font
// lacks shows in the fallback font. A file changed on disk loads again.

import { useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { EmptyState } from "../../ui/empty-state";
import { useFileVersion, versionedUrl } from "./use-file-version";
import { useWorkspaceFile } from "./use-workspace-file";

/** The sizes the sample line is set at, in px. */
const SIZES = [12, 16, 20, 24, 32, 48, 64, 96];

/**
 * The line set at each size until one is typed. Latin, as most fonts cover
 * it: a character a font lacks would show in the fallback font instead.
 */
const SAMPLE = "The quick brown fox jumps over the lazy dog";

const CHARACTER_SETS = [
  "ABCDEFGHIJKLMNOPQRSTUVWXYZ",
  "abcdefghijklmnopqrstuvwxyz",
  "0123456789",
  "!\"#$%&'()*+,-./:;<=>?@[\\]^_`{|}~",
];

interface FontPreviewProps {
  workspaceId: string;
  /** Absolute path on the workspace filesystem. */
  filePath: string;
}

export function FontPreview({ workspaceId, filePath }: FontPreviewProps) {
  const { t } = useTranslation();
  const file = useWorkspaceFile(workspaceId, filePath);
  if (file.kind !== "inside") {
    return (
      <EmptyState
        title={
          file.kind === "outside"
            ? t("fontPreview.outside_workspace")
            : t("imagePreview.workspace_not_found")
        }
        tone="status"
        className="min-h-0"
      />
    );
  }
  return <FontSpecimen url={file.url} workspaceId={workspaceId} relPath={file.relPath} />;
}

interface FontSpecimenProps {
  url: string;
  workspaceId: string;
  relPath: string;
}

function FontSpecimen({ url, workspaceId, relPath }: FontSpecimenProps) {
  const { t } = useTranslation();
  const src = versionedUrl(url, useFileVersion(workspaceId, relPath));
  const family = useLoadedFont(src);
  const [sample, setSample] = useState(SAMPLE);

  if (family === "failed") {
    return <EmptyState title={t("fontPreview.load_failed")} tone="status" className="min-h-0" />;
  }
  if (family === null) {
    return <div className="flex-1 bg-[var(--surface-backdrop-bg)]" aria-busy />;
  }

  const fontFamily = `"${family}", var(--font-sans)`;
  return (
    <div className="app-scrollbar flex-1 min-h-0 overflow-auto bg-[var(--surface-backdrop-bg)]">
      <div className="flex flex-col gap-6 p-6 text-[var(--surface-island-fg)]">
        <div className="flex flex-col gap-1 text-[24px] leading-snug" style={{ fontFamily }}>
          {CHARACTER_SETS.map((set) => (
            <p key={set} className="break-all">
              {set}
            </p>
          ))}
        </div>
        <input
          type="text"
          value={sample}
          onChange={(e) => setSample(e.target.value)}
          aria-label={t("fontPreview.sample_label")}
          className="w-full max-w-xl px-2 py-1 text-app-ui-sm bg-transparent border border-border rounded-(--radius-control)"
        />
        <div className="flex flex-col gap-4">
          {SIZES.map((size) => (
            <div key={size} className="flex items-baseline gap-4">
              <span className="w-10 shrink-0 text-right text-app-ui-sm tabular-nums text-muted-foreground select-none">
                {size}
              </span>
              <p className="min-w-0 truncate leading-tight" style={{ fontFamily, fontSize: size }}>
                {sample}
              </p>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/**
 * Loads `src` as a web font under a family name of its own: the name once
 * it loads, "failed" if it does not, null meanwhile. A version of the file
 * keeps showing until the next one loads, which then takes its place; the
 * font leaves the page with the preview.
 */
function useLoadedFont(src: string): string | null | "failed" {
  const family = `nexus-font-preview-${useId().replace(/[^a-zA-Z0-9-]/g, "")}`;
  const [state, setState] = useState<"loading" | "loaded" | "failed">("loading");
  const shown = useRef<FontFace | null>(null);

  useEffect(() => {
    let cancelled = false;
    const face = new FontFace(family, `url("${src}")`);
    face.load().then(
      () => {
        if (cancelled) return;
        document.fonts.add(face);
        if (shown.current) document.fonts.delete(shown.current);
        shown.current = face;
        setState("loaded");
      },
      () => {
        if (!cancelled) setState("failed");
      },
    );
    return () => {
      cancelled = true;
    };
  }, [family, src]);

  useEffect(
    () => () => {
      if (shown.current) document.fonts.delete(shown.current);
    },
    [],
  );

  if (state === "loading") return null;
  return state === "loaded" ? family : "failed";
}
