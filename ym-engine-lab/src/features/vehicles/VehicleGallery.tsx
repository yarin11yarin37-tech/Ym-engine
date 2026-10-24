import type { CSSProperties } from 'react';
import { VEHICLES } from '../../data/vehicles';
import { baseUrl } from '../../utils/env';

const INDUCTION: Record<string, string> = {
  none: 'Naturally aspirated',
  turbo: 'Turbocharged',
  'twin-turbo': 'Twin-turbo',
  supercharger: 'Supercharged',
};

export function VehicleGallery({ selectedId, onSelect }: { selectedId: string; onSelect: (id: string) => void }) {
  return (
    <div className="gallery" role="radiogroup" aria-label="Engine sound profile">
      {VEHICLES.map((v) => {
        const on = v.id === selectedId;
        return (
          <button
            key={v.id}
            type="button"
            role="radio"
            aria-checked={on}
            className={`vcard${on ? ' is-on' : ''}`}
            style={{ '--accent': v.ui.accent, '--accent-soft': v.ui.accentSoft } as CSSProperties}
            onClick={() => onSelect(v.id)}
          >
            <span className="vcard__media">
              {v.ui.image ? (
                <img src={baseUrl() + v.ui.image} alt="" loading="lazy" onError={(e) => (e.currentTarget.style.display = 'none')} />
              ) : (
                <span className="vcard__placeholder">Photo slot</span>
              )}
            </span>
            <span className="vcard__body">
              <span className="vcard__name">{v.displayName}</span>
              <span className="vcard__spec">{v.engineLabel}</span>
              <span className="vcard__meta">
                {INDUCTION[v.induction]}, redline {v.rpm.redline.toLocaleString('en-US')} rpm
              </span>
            </span>
          </button>
        );
      })}
    </div>
  );
}
