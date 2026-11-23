import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { z } from "zod";
import { resources, type SupportedLanguage } from "../../../shared/i18n";
import {
  APPROVED_ONLY_FAILURES,
  SIGN_IN_HELP_FAILURES,
  type SignInFailure,
  type SignInProvider,
  signInFailureTone,
  signInProviderName,
} from "../../../shared/remote/account";
import { siteUrl } from "../../../shared/site";
import { mainLanguage } from "../../i18n";
import { SignInError } from "./errors";

export type CallbackFailure = Extract<
  SignInFailure,
  | "not_invited"
  | "pending_approval"
  | "rejected"
  | "suspended"
  | "closed"
  | "access_denied"
  | "unverified_email"
  | "server_error"
  | "failed"
>;

const SignupAccessSchema = z.enum(["pending", "rejected", "suspended", "closed"]);

const SIGNUP_ACCESS: Record<z.infer<typeof SignupAccessSchema>, CallbackFailure> = {
  pending: "pending_approval",
  rejected: "rejected",
  suspended: "suspended",
  closed: "closed",
};

export function notInvitedFailure(access: unknown): CallbackFailure {
  if (access === undefined || access === null) return "not_invited";
  const known = SignupAccessSchema.safeParse(access);
  return known.success ? SIGNUP_ACCESS[known.data] : "failed";
}

const CALLBACK_ERRORS = ["access_denied", "unverified_email", "server_error"] as const;

export function callbackFailure(query: URLSearchParams): CallbackFailure | undefined {
  const error = query.get("error");
  if (error === null) return query.get("code") ? undefined : "failed";
  if (error === "not_invited") return notInvitedFailure(query.get("access"));
  return CALLBACK_ERRORS.find((e) => e === error) ?? "failed";
}

export interface Callback {
  code?: string;
  failure?: CallbackFailure;
  error?: string;
  state: string | null;
}

export interface LoopbackListener {
  readonly redirectUri: string;
  readonly result: Promise<Callback>;
  report(outcome: "signed-in" | SignInFailure, provider?: SignInProvider): void;
  close(): void;
}

export type PageOutcome = "signed-in" | "in-app" | Exclude<SignInFailure, "cancelled">;

export const PAGE_WAIT_MS = 10_000;

export const PAGE_HEADERS = {
  "content-type": "text/html; charset=utf-8",
  "cache-control": "no-store",
  "referrer-policy": "no-referrer",
  "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; img-src data:",
} as const;

const STYLE = `
:root{color-scheme:light dark;--bg:#f5f5f7;--card:#fff;--fg:#1d1d1f;--muted:#6e6e73;--border:#dcdce0;
--success:#1f8a4c;--info:#0b62c4;--warning:#9a5b00;--error:#c42b2b}
@media (prefers-color-scheme:dark){:root{--bg:#141416;--card:#1f1f22;--fg:#f2f2f4;--muted:#a1a1a8;
--border:#36363b;--success:#4cc38a;--info:#62a8ff;--warning:#f0b44c;--error:#ff6b6b}}
*{box-sizing:border-box}
html,body{margin:0;min-height:100%}
body{display:flex;align-items:center;justify-content:center;min-height:100vh;padding:24px;
background:var(--bg);color:var(--fg);-webkit-font-smoothing:antialiased;word-break:keep-all;overflow-wrap:anywhere;
font:15px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,"Apple SD Gothic Neo","Malgun Gothic",sans-serif}
main{width:100%;max-width:420px}
.brand{display:flex;align-items:center;gap:8px;margin:0 0 14px 2px;font-size:14px;font-weight:600;color:var(--muted)}
.brand svg{width:22px;height:22px;flex:none}
.card{padding:28px 28px 26px;border:1px solid var(--border);border-radius:14px;background:var(--card)}
.icon{display:flex;align-items:center;justify-content:center;width:38px;height:38px;margin:0 0 16px;border-radius:50%;
color:var(--tone);background:color-mix(in srgb,var(--tone) 14%,transparent)}
.icon svg{width:20px;height:20px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}
.success{--tone:var(--success)}.info{--tone:var(--info)}.warning{--tone:var(--warning)}.error{--tone:var(--error)}
h1{margin:0 0 6px;font-size:20px;line-height:1.35;font-weight:650}
p{margin:0}
.lead{margin:0 0 4px;font-weight:550}
.body{color:var(--muted)}
.more{margin:12px 0 0}
.more a{color:var(--info);font-weight:550;text-decoration:none}
.more a:hover{text-decoration:underline}
.foot{margin:16px 0 0;text-align:center;font-size:13px;color:var(--muted)}
`;

const LOGO =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x=".5" y=".5" width="23" height="23" rx="5" fill="#1c1c1e" stroke="#fff" stroke-opacity=".16"/>' +
  '<rect x="4.5" y="8.5" width="11" height="8.5" rx="2" fill="#77777d" transform="rotate(-14 10 12.75)"/>' +
  '<rect x="8.5" y="6.5" width="11" height="8.5" rx="2" fill="#e4e4e8" transform="rotate(-14 14 10.75)"/></svg>';

