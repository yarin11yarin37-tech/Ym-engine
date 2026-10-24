import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { useController } from '../../hooks/useController';

/**
 * Hold-to-accelerate pedal. Releases on pointerup, pointercancel, lostpointercapture,
 * context menu (long-press), unmount — and the controller also releases on blur and
 * when the tab is hidden — so the throttle can never stay stuck.
 */
export function AcceleratorPedal({ disabled }: { disabled?: boolean }) {
  const c = useController();
  const ref = useRef<HTMLButtonElement>(null);
  const active = useRef(new Set<number>());
  const [pressed, setPressed] = useState(false);

  const release = (id: number) => {
    if (!active.current.has(id)) return;
    active.current.delete(id);
    c.releasePedal(`pointer:${id}`);
    if (active.current.size === 0) {
      setPressed(false);
      if (anchor.current) c.setPedalLevel(c.selectedPedalLevel, true); // remember a dragged amount
      anchor.current = null;
    }
  };

  // Where the finger first touched and the gas amount at that moment.
  const anchor = useRef<{ y: number; level: number } | null>(null);

  /** Dragging up from the touch point adds gas, down removes it (full pedal height = full range). */
  const onMove = (e: ReactPointerEvent<HTMLButtonElement>) => {
    if (!active.current.has(e.pointerId) || !anchor.current) return;
    const h = e.currentTarget.getBoundingClientRect().height || 1;
    const level = Math.min(1, Math.max(0.1, anchor.current.level + (anchor.current.y - e.clientY) / (h * 0.75)));
    c.setPedalLevel(level, false);
    c.pressPedal(`pointer:${e.pointerId}`, level);
  };

  const onDown = (e: ReactPointerEvent<HTMLButtonElement>) => {
    if (disabled || (e.pointerType === 'mouse' && e.button !== 0)) return;
    e.preventDefault();
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      /* capture is optional */
    }
    active.current.add(e.pointerId);
    anchor.current = { y: e.clientY, level: c.selectedPedalLevel };
    c.pressPedal(`pointer:${e.pointerId}`);
    setPressed(true);
  };

  // Live depth indicator, written straight to a CSS variable (no React renders).
  useEffect(() => {
    let raf = 0;
    const tick = () => {
      raf = requestAnimationFrame(tick);
      ref.current?.style.setProperty('--depth', c.live.throttle.toFixed(3));
    };
    raf = requestAnimationFrame(tick);
    const ids = active.current;
    return () => {
      cancelAnimationFrame(raf);
      ids.forEach((id) => c.releasePedal(`pointer:${id}`));
      ids.clear();
    };
  }, [c]);

  useEffect(() => {
    if (disabled && active.current.size) {
      active.current.forEach((id) => c.releasePedal(`pointer:${id}`));
      active.current.clear();
      setPressed(false);
    }
  }, [disabled, c]);

  return (
    <button
      ref={ref}
      type="button"
      className={`pedal${pressed ? ' is-pressed' : ''}`}
      disabled={disabled}
      aria-label="Accelerator. Press to give the selected amount of gas; drag up or down to change it."
      aria-pressed={pressed}
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={(e) => release(e.pointerId)}
      onPointerCancel={(e) => release(e.pointerId)}
      onLostPointerCapture={(e) => release(e.pointerId)}
      onContextMenu={(e) => e.preventDefault()}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && !e.repeat) {
          e.preventDefault();
          c.pressPedal('key:pedal');
          setPressed(true);
        }
      }}
      onKeyUp={(e) => {
        if (e.key === 'Enter') {
          c.releasePedal('key:pedal');
          setPressed(false);
        }
      }}
      onBlur={() => {
        c.releasePedal('key:pedal');
        if (active.current.size === 0) setPressed(false);
      }}
    >
      <span className="pedal__fill" aria-hidden="true" />
      <span className="pedal__grip" aria-hidden="true" />
      <span className="pedal__label">
        Press for gas
        <small>Drag up or down to change</small>
      </span>
    </button>
  );
}
