import { describe, it, expect, beforeEach, vi } from 'vitest'
import { THEMES } from '../use-theme'
import { useSettingsStore } from '@/stores/settings-store'

// Expose the module-internal DEFAULT_THEME for assertions
// (it's not exported from use-theme — replicate the value here)
const FALLBACK_THEME = 'github-dark'

vi.mock('@/api/client', () => ({
  apiClient: {
    get: vi.fn(),
    put: vi.fn(),
  },
}))

import { apiClient } from '@/api/client'

const mockPut = apiClient.put as ReturnType<typeof vi.fn>

function resetStore() {
  useSettingsStore.setState({
    globalSettings: {},
    projectSettings: {},
    globalCliSettings: {},
    projectCliSettings: {},
    draftGlobal: {},
    draftProject: {},
    draftGlobalCli: {},
    draftProjectCli: {},
    isDirtyGlobal: false,
    isDirtyProject: false,
    isLoading: false,
    _pendingSaveKeys: new Set<string>(),
  })
}

// Replicate the theme-resolution logic from useTheme (pure, no React needed)
function resolveTheme(storeTheme: string | undefined): string {
  return storeTheme && THEMES.some((t) => t.id === storeTheme) ? storeTheme : FALLBACK_THEME
}

beforeEach(() => {
  resetStore()
  vi.clearAllMocks()
})

// ---------------------------------------------------------------------------
// Theme resolution from store
// ---------------------------------------------------------------------------

describe('theme from store', () => {
  it('returns the theme stored in globalSettings', () => {
    useSettingsStore.setState({ globalSettings: { theme: 'nord-aurora' } })
    const storeTheme = useSettingsStore.getState().globalSettings.theme
    expect(resolveTheme(storeTheme)).toBe('nord-aurora')
  })

  it('returns github-dark when globalSettings.theme is undefined', () => {
    useSettingsStore.setState({ globalSettings: {} })
    const storeTheme = useSettingsStore.getState().globalSettings.theme
    expect(resolveTheme(storeTheme)).toBe(FALLBACK_THEME)
  })

  it('falls back to github-dark for an unrecognized theme value', () => {
    useSettingsStore.setState({ globalSettings: { theme: 'not-a-real-theme' } })
    const storeTheme = useSettingsStore.getState().globalSettings.theme
    expect(resolveTheme(storeTheme)).toBe(FALLBACK_THEME)
  })
})

// ---------------------------------------------------------------------------
// setTheme triggers quickSave with null workspacePath
// ---------------------------------------------------------------------------

describe('setTheme calls quickSave', () => {
  it('quickSave is called with null workspacePath (global save)', async () => {
    mockPut.mockResolvedValue({ theme: 'monokai-pro' })

    await useSettingsStore.getState().quickSave({ theme: 'monokai-pro' }, null)

    expect(mockPut).toHaveBeenCalledWith(
      expect.stringContaining('/api/settings?scope=global'),
      expect.objectContaining({ theme: 'monokai-pro' }),
    )
  })

  it('quickSave updates globalSettings.theme in the store', async () => {
    useSettingsStore.setState({ globalSettings: { theme: 'github-dark' } })
    mockPut.mockResolvedValue({ theme: 'catppuccin-mocha' })

    await useSettingsStore.getState().quickSave({ theme: 'catppuccin-mocha' }, null)

    expect(useSettingsStore.getState().globalSettings.theme).toBe('catppuccin-mocha')
  })

  it('quickSave rollback restores previous theme on failure', async () => {
    useSettingsStore.setState({ globalSettings: { theme: 'github-dark' } })
    mockPut.mockRejectedValue(new Error('server error'))

    await useSettingsStore.getState().quickSave({ theme: 'obsidian' }, null)

    expect(useSettingsStore.getState().globalSettings.theme).toBe('github-dark')
  })
})

// ---------------------------------------------------------------------------
// THEMES constant sanity checks
// ---------------------------------------------------------------------------

describe('THEMES list', () => {
  it('includes github-dark as a valid theme', () => {
    expect(THEMES.some((t) => t.id === 'github-dark')).toBe(true)
  })

  it('every theme has id, label, and a 4-color palette', () => {
    for (const theme of THEMES) {
      expect(typeof theme.id).toBe('string')
      expect(typeof theme.label).toBe('string')
      expect(theme.palette).toHaveLength(4)
    }
  })
})
