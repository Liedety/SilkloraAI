import type { ThemeConfig } from '../types/index.ts';
import { fontStack } from './fonts.ts';

export const THEME_CACHE_STORAGE_KEY = 'silklora_theme_cache_v1';

export const FALLBACK_THEME_BASE: ThemeConfig = {
  id: 'graphite',
  name: 'Graphite',
  accentColor: '#52525b',
  actionColor: '#a1a1aa',
  appBgColor: '#09090b',
  appSurfaceColor: '#111114',
  bubbleUserBg: '#222227',
  bubbleBotBg: '#141418',
  bubbleRadius: 16,
  bubbleOpacity: 0.92,
  fontSize: 15,
  backgroundTint: 0.72,
  fontFamily: 'sans',
  usePixelUiFont: false,
  lineHeight: 'relaxed',
};

const VALID_FONTS = new Set<NonNullable<ThemeConfig['fontFamily']>>(['sans', 'serif', 'mono', 'pixel']);
const VALID_LINE_HEIGHTS = new Set<NonNullable<ThemeConfig['lineHeight']>>(['normal', 'relaxed', 'loose']);

export function isValidHexColor(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  return /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(value.trim());
}

export function parseHexColor(
  hex: string | undefined,
  fallback: [number, number, number] = [82, 82, 91]
): [number, number, number] {
  const clean = (hex || '').replace('#', '').trim();
  if (clean.length === 3) {
    const r = parseInt(clean[0] + clean[0], 16);
    const g = parseInt(clean[1] + clean[1], 16);
    const b = parseInt(clean[2] + clean[2], 16);
    if (!Number.isNaN(r) && !Number.isNaN(g) && !Number.isNaN(b)) return [r, g, b];
  } else if (clean.length >= 6) {
    const r = parseInt(clean.substring(0, 2), 16);
    const g = parseInt(clean.substring(2, 4), 16);
    const b = parseInt(clean.substring(4, 6), 16);
    if (!Number.isNaN(r) && !Number.isNaN(g) && !Number.isNaN(b)) return [r, g, b];
  }
  return fallback;
}

export function hexToRgb(hex: string | undefined): string {
  const [r, g, b] = parseHexColor(hex);
  return `${r}, ${g}, ${b}`;
}

export function hexToRgba(hex: string | undefined, alpha: number): string {
  const [r, g, b] = parseHexColor(hex);
  const clampedAlpha = Number.isFinite(alpha) ? Math.max(0, Math.min(1, alpha)) : 1;
  return `rgba(${r}, ${g}, ${b}, ${Number(clampedAlpha.toFixed(3))})`;
}

export function adjustBrightness(hex: string, percent: number): string {
  const [r, g, b] = parseHexColor(hex);
  const factor = 1 + percent / 100;
  const clamp = (v: number) => Math.max(0, Math.min(255, Math.round(v)));
  const add = percent > 0 ? percent * 0.45 : 0;
  const newR = clamp(r * factor + add);
  const newG = clamp(g * factor + add);
  const newB = clamp(b * factor + add);
  return `#${((1 << 24) + (newR << 16) + (newG << 8) + newB).toString(16).slice(1)}`;
}

export function contrastTextColor(hex: string): string {
  const [r, g, b] = parseHexColor(hex);
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return luminance > 0.62 ? '#09090b' : '#f4f4f5';
}

function clampNumber(val: unknown, min: number, max: number, fallback: number): number {
  if (typeof val !== 'number' || !Number.isFinite(val)) return fallback;
  return Math.max(min, Math.min(max, val));
}

/**
 * Sanitizes a partial or stored ThemeConfig so missing/corrupt fields never produce
 * broken CSS rules ("undefinedpx", NaN opacity) or unexpected appearance resets.
 */
