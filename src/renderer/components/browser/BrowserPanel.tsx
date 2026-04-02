import { useCallback, useEffect, useRef, useState } from 'react'
import { ArrowLeft, ArrowRight, RotateCw, Camera, X, Wrench } from 'lucide-react'
import { cn } from '../../lib/utils'

// ─── URL 허용 정책 ───────────────────────────────────────────────────────────

const ALLOWED_HOSTS = ['localhost', '127.0.0.1', '0.0.0.0', '[::1]']

function isAllowedUrl(url: string): boolean {
  try {
    const parsed = new URL(url)
    return ALLOWED_HOSTS.some((h) => parsed.hostname === h)
  } catch {
    return false
  }
}

// ─── Electron webview 태그 타입 보강 ─────────────────────────────────────────

interface WebviewElement extends HTMLElement {
  src: string
  loadURL: (url: string) => Promise<void>
  goBack: () => void
  goForward: () => void
  reload: () => void
  canGoBack: () => boolean
  canGoForward: () => boolean
  isLoading: () => boolean
  getURL: () => string
  openDevTools: () => void
  closeDevTools: () => void
  isDevToolsOpened: () => boolean
  capturePage: () => Promise<{ toDataURL: () => string }>
  addEventListener: (event: string, handler: (...args: unknown[]) => void) => void
  removeEventListener: (event: string, handler: (...args: unknown[]) => void) => void
}

// ─── BrowserPanel ────────────────────────────────────────────────────────────

