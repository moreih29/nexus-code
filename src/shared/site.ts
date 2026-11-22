/**
 * NexusCode's website: the one place the app makes its addresses. Its
 * Korean pages are at the root; every other UI language gets the English
 * ones, under /en/.
 */

const SITE = "https://nexuscode.gradiendo.com";

/** The site's pages the app links to. */
const PAGES = {
  home: "/",
  support: "/support/",
  /** Support's section on signing in and signup approval. */
  signIn: "/support/#sign-in",
  privacy: "/privacy/",
} as const;

export type SitePage = keyof typeof PAGES;

/** `page`'s address in the UI language `language`. */
export function siteUrl(page: SitePage, language: string): string {
  const korean = language === "ko" || language.startsWith("ko-");
  return `${SITE}${korean ? "" : "/en"}${PAGES[page]}`;
}
