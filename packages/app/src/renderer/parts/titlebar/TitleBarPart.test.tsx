import { describe, expect, test } from "bun:test";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type { NexusPlatform } from "../../../common/platform";
import { TitleBarPart } from "./TitleBarPart";

describe("TitleBarPart", () => {
  test("renders a draggable macOS titlebar with inset traffic-light padding", () => {
    const markup = renderToStaticMarkup(
      <TitleBarPart
        hasWorkspace={true}
        platform="darwin"
        onOpenCommandPalette={() => {}}
        onOpenWorkspace={() => {}}
      />,
    );

    expect(markup).toContain('data-component="titlebar"');
    expect(markup).toContain('role="banner"');
    expect(markup).toContain('aria-label="Application titlebar"');
    expect(markup).toContain('height:36px');
    expect(markup).toContain('padding-left:78px');
    expect(markup).toContain('-webkit-app-region:drag');
    expect(markup).toContain('data-titlebar-command-trigger="true"');
    expect(markup).toContain('aria-label="Open command palette"');
    expect(markup).toContain('aria-keyshortcuts="Meta+P"');
    expect(markup).toContain('-webkit-app-region:no-drag');
    expect(markup).toContain("Search commands");
    expect(markup).toContain("⌘P");
  });

  test("renders a non-macOS titlebar without left padding", () => {
    const markup = renderToStaticMarkup(
      <TitleBarPart
        hasWorkspace={true}
        platform="win32"
        onOpenCommandPalette={() => {}}
        onOpenWorkspace={() => {}}
      />,
    );

    expect(markup).toContain('data-platform="win32"');
    expect(markup).toContain('padding-left:0');
    expect(markup).toContain('-webkit-app-region:drag');
    expect(markup).toContain('-webkit-app-region:no-drag');
  });

  test("uses the palette callback when a workspace is active", () => {
    let paletteCalls = 0;
    let workspaceCalls = 0;
    const trigger = findTitlebarTrigger(
      TitleBarPart({
        hasWorkspace: true,
        platform: "darwin",
        onOpenCommandPalette: () => {
          paletteCalls += 1;
        },
        onOpenWorkspace: () => {
          workspaceCalls += 1;
        },
      }),
    );

    trigger.props.onClick?.();

    expect(paletteCalls).toBe(1);
    expect(workspaceCalls).toBe(0);
  });

  test("falls back to opening a workspace when no workspace is active", () => {
    let paletteCalls = 0;
    let workspaceCalls = 0;
    const markup = renderToStaticMarkup(
      <TitleBarPart
        hasWorkspace={false}
        platform="win32"
        onOpenCommandPalette={() => {
          paletteCalls += 1;
        }}
        onOpenWorkspace={() => {
          workspaceCalls += 1;
        }}
      />,
    );
    const trigger = findTitlebarTrigger(
      TitleBarPart({
        hasWorkspace: false,
        platform: "win32",
        onOpenCommandPalette: () => {
          paletteCalls += 1;
        },
        onOpenWorkspace: () => {
          workspaceCalls += 1;
        },
      }),
    );

    trigger.props.onClick?.();

    expect(markup).toContain("Open workspace…");
    expect(markup).not.toContain("Search commands");
    expect(markup).not.toContain("⌘P");
    expect(paletteCalls).toBe(0);
    expect(workspaceCalls).toBe(1);
  });

  test("covers darwin and Windows workspace-present and no-workspace fallback states", () => {
    const scenarios: Array<{
      platform: NexusPlatform;
      hasWorkspace: boolean;
      expectedLabel: string;
      expectedPadding: string;
      expectedPaletteCalls: number;
      expectedWorkspaceCalls: number;
      expectedShortcutVisible: boolean;
    }> = [
      {
        platform: "darwin",
        hasWorkspace: true,
        expectedLabel: "Search commands",
        expectedPadding: "padding-left:78px",
        expectedPaletteCalls: 1,
        expectedWorkspaceCalls: 0,
        expectedShortcutVisible: true,
      },
      {
        platform: "darwin",
        hasWorkspace: false,
        expectedLabel: "Open workspace…",
        expectedPadding: "padding-left:78px",
        expectedPaletteCalls: 0,
        expectedWorkspaceCalls: 1,
        expectedShortcutVisible: false,
      },
      {
        platform: "win32",
        hasWorkspace: true,
        expectedLabel: "Search commands",
        expectedPadding: "padding-left:0",
        expectedPaletteCalls: 1,
        expectedWorkspaceCalls: 0,
        expectedShortcutVisible: true,
      },
      {
        platform: "win32",
        hasWorkspace: false,
        expectedLabel: "Open workspace…",
        expectedPadding: "padding-left:0",
        expectedPaletteCalls: 0,
        expectedWorkspaceCalls: 1,
        expectedShortcutVisible: false,
      },
    ];

    for (const scenario of scenarios) {
      let paletteCalls = 0;
      let workspaceCalls = 0;
      const callbacks = {
        onOpenCommandPalette: () => {
          paletteCalls += 1;
        },
        onOpenWorkspace: () => {
          workspaceCalls += 1;
        },
      };

      const markup = renderToStaticMarkup(
        <TitleBarPart
          hasWorkspace={scenario.hasWorkspace}
          platform={scenario.platform}
          {...callbacks}
        />,
      );
      const trigger = findTitlebarTrigger(
        TitleBarPart({
          hasWorkspace: scenario.hasWorkspace,
          platform: scenario.platform,
          ...callbacks,
        }),
      );

      trigger.props.onClick?.();

      expect(markup).toContain(`data-platform="${scenario.platform}"`);
      expect(markup).toContain(scenario.expectedPadding);
      expect(markup).toContain(scenario.expectedLabel);
      expect(markup.includes("⌘P")).toBe(scenario.expectedShortcutVisible);
      expect(paletteCalls).toBe(scenario.expectedPaletteCalls);
      expect(workspaceCalls).toBe(scenario.expectedWorkspaceCalls);
    }
  });
});

type TriggerElement = ReactElement<{
  children?: ReactNode;
  onClick?: () => void;
  "data-titlebar-command-trigger"?: string;
}>;

function findTitlebarTrigger(node: ReactNode): TriggerElement {
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findTitlebarTriggerOrNull(child);
      if (found) {
        return found;
      }
    }
  }

  const found = findTitlebarTriggerOrNull(node);
  if (!found) {
    throw new Error("Titlebar command trigger was not found.");
  }

  return found;
}

function findTitlebarTriggerOrNull(node: ReactNode): TriggerElement | null {
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findTitlebarTriggerOrNull(child);
      if (found) {
        return found;
      }
    }
    return null;
  }

  if (!isValidElement(node)) {
    return null;
  }

  const element = node as TriggerElement;
  if (element.props["data-titlebar-command-trigger"] === "true") {
    return element;
  }

  return findTitlebarTriggerOrNull(element.props.children);
}
