import './app.css'
import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import { initIpcBridge } from './ipc-bridge'
import { useSettingsStore } from './stores/settings-store'

initIpcBridge()

// 저장된 테마를 DOM에 즉시 적용 (React 마운트 전에 처리)
const initialTheme = useSettingsStore.getState().theme
document.documentElement.setAttribute('data-theme', initialTheme)

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
