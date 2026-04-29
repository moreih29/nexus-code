import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";

import type { NexusPlatform } from "../../src/common/platform";
import { CommandPalette } from "../../src/renderer/components/CommandPalette";
import { TitleBarPart } from "../../src/renderer/parts/titlebar";
import "../../src/renderer/styles.css";
import { keyboardRegistryStore } from "../../src/renderer/stores/keyboard-registry";

interface TitlebarDomProbe {
  mounted: boolean;
  platform: string | null;
  role: string | null;
  ariaLabel: string | null;
  computedHeight: string;
  inlineHeight: string;
  paddingLeft: string;
  appRegion: string;
  appRegionMatched: boolean;
  triggerAppRegion: string;
  triggerNoDragRegionMatched: boolean;
  triggerAriaLabel: string | null;
  triggerShortcut: string | null;
  triggerText: string;
  shortcutVisible: boolean;
  styleAttribute: string | null;
  triggerStyleAttribute: string | null;
}

interface PaletteProbe {
  openBeforeClick: boolean;
  openAfterFallbackClick: boolean;
  openAfterPaletteClick: boolean;
  inputMountedAfterPaletteClick: boolean;
  inputPlaceholder: string | null;
  commandItemTexts: string[];
}

interface FullscreenProbe {
  attempted: boolean;
  nativeTrafficLightCoordinatesObservable: boolean;
  limitation: string;
}

interface TitlebarRuntimeSmokeResult {
  ok: boolean;
  errors: string[];
  activeTitlebar: TitlebarDomProbe;
  fallbackTitlebar: TitlebarDomProbe;
  interaction: {
    openWorkspaceCalls: number;
    unexpectedPaletteCallsFromFallback: number;
    unexpectedWorkspaceCallsFromPalette: number;
  };
  palette: PaletteProbe;
  fullscreen: FullscreenProbe;
  reason?: string;
}

declare global {
  interface Window {
    __nexusTitlebarRuntimeSmokeResult?: TitlebarRuntimeSmokeResult;
  }
}

const suspiciousMessagePattern =
  /Maximum update depth exceeded|Cannot update a component|error boundary|uncaught|unhandled|getSnapshot should be cached|not wrapped in act/i;
const capturedConsoleMessages: string[] = [];
const capturedErrors: string[] = [];

installConsoleCapture();
installCommandPaletteFixtureCommands();
void runSmoke();

