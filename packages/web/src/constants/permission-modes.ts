import { ShieldCheck, FileCheck2, Telescope, ShieldOff, type LucideIcon } from 'lucide-react'
import type { PermissionMode } from '@/stores/settings-store'

export interface PermissionModeDef {
  id: PermissionMode
  label: string
  icon: LucideIcon
  description: string
}

export const PERMISSION_MODES: PermissionModeDef[] = [
  { id: 'default', label: '기본', icon: ShieldCheck, description: '위험 작업은 매번 확인' },
  { id: 'acceptEdits', label: '편집 허용', icon: FileCheck2, description: '편집은 자동, 실행은 확인' },
  { id: 'plan', label: '계획', icon: Telescope, description: '읽기·탐색만, 편집 차단' },
  { id: 'bypassPermissions', label: '전체 허용', icon: ShieldOff, description: '모든 확인 건너뜀 (주의)' },
]
