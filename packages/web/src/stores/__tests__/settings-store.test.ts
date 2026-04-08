import { describe, it, expect, beforeEach, vi } from 'vitest'
import { useSettingsStore, getEffectiveSettings, normalizeModelId } from '../settings-store'

// Mock apiClient before any import of settings-store side-effects
vi.mock('@/api/client', () => ({
  apiClient: {
    get: vi.fn(),
    put: vi.fn(),
  },
}))

import { apiClient } from '@/api/client'

const mockGet = apiClient.get as ReturnType<typeof vi.fn>
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

beforeEach(() => {
  resetStore()
  vi.clearAllMocks()
})

// ---------------------------------------------------------------------------
// useEffectiveModel selector
// ---------------------------------------------------------------------------

describe('useEffectiveModel selector', () => {
  it('returns globalSettings.model when no project override', () => {
    useSettingsStore.setState({ globalSettings: { model: 'opus' }, projectSettings: {} })
    const { globalSettings, projectSettings } = useSettingsStore.getState()
    const effective = normalizeModelId({ ...globalSettings, ...projectSettings }.model)
    expect(effective).toBe('opus')
  })

  it('project model overrides global model', () => {
    useSettingsStore.setState({
      globalSettings: { model: 'opus' },
      projectSettings: { model: 'haiku' },
    })
    const { globalSettings, projectSettings } = useSettingsStore.getState()
    const effective = normalizeModelId({ ...globalSettings, ...projectSettings }.model)
    expect(effective).toBe('haiku')
  })

  it('defaults to sonnet when model is undefined', () => {
    useSettingsStore.setState({ globalSettings: {}, projectSettings: {} })
    const { globalSettings, projectSettings } = useSettingsStore.getState()
    const effective = normalizeModelId({ ...globalSettings, ...projectSettings }.model)
    expect(effective).toBe('sonnet')
  })

  it('normalizes legacy full model name to alias', () => {
    expect(normalizeModelId('claude-opus-4-6')).toBe('opus')
    expect(normalizeModelId('claude-sonnet-4-5')).toBe('sonnet')
    expect(normalizeModelId('claude-haiku-4-5')).toBe('haiku')
  })
})

// ---------------------------------------------------------------------------
// useEffectivePermissionMode selector
// ---------------------------------------------------------------------------

describe('useEffectivePermissionMode selector', () => {
  it('returns default when no permissionMode set', () => {
    useSettingsStore.setState({ globalSettings: {}, projectSettings: {} })
    const { globalSettings, projectSettings } = useSettingsStore.getState()
    const mode = ({ ...globalSettings, ...projectSettings }.permissionMode ?? 'default')
    expect(mode).toBe('default')
  })

  it('returns global permissionMode when no project override', () => {
    useSettingsStore.setState({ globalSettings: { permissionMode: 'auto' }, projectSettings: {} })
    const { globalSettings, projectSettings } = useSettingsStore.getState()
    const mode = ({ ...globalSettings, ...projectSettings }.permissionMode ?? 'default')
    expect(mode).toBe('auto')
  })

  it('project permissionMode overrides global', () => {
    useSettingsStore.setState({
      globalSettings: { permissionMode: 'auto' },
      projectSettings: { permissionMode: 'bypassPermissions' },
    })
    const { globalSettings, projectSettings } = useSettingsStore.getState()
    const mode = ({ ...globalSettings, ...projectSettings }.permissionMode ?? 'default')
    expect(mode).toBe('bypassPermissions')
  })
})

// ---------------------------------------------------------------------------
// quickSave — optimistic update
// ---------------------------------------------------------------------------

describe('quickSave optimistic update', () => {
  it('updates globalSettings immediately before API completes', async () => {
    useSettingsStore.setState({ globalSettings: { model: 'sonnet' } })

    // Delay the PUT so we can inspect state during the in-flight period
    let resolvePut!: (v: unknown) => void
    mockPut.mockReturnValue(new Promise((res) => { resolvePut = res }))

    const savePromise = useSettingsStore.getState().quickSave({ model: 'opus' }, null)

    // Optimistic update should be visible before PUT resolves
    expect(useSettingsStore.getState().globalSettings.model).toBe('opus')

    resolvePut({ model: 'opus' })
    await savePromise

    expect(useSettingsStore.getState().globalSettings.model).toBe('opus')
  })

  it('updates projectSettings optimistically when workspacePath provided', async () => {
    useSettingsStore.setState({ projectSettings: { model: 'sonnet' } })
    mockPut.mockResolvedValue({ model: 'haiku' })

    await useSettingsStore.getState().quickSave({ model: 'haiku' }, '/my/project')

    expect(useSettingsStore.getState().projectSettings.model).toBe('haiku')
  })
})

