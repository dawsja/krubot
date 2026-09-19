"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

/*
 * A swipe in from the left edge goes back, the way a phone's screens do.
 * Only on the phone layout (narrow, or inside the Android app): a desktop
 * with a touch screen keeps its sidebar and needs no gesture.
 */
const EDGE = 28;
const DISTANCE = 72;

export function useSwipeBack(href: string, enabled = true) {
  const router = useRouter();
  useEffect(() => {
    if (!enabled) return;
    let start: { x: number; y: number } | null = null;
    const phone = () => document.documentElement.dataset.shell === "android" || window.matchMedia("(width < 48rem)").matches;
    const onStart = (event: TouchEvent) => {
      const touch = event.touches[0];
      start = touch && touch.clientX <= EDGE && phone() ? { x: touch.clientX, y: touch.clientY } : null;
    };
    const onMove = (event: TouchEvent) => {
      const touch = event.touches[0];
      if (!start || !touch) return;
      const dx = touch.clientX - start.x;
      const dy = Math.abs(touch.clientY - start.y);
      if (dy > 40) start = null;
      else if (dx >= DISTANCE) {
        start = null;
        router.push(href);
      }
    };
    const onEnd = () => {
      start = null;
    };
    window.addEventListener("touchstart", onStart, { passive: true });
    window.addEventListener("touchmove", onMove, { passive: true });
    window.addEventListener("touchend", onEnd);
    window.addEventListener("touchcancel", onEnd);
    return () => {
      window.removeEventListener("touchstart", onStart);
      window.removeEventListener("touchmove", onMove);
      window.removeEventListener("touchend", onEnd);
      window.removeEventListener("touchcancel", onEnd);
    };
  }, [href, enabled, router]);
}
