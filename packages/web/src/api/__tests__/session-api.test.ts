import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('@/api/client', () => ({
  apiClient: {
    get: vi.fn(),
    post: vi.fn(),
    put: vi.fn(),
    delete: vi.fn(),
  },
}))

import { apiClient } from '@/api/client'
import {
  startSession,
  sendPrompt,
  cancelSession,
  resumeSession,
  fetchSessions,
  fetchHistory,
  fetchSessionStatus,
} from '../session'

const mockGet = apiClient.get as ReturnType<typeof vi.fn>
const mockPost = apiClient.post as ReturnType<typeof vi.fn>

beforeEach(() => {
  vi.clearAllMocks()
})

// ---------------------------------------------------------------------------
// startSession
// ---------------------------------------------------------------------------

describe('startSession', () => {
  it('POSTs to /api/sessions with the request body', async () => {
    const body = { workspacePath: '/ws', model: 'sonnet', prompt: 'hello' }
    const response = { id: 'sess-1', status: 'running' }
    mockPost.mockResolvedValue(response)

    const result = await startSession(body as Parameters<typeof startSession>[0])

    expect(mockPost).toHaveBeenCalledWith('/api/sessions', body)
    expect(result).toEqual(response)
  })
})

// ---------------------------------------------------------------------------
// sendPrompt
// ---------------------------------------------------------------------------

describe('sendPrompt', () => {
  it('POSTs to /api/sessions/:id/prompt with prompt body', async () => {
    mockPost.mockResolvedValue(undefined)

    await sendPrompt('sess-abc', 'what is 2+2?')

    expect(mockPost).toHaveBeenCalledWith('/api/sessions/sess-abc/prompt', { prompt: 'what is 2+2?' })
  })
})

// ---------------------------------------------------------------------------
// cancelSession
// ---------------------------------------------------------------------------

describe('cancelSession', () => {
  it('POSTs to /api/sessions/:id/cancel', async () => {
    mockPost.mockResolvedValue(undefined)

    await cancelSession('sess-xyz')

    expect(mockPost).toHaveBeenCalledWith('/api/sessions/sess-xyz/cancel')
  })
})

// ---------------------------------------------------------------------------
// resumeSession
// ---------------------------------------------------------------------------

describe('resumeSession', () => {
  it('POSTs to /api/sessions/:id/resume with prompt body', async () => {
    const response = { id: 'sess-1', status: 'running' }
    mockPost.mockResolvedValue(response)

    const result = await resumeSession('sess-1', 'continue please')

    expect(mockPost).toHaveBeenCalledWith('/api/sessions/sess-1/resume', { prompt: 'continue please' })
    expect(result).toEqual(response)
  })

  it('uses empty string as default prompt', async () => {
    mockPost.mockResolvedValue({ id: 'sess-2', status: 'running' })

    await resumeSession('sess-2')

    expect(mockPost).toHaveBeenCalledWith('/api/sessions/sess-2/resume', { prompt: '' })
  })
})

// ---------------------------------------------------------------------------
// fetchSessions
// ---------------------------------------------------------------------------

describe('fetchSessions', () => {
  it('uses encodeURIComponent for workspacePath in query string', async () => {
    mockGet.mockResolvedValue([])

    await fetchSessions('/my/workspace path')

    const encoded = encodeURIComponent('/my/workspace path')
    expect(mockGet).toHaveBeenCalledWith(`/api/sessions?workspacePath=${encoded}`)
  })
})

// ---------------------------------------------------------------------------
// fetchHistory
// ---------------------------------------------------------------------------

describe('fetchHistory', () => {
  it('includes offset and limit as query parameters', async () => {
    mockGet.mockResolvedValue({ messages: [], offset: 10, limit: 20 })

    await fetchHistory('sess-1', { offset: 10, limit: 20 })

    expect(mockGet).toHaveBeenCalledWith('/api/sessions/sess-1/history?offset=10&limit=20')
  })

  it('includes only offset when limit is not provided', async () => {
    mockGet.mockResolvedValue({ messages: [], offset: 5, limit: 50 })

    await fetchHistory('sess-1', { offset: 5 })

    expect(mockGet).toHaveBeenCalledWith('/api/sessions/sess-1/history?offset=5')
  })
})

// ---------------------------------------------------------------------------
// fetchSessionStatus
// ---------------------------------------------------------------------------

describe('fetchSessionStatus', () => {
  it('GETs /api/sessions/:id/status', async () => {
    mockGet.mockResolvedValue({ status: 'completed' })

    const result = await fetchSessionStatus('sess-done')

    expect(mockGet).toHaveBeenCalledWith('/api/sessions/sess-done/status')
    expect(result).toEqual({ status: 'completed' })
  })
})
