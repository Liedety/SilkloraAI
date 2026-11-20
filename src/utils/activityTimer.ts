export function formatActivityElapsed(elapsedSec: number, language: 'en' | 'ru' = 'en'): string {
  const safe = Number.isFinite(elapsedSec) ? Math.max(0, Math.floor(elapsedSec)) : 0;
  if (safe < 60) {
    return language === 'ru' ? `${safe} с` : `${safe}s`;
  }
  const mins = Math.floor(safe / 60);
  const rem = safe % 60;
  const padRem = rem < 10 ? `0${rem}` : String(rem);
  return language === 'ru' ? `${mins} мин ${padRem} с` : `${mins}m ${padRem}s`;
}

export function clampActivityPercent(progress?: number | null): number | null {
  if (typeof progress !== 'number' || !Number.isFinite(progress) || progress <= 0) {
    return null;
  }
  return Math.max(4, Math.min(100, Math.round(progress)));
}
