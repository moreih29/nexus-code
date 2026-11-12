// The settings dialog's pages, in the order its list shows them, and the
// words its search box finds each by beyond its name. One list, read by the
// dialog itself, so a page added here is the one it lists and searches.
//
// A page's dot tells that one of its values changed while the dialog was
// open: settings are stored as they change, so on closing the new values
// are the ones the next opening compares with.

import type { TFunction } from "i18next";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useEditorFontStore } from "../../state/stores/editor-font";
import { useIconThemeStore } from "../../state/stores/icon-theme";
import { useInactivePanelDimStore } from "../../state/stores/inactive-panel-dim";
import { useLanguageStore } from "../../state/stores/language";
import { useTerminalStore } from "../../state/stores/terminal";
import { useThemeStore } from "../../state/stores/theme";
import { useWindowOpacityStore } from "../../state/stores/window-opacity";
import { PROFILE_KEYWORDS, type SettingsNavItem } from "./types";

/** The pages that show a dot when one of their values changed. */
export type DirtyPage = "appearance" | "editor" | "terminal";

/** Every page of the dialog, `dirty` telling which show the dot. */
export function settingsNav(
  t: TFunction<"settings">,
  dirty: Partial<Record<DirtyPage, boolean>> = {},
): SettingsNavItem[] {
  return [
    {
      id: "appearance",
      label: t("nav.appearance"),
      keywords: ["theme", "opacity", "language", "dim", "inactive", "panel", "언어", "흐림"],
      dirty: dirty.appearance,
    },
    {
      id: "editor",
      label: t("nav.editor"),
      keywords: ["font", "size", "family", "ligatures", "line height"],
      dirty: dirty.editor,
    },
    {
      id: "language-servers",
      label: t("nav.languageServers"),
      parent: "editor",
      keywords: [
        "lsp",
        "language server",
        "completion",
        "diagnostics",
        "typescript",
        "python",
        "go",
        "rust",
        "yaml",
        "bash",
        "dockerfile",
        "자동 완성",
        "진단",
      ],
    },
    {
      id: "terminal",
      label: t("nav.terminal"),
      keywords: ["font", "size", "cursor", "family", "ligatures", "shell", "셸"],
      dirty: dirty.terminal,
    },
    {
      id: "notifications",
      label: t("nav.notifications"),
      keywords: ["alert", "desktop", "os", "notification", "claude"],
    },
    {
      id: "browser-permissions",
      label: t("nav.browserPermissions"),
      keywords: ["browser", "permission", "camera", "microphone", "location", "clipboard"],
    },
    {
      id: "keybindings",
      label: t("nav.keybindings"),
      keywords: ["keyboard", "shortcut", "keybinding", "hotkey", "단축키", "키보드"],
    },
    {
      id: "agent",
      label: t("nav.agent"),
      keywords: [
        "nexus",
        "cli",
        "agent",
        "claude",
        "codex",
        "task",
        "chat",
        "font",
        "에이전트",
        "작업",
        "채팅",
        "글꼴",
      ],
    },
    { id: "claude", label: t("nav.claude"), parent: "agent", keywords: PROFILE_KEYWORDS },
    { id: "codex", label: t("nav.codex"), parent: "agent", keywords: PROFILE_KEYWORDS },
    {
      id: "profile-rules",
      label: t("nav.profileRules"),
      parent: "agent",
      keywords: [...PROFILE_KEYWORDS, "workspace", "ssh", "rule", "워크스페이스", "규칙"],
    },
    {
      id: "manager",
      label: t("nav.manager"),
      parent: "agent",
      keywords: ["manager", "agent", "report", "permission", "매니저", "보고", "권한"],
    },
    {
      id: "about",
      label: t("nav.about"),
      footer: true,
      keywords: ["version", "update", "info"],
    },
  ];
}

/** The values a page's dot watches, by page. */
function useWatched(): Record<DirtyPage, readonly unknown[]> {
  return {
    appearance: [
      useIconThemeStore((s) => s.preference),
      useThemeStore((s) => s.preference),
      useWindowOpacityStore((s) => s.opacity),
      useInactivePanelDimStore((s) => s.dim),
      useLanguageStore((s) => s.preference),
    ],
    editor: [
      useEditorFontStore((s) => s.size),
      useEditorFontStore((s) => s.family),
      useEditorFontStore((s) => s.ligatures),
      useEditorFontStore((s) => s.lineHeight),
    ],
    terminal: [
      useTerminalStore((s) => s.fontSize),
      useTerminalStore((s) => s.cursorStyle),
      useTerminalStore((s) => s.fontFamily),
      useTerminalStore((s) => s.fontLigatures),
      useTerminalStore((s) => s.shell),
    ],
  };
}

/** Whether any of the values differs from the ones the dialog opened with. */
function changed(now: readonly unknown[], opened: readonly unknown[] | undefined): boolean {
  return opened !== undefined && now.some((value, i) => !Object.is(value, opened[i]));
}

/** The dialog's pages while it is `open`, each page's dot against the values it opened with. */
export function useSettingsNav(open: boolean): SettingsNavItem[] {
  const { t } = useTranslation("settings");
  const watched = useWatched();
  // Taken as the dialog opens, dropped as it closes: the next opening starts clean.
  const [opened, setOpened] = useState<Record<DirtyPage, readonly unknown[]> | null>(null);
  const [wasOpen, setWasOpen] = useState(false);
  if (open !== wasOpen) {
    setWasOpen(open);
    setOpened(open ? watched : null);
  }
  const appearance = changed(watched.appearance, opened?.appearance);
  const editor = changed(watched.editor, opened?.editor);
  const terminal = changed(watched.terminal, opened?.terminal);
  return useMemo(
    () => settingsNav(t, { appearance, editor, terminal }),
    [t, appearance, editor, terminal],
  );
}
