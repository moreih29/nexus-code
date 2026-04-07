import { useState } from 'react'
import { usePanelStore } from '../../stores/panel-store'
import { useWorkspaceStore } from '../../stores/workspace-store'
import { useWorkspaces, useFiles } from '../../hooks/use-workspaces'
import type { FileEntry } from '../../api/workspace'
import { File, FileCode, FileJson, FileText, Folder, FolderOpen, ChevronRight, ChevronDown, Image, Settings } from 'lucide-react'

interface FileTreeNode {
  name: string
  path: string
  type: 'file' | 'directory'
  children?: FileTreeNode[]
  status?: 'M' | 'A' | 'D'
}

function buildTree(files: FileEntry[]): FileTreeNode[] {
  const root: FileTreeNode[] = []
  const dirMap = new Map<string, FileTreeNode>()

  for (const file of files) {
    const parts = file.path.split('/')
    let currentChildren = root

    for (let i = 0; i < parts.length - 1; i++) {
      const dirPath = parts.slice(0, i + 1).join('/')
      let dir = dirMap.get(dirPath)
      if (!dir) {
        dir = { name: parts[i]!, path: dirPath, type: 'directory', children: [] }
        dirMap.set(dirPath, dir)
        currentChildren.push(dir)
      }
      currentChildren = dir.children!
    }

    const fileName = parts[parts.length - 1]!
    currentChildren.push({ name: fileName, path: file.path, type: 'file', status: file.status })
  }

  return root
}

function FileIcon({ name }: { name: string }) {
  const ext = name.split('.').pop()?.toLowerCase() ?? ''
  switch (ext) {
    case 'ts':
    case 'tsx':
    case 'js':
    case 'jsx':
      return <FileCode size={14} />
    case 'json':
      return <FileJson size={14} />
    case 'md':
    case 'txt':
    case 'csv':
      return <FileText size={14} />
    case 'png':
    case 'jpg':
    case 'jpeg':
    case 'gif':
    case 'svg':
    case 'webp':
      return <Image size={14} />
    case 'toml':
    case 'yaml':
    case 'yml':
    case 'env':
      return <Settings size={14} />
    default:
      return <File size={14} />
  }
}

interface FileTreeNodeProps {
  node: FileTreeNode
  depth: number
  onFileClick: (filePath: string) => void
}

function FileTreeNodeItem({ node, depth, onFileClick }: FileTreeNodeProps) {
  const openFilePath = usePanelStore((s) => s.openFilePath)
  const [collapsed, setCollapsed] = useState(false)
  const indent = depth * 16

  const isActive = node.type === 'file' && openFilePath === node.path

  function handleClick() {
    if (node.type === 'file') {
      onFileClick(node.path)
    } else {
      setCollapsed((prev) => !prev)
      usePanelStore.setState({ openFilePath: null })
    }
  }

  return (
    <>
      <div
        className={[
          'flex items-center gap-1.5 py-1 pr-3 cursor-pointer text-[12px] transition-colors',
          isActive
            ? 'bg-bg-active text-text-primary'
            : 'text-text-secondary hover:bg-bg-hover hover:text-text-primary',
        ].join(' ')}
        style={{ paddingLeft: `${12 + indent}px` }}
        onClick={handleClick}
      >
        {/* Icon */}
        {node.type === 'directory' ? (
          <span className="flex items-center gap-0.5 flex-shrink-0 text-text-muted">
            {collapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
            {collapsed ? <Folder size={14} /> : <FolderOpen size={14} />}
          </span>
        ) : (
          <span className="w-4 flex items-center justify-center flex-shrink-0 text-text-muted ml-[14px]">
            <FileIcon name={node.name} />
          </span>
        )}

        {/* Name */}
        <span className="flex-1 truncate">{node.name}</span>

        {/* Change badge */}
        {node.status === 'M' && (
          <span className="text-[10px] px-1.5 rounded-full font-medium bg-[rgba(210,153,34,0.2)] text-[#d29922]">
            M
          </span>
        )}
        {node.status === 'A' && (
          <span className="text-[10px] px-1.5 rounded-full font-medium bg-[rgba(63,185,80,0.2)] text-[#3fb950]">
            A
          </span>
        )}
        {node.status === 'D' && (
          <span className="text-[10px] px-1.5 rounded-full font-medium bg-[rgba(248,81,73,0.15)] text-[#f85149]">
            D
          </span>
        )}
      </div>

      {/* Children (hidden when collapsed) */}
      {node.type === 'directory' && !collapsed &&
        node.children?.map((child) => (
          <FileTreeNodeItem key={child.path} node={child} depth={depth + 1} onFileClick={onFileClick} />
        ))}
    </>
  )
}

export function FileTree() {
  const { activeWorkspaceId } = useWorkspaceStore()
  const { data: workspaces } = useWorkspaces()
  const { openFile } = usePanelStore()

  const activeWorkspace = workspaces?.find((ws) => ws.id === activeWorkspaceId)
  const workspacePath = activeWorkspace?.path ?? null

  const { data: files, isLoading, isError } = useFiles(workspacePath)

  const tree = files ? buildTree(files) : []
  const workspaceName = workspacePath?.split('/').filter(Boolean).pop() ?? '파일'

  function handleFileClick(filePath: string) {
    openFile(filePath)
  }

  return (
    <div className="flex flex-col overflow-hidden flex-1">
      {/* Toolbar */}
      <div className="flex items-center px-3 py-2 gap-1.5 border-b border-border-light text-[11px] text-text-secondary">
        <span className="flex-1 font-medium text-text-primary">{workspaceName}</span>
        <button className="hover:text-text-primary hover:bg-bg-hover px-1.5 py-0.5 rounded transition-colors">
          ⤢
        </button>
      </div>

      {/* Tree */}
      <div className="flex-1 overflow-y-auto py-1">
        {isLoading && (
          <div className="px-3 py-2 text-[12px] text-text-secondary">로딩 중...</div>
        )}
        {isError && (
          <div className="px-3 py-2 text-[12px] text-text-secondary">파일 목록을 불러올 수 없습니다.</div>
        )}
        {!isLoading && !isError && !workspacePath && (
          <div className="px-3 py-2 text-[12px] text-text-secondary">워크스페이스를 선택하세요.</div>
        )}
        {!isLoading && !isError && workspacePath && tree.length === 0 && (
          <div className="px-3 py-2 text-[12px] text-text-secondary">파일이 없습니다.</div>
        )}
        {tree.map((node) => (
          <FileTreeNodeItem key={node.path} node={node} depth={0} onFileClick={handleFileClick} />
        ))}
      </div>
    </div>
  )
}