async function runSmoke(): Promise<void> {
  try {
    const rootElement = document.getElementById("app");
    if (!rootElement) {
      publishResult(failedResult("Missing #app root"));
      return;
    }

    prepareDocument(rootElement);
    const root = createRoot(rootElement);
    root.render(
      <StrictMode>
        <TitlebarRuntimeHarness />
      </StrictMode>,
    );

    await waitForSelector('[data-titlebar-fixture="active"] [data-component="titlebar"]', rootElement, 5_000);
    await waitForSelector('[data-titlebar-fixture="fallback"] [data-component="titlebar"]', rootElement, 5_000);
    await animationFrame();

    const activeTitlebar = collectTitlebarProbe('[data-titlebar-fixture="active"]');
    const fallbackTitlebar = collectTitlebarProbe('[data-titlebar-fixture="fallback"]');
    const paletteBeforeClick = isPaletteOpen();

    const fallbackTrigger = triggerFor('[data-titlebar-fixture="fallback"]');
    fallbackTrigger?.click();
    await waitUntil(() => harnessNumberDataset("openWorkspaceCalls") === 1, 1_000, () => {
      return "Timed out waiting for no-workspace titlebar trigger to call open workspace.";
    });
    await animationFrame();
    const paletteAfterFallbackClick = isPaletteOpen();

    const activeTrigger = triggerFor('[data-titlebar-fixture="active"]');
    activeTrigger?.click();
    await waitForSelector('[data-slot="dialog-content"][data-state="open"]', document.body, 5_000);
    const commandInput = await waitForSelector('[data-slot="command-input"]', document.body, 5_000) as HTMLInputElement;
    await waitUntil(() => commandItemTexts().some((text) => text.includes("Titlebar Fixture Command")), 5_000, () => {
      return "Timed out waiting for command palette fixture command.";
    });

    const interaction = {
      openWorkspaceCalls: harnessNumberDataset("openWorkspaceCalls"),
      unexpectedPaletteCallsFromFallback: harnessNumberDataset("unexpectedPaletteCallsFromFallback"),
      unexpectedWorkspaceCallsFromPalette: harnessNumberDataset("unexpectedWorkspaceCallsFromPalette"),
    };
    const palette: PaletteProbe = {
      openBeforeClick: paletteBeforeClick,
      openAfterFallbackClick: paletteAfterFallbackClick,
      openAfterPaletteClick: isPaletteOpen(),
      inputMountedAfterPaletteClick: commandInput.isConnected,
      inputPlaceholder: commandInput.getAttribute("placeholder"),
      commandItemTexts: commandItemTexts(),
    };
    const fullscreen: FullscreenProbe = {
      attempted: false,
      nativeTrafficLightCoordinatesObservable: false,
      limitation:
        "The shared electron-renderer-smoke-runner only exposes renderer DOM inside a hidden BrowserWindow; native fullscreen toggles and macOS traffic-light coordinates are not observable from this fixture. BrowserWindow option helper coverage plus DOM drag/no-drag/padding/click coverage is the deterministic fallback.",
    };

    const fatalErrors = capturedErrors.filter((message) => suspiciousMessagePattern.test(message));
    const validationErrors = validateSmokeResult({
      activeTitlebar,
      fallbackTitlebar,
      interaction,
      palette,
      fullscreen,
    });
    const errors = [...fatalErrors, ...validationErrors];

    publishResult({
      ok: errors.length === 0,
      errors,
      activeTitlebar,
      fallbackTitlebar,
      interaction,
      palette,
      fullscreen,
      reason: errors[0],
    });
  } catch (error) {
    publishResult(failedResult(stringifyErrorPart(error)));
  }
}

function TitlebarRuntimeHarness(): JSX.Element {
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const [openWorkspaceCalls, setOpenWorkspaceCalls] = useState(0);
  const [unexpectedPaletteCallsFromFallback, setUnexpectedPaletteCallsFromFallback] = useState(0);
  const [unexpectedWorkspaceCallsFromPalette, setUnexpectedWorkspaceCallsFromPalette] = useState(0);

  return (
    <main
      data-titlebar-runtime-harness="true"
      data-open-workspace-calls={openWorkspaceCalls}
      data-unexpected-palette-calls-from-fallback={unexpectedPaletteCallsFromFallback}
      data-unexpected-workspace-calls-from-palette={unexpectedWorkspaceCallsFromPalette}
      className="flex min-h-full flex-col gap-4 bg-background p-4 text-foreground"
    >
      <section data-titlebar-fixture="active" aria-label="Active workspace titlebar fixture">
        <TitleBarPart
          hasWorkspace={true}
          platform={"darwin" satisfies NexusPlatform}
          onOpenCommandPalette={() => setCommandPaletteOpen(true)}
          onOpenWorkspace={() => setUnexpectedWorkspaceCallsFromPalette((count) => count + 1)}
        />
      </section>

      <section data-titlebar-fixture="fallback" aria-label="No workspace titlebar fixture">
        <TitleBarPart
          hasWorkspace={false}
          platform={"win32" satisfies NexusPlatform}
          onOpenCommandPalette={() => setUnexpectedPaletteCallsFromFallback((count) => count + 1)}
          onOpenWorkspace={() => setOpenWorkspaceCalls((count) => count + 1)}
        />
      </section>

      <CommandPalette open={commandPaletteOpen} onOpenChange={setCommandPaletteOpen} />
    </main>
  );
}

function installCommandPaletteFixtureCommands(): void {
  keyboardRegistryStore.setState({ bindings: {}, commands: {} });
  keyboardRegistryStore.getState().registerCommand({
    group: "App",
    id: "titlebar.fixture.command",
    run() {},
    title: "Titlebar Fixture Command",
  });
  keyboardRegistryStore.getState().registerBinding("Cmd+P", "titlebar.fixture.command");
}

