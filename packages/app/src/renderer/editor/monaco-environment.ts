import EditorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import JsonWorker from "monaco-editor/esm/vs/language/json/json.worker?worker";
import CssWorker from "monaco-editor/esm/vs/language/css/css.worker?worker";
import HtmlWorker from "monaco-editor/esm/vs/language/html/html.worker?worker";
import TsWorker from "monaco-editor/esm/vs/language/typescript/ts.worker?worker";

type MonacoWorkerLabel =
  | "css"
  | "handlebars"
  | "html"
  | "javascript"
  | "json"
  | "less"
  | "razor"
  | "scss"
  | "typescript";

interface MonacoEnvironment {
  getWorker(workerId: string, label: string): Worker;
}

declare global {
  // Monaco reads this global before constructing language/editor workers.
  // Keep this declaration local so the renderer does not depend on Monaco's
  // global .d.ts shape during non-Vite unit tests.
  var MonacoEnvironment: MonacoEnvironment | undefined;
}

export function installMonacoEnvironment(): void {
  globalThis.MonacoEnvironment = {
    getWorker(_workerId: string, label: string): Worker {
      switch (label as MonacoWorkerLabel) {
        case "json":
          return new JsonWorker();
        case "css":
        case "scss":
        case "less":
          return new CssWorker();
        case "html":
        case "handlebars":
        case "razor":
          return new HtmlWorker();
        case "typescript":
        case "javascript":
          return new TsWorker();
        default:
          return new EditorWorker();
      }
    },
  };
}
