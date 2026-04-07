export interface MockWorkspace {
  id: string
  name: string
  path: string
  gitBranch: string
  model: string
  status: 'active' | 'idle' | 'warning'
  activeSubagents: number
  totalSubagents: number
  pendingApprovals: number
}

export interface MockSubagent {
  id: string
  name: string
  type: 'Explore' | 'Engineer' | 'Researcher' | 'Writer' | 'Tester'
  status: 'running' | 'done' | 'waiting_permission'
  summary: string
  durationSec?: number
}

export type MockMessageRole = 'user' | 'assistant'

export interface MockToolCall {
  id: string
  name: string
  input: Record<string, unknown>
  status: 'running' | 'success' | 'error'
  result?: string
  isError?: boolean
}

export interface MockPermissionRequest {
  id: string
  toolName: string
  toolInput: Record<string, unknown>
}

export interface MockMessage {
  id: string
  role: MockMessageRole
  text: string
  label?: string
  toolCalls?: MockToolCall[]
  permissionRequest?: MockPermissionRequest
  subagentSpawn?: { count: number }
  subagentResult?: { name: string; type: string; summary: string }
  isStreaming?: boolean
}

export interface MockFileNode {
  name: string
  type: 'file' | 'directory'
  children?: MockFileNode[]
  changeStatus?: 'modified' | 'added' | 'deleted'
}

export interface MockGitChange {
  path: string
  status: 'M' | 'A' | 'D'
  additions: number
  deletions: number
  staged: boolean
}

export interface MockGitCommit {
  hash: string
  message: string
  timeAgo: string
}

// --- Mock Data ---

export const mockWorkspaces: MockWorkspace[] = [
  {
    id: 'ws-1',
    name: 'nexus-code',
    path: '~/workspaces/nexus-code',
    gitBranch: 'feat/ui-redesign',
    model: 'opus-4',
    status: 'active',
    activeSubagents: 2,
    totalSubagents: 3,
    pendingApprovals: 0,
  },
  {
    id: 'ws-2',
    name: 'api-server',
    path: '~/workspaces/api-server',
    gitBranch: 'fix/auth-bug',
    model: 'sonnet-4',
    status: 'warning',
    activeSubagents: 0,
    totalSubagents: 0,
    pendingApprovals: 1,
  },
  {
    id: 'ws-3',
    name: 'docs-site',
    path: '~/workspaces/docs-site',
    gitBranch: 'main',
    model: 'haiku-4',
    status: 'idle',
    activeSubagents: 0,
    totalSubagents: 0,
    pendingApprovals: 0,
  },
]

export const mockSubagents: MockSubagent[] = [
  {
    id: 'sa-1',
    name: '의존성 분석',
    type: 'Explore',
    status: 'done',
    summary: '3개 모듈에서 순환 의존성 발견',
    durationSec: 12,
  },
  {
    id: 'sa-2',
    name: '코드베이스 분석',
    type: 'Explore',
    status: 'running',
    summary: 'src/components/ 탐색 중 — 14개 파일 확인됨',
  },
  {
    id: 'sa-3',
    name: 'UI 컴포넌트 구현',
    type: 'Engineer',
    status: 'running',
    summary: 'workspace-card.tsx 수정 중',
  },
]

export const mockMessages: MockMessage[] = [
  {
    id: 'msg-1',
    role: 'user',
    text: '이 프로젝트 리팩토링해줘. 워크스페이스 카드에 git 브랜치 정보도 추가하고, 컴포넌트 구조도 개선해줘.',
  },
  {
    id: 'msg-2',
    role: 'assistant',
    label: 'Lead',
    text: '네, 리팩토링을 진행하겠습니다. 먼저 코드베이스를 분석하고 병렬로 작업을 나누겠습니다. 서브에이전트 3개를 스폰합니다.',
    subagentSpawn: { count: 3 },
  },
  {
    id: 'msg-3',
    role: 'assistant',
    label: 'Lead',
    text: '의존성 분석이 완료되었습니다. 순환 의존성 3건을 발견했습니다:',
    subagentResult: {
      name: '의존성 분석',
      type: 'Explore',
      summary:
        '1. use-workspaces → api/workspace → shared/types\n2. use-session → use-sse → use-session\n3. chat-message → agent-list → chat-message',
    },
  },
  {
    id: 'msg-4',
    role: 'assistant',
    label: 'Lead',
    text: '나머지 작업과 병렬로 순환 의존성을 수정하겠습니다.',
  },
  {
    id: 'msg-5',
    role: 'user',
    text: '좋아, 순환 의존성 먼저 해결해줘. 나머지는 그 다음에.',
  },
  {
    id: 'msg-6',
    role: 'assistant',
    label: 'Lead',
    text: '네, 순환 의존성을 우선적으로 해결하겠습니다. Engineer가 현재 진행 중인 작업과 함께 처리하도록 지시했습니다.',
  },
  {
    id: 'msg-7',
    role: 'assistant',
    label: 'Lead',
    text: '코드베이스 분석도 거의 완료되었습니다. 전체 14개 컴포넌트 중 5개가 리팩토링 대상입니다. 분석 결과를 기반으로 구조 개선 계획을 세우겠습니다.',
    isStreaming: true,
  },
]

