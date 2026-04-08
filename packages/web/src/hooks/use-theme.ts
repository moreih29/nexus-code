import { useEffect } from 'react'
import { useSettingsStore } from '@/stores/settings-store'

export type Theme =
  | 'github-dark'
  | 'midnight-blue'
  | 'monokai-pro'
  | 'nord-aurora'
  | 'catppuccin-mocha'
  | 'obsidian'
  | 'claude'
  | 'gpt'

export const THEMES: { id: Theme; label: string; palette: [string, string, string, string] }[] = [
  { id: 'github-dark', label: 'GitHub Dark', palette: ['#0d1117', '#1c2128', '#58a6ff', '#3fb950'] },
  { id: 'midnight-blue', label: 'Midnight Blue', palette: ['#0f0f1a', '#1a1b26', '#7aa2f7', '#9ece6a'] },
  { id: 'monokai-pro', label: 'Monokai Pro', palette: ['#19181a', '#2d2a2e', '#ffd866', '#ff6188'] },
  { id: 'nord-aurora', label: 'Nord Aurora', palette: ['#2e3440', '#434c5e', '#88c0d0', '#a3be8c'] },
  { id: 'catppuccin-mocha', label: 'Catppuccin Mocha', palette: ['#1e1e2e', '#313244', '#89b4fa', '#a6e3a1'] },
  { id: 'obsidian', label: 'Obsidian', palette: ['#080808', '#1a1a1a', '#e2b714', '#5ac85a'] },
  { id: 'claude', label: 'Claude', palette: ['#1a1410', '#2c2620', '#d4a27f', '#8fba7f'] },
  { id: 'gpt', label: 'GPT', palette: ['#0d0d0d', '#212121', '#10a37f', '#f5c542'] },
]

const DEFAULT_THEME: Theme = 'github-dark'

export function applyTheme(theme: Theme) {
  document.documentElement.setAttribute('data-theme', theme)
}

export function useTheme() {
  const storeTheme = useSettingsStore((s) => s.globalSettings.theme)
  const quickSave = useSettingsStore((s) => s.quickSave)

  const theme: Theme =
    storeTheme && THEMES.some((t) => t.id === storeTheme)
      ? (storeTheme as Theme)
      : DEFAULT_THEME

  // Apply theme to DOM whenever it changes in the store
  useEffect(() => {
    applyTheme(theme)
  }, [theme])

  function setTheme(next: Theme) {
    applyTheme(next)
    void quickSave({ theme: next }, null)
  }

  return { theme, setTheme, themes: THEMES }
}
