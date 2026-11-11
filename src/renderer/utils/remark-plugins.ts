import type { Options } from "react-markdown";
import remarkGfm from "remark-gfm";

/**
 * The remark plugins every markdown view uses: GitHub-flavored markdown, with
 * a single tilde left as text. "16:02~16:09" and "50~70%" are ranges, not
 * strikethrough; striking text out takes two tildes (~~gone~~), as CommonMark
 * editors and VS Code read it.
 */
export const REMARK_PLUGINS: NonNullable<Options["remarkPlugins"]> = [
  [remarkGfm, { singleTilde: false }],
];