export function normalizeThemeConfig(
  raw?: Partial<ThemeConfig> | null,
  fallback: ThemeConfig = FALLBACK_THEME_BASE
): ThemeConfig {
  if (!raw || typeof raw !== 'object') {
    return { ...fallback };
  }

  const pickHex = (candidate: unknown, def: string): string =>
    isValidHexColor(candidate) ? candidate.trim() : def;

  const fontFamily =
    typeof raw.fontFamily === 'string' && VALID_FONTS.has(raw.fontFamily as NonNullable<ThemeConfig['fontFamily']>)
      ? (raw.fontFamily as NonNullable<ThemeConfig['fontFamily']>)
      : fallback.fontFamily || 'sans';

  const lineHeight =
    typeof raw.lineHeight === 'string' && VALID_LINE_HEIGHTS.has(raw.lineHeight as NonNullable<ThemeConfig['lineHeight']>)
      ? (raw.lineHeight as NonNullable<ThemeConfig['lineHeight']>)
      : fallback.lineHeight || 'relaxed';

  return {
    id: typeof raw.id === 'string' && raw.id.trim() ? raw.id.trim() : fallback.id,
    name: typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim() : fallback.name,
    accentColor: pickHex(raw.accentColor, fallback.accentColor),
    actionColor: pickHex(raw.actionColor, fallback.actionColor),
    appBgColor: pickHex(raw.appBgColor, fallback.appBgColor || '#09090b'),
    appSurfaceColor: pickHex(raw.appSurfaceColor, fallback.appSurfaceColor || '#111114'),
    bubbleUserBg: pickHex(raw.bubbleUserBg, fallback.bubbleUserBg),
    bubbleBotBg: pickHex(raw.bubbleBotBg, fallback.bubbleBotBg),
    bubbleRadius: Math.round(clampNumber(raw.bubbleRadius, 0, 28, fallback.bubbleRadius)),
    bubbleOpacity: Number(clampNumber(raw.bubbleOpacity, 0.3, 1.0, fallback.bubbleOpacity).toFixed(2)),
    fontSize: Math.round(clampNumber(raw.fontSize, 12, 22, fallback.fontSize)),
    backgroundTint: Number(clampNumber(raw.backgroundTint, 0.0, 0.98, fallback.backgroundTint).toFixed(2)),
    fontFamily,
    usePixelUiFont: typeof raw.usePixelUiFont === 'boolean' ? raw.usePixelUiFont : Boolean(fallback.usePixelUiFont),
    lineHeight,
  };
}

function defaultStorage(): Storage | null {
  try {
    if (typeof window !== 'undefined' && window.localStorage) {
      return window.localStorage;
    }
  } catch {
    // ignore sandboxed storage errors
  }
  return null;
}

export function saveCachedTheme(
  theme: Partial<ThemeConfig> | null | undefined,
  storage: Pick<Storage, 'setItem'> | null = defaultStorage(),
  fallback: ThemeConfig = FALLBACK_THEME_BASE
): ThemeConfig {
  const normalized = normalizeThemeConfig(theme, fallback);
  if (storage) {
    try {
      storage.setItem(THEME_CACHE_STORAGE_KEY, JSON.stringify(normalized));
    } catch {
      // ignore quota / private mode errors
    }
  }
  return normalized;
}