const ICONS = {
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7.5V12l3 2"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5.5M12 7.6v.1"/>',
  alert: '<circle cx="12" cy="12" r="9"/><path d="M12 7.5V13M12 16.4v.1"/>',
} as const;

const ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ESCAPES[c] ?? c);
}

type AccountWords = (typeof resources)[SupportedLanguage]["settings"]["remote"]["account"];

function pageWords(
  outcome: PageOutcome,
  words: AccountWords,
  provider: SignInProvider | undefined,
): { title: string; body: string } {
  if (outcome === "signed-in") return words.browser.signedIn;
  if (outcome === "in-app") return words.browser.continueInApp;
  const name = outcome === "pending_approval" ? signInProviderName(provider) : undefined;
  if (name === undefined) return words.failure[outcome];
  const { title, bodyWithProvider } = words.failure.pending_approval;
  return { title, body: bodyWithProvider.replace("{{provider}}", name) };
}

export function page(
  outcome: PageOutcome,
  language: SupportedLanguage,
  provider?: SignInProvider,
): string {
  const words = resources[language].settings.remote.account;
  const { title, body } = pageWords(outcome, words, provider);
  const lead =
    outcome !== "signed-in" && outcome !== "in-app" && APPROVED_ONLY_FAILURES.includes(outcome)
      ? `<p class="lead">${escapeHtml(words.approvedOnly)}</p>`
      : "";
  const help =
    outcome !== "signed-in" && outcome !== "in-app" && SIGN_IN_HELP_FAILURES.includes(outcome)
      ? `<p class="more"><a href="${escapeHtml(siteUrl("signIn", language))}" target="_blank" rel="noopener noreferrer">${escapeHtml(words.learnMore)}</a></p>`
      : "";
  const tone =
    outcome === "signed-in"
      ? "success"
      : outcome === "in-app"
        ? "info"
        : signInFailureTone(outcome);
  const icon =
    outcome === "signed-in"
      ? ICONS.check
      : outcome === "pending_approval"
        ? ICONS.clock
        : tone === "info"
          ? ICONS.info
          : ICONS.alert;
  return [
    `<!doctype html><html lang="${language}"><head><meta charset="utf-8">`,
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    `<title>${escapeHtml(title)} · NexusCode</title><style>${STYLE}</style></head>`,
    `<body><main><div class="brand">${LOGO}<span>NexusCode</span></div>`,
    `<section class="card ${tone}"><div class="icon"><svg viewBox="0 0 24 24" aria-hidden="true">${icon}</svg></div>`,
    `<h1>${escapeHtml(title)}</h1>${lead}<p class="body">${escapeHtml(body)}</p>${help}</section>`,
    `<p class="foot">${escapeHtml(words.browser.closeTab)}</p></main></body></html>`,
  ].join("");
}

export async function listenForCallback(
  timeoutMs: number,
  language: () => SupportedLanguage = mainLanguage,
  pageWaitMs: number = PAGE_WAIT_MS,
): Promise<LoopbackListener> {
  let settle: { resolve(c: Callback): void; reject(e: Error): void } | null = null;
  const result = new Promise<Callback>((resolve, reject) => {
    settle = { resolve, reject };
  });
  result.catch(() => {});
  let told: { outcome: PageOutcome; provider?: SignInProvider } | undefined;
  const waiting = new Set<() => void>();
  const report = (outcome: "signed-in" | SignInFailure, provider?: SignInProvider) => {
    if (told) return;
    told = { outcome: outcome === "cancelled" ? "in-app" : outcome, provider };
    const pages = [...waiting];
    waiting.clear();
    for (const send of pages) send();
  };
  const answer = (res: ServerResponse) => {
    const send = (outcome: PageOutcome, provider?: SignInProvider) => {
      if (res.headersSent || res.destroyed) return;
      res.writeHead(200, PAGE_HEADERS).end(page(outcome, language(), provider));
    };
    if (told) {
      send(told.outcome, told.provider);
      return;
    }
    const sendTold = () => {
      clearTimeout(wait);
      if (told) send(told.outcome, told.provider);
    };
    const wait = setTimeout(() => {
      waiting.delete(sendTold);
      send("in-app");
    }, pageWaitMs);
    waiting.add(sendTold);
    res.once("close", () => {
      clearTimeout(wait);
      waiting.delete(sendTold);
    });
  };
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (req.method !== "GET" || url.pathname !== "/callback") {
      res.writeHead(404).end();
      return;
    }
    const code = url.searchParams.get("code") ?? undefined;
    const error = url.searchParams.get("error") ?? undefined;
    const failure = callbackFailure(url.searchParams);
    finish(() =>
      settle?.resolve({
        code,
        ...(failure ? { failure } : {}),
        error,
        state: url.searchParams.get("state"),
      }),
    );
    answer(res);
  });
  const timer = setTimeout(() => stop("timed-out"), timeoutMs);
  let done = false;
  const finish = (then: () => void) => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    server.close();
    then();
  };
  const stop = (failure: "cancelled" | "timed-out") => {
    finish(() => settle?.reject(new SignInError(failure)));
  };
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const { port } = server.address() as AddressInfo;
  return {
    redirectUri: `http://127.0.0.1:${port}/callback`,
    result,
    report,
    close: () => stop("cancelled"),
  };
}
