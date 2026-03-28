import { join } from 'path'
import { readFile, writeFile, mkdir } from 'fs/promises'
import { app } from 'electron'
import type { ApprovalRule } from '../../shared/types'
import log from '../logger'

function permissionsFilePath(): string {
  return join(app.getPath('home'), '.nexus-code', 'permissions-global.json')
}

export async function loadPermanentRules(): Promise<ApprovalRule[]> {
  try {
    const raw = await readFile(permissionsFilePath(), 'utf8')
    return JSON.parse(raw) as ApprovalRule[]
  } catch {
    return []
  }
}

export async function savePermanentRule(toolName: string): Promise<void> {
  try {
    const filePath = permissionsFilePath()
    await mkdir(join(filePath, '..'), { recursive: true })
    const rules = await loadPermanentRules()
    if (!rules.some((r) => r.toolName === toolName)) {
      rules.push({ toolName, scope: 'permanent' })
      await writeFile(filePath, JSON.stringify(rules, null, 2), 'utf8')
    }
  } catch (err) {
    log.error('[ApprovalStore] savePermanentRule failed:', err)
  }
}

export async function removePermanentRule(toolName: string): Promise<void> {
  try {
    const filePath = permissionsFilePath()
    const rules = await loadPermanentRules()
    const filtered = rules.filter((r) => r.toolName !== toolName)
    await writeFile(filePath, JSON.stringify(filtered, null, 2), 'utf8')
  } catch (err) {
    log.error('[ApprovalStore] removePermanentRule failed:', err)
  }
}
