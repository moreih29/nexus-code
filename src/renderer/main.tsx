import './app.css'
import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import { initIpcBridge } from './ipc-bridge'

initIpcBridge()

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
