import { useCallback, useEffect, useRef, useState } from 'react'
import Editor, { type Monaco } from '@monaco-editor/react'
import type * as monacoTypes from 'monaco-editor'
import { FileCode2 } from 'lucide-react'
import { EditorTabBar } from './EditorTabBar'
import { MarkdownPreview } from './MarkdownPreview'
import { EmptyState } from '../ui/empty-state'
import type { EditorFile } from '../../../shared/types'
import { useEditorStore, type OpenFileRequest } from '../../stores/editor-store'

// ─── Monaco 테마 정의 ────────────────────────────────────────────────────────

function defineNexusTheme(monaco: Monaco) {
  monaco.editor.defineTheme('nexus-dark', {
    base: 'vs-dark',
    inherit: true,
    rules: [],
    colors: {
      'editor.background': '#0d0d0d',
      'editor.foreground': '#e8e2da',
      'editor.lineHighlightBackground': '#1a1815',
      'editor.selectionBackground': '#cc785c40',
      'editorCursor.foreground': '#cc785c',
      'editorLineNumber.foreground': '#666666',
      'editorLineNumber.activeForeground': '#cc785c',
      'editorIndentGuide.background': '#1f1c1a',
      'editorIndentGuide.activeBackground': '#3a3530',
    },
  })
}

// ─── 런타임 모델 관리 ─────────────────────────────────────────────────────────

const modelMap = new Map<string, monacoTypes.editor.ITextModel>()

function getOrCreateModel(
  monaco: Monaco,
  file: EditorFile,
): monacoTypes.editor.ITextModel {
  const uri = monaco.Uri.parse(`file://${file.path}`)
  const existing = monaco.editor.getModel(uri)
  if (existing) return existing

  const model = monaco.editor.createModel(file.content, file.language, uri)
  modelMap.set(file.path, model)
  return model
}

function disposeModel(path: string) {
  const model = modelMap.get(path)
  if (model) {
    model.dispose()
    modelMap.delete(path)
  }
}

// ─── 데모용 초기 파일 ─────────────────────────────────────────────────────────

const DEMO_FILES: EditorFile[] = [
  {
    path: 'welcome.ts',
    content: [
      '// Nexus Code Editor',
      '// Monaco Editor가 정상적으로 로드되었습니다.',
      '',
      'function greet(name: string): string {',
      '  return `Hello, ${name}!`',
      '}',
      '',
      'console.log(greet("Nexus"))',
      '',
    ].join('\n'),
    language: 'typescript',
    isDirty: false,
    isTemporary: true,
  },
]

// ─── 파일 확장자 → Monaco 언어 매핑 ─────────────────────────────────────────

function detectLanguage(filePath: string): string {
  const ext = filePath.split('.').pop()?.toLowerCase() ?? ''
  const map: Record<string, string> = {
    ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript',
    py: 'python', json: 'json', css: 'css', html: 'html', md: 'markdown',
    yaml: 'yaml', yml: 'yaml', sh: 'shell', bash: 'shell', sql: 'sql',
  }
  return map[ext] ?? 'plaintext'
}

// ─── EditorPanel ─────────────────────────────────────────────────────────────

