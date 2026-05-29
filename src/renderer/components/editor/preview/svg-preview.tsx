// SvgPreview — renders user-supplied SVG markup via `<img>` + blob URL.
//
// SECURITY MODEL (plan 60 issue 3)
//   Inline SVG inserted into the renderer's DOM (innerHTML, dangerouslySet…)
//   shares origin with the rest of our document. That means `<script>`
//   inside an SVG, `<foreignObject>` with embedded HTML, and even some
//   `xlink:href="javascript:…"` patterns run with full access to our
//   globals — a textbook XSS surface.
//
//   Loading the same SVG through `<img src=…>` instead opts into the
//   browser's "image" mode for SVG: scripts are disabled, foreignObject
//   is disabled, external resource fetches are blocked. The browser
//   treats the SVG as an image, not a document. This is the same trick
//   GitHub and other code hosts use for untrusted SVG.
//
// We construct a blob URL per source revision so the image picks up live
// edits, and revoke the previous URL on cleanup to avoid leaking memory.

import { useEffect, useState } from "react";
import { capPreviewSource, getPreviewTruncatedMessage } from "./constants";

interface SvgPreviewProps {
  source: string;
}

export function SvgPreview({ source }: SvgPreviewProps) {
  const { text, truncated } = capPreviewSource(source);
  const blobUrl = useSvgBlobUrl(text);

  return (
    <div className="flex flex-col h-full min-h-0 bg-[var(--surface-backdrop-bg)]">
      {truncated && (
        <div
          role="status"
          className="px-3 py-1 text-app-ui-sm text-[var(--state-warning-fg)] bg-[var(--state-warning-bg)] border-b border-[var(--state-warning-border)]"
        >
          {getPreviewTruncatedMessage()}
        </div>
      )}
      <div className="app-scrollbar flex-1 min-h-0 flex items-center justify-center p-4 overflow-auto">
        {blobUrl && (
          <img src={blobUrl} alt="SVG preview" className="max-w-full max-h-full object-contain" />
        )}
      </div>
    </div>
  );
}

/**
 * Build a blob URL for the given SVG markup and revoke the previous one
 * whenever the source changes. The mime type is set explicitly so the
 * browser picks the image renderer (rather than text/plain fallback) when
 * the `<img>` element fetches the URL.
 */
function useSvgBlobUrl(source: string): string | null {
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    const blob = new Blob([source], { type: "image/svg+xml" });
    const objectUrl = URL.createObjectURL(blob);
    setUrl(objectUrl);
    return () => {
      URL.revokeObjectURL(objectUrl);
    };
  }, [source]);

  return url;
}
