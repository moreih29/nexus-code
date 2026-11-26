import type { TFunction } from "i18next";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { resources, SUPPORTED_LANGUAGES } from "../../../shared/i18n";
import { useEditorFontStore } from "../../state/stores/editor-font";
import { useIconThemeStore } from "../../state/stores/icon-theme";
import { useInactivePanelDimStore } from "../../state/stores/inactive-panel-dim";
import { useLanguageStore } from "../../state/stores/language";
import { useTerminalStore } from "../../state/stores/terminal";
import { useThemeStore } from "../../state/stores/theme";
import { useWindowOpacityStore } from "../../state/stores/window-opacity";
import { PROFILE_KEYWORDS, type SettingsNavItem } from "./types";

export type DirtyPage = "appearance" | "editor" | "terminal";

type NavKey = keyof (typeof resources)["en"]["settings"]["nav"];

function names(key: NavKey): string[] {
  return SUPPORTED_LANGUAGES.map((lng) => resources[lng].settings.nav[key]);
}

export function navMatches(item: SettingsNavItem, q: string): boolean {
  return (
    item.label.toLowerCase().includes(q) ||
    (item.keywords ?? []).some((k) => k.toLowerCase().includes(q))
  );
}

export function settingsNav(
  t: TFunction<"settings">,
  dirty: Partial<Record<DirtyPage, boolean>> = {},
): SettingsNavItem[] {
  return [
    {
      id: "appearance",
      label: t("nav.appearance"),
      keywords: [
        ...names("appearance"),
        "theme",
        "opacity",
        "language",
        "dim",
        "inactive",
        "panel",
        "icon",
        "window",
        "언어",
        "흐림",
        "테마",
        "불투명도",
        "투명",
        "패널",
        "아이콘",
        "창",
      ],
      dirty: dirty.appearance,
    },
    {
      id: "editor",
      label: t("nav.editor"),
      keywords: [
        ...names("editor"),
        "font",
        "size",
        "family",
        "ligatures",
        "line height",
        "preview",
        "글꼴",
        "크기",
        "합자",
        "줄 간격",
        "미리보기",
      ],
      dirty: dirty.editor,
    },
    {
      id: "language-servers",
      label: t("nav.languageServers"),
      parent: "editor",
      keywords: [
        ...names("languageServers"),
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
      keywords: [
        ...names("terminal"),
        "font",
        "size",
        "cursor",
        "family",
        "ligatures",
        "shell",
        "agent",
        "셸",
        "글꼴",
        "크기",
        "커서",
        "합자",
        "기본 에이전트",
      ],
      dirty: dirty.terminal,
    },
    {
      id: "notifications",
      label: t("nav.notifications"),
      keywords: [
        ...names("notifications"),
        "alert",
        "desktop",
        "os",
        "usage",
        "limit",
        "claude",
        "데스크톱",
        "사용량",
        "한도",
      ],
    },
    {
      id: "notes",
      label: t("nav.notes"),
      keywords: [
        ...names("notes"),
        "storage",
        "disk",
        "recording",
        "summary",
        "summaries",
        "voice",
        "voiceprint",
        "저장 공간",
        "용량",
        "녹음",
        "요약",
        "음성",
        "목소리",
      ],
    },
    {
      id: "browser-permissions",
      label: t("nav.browserPermissions"),
      keywords: [
        ...names("browserPermissions"),
        "browser",
        "permission",
        "camera",
        "microphone",
        "location",
        "clipboard",
        "screen share",
        "브라우저",
        "권한",
        "카메라",
        "마이크",
        "위치",
        "클립보드",
        "화면 공유",
      ],
    },
    {
      id: "keybindings",
      label: t("nav.keybindings"),
      keywords: [
        ...names("keybindings"),
        "keyboard",
        "shortcut",
        "keybinding",
        "hotkey",
        "단축키",
        "키보드",
      ],
    },
    {
      id: "agent",
      label: t("nav.agent"),
      keywords: [
        ...names("agent"),
        "nexus",
        "cli",
        "agent",
        "claude",
        "codex",
        "task",
        "chat",
        "font",
        "usage",
        "limit",
        "에이전트",
        "작업",
        "채팅",
        "글꼴",
        "사용량",
        "한도",
      ],
    },
    {
      id: "cross-workspace",
      label: t("nav.crossWorkspace"),
      parent: "agent",
      keywords: [
        ...names("crossWorkspace"),
        "workspace",
        "permission",
        "approval",
        "ask",
        "워크스페이스",
        "권한",
        "승인",
        "묻기",
      ],
    },
    {
      id: "claude",
      label: t("nav.claude"),
      parent: "agent",
      keywords: [...names("claude"), ...PROFILE_KEYWORDS],
    },
    {
      id: "codex",
      label: t("nav.codex"),
      parent: "agent",
      keywords: [...names("codex"), ...PROFILE_KEYWORDS],
    },
    {
      id: "instructions",
      label: t("nav.instructions"),
      parent: "agent",
      keywords: [
        ...names("instructions"),
        "instructions",
        "prompt",
        "rules",
        "지시",
        "프롬프트",
        "규칙",
      ],
    },
    {
      id: "profile-rules",
      label: t("nav.profileRules"),
      parent: "agent",
      keywords: [
        ...names("profileRules"),
        ...PROFILE_KEYWORDS,
        "workspace",
        "ssh",
        "rule",
        "워크스페이스",
        "규칙",
      ],
    },
    {
      id: "remote",
      label: t("nav.remote"),
      keywords: [
        ...names("remote"),
        "remote",
        "account",
        "google",
        "sign in",
        "device",
        "nexuscode",
        "password",
        "voice",
        "dictation",
        "control",
        "원격",
        "계정",
        "로그인",
        "기기",
        "암호",
        "음성",
        "받아쓰기",
        "조작",
      ],
    },
    {
      id: "about",
      label: t("nav.about"),
      footer: true,
      keywords: [
        ...names("about"),
        "version",
        "update",
        "info",
        "logs",
        "release notes",
        "버전",
        "업데이트",
        "로그",
        "릴리스 노트",
      ],
    },
  ];
}

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

function changed(now: readonly unknown[], opened: readonly unknown[] | undefined): boolean {
  return opened !== undefined && now.some((value, i) => !Object.is(value, opened[i]));
}

export function useSettingsNav(open: boolean): SettingsNavItem[] {
  const { t } = useTranslation("settings");
  const watched = useWatched();
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
