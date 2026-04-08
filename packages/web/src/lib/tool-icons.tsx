import { FileText, Pencil, FileOutput, Terminal, Search, FolderSearch, Bot, Wrench } from 'lucide-react'

export function getToolIcon(name: string) {
  switch (name) {
    case 'Read': return <FileText size={14} />
    case 'Edit': return <Pencil size={14} />
    case 'Write': return <FileOutput size={14} />
    case 'Bash': return <Terminal size={14} />
    case 'Grep': return <Search size={14} />
    case 'Glob': return <FolderSearch size={14} />
    case 'Agent':
    case 'Task': return <Bot size={14} />
    default: return <Wrench size={14} />
  }
}
