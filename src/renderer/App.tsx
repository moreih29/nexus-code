import { useEffect } from 'react'
import { AppLayout } from './components/layout/AppLayout'
import { IpcChannel } from '../shared/ipc'
import type { PluginDataEvent } from '../shared/types'
import { usePluginStore } from './stores/plugin-store'

function App(): JSX.Element {
  const handlePluginData = usePluginStore((s) => s.handlePluginData)

  useEffect(() => {
    const handler = (event: PluginDataEvent): void => {
      handlePluginData(event)
    }
    window.electronAPI.on(IpcChannel.PLUGIN_DATA, handler as (...args: unknown[]) => void)
    return () => {
      window.electronAPI.off(IpcChannel.PLUGIN_DATA, handler as (...args: unknown[]) => void)
    }
  }, [handlePluginData])

  return <AppLayout />
}

export default App
