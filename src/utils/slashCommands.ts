export interface WandCommandParse {
  isWandCommand: boolean;
  command: string;
  hint: string;
}

export type SlashCommandId =
  | '/scene'
  | '/wand'
  | '/continue'
  | '/summary'
  | '/action'
  | '/memory'
  | '/reset';

export interface SlashCommandMeta {
  id: SlashCommandId;
  aliases: string[];
}

export const SLASH_COMMAND_LIST: SlashCommandMeta[] = [
  { id: '/scene', aliases: ['/scene', '/сцена', '/фото', '/кадр'] },
  { id: '/wand', aliases: ['/wand', '/reply', '/ghost', '/ответ', '/палочка', '/реплика'] },
  { id: '/continue', aliases: ['/continue', '/продолжить', '/дальше'] },
  { id: '/summary', aliases: ['/summary', '/сводка', '/пересказ'] },
  { id: '/action', aliases: ['/action', '/действие'] },
  { id: '/memory', aliases: ['/memory', '/память'] },
  { id: '/reset', aliases: ['/reset', '/сброс'] },
];

/**
 * Parses `/wand [optional reply direction]` (plus `/reply`, `/ghost`, `/ответ`, `/палочка`, `/реплика`).
 */
export function parseWandCommand(rawInput: string): WandCommandParse {
  const trimmed = (rawInput || '').trim();
  const match = trimmed.match(/^(\/(?:wand|reply|ghost|ответ|палочка|реплика))(?=\s|$)([\s\S]*)$/i);
  if (!match) {
    return { isWandCommand: false, command: '', hint: '' };
  }
  return {
    isWandCommand: true,
    command: match[1].toLowerCase(),
    hint: (match[2] || '').trim(),
  };
}

/**
 * Resolves any exact slash command token (EN or RU alias) to its canonical SlashCommandId.
 */
export function resolveCanonicalSlashCommand(rawToken: string): SlashCommandId | null {
  const token = (rawToken || '').trim().toLowerCase();
  if (!token.startsWith('/')) return null;
  for (const item of SLASH_COMMAND_LIST) {
    if (item.aliases.includes(token)) {
      return item.id;
    }
  }
  return null;
}

/**
 * Filters slash commands for the `/` autocomplete menu while typing the command token.
 * Returns matching commands, or all commands when input is just `/`.
 */
export function filterSlashCommands(rawInput: string): SlashCommandId[] {
  const trimmed = (rawInput || '').trimStart();
  if (!trimmed.startsWith('/')) return [];
  if (/\s/.test(trimmed)) return [];

  const query = trimmed.toLowerCase();
  if (query === '/') {
    return SLASH_COMMAND_LIST.map((c) => c.id);
  }

  return SLASH_COMMAND_LIST.filter((c) =>
    c.aliases.some((alias) => alias.startsWith(query))
  ).map((c) => c.id);
}
