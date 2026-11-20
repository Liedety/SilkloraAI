import React, { useEffect, useRef, useState } from 'react';
import { Loader2, X } from 'lucide-react';
import { clampActivityPercent, formatActivityElapsed } from '../utils/activityTimer';

export { clampActivityPercent, formatActivityElapsed };

export interface ActivityProgressBarProps {
  label: string;
  sublabel?: string;
  progress?: number | null;
  stepInfo?: { step: number; totalSteps: number } | null;
  startedAt?: number;
  language?: 'en' | 'ru';
  accent?: 'emerald' | 'violet' | 'amber' | 'slate';
  compact?: boolean;
  onCancel?: () => void;
  cancelLabel?: string;
  className?: string;
}

const ACCENT_FILL: Record<NonNullable<ActivityProgressBarProps['accent']>, string> = {
  emerald: 'bg-emerald-500/85',
  violet: 'bg-violet-500/85',
  amber: 'bg-amber-500/85',
  slate: 'bg-slate-400/85',
};

const ACCENT_SPIN: Record<NonNullable<ActivityProgressBarProps['accent']>, string> = {
  emerald: 'text-emerald-400',
  violet: 'text-violet-400',
  amber: 'text-amber-400',
  slate: 'text-slate-300',
};

export const ActivityProgressBar: React.FC<ActivityProgressBarProps> = ({
  label,
  sublabel,
  progress,
  stepInfo,
  startedAt,
  language = 'en',
  accent = 'slate',
  compact = false,
  onCancel,
  cancelLabel,
  className = '',
}) => {
  const mountRef = useRef<number>(Date.now());
  const effectiveStart = startedAt && startedAt > 0 ? startedAt : mountRef.current;
  const [now, setNow] = useState<number>(() => Date.now());

  useEffect(() => {
    setNow(Date.now());
    const timer = setInterval(() => {
      setNow(Date.now());
    }, 1000);
    return () => clearInterval(timer);
  }, [effectiveStart]);

  const elapsedSec = Math.max(0, Math.floor((now - effectiveStart) / 1000));
  const clampedPct = clampActivityPercent(progress);

  const metaParts: string[] = [];
  if (stepInfo && stepInfo.totalSteps > 0 && stepInfo.step > 0) {
    metaParts.push(`${stepInfo.step}/${stepInfo.totalSteps}`);
  }
  if (clampedPct !== null) {
    metaParts.push(`${clampedPct}%`);
  }
  metaParts.push(formatActivityElapsed(elapsedSec, language));

  const fillClass = ACCENT_FILL[accent] || ACCENT_FILL.slate;
  const spinClass = ACCENT_SPIN[accent] || ACCENT_SPIN.slate;

  return (
    <div
      role="status"
      aria-live="polite"
      className={`rounded-xl bg-silk-950/85 border border-silk-800 ${
        compact ? 'px-3 py-2 space-y-1.5' : 'px-3.5 py-2.5 space-y-2'
      } ${className}`}
    >
      <div className="flex items-center justify-between gap-2 min-w-0">
        <div className="flex items-center gap-2 min-w-0">
          <Loader2 className={`${compact ? 'w-3.5 h-3.5' : 'w-4 h-4'} animate-spin shrink-0 ${spinClass}`} />
          <span className={`${compact ? 'text-[11px]' : 'text-xs'} font-medium text-slate-200 truncate`}>
            {label}
          </span>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <span className="text-[11px] font-mono text-slate-400 tabular-nums">
            {metaParts.join(' · ')}
          </span>
          {onCancel && (
            <button
              type="button"
              onClick={onCancel}
              className="inline-flex items-center gap-1 px-2 py-0.5 rounded-lg bg-silk-900 hover:bg-red-500/15 border border-silk-700 hover:border-red-500/40 text-[11px] text-slate-300 hover:text-red-300 transition-colors"
            >
              <X className="w-3 h-3" />
              {cancelLabel ? <span>{cancelLabel}</span> : null}
            </button>
          )}
        </div>
      </div>

      <div className="w-full h-1.5 rounded-full bg-silk-900 border border-silk-800/80 overflow-hidden">
        {clampedPct !== null ? (
          <div
            className={`h-full rounded-full ${fillClass} progress-sheen transition-all duration-300`}
            style={{ width: `${clampedPct}%` }}
          />
        ) : (
          <div className={`h-full rounded-full ${fillClass} progress-indeterminate-bar`} />
        )}
      </div>

      {sublabel ? (
        <p className="text-[11px] text-slate-400 truncate leading-snug">{sublabel}</p>
      ) : null}
    </div>
  );
};
