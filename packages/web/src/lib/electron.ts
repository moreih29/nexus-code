import { invoke } from '@tauri-apps/api/core'

export function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}

export async function selectFolder(): Promise<string | null> {
  if (isTauri()) {
    try {
      const result = await invoke<string | null>('select_folder')
      return result ?? null
    } catch (err) {
      console.error('[selectFolder] Tauri invoke 실패:', err)
      return null
    }
  }
  // browser fallback (dev): prompt로 경로 직접 입력
  const folderPath = window.prompt('워크스페이스 경로를 입력하세요 (절대경로):')
  return folderPath || null
}
