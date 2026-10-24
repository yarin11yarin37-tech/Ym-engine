import { createContext, useContext, useSyncExternalStore } from 'react';
import type { EngineController, UiSnapshot } from '../services/EngineController';

export const ControllerContext = createContext<EngineController | null>(null);

export function useController(): EngineController {
  const c = useContext(ControllerContext);
  if (!c) throw new Error('EngineController missing');
  return c;
}

/** Throttled (~12 Hz) UI snapshot; never re-renders at audio-frame rate. */
export function useSnapshot(): UiSnapshot {
  const c = useController();
  return useSyncExternalStore(c.subscribe, c.getSnapshot, c.getSnapshot);
}
