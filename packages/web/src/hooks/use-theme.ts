import { useEffect, useState } from 'react'

export type Theme =
  | 'github-dark'
  | 'midnight-blue'
  | 'monokai-pro'
  | 'nord-aurora'
  | 'catppuccin-mocha'
  | 'obsidian'
  | 'claude'
  | 'gpt'

export const THEMES: { id: Theme; label: string }[] = [
  { id: 'github-dark', label: 'GitHub Dark' },
  { id: 'midnight-blue', label: 'Midnight Blue' },
  { id: 'monokai-pro', label: 'Monokai Pro' },
  { id: 'nord-aurora', label: 'Nord Aurora' },
  { id: 'catppuccin-mocha', label: 'Catppuccin Mocha' },
  { id: 'obsidian', label: 'Obsidian' },
  { id: 'claude', label: 'Claude' },
  { id: 'gpt', label: 'GPT' },
]

const STORAGE_KEY = 'nexus-theme'
const DEFAULT_THEME: Theme = 'github-dark'

function getStoredTheme(): Theme {
  try {
    const stored = localStorage.getItem(STORAGE_KEY)
    if (stored && THEMES.some((t) => t.id === stored)) {
      return stored as Theme
    }
  } catch {
    // ignore
  }
  return DEFAULT_THEME
}

function applyTheme(theme: Theme) {
  document.documentElement.setAttribute('data-theme', theme)
}

export function useTheme() {
  const [theme, setThemeState] = useState<Theme>(getStoredTheme)

  useEffect(() => {
    applyTheme(theme)
  }, [theme])

  function setTheme(next: Theme) {
    setThemeState(next)
    try {
      localStorage.setItem(STORAGE_KEY, next)
    } catch {
      // ignore
    }
    applyTheme(next)
  }

  return { theme, setTheme, themes: THEMES }
}
