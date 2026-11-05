// YamlTreePreview — a YAML file as the tree a JSON file shows. Its reader
// (the `yaml` library) loads the first time one is shown.

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { JsonTreePreview, type TreeFormat } from "./json-tree-preview";

let loading: Promise<TreeFormat> | null = null;
let loaded: TreeFormat | null = null;

function loadYamlFormat(): Promise<TreeFormat> {
  loading ??= import("@/services/editor/preview/yaml-tree").then((module) => {
    loaded = { name: "YAML", parse: module.parseYaml };
    return loaded;
  });
  return loading;
}

export function YamlTreePreview({ source }: { source: string }) {
  const { t } = useTranslation();
  const [format, setFormat] = useState<TreeFormat | null>(loaded);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (format) return;
    let live = true;
    loadYamlFormat().then(
      (next) => {
        if (live) setFormat(next);
      },
      () => {
        // A later preview tries again.
        loading = null;
        if (live) setFailed(true);
      },
    );
    return () => {
      live = false;
    };
  }, [format]);

  if (format) return <JsonTreePreview source={source} format={format} />;
  return (
    <div
      role="status"
      className="h-full p-4 text-app-ui-sm text-muted-foreground bg-[var(--surface-backdrop-bg)]"
    >
      {failed ? t("jsonPreview.load_failed") : null}
    </div>
  );
}
