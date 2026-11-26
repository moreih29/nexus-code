import { createContext, type ReactNode, useContext, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { EmptyState } from "../../ui/empty-state";

const DraftContext = createContext<{ file: File; url: string } | null>(null);

export function usePreviewDraft() {
  return useContext(DraftContext);
}

export function PreviewDraft({ file, children }: { file: File; children: ReactNode }) {
  const { t } = useTranslation();
  const [source, setSource] = useState<{ file: File; url: string } | null>(null);
  useEffect(() => {
    const url = URL.createObjectURL(file);
    setSource({ file, url });
    return () => URL.revokeObjectURL(url);
  }, [file]);
  if (source?.file !== file) {
    return <EmptyState title={t("editor.loading")} tone="status" className="h-full" />;
  }
  return <DraftContext.Provider value={source}>{children}</DraftContext.Provider>;
}
