import { describe, it, expect } from 'vitest'
import { encodeWorkspacePath } from '../workspace-path'

describe('encodeWorkspacePath', () => {
  it('strips leading slash from absolute path', () => {
    expect(encodeWorkspacePath('/Users/foo/bar')).toBe('Users/foo/bar')
  })

  it('leaves relative path unchanged', () => {
    expect(encodeWorkspacePath('foo/bar')).toBe('foo/bar')
  })

  it('root path / returns empty string', () => {
    expect(encodeWorkspacePath('/')).toBe('')
  })

  it('empty string returns empty string', () => {
    expect(encodeWorkspacePath('')).toBe('')
  })

  it('preserves spaces in path segments', () => {
    expect(encodeWorkspacePath('/Users/foo bar/baz')).toBe('Users/foo bar/baz')
  })

  it('passes through special characters unchanged', () => {
    expect(encodeWorkspacePath('/Users/foo@bar/baz#qux')).toBe('Users/foo@bar/baz#qux')
  })
})
