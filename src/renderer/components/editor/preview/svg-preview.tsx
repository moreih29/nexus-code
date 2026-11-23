import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { capPreviewSource, getPreviewTruncatedMessage } from "./constants";

interface SvgPreviewProps {
  source: string;
}

export function SvgPreview({ source }: SvgPreviewProps) {
  const { t } = useTranslation();
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
          <img
            src={blobUrl}
            alt={t("preview.svg_alt")}
            className="max-w-full max-h-full object-contain"
          />
        )}
      </div>
    </div>
  );
}

export function useSvgBlobUrl(source: string | null): string | null {
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    if (source === null) {
      setUrl(null);
      return;
    }
    const blob = new Blob([source], { type: "image/svg+xml" });
    const objectUrl = URL.createObjectURL(blob);
    setUrl(objectUrl);
    return () => {
      URL.revokeObjectURL(objectUrl);
    };
  }, [source]);

  return url;
}
