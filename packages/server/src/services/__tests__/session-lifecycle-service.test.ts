import { describe, it, expect } from 'vitest'
import { resolvePermissionMode, settingsChanged } from '../session-lifecycle-service.js'

describe('resolvePermissionMode', () => {
  it("returns 'bypassPermissions' when input is 'bypassPermissions'", () => {
    expect(resolvePermissionMode('bypassPermissions')).toBe('bypassPermissions')
  })

  it("returns undefined when input is 'default'", () => {
    expect(resolvePermissionMode('default')).toBeUndefined()
  })

  it('returns undefined when input is undefined', () => {
    expect(resolvePermissionMode(undefined)).toBeUndefined()
  })

  it('returns undefined when input is null', () => {
    expect(resolvePermissionMode(null)).toBeUndefined()
  })

  it('returns undefined for an unrecognized string', () => {
    expect(resolvePermissionMode('unknown')).toBeUndefined()
  })
})

describe('settingsChanged', () => {
  it('returns false when both objects are identical', () => {
    const settings = { model: 'sonnet', theme: 'claude' }
    expect(settingsChanged(settings, settings)).toBe(false)
  })

  it('returns false when CLI-relevant keys are equal but theme differs', () => {
    const a = { model: 'sonnet', theme: 'claude' }
    const b = { model: 'sonnet', theme: 'monokai-pro' }
    expect(settingsChanged(a, b)).toBe(false)
  })

  it('returns true when model changes', () => {
    const a = { model: 'sonnet' }
    const b = { model: 'opus' }
    expect(settingsChanged(a, b)).toBe(true)
  })

  it('returns true when permissionMode changes', () => {
    const a = { permissionMode: 'default' }
    const b = { permissionMode: 'bypassPermissions' }
    expect(settingsChanged(a, b)).toBe(true)
  })

  it('returns false when both objects are empty', () => {
    expect(settingsChanged({}, {})).toBe(false)
  })

  it('returns true when effortLevel changes', () => {
    const a = { effortLevel: 'medium' }
    const b = { effortLevel: 'high' }
    expect(settingsChanged(a, b)).toBe(true)
  })

  it('returns false when only non-CLI key (theme) differs', () => {
    const a = { model: 'haiku', theme: 'dark' }
    const b = { model: 'haiku', theme: 'light' }
    expect(settingsChanged(a, b)).toBe(false)
  })
})