export function readCachedTheme(
  storage: Pick<Storage, 'getItem'> | null = defaultStorage(),
  fallback: ThemeConfig = FALLBACK_THEME_BASE
): ThemeConfig | null {
  if (!storage) return null;
  try {
    const raw = storage.getItem(THEME_CACHE_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    return normalizeThemeConfig(parsed, fallback);
  } catch {
    return null;
  }
}

/**
 * Resolves the active theme without ever flashing or resetting to DEFAULT_THEME
 * while IndexedDB queries are still loading on ChatView mount.
 */
export function resolveActiveTheme(params: {
  dbTheme?: Partial<ThemeConfig> | null;
  propTheme?: Partial<ThemeConfig> | null;
  cachedTheme?: Partial<ThemeConfig> | null;
  fallback?: ThemeConfig;
}): ThemeConfig {
  const base = params.fallback || FALLBACK_THEME_BASE;
  const source = params.dbTheme || params.propTheme || params.cachedTheme || base;
  return normalizeThemeConfig(source, base);
}

export function lineHeightNumeric(lineHeight?: ThemeConfig['lineHeight']): number {
  if (lineHeight === 'loose') return 1.8;
  if (lineHeight === 'normal') return 1.45;
  return 1.6;
}

/**
 * Applies all application and chat-bubble theme variables directly to `:root`.
 */
export function applyThemeToDocument(
  rawTheme: Partial<ThemeConfig> | null | undefined,
  doc: Document | null = typeof document !== 'undefined' ? document : null
): ThemeConfig {
  const theme = normalizeThemeConfig(rawTheme);
  if (!doc?.documentElement) return theme;

  const root = doc.documentElement;
  const accent = theme.accentColor;
  const action = theme.actionColor;
  const bg = theme.appBgColor || '#09090b';
  const surface = theme.appSurfaceColor || '#111114';

  const accentHover = adjustBrightness(accent, 15);
  const accentLight = adjustBrightness(accent, 42);
  const surfaceElevated = adjustBrightness(surface, 14);
  const border = adjustBrightness(surface, 26);
  const borderSubtle = adjustBrightness(surface, 38);

  root.style.setProperty('--theme-accent', accent);
  root.style.setProperty('--theme-accent-rgb', hexToRgb(accent));
  root.style.setProperty('--theme-on-accent', contrastTextColor(accent));
  root.style.setProperty('--theme-accent-hover', accentHover);
  root.style.setProperty('--theme-accent-hover-rgb', hexToRgb(accentHover));
  root.style.setProperty('--theme-accent-light', accentLight);
  root.style.setProperty('--theme-accent-light-rgb', hexToRgb(accentLight));

  root.style.setProperty('--theme-action', action);
  root.style.setProperty('--theme-action-rgb', hexToRgb(action));

  root.style.setProperty('--app-bg', bg);
  root.style.setProperty('--app-bg-rgb', hexToRgb(bg));
  root.style.setProperty('--app-surface', surface);
  root.style.setProperty('--app-surface-rgb', hexToRgb(surface));
  root.style.setProperty('--app-surface-elevated', surfaceElevated);
  root.style.setProperty('--app-surface-elevated-rgb', hexToRgb(surfaceElevated));
  root.style.setProperty('--app-border', border);
  root.style.setProperty('--app-border-rgb', hexToRgb(border));
  root.style.setProperty('--app-border-subtle', borderSubtle);
  root.style.setProperty('--app-border-subtle-rgb', hexToRgb(borderSubtle));

  // Chat message bubble CSS custom properties (persistent across screen mounts)
  root.style.setProperty('--bubble-user-bg', hexToRgba(theme.bubbleUserBg, theme.bubbleOpacity));
  root.style.setProperty('--bubble-bot-bg', hexToRgba(theme.bubbleBotBg, theme.bubbleOpacity));
  root.style.setProperty('--bubble-radius', `${theme.bubbleRadius}px`);
  root.style.setProperty('--bubble-opacity', String(theme.bubbleOpacity));
  root.style.setProperty('--chat-font-size', `${theme.fontSize}px`);
  root.style.setProperty('--chat-line-height', String(lineHeightNumeric(theme.lineHeight)));
  root.style.setProperty('--chat-bg-tint', String(theme.backgroundTint));

  const metaThemeColor = doc.querySelector('meta[name="theme-color"]');
  if (metaThemeColor) {
    metaThemeColor.setAttribute('content', bg);
  }

  const fontChoice = theme.fontFamily || 'sans';
  root.style.setProperty('--app-font', fontStack(fontChoice));
  root.style.setProperty('--chat-font-family', 'inherit');
  root.setAttribute('data-font', fontChoice);

  return theme;
}
