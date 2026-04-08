import { describe, it, expect, beforeEach, vi } from 'vitest'
import { useSettingsStore } from '../settings-store'

vi.mock('@/api/client', () => ({
  apiClient: {
    get: vi.fn(),
    put: vi.fn(),
    post: vi.fn(),
    delete: vi.fn(),
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
    scope: 'global',
    _pendingSaveKeys: new Set<string>(),
  })
}

beforeEach(() => {
  resetStore()
  vi.clearAllMocks()
})

// ---------------------------------------------------------------------------
// loadSettings
// ---------------------------------------------------------------------------

describe('loadSettings', () => {
  it('skips project settings when workspacePath is null — API called 2 times', async () => {
    mockGet.mockResolvedValue({})

    await useSettingsStore.getState().loadSettings(null)

    expect(mockGet).toHaveBeenCalledTimes(2)
    expect(mockGet).toHaveBeenCalledWith('/api/settings?scope=global')
    expect(mockGet).toHaveBeenCalledWith('/api/cli-settings?scope=global')
  })

  it('calls API 4 times when workspacePath is provided (global 2 + project 2)', async () => {
    mockGet.mockResolvedValue({})

    await useSettingsStore.getState().loadSettings('/my/project')

    expect(mockGet).toHaveBeenCalledTimes(4)
    expect(mockGet).toHaveBeenCalledWith('/api/settings?scope=global')
    expect(mockGet).toHaveBeenCalledWith('/api/cli-settings?scope=global')
    const encoded = encodeURIComponent('/my/project')
    expect(mockGet).toHaveBeenCalledWith(`/api/settings?scope=project&workspace=${encoded}`)
    expect(mockGet).toHaveBeenCalledWith(`/api/cli-settings?scope=project&workspace=${encoded}`)
  })

  it('sets isLoading false and preserves existing state on API failure', async () => {
    useSettingsStore.setState({ globalSettings: { model: 'opus' } })
    mockGet.mockRejectedValue(new Error('network error'))

    await useSettingsStore.getState().loadSettings(null)

    const state = useSettingsStore.getState()
    expect(state.isLoading).toBe(false)
    expect(state.globalSettings.model).toBe('opus')
  })

  it('loads CLI settings (globalCliSettings, projectCliSettings) correctly', async () => {
    const globalCli = { language: 'en', alwaysThinkingEnabled: true }
    const projectCli = { permissions: { allow: ['Bash'], deny: [] } }

    mockGet.mockImplementation((url: string) => {
      if (url === '/api/settings?scope=global') return Promise.resolve({ model: 'sonnet' })
      if (url === '/api/cli-settings?scope=global') return Promise.resolve(globalCli)
      const encoded = encodeURIComponent('/ws')
      if (url === `/api/settings?scope=project&workspace=${encoded}`) return Promise.resolve({})
      if (url === `/api/cli-settings?scope=project&workspace=${encoded}`) return Promise.resolve(projectCli)
      return Promise.resolve({})
    })

    await useSettingsStore.getState().loadSettings('/ws')

    const state = useSettingsStore.getState()
    expect(state.globalCliSettings).toEqual(globalCli)
    expect(state.projectCliSettings).toEqual(projectCli)
    expect(state.draftGlobalCli).toEqual(globalCli)
    expect(state.draftProjectCli).toEqual(projectCli)
  })
})

// ---------------------------------------------------------------------------
// updateDraft
// ---------------------------------------------------------------------------

describe('updateDraft', () => {
  it('global scope — updates draftGlobal and sets isDirtyGlobal true', () => {
    useSettingsStore.getState().updateDraft('global', { model: 'opus', theme: 'nord' })

    const state = useSettingsStore.getState()
    expect(state.draftGlobal.model).toBe('opus')
    expect(state.draftGlobal.theme).toBe('nord')
    expect(state.isDirtyGlobal).toBe(true)
    expect(state.isDirtyProject).toBe(false)
  })

  it('project scope — updates draftProject and sets isDirtyProject true', () => {
    useSettingsStore.getState().updateDraft('project', { maxTurns: 5 })

    const state = useSettingsStore.getState()
    expect(state.draftProject.maxTurns).toBe(5)
    expect(state.isDirtyProject).toBe(true)
    expect(state.isDirtyGlobal).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// updateDraftCli
// ---------------------------------------------------------------------------

describe('updateDraftCli', () => {
  it('global scope — updates draftGlobalCli and sets isDirtyGlobal true', () => {
    useSettingsStore.getState().updateDraftCli('global', { language: 'ko' })

    const state = useSettingsStore.getState()
    expect(state.draftGlobalCli.language).toBe('ko')
    expect(state.isDirtyGlobal).toBe(true)
  })

  it('project scope — updates draftProjectCli and sets isDirtyProject true', () => {
    useSettingsStore.getState().updateDraftCli('project', { alwaysThinkingEnabled: false })

    const state = useSettingsStore.getState()
    expect(state.draftProjectCli.alwaysThinkingEnabled).toBe(false)
    expect(state.isDirtyProject).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// resetProjectKey
// ---------------------------------------------------------------------------

describe('resetProjectKey', () => {
  it('removes key from draftProject and sets isDirtyProject true', () => {
    useSettingsStore.setState({ draftProject: { model: 'opus', maxTurns: 10 } })

    useSettingsStore.getState().resetProjectKey('model')

    const state = useSettingsStore.getState()
    expect('model' in state.draftProject).toBe(false)
    expect(state.draftProject.maxTurns).toBe(10)
    expect(state.isDirtyProject).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// saveSettings
// ---------------------------------------------------------------------------

describe('saveSettings', () => {
  it('calls API when scope is global and isDirtyGlobal is true', async () => {
    useSettingsStore.setState({
      scope: 'global',
      isDirtyGlobal: true,
      draftGlobal: { model: 'opus' },
      draftGlobalCli: { language: 'en' },
    })
    mockPut.mockResolvedValue({})

    await useSettingsStore.getState().saveSettings(null)

    expect(mockPut).toHaveBeenCalledWith('/api/settings?scope=global', { model: 'opus' })
    expect(mockPut).toHaveBeenCalledWith('/api/cli-settings?scope=global', { language: 'en' })
    expect(useSettingsStore.getState().isDirtyGlobal).toBe(false)
  })

  it('calls API when scope is project, isDirtyProject is true, and workspacePath provided', async () => {
    useSettingsStore.setState({
      scope: 'project',
      isDirtyProject: true,
      draftProject: { maxTurns: 3 },
      draftProjectCli: { alwaysThinkingEnabled: true },
    })
    mockPut.mockResolvedValue({})

    await useSettingsStore.getState().saveSettings('/my/ws')

    const encoded = encodeURIComponent('/my/ws')
    expect(mockPut).toHaveBeenCalledWith(`/api/settings?scope=project&workspace=${encoded}`, { maxTurns: 3 })
    expect(mockPut).toHaveBeenCalledWith(`/api/cli-settings?scope=project&workspace=${encoded}`, { alwaysThinkingEnabled: true })
    expect(useSettingsStore.getState().isDirtyProject).toBe(false)
  })

  it('does not call API when not dirty', async () => {
    useSettingsStore.setState({ scope: 'global', isDirtyGlobal: false })

    await useSettingsStore.getState().saveSettings(null)

    expect(mockPut).not.toHaveBeenCalled()
  })

  it('does not call API when scope is project but workspacePath is null', async () => {
    useSettingsStore.setState({ scope: 'project', isDirtyProject: true })

    await useSettingsStore.getState().saveSettings(null)

    expect(mockPut).not.toHaveBeenCalled()
  })

  it('rethrows error when API fails', async () => {
    useSettingsStore.setState({ scope: 'global', isDirtyGlobal: true, draftGlobal: {}, draftGlobalCli: {} })
    mockPut.mockRejectedValue(new Error('server error'))

    await expect(useSettingsStore.getState().saveSettings(null)).rejects.toThrow('server error')
  })
})

// ---------------------------------------------------------------------------
// quickSave — server confirmed merge
// ---------------------------------------------------------------------------

describe('quickSave server confirmation', () => {
  it('confirms state with server merged response', async () => {
    useSettingsStore.setState({ globalSettings: { model: 'sonnet', theme: 'dark' } })
    // Server returns full merged settings
    mockPut.mockResolvedValue({ model: 'opus', theme: 'dark', maxTurns: 10 })

    await useSettingsStore.getState().quickSave({ model: 'opus' }, null)

    const state = useSettingsStore.getState()
    // globalSettings should reflect server authoritative response
    expect(state.globalSettings).toEqual({ model: 'opus', theme: 'dark', maxTurns: 10 })
    expect(state.draftGlobal.model).toBe('opus')
    expect(state.draftGlobal.maxTurns).toBe(10)
  })
})

// ---------------------------------------------------------------------------
// quickSave — concurrent calls accumulate _pendingSaveKeys
// ---------------------------------------------------------------------------

describe('quickSave concurrent _pendingSaveKeys accumulation', () => {
  it('accumulates keys from simultaneous quickSave calls', async () => {
    let resolveFirst!: (v: unknown) => void
    let resolveSecond!: (v: unknown) => void

    mockPut
      .mockReturnValueOnce(new Promise((res) => { resolveFirst = res }))
      .mockReturnValueOnce(new Promise((res) => { resolveSecond = res }))

    const p1 = useSettingsStore.getState().quickSave({ model: 'opus' }, null)
    const p2 = useSettingsStore.getState().quickSave({ theme: 'nord' }, null)

    // Both keys should be pending before either resolves
    const pending = useSettingsStore.getState()._pendingSaveKeys
    expect(pending.has('model')).toBe(true)
    expect(pending.has('theme')).toBe(true)

    resolveFirst({ model: 'opus' })
    resolveSecond({ theme: 'nord' })
    await Promise.all([p1, p2])

    // After both settle, keys should be removed
    expect(useSettingsStore.getState()._pendingSaveKeys.size).toBe(0)
  })
})
