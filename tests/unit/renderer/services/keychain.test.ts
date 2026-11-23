/**
 * The window's side of the keychain: the question before it is read (after
 * the release notes close), and the toast while macOS asks.
 */
import { beforeEach, expect, mock, test } from "bun:test";
import type { KeychainStatus } from "../../../../src/shared/keychain";

const calls: { method: string; args: unknown }[] = [];
const answers: Record<string, unknown> = {};
let changed: ((status: KeychainStatus) => void) | undefined;

mock.module("../../../../src/renderer/ipc/client", () => ({
  ipcCallResult: (_channel: string, method: string, args: unknown) => {
    calls.push({ method, args });
    return Promise.resolve({ ok: true as const, value: answers[method] });
  },
  unwrapIpcResult: <T>(result: { ok: boolean; value?: T }): T => result.value as T,
  ipcListen: (_channel: string, _event: string, listener: (status: KeychainStatus) => void) => {
    changed = listener;
    return () => {
      changed = undefined;
    };
  },
  canUseIpcBridge: () => false,
}));

const prompts: Record<string, string | undefined>[] = [];
let confirm: (open: boolean) => void = () => {};
mock.module("../../../../src/renderer/components/ui/confirm-dialog", () => ({
  showConfirmDialog: (request: Record<string, string | undefined>) => {
    prompts.push(request);
    return new Promise<boolean>((resolve) => {
      confirm = resolve;
    });
  },
}));

const toasts: { id: number; kind: string; message: string; durationMs?: number }[] = [];
const dismissed: number[] = [];
mock.module("../../../../src/renderer/components/ui/toast", () => ({
  showToast: (input: { kind: string; message: string; durationMs?: number }) => {
    const id = toasts.length + 1;
    toasts.push({ id, ...input });
    return id;
  },
  dismissToast: (id: number) => dismissed.push(id),
}));

const { startKeychain, keychainItemsText } = await import(
  "../../../../src/renderer/services/keychain"
);
const { useReleaseNotesStore } = await import(
  "../../../../src/renderer/state/stores/release-notes"
);

const status = (patch: Partial<KeychainStatus>): KeychainStatus => ({
  state: "open",
  items: [],
  busy: false,
  ...patch,
});

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  calls.length = 0;
  prompts.length = 0;
  toasts.length = 0;
  dismissed.length = 0;
  for (const key of Object.keys(answers)) delete answers[key];
});

test("asks once the release notes close, in the words the user agreed", async () => {
  const asking = status({ state: "ask", items: ["remote", "voices"] });
  answers.status = asking;
  answers.claimPrompt = { prompt: true, status: asking };
  answers.answer = status({ state: "locked", items: ["remote", "voices"] });
  useReleaseNotesStore.setState({ open: true });
  const stop = startKeychain();
  try {
    await flush();
    expect(calls.map((c) => c.method)).toEqual(["status"]);
    useReleaseNotesStore.setState({ open: false });
    await flush();
    expect(prompts).toEqual([
      {
        title: "Open the keychain?",
        description: "Kept in the macOS keychain · Remote sign-in, Remembered voices",
        hint: 'Enter your login password in the next macOS window and choose "Always Allow". Asked once after the app\'s signature changes',
        cancelLabel: "Later",
        confirmLabel: "Continue",
      },
    ]);
    confirm(false);
    await flush();
    expect(calls.at(-1)).toEqual({ method: "answer", args: { open: false } });
  } finally {
    stop();
  }
});

test("another window asking: this one shows nothing", async () => {
  const asking = status({ state: "ask", items: ["profileKeys"] });
  answers.status = asking;
  answers.claimPrompt = { prompt: false, status: status({ state: "opening" }) };
  const stop = startKeychain();
  try {
    await flush();
    expect(calls.map((c) => c.method)).toEqual(["status", "claimPrompt"]);
    expect(prompts).toEqual([]);
  } finally {
    stop();
  }
});

test("while macOS asks, a toast says what to choose, until the call ends", async () => {
  answers.status = status({});
  const stop = startKeychain();
  try {
    await flush();
    changed?.(status({ state: "opening", busy: true }));
    changed?.(status({ state: "opening", busy: true }));
    expect(toasts).toEqual([
      {
        id: 1,
        kind: "info",
        message: 'Checking the keychain · Choose "Always Allow" in the macOS window.',
        durationMs: Number.POSITIVE_INFINITY,
      },
    ]);
    changed?.(status({ state: "open", busy: false }));
    expect(dismissed).toEqual([1]);
  } finally {
    stop();
  }
});

test("the items in Korean, as given", async () => {
  const i18next = (await import("i18next")).default;
  const language = i18next.language;
  await i18next.changeLanguage("ko");
  try {
    expect(keychainItemsText(status({ items: ["remote", "profileKeys", "voices"] }))).toBe(
      "원격 로그인, 프로필 API 키, 기억한 목소리",
    );
    expect(i18next.t("common:keychain.prompt.description", { items: "원격 로그인" })).toBe(
      "macOS 키체인에 보관 중 · 원격 로그인",
    );
  } finally {
    await i18next.changeLanguage(language);
  }
});
