import { describe, it, expect, vi, beforeEach } from 'vitest'

// vi.mock must be at module level before imports (vitest hoisting)
vi.mock('node:fs/promises', () => ({
  readFile: vi.fn(),
  writeFile: vi.fn().mockResolvedValue(undefined),
  mkdir: vi.fn().mockResolvedValue(undefined),
}))

import { readFile, writeFile, mkdir } from 'node:fs/promises'
import {
  CLI_SETTINGS_WHITELIST,
  readCliSettings,
  writeCliSettings,
  getCliSettingsPath,
} from '../cli-settings-proxy.js'

// Cast to MockedFunction manually — vi.mocked not available in bun's vitest build
const mockReadFile = readFile as unknown as ReturnType<typeof vi.fn>
const mockWriteFile = writeFile as unknown as ReturnType<typeof vi.fn>
const mockMkdir = mkdir as unknown as ReturnType<typeof vi.fn>

const FAKE_PATH = '/fake/.claude/settings.json'

describe('CLI_SETTINGS_WHITELIST', () => {
  it('contains only the expected keys', () => {
    expect(CLI_SETTINGS_WHITELIST).toEqual(['permissions', 'language', 'alwaysThinkingEnabled'])
  })

  it('does not include arbitrary keys like apiKey or theme', () => {
    expect(CLI_SETTINGS_WHITELIST).not.toContain('apiKey')
    expect(CLI_SETTINGS_WHITELIST).not.toContain('theme')
    expect(CLI_SETTINGS_WHITELIST).not.toContain('debug')
  })
})

describe('getCliSettingsPath', () => {
  it('returns ~/.claude/settings.json for global scope', () => {
    const path = getCliSettingsPath('global')
    expect(path).toMatch(/\.claude[/\\]settings\.json$/)
  })

  it('returns project-scoped path when workspacePath is given', () => {
    const path = getCliSettingsPath('project', '/my/project')
    expect(path).toBe('/my/project/.claude/settings.json')
  })

  it('throws when project scope is used without workspacePath', () => {
    expect(() => getCliSettingsPath('project')).toThrow()
  })
})

describe('readCliSettings — whitelist filtering', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockWriteFile.mockResolvedValue(undefined)
    mockMkdir.mockResolvedValue(undefined)
  })

  it('returns only whitelisted keys, discarding unlisted ones', async () => {
    const raw = JSON.stringify({
      language: 'ko',
      alwaysThinkingEnabled: true,
      apiKey: 'secret',
      theme: 'dark',
      debug: true,
    })
    mockReadFile.mockResolvedValue(raw)

    const result = await readCliSettings(FAKE_PATH)

    expect(result.language).toBe('ko')
    expect(result.alwaysThinkingEnabled).toBe(true)
    expect((result as Record<string, unknown>).apiKey).toBeUndefined()
    expect((result as Record<string, unknown>).theme).toBeUndefined()
    expect((result as Record<string, unknown>).debug).toBeUndefined()
  })

  it('returns empty object when file does not exist', async () => {
    mockReadFile.mockRejectedValue(new Error('ENOENT: no such file'))
    const result = await readCliSettings(FAKE_PATH)
    expect(result).toEqual({})
  })

  it('returns empty object when file contains invalid JSON', async () => {
    mockReadFile.mockResolvedValue('not-json')
    const result = await readCliSettings(FAKE_PATH)
    expect(result).toEqual({})
  })

  it('parses permissions.allow and permissions.deny correctly', async () => {
    const raw = JSON.stringify({
      permissions: {
        allow: ['Bash', 'Read'],
        deny: ['Write'],
      },
    })
    mockReadFile.mockResolvedValue(raw)

    const result = await readCliSettings(FAKE_PATH)

    expect(result.permissions?.allow).toEqual(['Bash', 'Read'])
    expect(result.permissions?.deny).toEqual(['Write'])
  })
})

describe('writeCliSettings — whitelist enforcement', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockWriteFile.mockResolvedValue(undefined)
    mockMkdir.mockResolvedValue(undefined)
  })

  it('writes only whitelisted keys, discarding non-whitelisted ones', async () => {
    mockReadFile.mockRejectedValue(new Error('ENOENT'))

    await writeCliSettings(FAKE_PATH, {
      language: 'en',
      apiKey: 'do-not-write',
      theme: 'dark',
    })

    expect(mockWriteFile).toHaveBeenCalledOnce()
    const writtenJson = JSON.parse(mockWriteFile.mock.calls[0][1] as string) as Record<string, unknown>
    expect(writtenJson.language).toBe('en')
    expect(writtenJson.apiKey).toBeUndefined()
    expect(writtenJson.theme).toBeUndefined()
  })

  it('merges with existing file data, preserving non-updated whitelisted fields', async () => {
    const existing = JSON.stringify({ language: 'ko', alwaysThinkingEnabled: false })
    mockReadFile.mockResolvedValue(existing)

    await writeCliSettings(FAKE_PATH, { alwaysThinkingEnabled: true })

    const writtenJson = JSON.parse(mockWriteFile.mock.calls[0][1] as string) as Record<string, unknown>
    expect(writtenJson.language).toBe('ko')
    expect(writtenJson.alwaysThinkingEnabled).toBe(true)
  })

  it('creates the directory before writing', async () => {
    mockReadFile.mockRejectedValue(new Error('ENOENT'))

    await writeCliSettings(FAKE_PATH, { language: 'ja' })

    expect(mockMkdir).toHaveBeenCalledWith('/fake/.claude', { recursive: true })
  })
})

describe('writeCliSettings → readCliSettings round-trip value preservation', () => {
  it('preserves language and alwaysThinkingEnabled through write→read cycle', async () => {
    // Capture what writeFile was called with, then feed it back to readFile
    let captured = ''
    mockWriteFile.mockImplementation(async (_path, data) => {
      captured = data as string
    })
    mockReadFile.mockImplementation(async () => captured)
    mockMkdir.mockResolvedValue(undefined)

    await writeCliSettings(FAKE_PATH, {
      language: 'fr',
      alwaysThinkingEnabled: true,
    })

    const result = await readCliSettings(FAKE_PATH)
    expect(result.language).toBe('fr')
    expect(result.alwaysThinkingEnabled).toBe(true)
  })

  it('preserves permissions through write→read cycle', async () => {
    let captured = ''
    mockWriteFile.mockImplementation(async (_path, data) => {
      captured = data as string
    })
    mockReadFile.mockImplementation(async () => captured)
    mockMkdir.mockResolvedValue(undefined)

    await writeCliSettings(FAKE_PATH, {
      permissions: { allow: ['Bash', 'Read'], deny: ['Write'] },
    })

    const result = await readCliSettings(FAKE_PATH)
    expect(result.permissions?.allow).toEqual(['Bash', 'Read'])
    expect(result.permissions?.deny).toEqual(['Write'])
  })
})
