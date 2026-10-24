import { useEffect, useState } from 'react';
import { BRAND } from '../config/brand';
import { ControllerContext, useSnapshot } from '../hooks/useController';
import { EngineController } from '../services/EngineController';
import { ErrorBoundary } from '../components/ErrorBoundary';
import { StartScreen } from '../components/StartScreen';
import { Cockpit } from '../features/dashboard/Cockpit';

function Screens() {
  const snap = useSnapshot();
  return snap.started ? <Cockpit /> : <StartScreen />;
}

export function App() {
  // One controller for the app lifetime; disposed on unmount (StrictMode-safe).
  const [controller, setController] = useState<EngineController | null>(null);
  useEffect(() => {
    const c = new EngineController();
    setController(c);
    document.title = BRAND.name;
    return () => {
      void c.dispose();
    };
  }, []);

  if (!controller) return null;
  return (
    <ErrorBoundary>
      <ControllerContext.Provider value={controller}>
        <Screens />
      </ControllerContext.Provider>
    </ErrorBoundary>
  );
}
