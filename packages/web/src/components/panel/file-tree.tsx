import type { MockFileNode } from '../../mock/data'
import { usePanelStore } from '../../stores/panel-store'

interface FileTreeNodeProps {
  node: MockFileNode
  depth: number
}

function FileTreeNode({ node, depth }: FileTreeNodeProps) {
  const { openFile, openFilePath } = usePanelStore()
  const indent = depth * 16

  const isActive = node.type === 'file' && openFilePath?.endsWith(node.name)

  function handleClick() {
    if (node.type === 'file') {
      openFile(node.name)
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
        <span className="w-4 text-center flex-shrink-0 text-[14px]">
          {node.type === 'directory' ? '▾' : '📄'}
        </span>

        {/* Name */}
        <span className="flex-1 truncate">{node.name}</span>

        {/* Change badge */}
        {node.changeStatus === 'modified' && (
          <span className="text-[10px] px-1.5 rounded-full font-medium bg-[rgba(210,153,34,0.2)] text-[#d29922]">
            M
          </span>
        )}
        {node.changeStatus === 'added' && (
          <span className="text-[10px] px-1.5 rounded-full font-medium bg-[rgba(63,185,80,0.2)] text-[#3fb950]">
            A
          </span>
        )}
        {node.changeStatus === 'deleted' && (
          <span className="text-[10px] px-1.5 rounded-full font-medium bg-[rgba(248,81,73,0.15)] text-[#f85149]">
            D
          </span>
        )}
      </div>

      {/* Children */}
      {node.type === 'directory' && node.children?.map((child) => (
        <FileTreeNode key={child.name} node={child} depth={depth + 1} />
      ))}
    </>
  )
}

export function FileTree() {
  const { fileTree } = usePanelStore()

  return (
    <div className="flex flex-col overflow-hidden flex-1">
      {/* Toolbar */}
      <div className="flex items-center px-3 py-2 gap-1.5 border-b border-border-light text-[11px] text-text-secondary">
        <span className="flex-1 font-medium text-text-primary">nexus-code</span>
        <button className="hover:text-text-primary hover:bg-bg-hover px-1.5 py-0.5 rounded transition-colors">
          ⤢
        </button>
      </div>

      {/* Tree */}
      <div className="flex-1 overflow-y-auto py-1">
        {fileTree.map((node) => (
          <FileTreeNode key={node.name} node={node} depth={0} />
        ))}
      </div>
    </div>
  )
}
