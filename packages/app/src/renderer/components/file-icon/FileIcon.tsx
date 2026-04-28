import { useEffect, useMemo, useState } from "react";

import { cn } from "@/lib/utils";
import {
  loadFileIconSvgState,
  type LoadedFileIconSvg,
} from "./file-icon-loader";
import {
  resolveFileIconSource,
  type FileIconFolderState,
  type FileIconKind,
  type FileIconSource,
} from "./file-icon-resolver";

export const FILE_ICON_DEFAULT_SIZE = 14;

export interface FileIconProps {
  name: string;
  kind: FileIconKind;
  folderState?: FileIconFolderState;
  size?: number;
  className?: string;
}

type FileIconRenderState =
  | {
      status: "loading";
      iconFileName: string;
      svg: null;
    }
  | LoadedFileIconSvg;

export function FileIcon({
  name,
  kind,
  folderState,
  size = FILE_ICON_DEFAULT_SIZE,
  className,
}: FileIconProps): JSX.Element {
  const source = useMemo(
    () => resolveFileIconSource({ name, kind, folderState }),
    [folderState, kind, name],
  );
  const [loadedSvg, setLoadedSvg] = useState<FileIconRenderState>(() => ({
    status: "loading",
    iconFileName: source.fileName,
    svg: null,
  }));

  useEffect(() => {
    let canceled = false;

    setLoadedSvg({
      status: "loading",
      iconFileName: source.fileName,
      svg: null,
    });

    void loadFileIconSvgState(source).then((nextState) => {
      if (!canceled) {
        setLoadedSvg(nextState);
      }
    });

    return () => {
      canceled = true;
    };
  }, [source]);

  const matchingLoadedSvg = loadedSvg.iconFileName === source.fileName ? loadedSvg : null;

  return (
    <FileIconView
      className={className}
      loadState={matchingLoadedSvg?.status ?? "loading"}
      size={size}
      source={source}
      svg={matchingLoadedSvg?.svg ?? null}
    />
  );
}

export function FileIconView({
  className,
  loadState,
  size = FILE_ICON_DEFAULT_SIZE,
  source,
  svg,
}: {
  className?: string;
  loadState: FileIconRenderState["status"];
  size?: number;
  source: FileIconSource;
  svg: string | null;
}): JSX.Element {
  const iconStyle = { width: size, height: size };
  const baseClassName = cn("inline-flex shrink-0 items-center justify-center align-[-0.125em]", className);

  if (loadState === "loaded" && svg) {
    return (
      <span
        aria-hidden="true"
        className={cn(baseClassName, "[&>svg]:block [&>svg]:size-full")}
        data-file-icon="true"
        data-file-icon-kind={source.kind}
        data-file-icon-name={source.basename}
        data-file-icon-source={source.fileName}
        data-file-icon-state="loaded"
        data-file-icon-uses-default={source.usesLibraryDefault ? "true" : "false"}
        dangerouslySetInnerHTML={{ __html: svg }}
        style={iconStyle}
      />
    );
  }

  return (
    <span
      aria-hidden="true"
      className={cn(baseClassName, "rounded-sm border border-sidebar-border bg-muted/70")}
      data-file-icon="true"
      data-file-icon-kind={source.kind}
      data-file-icon-name={source.basename}
      data-file-icon-source={source.fileName}
      data-file-icon-state={loadState === "failed" ? "failed" : "loading"}
      data-file-icon-uses-default={source.usesLibraryDefault ? "true" : "false"}
      style={iconStyle}
    />
  );
}
