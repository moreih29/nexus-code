export function BrowserView() {
  return (
    <div className="flex flex-col flex-1 overflow-hidden">
      {/* Browser toolbar */}
      <div className="flex items-center gap-2 px-3 py-2 bg-bg-elevated border-b border-border">
        <div className="flex gap-0.5">
          <button className="bg-transparent border-none text-text-muted cursor-pointer text-[14px] px-1.5 py-0.5 rounded hover:text-text-primary hover:bg-bg-hover transition-colors">
            ←
          </button>
          <button className="bg-transparent border-none text-text-muted cursor-pointer text-[14px] px-1.5 py-0.5 rounded hover:text-text-primary hover:bg-bg-hover transition-colors">
            →
          </button>
          <button className="bg-transparent border-none text-text-muted cursor-pointer text-[14px] px-1.5 py-0.5 rounded hover:text-text-primary hover:bg-bg-hover transition-colors">
            ↻
          </button>
        </div>
        <input
          className="flex-1 bg-bg-base border border-border rounded px-2.5 py-1 text-[11px] text-text-secondary font-sans outline-none"
          value="http://localhost:5173"
          readOnly
        />
      </div>

      {/* Browser content area */}
      <div
        className="flex-1 flex flex-col items-center justify-start p-5 overflow-y-auto"
        style={{ background: '#1a1a2e' }}
      >
        <div
          className="w-full max-w-[500px] rounded-lg p-6"
          style={{ background: 'white', color: '#1a1a2e' }}
        >
          <h2 className="text-[16px] font-semibold mb-3" style={{ color: '#111' }}>
            Nexus Code
          </h2>
          <p className="text-[12px] leading-relaxed mb-2.5" style={{ color: '#555' }}>
            워크스페이스 3개 등록됨
          </p>

          {/* Mock workspace cards */}
          <div className="flex items-center gap-2.5 p-3 border rounded-lg mb-2" style={{ borderColor: '#e0e0e0' }}>
            <div className="w-2 h-2 rounded-full flex-shrink-0" style={{ background: '#22c55e' }} />
            <div>
              <div className="font-semibold text-[13px]" style={{ color: '#111' }}>nexus-code</div>
              <div className="text-[11px]" style={{ color: '#888' }}>feat/ui-redesign</div>
            </div>
          </div>

          <div className="flex items-center gap-2.5 p-3 border rounded-lg mb-2" style={{ borderColor: '#e0e0e0' }}>
            <div className="w-2 h-2 rounded-full flex-shrink-0" style={{ background: '#eab308' }} />
            <div>
              <div className="font-semibold text-[13px]" style={{ color: '#111' }}>api-server</div>
              <div className="text-[11px]" style={{ color: '#888' }}>fix/auth-bug</div>
            </div>
          </div>

          <div className="flex items-center gap-2.5 p-3 border rounded-lg mb-2" style={{ borderColor: '#e0e0e0' }}>
            <div className="w-2 h-2 rounded-full flex-shrink-0" style={{ background: '#9ca3af' }} />
            <div>
              <div className="font-semibold text-[13px]" style={{ color: '#111' }}>docs-site</div>
              <div className="text-[11px]" style={{ color: '#888' }}>main</div>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
