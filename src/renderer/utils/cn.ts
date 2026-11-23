import { type ClassValue, clsx } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";
import { appTypeScale, typeScale } from "../../shared/design-tokens";

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
