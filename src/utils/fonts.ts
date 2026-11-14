import type { ThemeConfig } from '../types';

export type FontChoice = NonNullable<ThemeConfig['fontFamily']>;

const FONT_STACKS: Record<FontChoice, string> = {
  sans: "system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
  serif: "Georgia, Cambria, 'Times New Roman', serif",
  mono: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Roboto Mono', monospace",
  pixel: "'DotGothic16', ui-sans-serif, system-ui, sans-serif",
};

/** CSS font-family value for one of the four app fonts. */
export function fontStack(choice?: string): string {
  return FONT_STACKS[(choice as FontChoice) in FONT_STACKS ? (choice as FontChoice) : 'sans'];
}
