import { describe, it, expect, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import { SettingsStore } from '../settings-store.js'

describe('SettingsStore', () => {
  let db: Database.Database
  let store: SettingsStore

  beforeEach(() => {
    db = new Database(':memory:')
    store = new SettingsStore(db)
  })

  describe('global settings', () => {
    it('returns empty object when no settings saved', () => {
      expect(store.getGlobalSettings()).toEqual({})
    })

    it('saves and retrieves global settings', () => {
      store.updateGlobalSettings({ theme: 'monokai-pro', model: 'opus' })
      expect(store.getGlobalSettings()).toEqual({ theme: 'monokai-pro', model: 'opus' })
    })

    it('merges partial updates without losing existing keys', () => {
      store.updateGlobalSettings({ theme: 'monokai-pro', model: 'opus' })
      store.updateGlobalSettings({ theme: 'claude' })
      expect(store.getGlobalSettings()).toEqual({ theme: 'claude', model: 'opus' })
    })

    it('does not create duplicate rows on repeated updates', () => {
      store.updateGlobalSettings({ theme: 'a' })
      store.updateGlobalSettings({ theme: 'b' })
      store.updateGlobalSettings({ theme: 'c' })
      const count = db.prepare(`SELECT COUNT(*) as cnt FROM settings WHERE scope = 'global' AND workspace_path IS NULL`).get() as { cnt: number }
      expect(count.cnt).toBe(1)
    })

    it('round-trips: update then get returns the updated value', () => {
      store.updateGlobalSettings({ theme: 'midnight-blue' })
      store.updateGlobalSettings({ theme: 'monokai-pro' })
      expect(store.getGlobalSettings().theme).toBe('monokai-pro')
    })
  })

  describe('project settings', () => {
    it('returns empty object when no settings saved', () => {
      expect(store.getProjectSettings('/test/path')).toEqual({})
    })

    it('saves and retrieves project settings', () => {
      store.updateProjectSettings('/test/path', { model: 'haiku' })
      expect(store.getProjectSettings('/test/path')).toEqual({ model: 'haiku' })
    })

    it('isolates settings per workspace path', () => {
      store.updateProjectSettings('/path/a', { model: 'opus' })
      store.updateProjectSettings('/path/b', { model: 'haiku' })
      expect(store.getProjectSettings('/path/a').model).toBe('opus')
      expect(store.getProjectSettings('/path/b').model).toBe('haiku')
    })

    it('merges partial updates for the same workspace', () => {
      store.updateProjectSettings('/test', { model: 'opus', theme: 'claude' })
      store.updateProjectSettings('/test', { model: 'sonnet' })
      expect(store.getProjectSettings('/test')).toEqual({ model: 'sonnet', theme: 'claude' })
    })
  })

  describe('effective settings', () => {
    it('returns defaults when nothing saved', () => {
      const effective = store.getEffectiveSettings('/test')
      expect(effective.model).toBe('sonnet')
      expect(effective.effortLevel).toBe('medium')
    })

    it('global overrides defaults', () => {
      store.updateGlobalSettings({ model: 'opus' })
      expect(store.getEffectiveSettings('/test').model).toBe('opus')
    })

    it('project overrides global', () => {
      store.updateGlobalSettings({ model: 'opus' })
      store.updateProjectSettings('/test', { model: 'haiku' })
      expect(store.getEffectiveSettings('/test').model).toBe('haiku')
    })
  })

  describe('deleteProjectKey', () => {
    it('removes a specific key from project settings', () => {
      store.updateProjectSettings('/test', { model: 'opus', theme: 'claude' })
      store.deleteProjectKey('/test', 'model')
      expect(store.getProjectSettings('/test')).toEqual({ theme: 'claude' })
    })
  })

  describe('auto → bypassPermissions 마이그레이션', () => {
    // 헬퍼: 현재 store가 관리하는 db에 raw JSON을 직접 INSERT
    function insertRawGlobal(rawDb: Database.Database, json: string): void {
      rawDb
        .prepare(
          `INSERT INTO settings (scope, workspace_path, settings_json) VALUES ('global', NULL, ?)`
        )
        .run(json)
    }

    it('시나리오1: lazy 매핑 — getGlobalSettings()가 auto를 bypassPermissions로 반환', () => {
      // store 생성 시 migration은 빈 테이블에 실행됨; 이후 raw 'auto' 직접 삽입
      insertRawGlobal(db, JSON.stringify({ permissionMode: 'auto' }))
      const settings = store.getGlobalSettings()
      expect(settings.permissionMode).toBe('bypassPermissions')
    })

    it('시나리오2: Zod 파싱 호환 — auto 값이 런타임 에러 없이 로드됨', () => {
      insertRawGlobal(db, JSON.stringify({ permissionMode: 'auto', model: 'opus' }))
      let result: ReturnType<typeof store.getGlobalSettings> | undefined
      expect(() => {
        result = store.getGlobalSettings()
      }).not.toThrow()
      // lazy 매핑이 Zod 파싱 이전에 실행되므로 에러 없이 변환된 값을 반환
      expect(result?.permissionMode).toBe('bypassPermissions')
    })

    it('시나리오3: one-shot UPDATE — migrate 후 DB에 auto 행이 0개, bypassPermissions 행이 1개', () => {
      // 1단계: 현재 store(빈 테이블)에 raw 'auto' 삽입
      insertRawGlobal(db, JSON.stringify({ permissionMode: 'auto' }))

      // 2단계: 새 SettingsStore 생성 → migrateAutoPermissionMode() 재실행
      new SettingsStore(db)

      // 3단계: DB 직접 쿼리로 검증
      const autoRows = db
        .prepare(
          `SELECT id FROM settings WHERE json_extract(settings_json, '$.permissionMode') = 'auto'`
        )
        .all()
      expect(autoRows).toHaveLength(0)

      const bypassRows = db
        .prepare(
          `SELECT id FROM settings WHERE json_extract(settings_json, '$.permissionMode') = 'bypassPermissions'`
        )
        .all()
      expect(bypassRows).toHaveLength(1)
    })

    it('시나리오4: idempotent — bypassPermissions 행은 migrate 후에도 변경 없음', () => {
      // 이미 bypassPermissions인 행 삽입
      insertRawGlobal(db, JSON.stringify({ permissionMode: 'bypassPermissions' }))

      // 새 store 생성으로 migration 재실행
      new SettingsStore(db)

      const row = db
        .prepare(
          `SELECT settings_json FROM settings WHERE scope = 'global' AND workspace_path IS NULL`
        )
        .get() as { settings_json: string }
      const parsed = JSON.parse(row.settings_json) as { permissionMode?: string }
      expect(parsed.permissionMode).toBe('bypassPermissions')
    })

    it('시나리오5: 알 수 없는 값 — invalid_value가 있어도 getGlobalSettings()가 에러 없이 반환', () => {
      insertRawGlobal(db, JSON.stringify({ permissionMode: 'invalid_value', model: 'haiku' }))
      let result: ReturnType<typeof store.getGlobalSettings> | undefined
      expect(() => {
        result = store.getGlobalSettings()
      }).not.toThrow()
      // 알 수 없는 값은 lazy 매핑 대상이 아니므로 그대로 반환
      // 중요: 에러 없이 다른 필드들은 정상 반환됨
      expect(result?.model).toBe('haiku')
    })
  })
})
