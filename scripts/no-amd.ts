const AMD_CHECKS = [
  /\bdefine\.amd\b(?!\s*=(?!=))/g,
  /\(\s*typeof\s+define\s*\)\s*\[\s*0\s*\]\s*===?\s*["']f["']/g,
  /\btypeof\s+define\s*===?\s*["']function["']/g,
  /["']function["']\s*===?\s*typeof\s+define\b/g,
];

export function withoutAmdCheck(code: string): string | null {
  if (!code.includes("define")) return null;
  let out = code;
  for (const check of AMD_CHECKS) out = out.replace(check, "false");
  return out === code ? null : out;
}