function collectTitlebarProbe(scopeSelector: string): TitlebarDomProbe {
  const scope = document.querySelector<HTMLElement>(scopeSelector);
  const titlebar = scope?.querySelector<HTMLElement>('[data-component="titlebar"]') ?? null;
  const trigger = scope?.querySelector<HTMLButtonElement>('[data-titlebar-command-trigger="true"]') ?? null;

  if (!titlebar || !trigger) {
    return {
      mounted: false,
      platform: null,
      role: null,
      ariaLabel: null,
      computedHeight: "",
      inlineHeight: "",
      paddingLeft: "",
      appRegion: "",
      appRegionMatched: false,
      triggerAppRegion: "",
      triggerNoDragRegionMatched: false,
      triggerAriaLabel: null,
      triggerShortcut: null,
      triggerText: "",
      shortcutVisible: false,
      styleAttribute: null,
      triggerStyleAttribute: null,
    };
  }

  const titlebarStyleAttribute = titlebar.getAttribute("style");
  const triggerStyleAttribute = trigger.getAttribute("style");
  const appRegion = appRegionFor(titlebar);
  const triggerAppRegion = appRegionFor(trigger);

  return {
    mounted: true,
    platform: titlebar.dataset.platform ?? null,
    role: titlebar.getAttribute("role"),
    ariaLabel: titlebar.getAttribute("aria-label"),
    computedHeight: getComputedStyle(titlebar).height,
    inlineHeight: titlebar.style.height,
    paddingLeft: getComputedStyle(titlebar).paddingLeft,
    appRegion,
    appRegionMatched: regionMatches(appRegion, titlebarStyleAttribute, "drag"),
    triggerAppRegion,
    triggerNoDragRegionMatched: regionMatches(triggerAppRegion, triggerStyleAttribute, "no-drag"),
    triggerAriaLabel: trigger.getAttribute("aria-label"),
    triggerShortcut: trigger.getAttribute("aria-keyshortcuts"),
    triggerText: normalizeText(trigger.textContent ?? ""),
    shortcutVisible: trigger.querySelector("kbd") !== null,
    styleAttribute: titlebarStyleAttribute,
    triggerStyleAttribute,
  };
}

function validateSmokeResult({
  activeTitlebar,
  fallbackTitlebar,
  interaction,
  palette,
  fullscreen,
}: Pick<TitlebarRuntimeSmokeResult, "activeTitlebar" | "fallbackTitlebar" | "interaction" | "palette" | "fullscreen">): string[] {
  const errors: string[] = [];

  validateTitlebarProbe(errors, activeTitlebar, {
    name: "active darwin titlebar",
    platform: "darwin",
    paddingLeft: "78px",
    triggerText: "Search commands⌘P",
    shortcutVisible: true,
  });
  validateTitlebarProbe(errors, fallbackTitlebar, {
    name: "fallback Windows titlebar",
    platform: "win32",
    paddingLeft: "0px",
    triggerText: "Open workspace…",
    shortcutVisible: false,
  });

  if (interaction.openWorkspaceCalls !== 1) {
    errors.push(`Expected one no-workspace openWorkspace call, saw ${interaction.openWorkspaceCalls}.`);
  }
  if (interaction.unexpectedPaletteCallsFromFallback !== 0) {
    errors.push(`No-workspace fallback unexpectedly opened the command palette ${interaction.unexpectedPaletteCallsFromFallback} time(s).`);
  }
  if (interaction.unexpectedWorkspaceCallsFromPalette !== 0) {
    errors.push(`Workspace-present titlebar unexpectedly called openWorkspace ${interaction.unexpectedWorkspaceCallsFromPalette} time(s).`);
  }
  if (palette.openBeforeClick) {
    errors.push("Command palette was open before titlebar trigger click.");
  }
  if (palette.openAfterFallbackClick) {
    errors.push("No-workspace fallback opened the command palette.");
  }
  if (!palette.openAfterPaletteClick || !palette.inputMountedAfterPaletteClick) {
    errors.push("Command palette did not open after workspace-present titlebar trigger click.");
  }
  if (palette.inputPlaceholder !== "Type a command...") {
    errors.push(`Unexpected command palette input placeholder: ${palette.inputPlaceholder ?? "<missing>"}.`);
  }
  if (!palette.commandItemTexts.some((text) => text.includes("Titlebar Fixture Command"))) {
    errors.push("Command palette fixture command was not visible after opening.");
  }
  if (fullscreen.nativeTrafficLightCoordinatesObservable) {
    errors.push("Fullscreen probe unexpectedly claimed native traffic-light coordinates are observable.");
  }
  if (fullscreen.limitation.length === 0) {
    errors.push("Fullscreen traffic-light coordinate limitation was not reported.");
  }

  return errors;
}

