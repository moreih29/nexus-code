import { useCallback } from 'react'
import { useLayoutStore } from '../../stores/layout-store'

const MIN_WIDTH = 200
const MAX_WIDTH_RATIO = 0.6

export function ResizeHandle() {
  const setRightPanelWidth = useLayoutStore((s) => s.setRightPanelWidth)

  const onMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault()
      const startX = e.clientX
      const startWidth = useLayoutStore.getState().rightPanelWidth

      const onMouseMove = (ev: MouseEvent) => {
        const delta = startX - ev.clientX
        const maxWidth = window.innerWidth * MAX_WIDTH_RATIO
        const newWidth = Math.min(maxWidth, Math.max(MIN_WIDTH, startWidth + delta))
        setRightPanelWidth(newWidth)
      }

      const onMouseUp = () => {
        document.removeEventListener('mousemove', onMouseMove)
        document.removeEventListener('mouseup', onMouseUp)
        document.body.style.cursor = ''
        document.body.style.userSelect = ''
      }

      document.body.style.cursor = 'col-resize'
      document.body.style.userSelect = 'none'
      document.addEventListener('mousemove', onMouseMove)
      document.addEventListener('mouseup', onMouseUp)
    },
    [setRightPanelWidth],
  )

  return (
    <div
      onMouseDown={onMouseDown}
      className="absolute top-0 left-0 w-1 h-full cursor-col-resize z-10 hover:bg-accent/40 transition-colors"
    />
  )
}
