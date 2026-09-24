import * as React from "react"

const MOBILE_BREAKPOINT = 768
const QUERY = `(max-width: ${MOBILE_BREAKPOINT - 1}px)`

function subscribe(onChange: () => void) {
  const mql = window.matchMedia(QUERY)
  mql.addEventListener("change", onChange)
  return () => mql.removeEventListener("change", onChange)
}

/** Whether the layout is the phone's: a narrow viewport, or the Android app at any width; false on the server and until hydrated. */
export function useIsMobile() {
  return React.useSyncExternalStore(
    subscribe,
    () => Boolean(window.kruMobile) || window.matchMedia(QUERY).matches,
    () => false
  )
}

const COARSE = "(pointer: coarse)"

function subscribeCoarse(onChange: () => void) {
  const mql = window.matchMedia(COARSE)
  mql.addEventListener("change", onChange)
  return () => mql.removeEventListener("change", onChange)
}

/** Whether the main input is a touch screen; false on the server and until hydrated. */
export function useCoarsePointer() {
  return React.useSyncExternalStore(
    subscribeCoarse,
    () => window.matchMedia(COARSE).matches,
    () => false
  )
}
