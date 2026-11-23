import type { Options } from "react-markdown";
import remarkGfm from "remark-gfm";

export const REMARK_PLUGINS: NonNullable<Options["remarkPlugins"]> = [
  [remarkGfm, { singleTilde: false }],
];
