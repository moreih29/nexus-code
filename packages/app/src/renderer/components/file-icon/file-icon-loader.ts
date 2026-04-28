import type { FileIconSource } from "./file-icon-resolver";

export type FileIconSvgModule = string | { default: string };
export type FileIconSvgModuleLoader = () => Promise<FileIconSvgModule>;
export type FileIconSvgModuleMap = Record<string, FileIconSvgModuleLoader>;
export type FileIconSvgLoader = (fileName: string) => Promise<string>;
export type FileIconWarn = (message: string, details: FileIconLoadFailureDetails) => void;

export interface FileIconLoadFailureDetails {
  iconFileName: string;
  requestedName: string;
  kind: FileIconSource["kind"];
  error: unknown;
}

export type LoadedFileIconSvg =
  | {
      status: "loaded";
      iconFileName: string;
      svg: string;
    }
  | {
      status: "failed";
      iconFileName: string;
      svg: null;
      error: unknown;
    };

const iconSvgCache = new Map<string, Promise<string>>();
let defaultFileIconSvgLoader: Promise<FileIconSvgLoader> | null = null;

export function loadFileIconSvg(fileName: string, loader?: FileIconSvgLoader): Promise<string> {
  if (loader) {
    return loader(fileName);
  }

  const cached = iconSvgCache.get(fileName);
  if (cached) {
    return cached;
  }

  const pending = getDefaultFileIconSvgLoader()
    .then((defaultLoader) => defaultLoader(fileName))
    .catch((error: unknown) => {
      iconSvgCache.delete(fileName);
      throw error;
    });
  iconSvgCache.set(fileName, pending);
  return pending;
}

export async function loadFileIconSvgState(
  source: FileIconSource,
  loader: FileIconSvgLoader = loadFileIconSvg,
  warn: FileIconWarn = console.warn,
): Promise<LoadedFileIconSvg> {
  try {
    return {
      status: "loaded",
      iconFileName: source.fileName,
      svg: await loader(source.fileName),
    };
  } catch (error) {
    warn("FileIcon failed to load SVG asset; rendering placeholder.", {
      iconFileName: source.fileName,
      requestedName: source.name,
      kind: source.kind,
      error,
    });

    return {
      status: "failed",
      iconFileName: source.fileName,
      svg: null,
      error,
    };
  }
}

export function createFileIconSvgLoader(
  modules: FileIconSvgModuleMap,
  assetPrefix = "../../assets/file-icons/",
): FileIconSvgLoader {
  return async (fileName: string): Promise<string> => {
    const modulePath = `${assetPrefix}${fileName}`;
    const loadModule = modules[modulePath];
    if (!loadModule) {
      throw new Error(`Missing file icon SVG asset: ${fileName}`);
    }

    return svgTextFromModule(await loadModule(), fileName);
  };
}

function svgTextFromModule(moduleValue: FileIconSvgModule, fileName: string): string {
  const svg = typeof moduleValue === "string" ? moduleValue : moduleValue.default;
  if (!svg.trim().startsWith("<svg")) {
    throw new Error(`Invalid file icon SVG asset: ${fileName}`);
  }

  return svg;
}

function getDefaultFileIconSvgLoader(): Promise<FileIconSvgLoader> {
  defaultFileIconSvgLoader ??= import("./file-icon-vite-modules").then(({ viteIconModules }) =>
    createFileIconSvgLoader(viteIconModules),
  );

  return defaultFileIconSvgLoader;
}