// ---------------------------------------------------------------------------
// quickSave — rollback on failure
// ---------------------------------------------------------------------------

describe('quickSave rollback on failure', () => {
  it('restores globalSettings to previous value when PUT fails', async () => {
    useSettingsStore.setState({ globalSettings: { model: 'sonnet' } })
    mockPut.mockRejectedValue(new Error('network error'))

    await useSettingsStore.getState().quickSave({ model: 'opus' }, null)

    expect(useSettingsStore.getState().globalSettings.model).toBe('sonnet')
  })

  it('restores projectSettings to previous value when PUT fails', async () => {
    useSettingsStore.setState({ projectSettings: { model: 'haiku' } })
    mockPut.mockRejectedValue(new Error('network error'))

    await useSettingsStore.getState().quickSave({ model: 'opus' }, '/my/project')

    expect(useSettingsStore.getState().projectSettings.model).toBe('haiku')
  })
})

// ---------------------------------------------------------------------------
// quickSave — _pendingSaveKeys lifecycle
// ---------------------------------------------------------------------------

describe('quickSave clears pending keys on success', () => {
  it('removes keys from _pendingSaveKeys after successful PUT', async () => {
    mockPut.mockResolvedValue({ model: 'opus' })

    await useSettingsStore.getState().quickSave({ model: 'opus' }, null)

    expect(useSettingsStore.getState()._pendingSaveKeys.has('model')).toBe(false)
    expect(useSettingsStore.getState()._pendingSaveKeys.size).toBe(0)
  })

  it('removes keys from _pendingSaveKeys even after failed PUT', async () => {
    mockPut.mockRejectedValue(new Error('server error'))

    await useSettingsStore.getState().quickSave({ model: 'haiku' }, null)

    expect(useSettingsStore.getState()._pendingSaveKeys.has('model')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// loadSettings — pending keys protection
// ---------------------------------------------------------------------------

describe('loadSettings preserves pending keys', () => {
  it('keeps in-flight key values over server response when _pendingSaveKeys is populated', async () => {
    // Simulate: user changed model to 'opus' via quickSave (in-flight),
    // but server returns stale 'sonnet'
    useSettingsStore.setState({
      globalSettings: { model: 'opus' },
      _pendingSaveKeys: new Set(['model']),
    })

    mockGet.mockResolvedValue({ model: 'sonnet' })

    await useSettingsStore.getState().loadSettings(null)

    // The in-flight value 'opus' should survive the load
    expect(useSettingsStore.getState().globalSettings.model).toBe('opus')
  })

  it('applies server values for keys not in _pendingSaveKeys', async () => {
    useSettingsStore.setState({
      globalSettings: { model: 'opus', theme: 'github-dark' },
      _pendingSaveKeys: new Set(['model']),
    })

    mockGet.mockResolvedValue({ model: 'sonnet', theme: 'nord-aurora' })

    await useSettingsStore.getState().loadSettings(null)

    // model is pending — kept from current store
    expect(useSettingsStore.getState().globalSettings.model).toBe('opus')
    // theme is not pending — server value wins
    expect(useSettingsStore.getState().globalSettings.theme).toBe('nord-aurora')
  })
})

// ---------------------------------------------------------------------------
// getEffectiveSettings
// ---------------------------------------------------------------------------

describe('getEffectiveSettings', () => {
  it('returns global settings when no project settings', () => {
    useSettingsStore.setState({
      globalSettings: { model: 'sonnet', theme: 'github-dark' },
      projectSettings: {},
    })
    const effective = getEffectiveSettings()
    expect(effective.model).toBe('sonnet')
    expect(effective.theme).toBe('github-dark')
  })

  it('project settings override global settings', () => {
    useSettingsStore.setState({
      globalSettings: { model: 'sonnet', permissionMode: 'default' },
      projectSettings: { model: 'opus' },
    })
    const effective = getEffectiveSettings()
    expect(effective.model).toBe('opus')
    expect(effective.permissionMode).toBe('default')
  })

  it('returns empty object when both settings are empty', () => {
    useSettingsStore.setState({ globalSettings: {}, projectSettings: {} })
    const effective = getEffectiveSettings()
    expect(Object.keys(effective)).toHaveLength(0)
  })
})
