import type { ReactNode } from 'react';
import type { AudioStatus } from '../features/audio/AudioEngine';
import { useController } from '../hooks/useController';

export function VolumeControl({ value, compact = false }: { value: number; compact?: boolean }) {
  const c = useController();
  return (
    <label className={`volume${compact ? ' volume--compact' : ''}`}>
      <span className="volume__label">Volume</span>
      <input
        type="range"
        min={0}
        max={100}
        step={1}
        value={Math.round(value * 100)}
        onChange={(e) => c.setVolume(Number(e.currentTarget.value) / 100)}
        aria-valuetext={`${Math.round(value * 100)} percent`}
      />
      <span className="volume__value">{Math.round(value * 100)}</span>
    </label>
  );
}

const AUDIO_LABEL: Record<AudioStatus, string> = {
  idle: 'Sound ready to start',
  starting: 'Starting sound',
  running: 'Sound on',
  suspended: 'Sound paused',
  error: 'Sound unavailable',
  closed: 'Sound off',
};

export function SoundStatus({ status }: { status: AudioStatus }) {
  return (
    <span className={`status status--${status}`} role="status">
      <i aria-hidden="true" />
      {AUDIO_LABEL[status]}
    </span>
  );
}

interface SegmentOption<T extends string> {
  value: T;
  label: string;
  hint?: string;
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
  name,
  disabled,
}: {
  value: T;
  options: SegmentOption<T>[];
  onChange: (v: T) => void;
  name: string;
  disabled?: boolean;
}) {
  return (
    <div className="segmented" role="radiogroup" aria-label={name}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          disabled={disabled}
          className={`segmented__opt${value === o.value ? ' is-on' : ''}`}
          onClick={() => onChange(o.value)}
        >
          <span>{o.label}</span>
          {o.hint && <small>{o.hint}</small>}
        </button>
      ))}
    </div>
  );
}

export function SimTag({ children = 'Simulated' }: { children?: ReactNode }) {
  return <span className="simtag">{children}</span>;
}