export function BrowserPanel() {
  const webviewRef = useRef<WebviewElement | null>(null)
  const [url, setUrl] = useState('http://localhost:3000')
  const [inputUrl, setInputUrl] = useState('http://localhost:3000')
  const [isLoading, setIsLoading] = useState(false)
  const [canGoBack, setCanGoBack] = useState(false)
  const [canGoForward, setCanGoForward] = useState(false)
  const [devToolsOpen, setDevToolsOpen] = useState(false)
  const [capturedImage, setCapturedImage] = useState<string | null>(null)

  // webview 이벤트 등록
  useEffect(() => {
    const wv = webviewRef.current
    if (!wv) return

    const onStartLoading = () => setIsLoading(true)
    const onStopLoading = () => {
      setIsLoading(false)
      setCanGoBack(wv.canGoBack())
      setCanGoForward(wv.canGoForward())
      setUrl(wv.getURL())
      setInputUrl(wv.getURL())
    }
    const onNavigate = () => {
      setUrl(wv.getURL())
      setInputUrl(wv.getURL())
    }

    wv.addEventListener('did-start-loading', onStartLoading)
    wv.addEventListener('did-stop-loading', onStopLoading)
    wv.addEventListener('did-navigate', onNavigate)
    wv.addEventListener('did-navigate-in-page', onNavigate)

    return () => {
      wv.removeEventListener('did-start-loading', onStartLoading)
      wv.removeEventListener('did-stop-loading', onStopLoading)
      wv.removeEventListener('did-navigate', onNavigate)
      wv.removeEventListener('did-navigate-in-page', onNavigate)
    }
  }, [])

  const navigate = useCallback((targetUrl: string) => {
    const wv = webviewRef.current
    if (!wv) return

    // URL 정규화
    let normalized = targetUrl.trim()
    if (!normalized.startsWith('http://') && !normalized.startsWith('https://')) {
      normalized = `http://${normalized}`
    }

    if (!isAllowedUrl(normalized)) {
      // 외부 URL → 시스템 기본 브라우저로 위임
      window.open(normalized, '_blank')
      return
    }

    wv.src = normalized
    setUrl(normalized)
  }, [])

  const handleUrlSubmit = useCallback((e: React.FormEvent) => {
    e.preventDefault()
    navigate(inputUrl)
  }, [inputUrl, navigate])

  const handleCapture = useCallback(async () => {
    const wv = webviewRef.current
    if (!wv) return

    try {
      const image = await wv.capturePage()
      const dataUrl = image.toDataURL()
      setCapturedImage(dataUrl)
      // ChatInput에 이미지 첨부 이벤트 전달
      const base64 = dataUrl.replace(/^data:image\/png;base64,/, '')
      window.dispatchEvent(new CustomEvent('browser-screenshot', {
        detail: { mediaType: 'image/png', data: base64 },
      }))
    } catch {
      // 캡처 실패 시 무시
    }
  }, [])

  const toggleDevTools = useCallback(() => {
    const wv = webviewRef.current
    if (!wv) return

    if (wv.isDevToolsOpened()) {
      wv.closeDevTools()
      setDevToolsOpen(false)
    } else {
      wv.openDevTools()
      setDevToolsOpen(true)
    }
  }, [])

  return (
    <div className="flex h-full flex-col bg-background">
      {/* 상단 네비게이션 바 */}
      <div className="flex h-9 shrink-0 items-center gap-1 border-b border-border bg-card px-2">
        <NavButton
          icon={<ArrowLeft size={14} />}
          disabled={!canGoBack}
          onClick={() => webviewRef.current?.goBack()}
          title="뒤로"
        />
        <NavButton
          icon={<ArrowRight size={14} />}
          disabled={!canGoForward}
          onClick={() => webviewRef.current?.goForward()}
          title="앞으로"
        />
        <NavButton
          icon={<RotateCw size={14} className={isLoading ? 'animate-spin' : ''} />}
          onClick={() => webviewRef.current?.reload()}
          title="새로고침"
        />

        {/* URL 입력 */}
        <form onSubmit={handleUrlSubmit} className="flex min-w-0 flex-1 px-1">
          <input
            type="text"
            value={inputUrl}
            onChange={(e) => setInputUrl(e.target.value)}
            className="w-full rounded bg-muted px-2 py-1 text-xs text-foreground outline-none focus:ring-1 focus:ring-ring font-mono"
            placeholder="URL 입력..."
          />
        </form>

        <NavButton
          icon={<X size={14} />}
          onClick={() => { /* 패널 닫기는 PanelGrid에서 처리 */ }}
          title="닫기"
        />
      </div>

      {/* webview 영역 */}
      <div className="min-h-0 flex-1">
        <webview
          ref={webviewRef as React.Ref<HTMLElement>}
          src={url}
          partition="browser-panel"
          webpreferences="contextIsolation=yes, nodeIntegration=no, sandbox=yes"
          allowpopups={false}
          style={{ width: '100%', height: '100%' }}
        />
      </div>

      {/* 하단 액션 바 */}
      <div className="flex h-7 shrink-0 items-center justify-between border-t border-border bg-card px-2">
        <div className="flex items-center gap-2">
          <button
            onClick={() => void handleCapture()}
            className="flex items-center gap-1 rounded px-2 py-0.5 text-xs text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
            title="스크린샷 캡처"
          >
            <Camera size={12} />
            <span>캡처</span>
          </button>
          <button
            onClick={toggleDevTools}
            className={cn(
              'flex items-center gap-1 rounded px-2 py-0.5 text-xs transition-colors',
              devToolsOpen
                ? 'bg-primary/15 text-primary'
                : 'text-muted-foreground hover:bg-muted hover:text-foreground',
            )}
            title="DevTools 토글"
          >
            <Wrench size={12} />
            <span>DevTools</span>
          </button>
        </div>

        {/* 캡처 프리뷰 */}
        {capturedImage && (
          <div className="flex items-center gap-1">
            <span className="text-xs text-success">캡처됨</span>
            <button
              onClick={() => setCapturedImage(null)}
              className="text-xs text-muted-foreground hover:text-foreground"
            >
              ✕
            </button>
          </div>
        )}

        <span className="text-xs text-dim-foreground">
          {isLoading ? '로딩 중...' : new URL(url).hostname}
        </span>
      </div>
    </div>
  )
}

function NavButton({ icon, disabled, onClick, title }: {
  icon: React.ReactNode
  disabled?: boolean
  onClick: () => void
  title: string
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={cn(
        'flex h-6 w-6 items-center justify-center rounded transition-colors',
        disabled
          ? 'text-muted-foreground/30 cursor-not-allowed'
          : 'text-muted-foreground hover:bg-muted hover:text-foreground',
      )}
      title={title}
    >
      {icon}
    </button>
  )
}
