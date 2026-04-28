import type { FileIconSvgModuleMap } from "./file-icon-loader";

export const viteIconModules = import.meta.glob<string>("../../assets/file-icons/*.svg", {
  query: "?raw",
  import: "default",
}) as FileIconSvgModuleMap;
