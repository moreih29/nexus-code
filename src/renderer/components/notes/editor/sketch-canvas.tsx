import "./excalidraw-assets";
import { Excalidraw, exportToSvg, serializeAsJSON } from "@excalidraw/excalidraw";
import "@excalidraw/excalidraw/index.css";
import { type ComponentProps, useMemo } from "react";

type Props = ComponentProps<typeof Excalidraw>;
type OnChange = NonNullable<Props["onChange"]>;
export type SketchElements = Parameters<OnChange>[0];
export type SketchAppState = Parameters<OnChange>[1];
export type SketchFiles = Parameters<OnChange>[2];
export type SketchApi = Parameters<NonNullable<Props["excalidrawAPI"]>>[0];

export interface SketchScene {
  elements: SketchElements;
  appState: SketchAppState;
  files: SketchFiles;
}

export async function exportSketch(scene: SketchScene): Promise<{ scene: string; svg: string }> {
  const live = scene.elements.filter((e) => !e.isDeleted);
  const json = serializeAsJSON(scene.elements, scene.appState, scene.files, "local");
  if (!live.length)
    return { scene: json, svg: '<svg xmlns="http://www.w3.org/2000/svg" width="0" height="0"/>' };
  const svg = await exportToSvg({
    elements: live,
    appState: {
      ...scene.appState,
      exportBackground: false,
      exportWithDarkMode: false,
      exportScale: 1,
    },
    files: scene.files,
    exportPadding: 12,
  });
  return { scene: json, svg: svg.outerHTML };
}

export default function SketchCanvas({
  initial,
  dark,
  language,
  onApi,
  onChange,
}: {
  initial: string | null;
  dark: boolean;
  language: string;
  onApi: (api: SketchApi) => void;
  onChange: (scene: SketchScene) => void;
}) {
  const initialData = useMemo(() => {
    if (!initial)
      return { appState: { viewBackgroundColor: "transparent" }, scrollToContent: true };
    try {
      const parsed = JSON.parse(initial) as Record<string, unknown>;
      return { ...parsed, scrollToContent: true } as Props["initialData"];
    } catch {
      return { scrollToContent: true };
    }
  }, [initial]);

  return (
    <Excalidraw
      initialData={initialData}
      theme={dark ? "dark" : "light"}
      langCode={language.startsWith("ko") ? "ko-KR" : "en"}
      excalidrawAPI={onApi}
      onChange={(elements, appState, files) => onChange({ elements, appState, files })}
      UIOptions={{
        canvasActions: {
          changeViewBackgroundColor: false,
          clearCanvas: true,
          export: false,
          loadScene: false,
          saveAsImage: false,
          saveToActiveFile: false,
          toggleTheme: false,
        },
        tools: { image: true },
      }}
    />
  );
}
