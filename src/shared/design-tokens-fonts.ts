// Font family tokens. Lifted out of `design-tokens.ts` so the marketing
// type-scale (`design-tokens-marketing.ts`) and the in-app code scale
// can both import them without forming a circular dependency through
// `design-tokens.ts`.

export const fontFamily = {
  // Tailwind utility overrides — font-sans / font-mono map to these
  sans: "Pretendard, system-ui, -apple-system, sans-serif",
  mono: `"JetBrains Mono Nerd Font", "Sarasa Term K", ui-monospace, monospace`,
  // display/body/caption roles → Pretendard with Korean-first rendering
  display: "Pretendard, system-ui, -apple-system, sans-serif",
  // medium/square/uiSupplement: Pretendard placeholder (revisit when assets arrive)
  medium: "Pretendard, system-ui, -apple-system, sans-serif",
  square: "Pretendard, system-ui, -apple-system, sans-serif",
  uiSupplement: "Pretendard, system-ui, -apple-system, sans-serif",
  // mono roles → JetBrains Mono Nerd Font + Sarasa Term K fallback
  monoDisplay: `"JetBrains Mono Nerd Font", "Sarasa Term K", ui-monospace, monospace`,
  monoBody: `"JetBrains Mono Nerd Font", "Sarasa Term K", ui-monospace, monospace`,
} as const;
