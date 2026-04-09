import { describe, it, expect } from 'vitest'
import { PERMISSION_MODES } from '../permission-modes'

describe('PERMISSION_MODES 상수', () => {
  it('4개 모드 포함', () => {
    expect(PERMISSION_MODES).toHaveLength(4)
  })

  it('모드 ID 순서: default → acceptEdits → plan → bypassPermissions', () => {
    expect(PERMISSION_MODES.map((m) => m.id)).toEqual([
      'default',
      'acceptEdits',
      'plan',
      'bypassPermissions',
    ])
  })

  it('한글 라벨', () => {
    const labels = Object.fromEntries(PERMISSION_MODES.map((m) => [m.id, m.label]))
    expect(labels).toEqual({
      default: '기본',
      acceptEdits: '편집 허용',
      plan: '계획',
      bypassPermissions: '전체 허용',
    })
  })

  it('모든 모드에 아이콘 정의', () => {
    for (const mode of PERMISSION_MODES) {
      expect(mode.icon).toBeDefined()
      expect(typeof mode.icon).toBe('object')
    }
  })

  it('모든 모드에 설명 한 줄', () => {
    for (const mode of PERMISSION_MODES) {
      expect(mode.description).toBeTruthy()
      expect(mode.description.length).toBeGreaterThan(0)
      expect(mode.description.length).toBeLessThan(40)
    }
  })

  it('ID 중복 없음', () => {
    const ids = PERMISSION_MODES.map((m) => m.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it("'auto' 모드 제거 확인 (Issue #1)", () => {
    const ids = PERMISSION_MODES.map((m) => m.id) as string[]
    expect(ids).not.toContain('auto')
  })
})