export function EditorPanel() {
  const [files, setFiles] = useState<EditorFile[]>(DEMO_FILES)
  const [activeFilePath, setActiveFilePath] = useState<string | null>(DEMO_FILES[0]?.path ?? null)
  const monacoRef = useRef<Monaco | null>(null)
  const editorRef = useRef<monacoTypes.editor.IStandaloneCodeEditor | null>(null)
  const pendingOpen = useEditorStore((s) => s.pendingOpen)
  const consumeOpenRequest = useEditorStore((s) => s.consumeOpenRequest)
  const setEditorVisible = useEditorStore((s) => s.setEditorVisible)

  const activeFile = files.find((f) => f.path === activeFilePath) ?? null

  // 마운트/언마운트 시 에디터 가시성 추적
  useEffect(() => {
    setEditorVisible(true)
    return () => setEditorVisible(false)
  }, [setEditorVisible])

  // editor-store에서 openFile 요청 소비
  useEffect(() => {
    if (!pendingOpen) return
    const req = consumeOpenRequest()
    if (!req) return
    openFileFromRequest(req)
  }, [pendingOpen, consumeOpenRequest])

  const openFileFromRequest = useCallback((req: OpenFileRequest) => {
    setFiles((prev) => {
      // 이미 열려있으면 활성화만
      if (prev.some((f) => f.path === req.filePath)) {
        setActiveFilePath(req.filePath)
        return prev
      }
      const newFile: EditorFile = {
        path: req.filePath,
        content: req.content ?? '',
        language: req.language ?? detectLanguage(req.filePath),
        isDirty: false,
        isTemporary: req.isTemporary ?? false,
      }
      setActiveFilePath(req.filePath)
      return [...prev, newFile]
    })
  }, [])

  // Escape 키: Monaco 포커스 해제 → ChatInput으로 포커스 이동
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && editorRef.current?.hasTextFocus()) {
        e.preventDefault()
        e.stopPropagation()
        // ChatInput으로 포커스 이동
        const chatInput = document.querySelector<HTMLTextAreaElement>('[data-chat-input]')
        if (chatInput) {
          chatInput.focus()
        } else {
          editorRef.current?.getContainerDomNode()?.blur()
        }
      }
    }
    window.addEventListener('keydown', handleKeyDown, true)
    return () => window.removeEventListener('keydown', handleKeyDown, true)
  }, [])

  // 탭 전환: setModel
  useEffect(() => {
    const editor = editorRef.current
    const monaco = monacoRef.current
    if (!editor || !monaco || !activeFile) return

    const model = getOrCreateModel(monaco, activeFile)
    if (editor.getModel() !== model) {
      editor.setModel(model)
    }
  }, [activeFile])

  const handleEditorMount = useCallback((
    editor: monacoTypes.editor.IStandaloneCodeEditor,
    monaco: Monaco,
  ) => {
    monacoRef.current = monaco
    editorRef.current = editor

    defineNexusTheme(monaco)
    monaco.editor.setTheme('nexus-dark')

    // 초기 파일 모델 생성
    if (activeFile) {
      const model = getOrCreateModel(monaco, activeFile)
      editor.setModel(model)
    }

    // dirty 상태 추적
    editor.onDidChangeModelContent(() => {
      const currentModel = editor.getModel()
      if (!currentModel) return
      const path = currentModel.uri.path.replace(/^\//, '')
      setFiles((prev) =>
        prev.map((f) => (f.path === path ? { ...f, isDirty: true } : f)),
      )
    })
  }, [activeFile])

  const handleClose = useCallback((path: string) => {
    setFiles((prev) => {
      const next = prev.filter((f) => f.path !== path)
      if (activeFilePath === path) {
        setActiveFilePath(next[0]?.path ?? null)
      }
      return next
    })
    disposeModel(path)
  }, [activeFilePath])

  // 파일이 없을 때
  if (files.length === 0) {
    return (
      <div className="flex h-full items-center justify-center bg-background">
        <EmptyState
          size="sm"
          icon={<FileCode2 className="h-full w-full" />}
          title="열린 파일 없음"
          description="Cmd+E로 에디터를 열 수 있습니다"
        />
      </div>
    )
  }

  const isMarkdown = activeFile?.language === 'markdown' || activeFile?.path.endsWith('.md')

  const editorElement = activeFile ? (
    <Editor
      theme="nexus-dark"
      defaultLanguage={activeFile.language}
      options={{
        automaticLayout: true,
        minimap: { enabled: !isMarkdown },
        scrollBeyondLastLine: false,
        fontSize: 13,
        lineNumbers: 'on',
        renderWhitespace: 'selection',
        bracketPairColorization: { enabled: true },
        padding: { top: 8 },
      }}
      onMount={handleEditorMount}
    />
  ) : null

  // 현재 활성 모델 (MarkdownPreview에 전달)
  const activeModel = activeFile && monacoRef.current
    ? getOrCreateModel(monacoRef.current, activeFile)
    : null

  return (
    <div className="flex h-full flex-col bg-background">
      <EditorTabBar
        files={files}
        activeFilePath={activeFilePath}
        onSelect={setActiveFilePath}
        onClose={handleClose}
      />
      <div className="min-h-0 flex-1">
        {activeFile && isMarkdown ? (
          <MarkdownPreview model={activeModel} editorElement={editorElement} />
        ) : (
          editorElement
        )}
      </div>
    </div>
  )
}