function validateTitlebarProbe(
  errors: string[],
  probe: TitlebarDomProbe,
  expected: {
    name: string;
    platform: string;
    paddingLeft: string;
    triggerText: string;
    shortcutVisible: boolean;
  },
): void {
  if (!probe.mounted) {
    errors.push(`${expected.name} did not mount.`);
    return;
  }
  if (probe.platform !== expected.platform) {
    errors.push(`${expected.name} platform expected ${expected.platform}, saw ${probe.platform ?? "<missing>"}.`);
  }
  if (probe.role !== "banner" || probe.ariaLabel !== "Application titlebar") {
    errors.push(`${expected.name} banner semantics changed: role=${probe.role}, aria=${probe.ariaLabel}.`);
  }
  if (probe.computedHeight !== "36px" || probe.inlineHeight !== "36px") {
    errors.push(`${expected.name} height expected 36px, saw computed=${probe.computedHeight}, inline=${probe.inlineHeight}.`);
  }
  if (probe.paddingLeft !== expected.paddingLeft) {
    errors.push(`${expected.name} padding-left expected ${expected.paddingLeft}, saw ${probe.paddingLeft}.`);
  }
  if (!probe.appRegionMatched) {
    errors.push(`${expected.name} did not expose the titlebar drag region token.`);
  }
  if (!probe.triggerNoDragRegionMatched) {
    errors.push(`${expected.name} trigger did not expose the no-drag region token.`);
  }
  if (probe.triggerAriaLabel !== "Open command palette" || probe.triggerShortcut !== "Meta+P") {
    errors.push(`${expected.name} trigger accessibility contract changed.`);
  }
  if (probe.triggerText !== expected.triggerText) {
    errors.push(`${expected.name} trigger text expected ${expected.triggerText}, saw ${probe.triggerText}.`);
  }
  if (probe.shortcutVisible !== expected.shortcutVisible) {
    errors.push(`${expected.name} shortcut visibility expected ${String(expected.shortcutVisible)}, saw ${String(probe.shortcutVisible)}.`);
  }
}

function triggerFor(scopeSelector: string): HTMLButtonElement | null {
  return document.querySelector<HTMLButtonElement>(`${scopeSelector} [data-titlebar-command-trigger="true"]`);
}

function appRegionFor(element: HTMLElement): string {
  const style = element.style as CSSStyleDeclaration & {
    WebkitAppRegion?: string;
    webkitAppRegion?: string;
  };
  return element.style.getPropertyValue("-webkit-app-region") || style.WebkitAppRegion || style.webkitAppRegion || "";
}

function regionMatches(appRegion: string, styleAttribute: string | null, expected: "drag" | "no-drag"): boolean {
  if (appRegion === expected) {
    return true;
  }

  return new RegExp(`-webkit-app-region:\\s*${expected}(?:;|$)`).test(styleAttribute ?? "");
}

function isPaletteOpen(): boolean {
  return document.querySelector('[data-slot="dialog-content"][data-state="open"]') !== null;
}

function commandItemTexts(): string[] {
  return Array.from(document.querySelectorAll<HTMLElement>('[data-slot="command-item"]')).map((element) => {
    return normalizeText(element.textContent ?? "");
  });
}

function harnessNumberDataset(key: "openWorkspaceCalls" | "unexpectedPaletteCallsFromFallback" | "unexpectedWorkspaceCallsFromPalette"): number {
  const harness = document.querySelector<HTMLElement>('[data-titlebar-runtime-harness="true"]');
  const value = harness?.dataset[key];
  return Number(value ?? "0");
}

