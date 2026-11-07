import { type ClassValue, clsx } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";
import { appTypeScale, typeScale } from "../../shared/design-tokens";

// ---------------------------------------------------------------------------
// tailwind-merge — register custom typography utilities
//
// design-tokens.ts → vite plugin emits `--text-{role}` Tailwind v4 vars,
// which Tailwind auto-generates `text-{role}` font-size utilities for.
// However tailwind-merge's default config only recognizes the standard
// `text-{xs|sm|base|lg|xl|2xl|...}` scale; unknown `text-{name}` is
// classified as text-color and conflicts with `text-foreground` /
// `text-muted-foreground` in the same `cn()` call — the size utility is
// silently dropped during merge. Register every typeScale + appTypeScale
// role here so they are correctly placed in the font-size group.
//
// `git-destructive-text` (globals.css) is a text colour: registered so it
// replaces `text-foreground` when a Git menu item marks itself destructive.
// ---------------------------------------------------------------------------

function camelToKebab(s: string): string {
  return s.replace(/([A-Z])/g, (m) => `-${m.toLowerCase()}`);
}

const TYPO_ROLE_NAMES = [...Object.keys(typeScale), ...Object.keys(appTypeScale)].map(camelToKebab);

const twMerge = extendTailwindMerge({
  extend: {
    classGroups: {
      "font-size": [{ text: TYPO_ROLE_NAMES }],
      "text-color": ["git-destructive-text"],
    },
  },
});

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
