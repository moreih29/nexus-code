interface ElectronAPI {
  selectFolder: () => Promise<string | null>
}

declare global {
  interface Window {
    electronAPI?: ElectronAPI
  }
}

export function isElectron(): boolean {
  return !!window.electronAPI
}

export async function selectFolder(): Promise<string | null> {
  if (window.electronAPI) {
    return window.electronAPI.selectFolder()
  }
  // fallback: prompt로 경로 직접 입력
  const folderPath = window.prompt('워크스페이스 경로를 입력하세요 (절대경로):')
  return folderPath || null
}