function installConsoleCapture(): void {
  const originalConsoleError = console.error.bind(console);
  const originalConsoleWarn = console.warn.bind(console);

  console.error = (...args: unknown[]) => {
    const message = args.map(stringifyErrorPart).join(" ");
    capturedConsoleMessages.push(message);
    capturedErrors.push(message);
    originalConsoleError(...args);
  };
  console.warn = (...args: unknown[]) => {
    const message = args.map(stringifyErrorPart).join(" ");
    capturedConsoleMessages.push(message);
    if (suspiciousMessagePattern.test(message)) {
      capturedErrors.push(message);
    }
    originalConsoleWarn(...args);
  };
  window.addEventListener("error", (event) => {
    const message = stringifyErrorPart(event.error ?? event.message ?? event);
    capturedConsoleMessages.push(message);
    capturedErrors.push(message);
  });
  window.addEventListener("unhandledrejection", (event) => {
    const message = stringifyErrorPart(event.reason);
    capturedConsoleMessages.push(message);
    capturedErrors.push(message);
  });
}

function prepareDocument(rootElement: HTMLElement): void {
  document.documentElement.style.width = "1024px";
  document.documentElement.style.height = "768px";
  document.body.style.width = "1024px";
  document.body.style.height = "768px";
  document.body.style.margin = "0";
  rootElement.style.width = "1024px";
  rootElement.style.height = "768px";
}

async function waitForSelector(
  selector: string,
  root: ParentNode,
  timeoutMs = 5_000,
): Promise<HTMLElement> {
  let latest: HTMLElement | null = null;
  await waitUntil(() => {
    latest = root.querySelector<HTMLElement>(selector);
    return latest !== null;
  }, timeoutMs, () => `Timed out waiting for selector ${selector}.`);
  return latest!;
}

async function waitUntil(predicate: () => boolean, timeoutMs: number, errorMessage: () => string): Promise<void> {
  const startedAt = performance.now();
  while (performance.now() - startedAt < timeoutMs) {
    if (predicate()) {
      return;
    }
    await animationFrame();
  }
  throw new Error(errorMessage());
}

function animationFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

function normalizeText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function failedResult(reason: string): TitlebarRuntimeSmokeResult {
  const emptyProbe: TitlebarDomProbe = {
    mounted: false,
    platform: null,
    role: null,
    ariaLabel: null,
    computedHeight: "",
    inlineHeight: "",
    paddingLeft: "",
    appRegion: "",
    appRegionMatched: false,
    triggerAppRegion: "",
    triggerNoDragRegionMatched: false,
    triggerAriaLabel: null,
    triggerShortcut: null,
    triggerText: "",
    shortcutVisible: false,
    styleAttribute: null,
    triggerStyleAttribute: null,
  };

  return {
    ok: false,
    errors: [reason],
    activeTitlebar: emptyProbe,
    fallbackTitlebar: emptyProbe,
    interaction: {
      openWorkspaceCalls: 0,
      unexpectedPaletteCallsFromFallback: 0,
      unexpectedWorkspaceCallsFromPalette: 0,
    },
    palette: {
      openBeforeClick: false,
      openAfterFallbackClick: false,
      openAfterPaletteClick: false,
      inputMountedAfterPaletteClick: false,
      inputPlaceholder: null,
      commandItemTexts: [],
    },
    fullscreen: {
      attempted: false,
      nativeTrafficLightCoordinatesObservable: false,
      limitation: "Smoke failed before fullscreen limitation could be recorded.",
    },
    reason,
  };
}

function stringifyErrorPart(part: unknown): string {
  if (part instanceof Error) {
    return `${part.message}\n${part.stack ?? ""}`;
  }
  if (typeof part === "string") {
    return part;
  }
  try {
    return JSON.stringify(part);
  } catch {
    return String(part);
  }
}

function publishResult(result: TitlebarRuntimeSmokeResult): void {
  window.__nexusTitlebarRuntimeSmokeResult = result;
}
