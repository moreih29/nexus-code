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
const loadedIconSvgStateCache = new Map<string, LoadedFileIconSvg>();
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
  const shouldUseLoadedStateCache = loader === loadFileIconSvg;
  const cachedState = shouldUseLoadedStateCache
    ? readCachedFileIconSvgState(source.fileName)
    : null;
  if (cachedState) {
    return cachedState;
  }

  try {
    const nextState: LoadedFileIconSvg = {
      status: "loaded",
      iconFileName: source.fileName,
      svg: await loader(source.fileName),
    };
    if (shouldUseLoadedStateCache) {
      loadedIconSvgStateCache.set(source.fileName, nextState);
    }
    return nextState;
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

export function readCachedFileIconSvgState(fileName: string): LoadedFileIconSvg | null {
  return loadedIconSvgStateCache.get(fileName) ?? null;
}

export function createFileIconSvgLoader(
  modules: FileIconSvgModuleMap,
  assetPrefix = "../../assets/file-icons/",
): FileIconSvgLoader {
  return async (fileName: string): Promise<string> => {
    const directLoader = modules[`${assetPrefix}${fileName}`];
    if (directLoader) {
      return svgTextFromModule(await directLoader(), fileName);
    }

    const fallbackFileName = fallbackAssetFor(fileName);
    const fallbackLoader = modules[`${assetPrefix}${fallbackFileName}`];
    if (!fallbackLoader) {
      throw new Error(`Missing file icon SVG asset: ${fileName}`);
    }

    return svgTextFromModule(await fallbackLoader(), fileName);
  };
}

function fallbackAssetFor(fileName: string): string {
  if (fileName.startsWith("folder_type_") && fileName.endsWith("_opened.svg")) {
    return "default_folder_opened.svg";
  }
  if (
    fileName.startsWith("folder_type_") ||
    fileName.startsWith("folder_") ||
    fileName === "default_folder.svg"
  ) {
    return "default_folder.svg";
  }
  return "default_file.svg";
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
