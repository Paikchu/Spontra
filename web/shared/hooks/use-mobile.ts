import { useCallback, useSyncExternalStore } from "react"

const MOBILE_BREAKPOINT = 768
const getServerSnapshot = () => false

export function useIsMobile(breakpoint = MOBILE_BREAKPOINT) {
  const query = `(max-width: ${breakpoint - 1}px)`
  const subscribe = useCallback((onChange: () => void) => {
    const media = window.matchMedia(query)
    media.addEventListener("change", onChange)
    return () => media.removeEventListener("change", onChange)
  }, [query])
  const getSnapshot = useCallback(() => window.matchMedia(query).matches, [query])
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot)
}