export const mockSubagentLog: MockMessage[] = [
  {
    id: 'sa-log-1',
    role: 'assistant',
    label: 'Explore',
    text: '',
    toolCalls: [
      { id: 'tc-1', name: 'Glob', input: { pattern: 'src/**/*.tsx' }, status: 'success', result: '14개 파일 매칭' },
      { id: 'tc-2', name: 'Read', input: { file_path: 'src/components/workspace-card.tsx' }, status: 'success', result: 'FC<WorkspaceCardProps> — name, path, isActive props' },
      { id: 'tc-3', name: 'Read', input: { file_path: 'src/components/agent-list.tsx' }, status: 'success', result: '에이전트 목록 컴포넌트. useSession 훅 의존' },
      { id: 'tc-4', name: 'Grep', input: { pattern: 'import.*from', path: 'src/hooks/' }, status: 'success', result: '의존성 그래프 추적 중' },
      { id: 'tc-5', name: 'Read', input: { file_path: 'src/hooks/use-workspaces.ts' }, status: 'running' },
    ],
  },
]

export const mockEngineerLog: MockMessage[] = [
  {
    id: 'eng-log-1',
    role: 'assistant',
    label: 'Engineer',
    text: '',
    toolCalls: [
      { id: 'tc-e1', name: 'Read', input: { file_path: 'src/components/workspace-card.tsx' }, status: 'success' },
      {
        id: 'tc-e2',
        name: 'Edit',
        input: { file_path: 'src/components/workspace-card.tsx' },
        status: 'success',
        result: '+ <span className="ws-branch">\n+   <GitBranchIcon size={12} />\n+   {workspace.gitBranch ?? \'main\'}\n+ </span>',
      },
      {
        id: 'tc-e3',
        name: 'Write',
        input: { file_path: 'src/components/icons/git-branch-icon.tsx' },
        status: 'success',
        result: '새 아이콘 컴포넌트 생성 (24줄)',
      },
    ],
    permissionRequest: {
      id: 'perm-1',
      toolName: 'Bash',
      toolInput: { command: 'git branch --show-current' },
    },
  },
]

export const mockFileTree: MockFileNode[] = [
  {
    name: 'src',
    type: 'directory',
    children: [
      {
        name: 'components',
        type: 'directory',
        children: [
          { name: 'workspace-card.tsx', type: 'file', changeStatus: 'modified' },
          { name: 'agent-list.tsx', type: 'file' },
          { name: 'chat-message.tsx', type: 'file' },
        ],
      },
      {
        name: 'hooks',
        type: 'directory',
        children: [
          { name: 'use-workspaces.ts', type: 'file', changeStatus: 'modified' },
          { name: 'use-session.ts', type: 'file' },
          { name: 'use-sse.ts', type: 'file' },
        ],
      },
      {
        name: 'api',
        type: 'directory',
        children: [
          { name: 'client.ts', type: 'file' },
          { name: 'workspace.ts', type: 'file' },
        ],
      },
    ],
  },
  { name: 'App.tsx', type: 'file' },
  { name: 'main.tsx', type: 'file' },
  { name: 'package.json', type: 'file', changeStatus: 'added' },
]

export const mockGitChanges: MockGitChange[] = [
  { path: 'src/components/git-branch-icon.tsx', status: 'A', additions: 24, deletions: 0, staged: true },
  { path: 'src/components/workspace-card.tsx', status: 'M', additions: 12, deletions: 3, staged: false },
  { path: 'src/hooks/use-workspaces.ts', status: 'M', additions: 5, deletions: 1, staged: false },
]

export const mockGitCommits: MockGitCommit[] = [
  { hash: 'abc1234', message: 'feat: 워크스페이스 카드 UI 구현', timeAgo: '2시간 전' },
  { hash: 'def5678', message: 'refactor: 에이전트 탭 컴포넌트 분리', timeAgo: '5시간 전' },
]
