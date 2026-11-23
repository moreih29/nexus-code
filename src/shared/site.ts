const SITE = "https://nexuscode.gradiendo.com";

const PAGES = {
  home: "/",
  support: "/support/",
  signIn: "/support/#sign-in",
  privacy: "/privacy/",
} as const;

export type SitePage = keyof typeof PAGES;

export function siteUrl(page: SitePage, language: string): string {
  const korean = language === "ko" || language.startsWith("ko-");
  return `${SITE}${korean ? "" : "/en"}${PAGES[page]}`;
}
