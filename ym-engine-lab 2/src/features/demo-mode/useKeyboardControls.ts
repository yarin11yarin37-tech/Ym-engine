import { useEffect } from 'react';
import type { EngineController } from '../../services/EngineController';

/**
 * Desktop keys: Space / ↑ / W = throttle (hold), E / → = gear up, Q / ← = gear down,
 * B = blip, I = return to idle. Keys release on keyup, blur and unmount.
 */
export function useKeyboardControls(c: EngineController, enabled: boolean): void {
  useEffect(() => {
    if (!enabled) return;
    const throttleKeys = new Set([' ', 'ArrowUp', 'w', 'W']);
    const held = new Set<string>();
    const isTyping = (t: EventTarget | null) =>
      t instanceof HTMLElement && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT');

    const down = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (throttleKeys.has(e.key)) {
        if (isTyping(e.target)) return;
        e.preventDefault();
        if (!held.has(e.key)) {
          held.add(e.key);
          c.pressPedal(`key:${e.key}`);
        }
        return;
      }
      if (e.repeat) return;
      switch (e.key) {
        case 'e':
        case 'E':
        case 'ArrowRight':
          c.gearUp();
          break;
        case 'q':
        case 'Q':
        case 'ArrowLeft':
          c.gearDown();
          break;
        case 'b':
        case 'B':
          c.blip();
          break;
        case 'i':
        case 'I':
          c.returnToIdle();
          break;
      }
    };
    const up = (e: KeyboardEvent) => {
      // Space on a focused button would otherwise "click" it on keyup.
      if (e.key === ' ' && !isTyping(e.target)) e.preventDefault();
      if (held.delete(e.key)) c.releasePedal(`key:${e.key}`);
    };
    const releaseAll = () => {
      held.forEach((k) => c.releasePedal(`key:${k}`));
      held.clear();
    };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    window.addEventListener('blur', releaseAll);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
      window.removeEventListener('blur', releaseAll);
      releaseAll();
    };
  }, [c, enabled]);
}
