import { useThree } from '@react-three/fiber'
import { useEffect } from 'react'

/**
 * Stops the render loop while the page is hidden, so a background tab does no
 * work. Restarting the loop also restarts its clock, so the first frame back
 * advances by one frame's time rather than the whole absence.
 */
export function PauseWhenHidden() {
  const setFrameloop = useThree((s) => s.setFrameloop)
  const invalidate = useThree((s) => s.invalidate)
  useEffect(() => {
    const sync = () => {
      if (document.hidden) return setFrameloop('never')
      setFrameloop('always')
      // A stopped loop only restarts when asked for a frame.
      invalidate()
    }
    if (document.hidden) setFrameloop('never')
    document.addEventListener('visibilitychange', sync)
    return () => document.removeEventListener('visibilitychange', sync)
  }, [setFrameloop, invalidate])
  return null
}
