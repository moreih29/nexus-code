export interface SettingsNavItem {
  id: string;
  label: string;
  parent?: string;
  footer?: boolean;
  keywords?: string[];
  dirty?: boolean;
}

export const PROFILE_KEYWORDS: string[] = [
  "profile",
  "account",
  "login",
  "sign in",
  "CLAUDE_CONFIG_DIR",
  "CODEX_HOME",
  "프로필",
  "계정",
  "로그인",
];
