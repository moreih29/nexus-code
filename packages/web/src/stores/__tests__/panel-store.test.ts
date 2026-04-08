import { describe, it, expect, beforeEach } from 'vitest'
import { usePanelStore } from '../panel-store'

function resetStore() {
  usePanelStore.setState({
    rightTab: 'files',
    rightView: 'files',
    subagentPanelCollapsed: false,
    subagentPanelHidden: false,
    openFilePath: null,
  })
}

beforeEach(() => {
  resetStore()
})

// ---------------------------------------------------------------------------
// Initial state
// ---------------------------------------------------------------------------

describe('initial state', () => {
  it('has rightTab files and openFilePath null', () => {
    const state = usePanelStore.getState()
    expect(state.rightTab).toBe('files')
    expect(state.openFilePath).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// setRightTab
// ---------------------------------------------------------------------------

describe('setRightTab', () => {
  it('updates both rightTab and rightView', () => {
    usePanelStore.getState().setRightTab('git')
    const state = usePanelStore.getState()
    expect(state.rightTab).toBe('git')
    expect(state.rightView).toBe('git')
  })
})

// ---------------------------------------------------------------------------
// setRightView
// ---------------------------------------------------------------------------

describe('setRightView', () => {
  it('updates only rightView, not rightTab', () => {
    usePanelStore.getState().setRightView('editor')
    const state = usePanelStore.getState()
    expect(state.rightView).toBe('editor')
    expect(state.rightTab).toBe('files')
  })
})

// ---------------------------------------------------------------------------
// openFile
// ---------------------------------------------------------------------------

describe('openFile', () => {
  it('sets rightView to editor and stores the file path', () => {
    usePanelStore.getState().openFile('/home/user/project/src/index.ts')
    const state = usePanelStore.getState()
    expect(state.rightView).toBe('editor')
    expect(state.openFilePath).toBe('/home/user/project/src/index.ts')
  })
})

// ---------------------------------------------------------------------------
// toggleSubagentPanel
// ---------------------------------------------------------------------------

describe('toggleSubagentPanel', () => {
  it('toggles subagentPanelCollapsed from false to true and back', () => {
    expect(usePanelStore.getState().subagentPanelCollapsed).toBe(false)
    usePanelStore.getState().toggleSubagentPanel()
    expect(usePanelStore.getState().subagentPanelCollapsed).toBe(true)
    usePanelStore.getState().toggleSubagentPanel()
    expect(usePanelStore.getState().subagentPanelCollapsed).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// setSubagentPanelHidden
// ---------------------------------------------------------------------------

describe('setSubagentPanelHidden', () => {
  it('sets subagentPanelHidden to the provided value', () => {
    usePanelStore.getState().setSubagentPanelHidden(true)
    expect(usePanelStore.getState().subagentPanelHidden).toBe(true)
    usePanelStore.getState().setSubagentPanelHidden(false)
    expect(usePanelStore.getState().subagentPanelHidden).toBe(false)
  })
})
