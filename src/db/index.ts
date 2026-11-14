import Dexie, { type Table } from 'dexie';
import type {
  Character,
  Folder,
  Group,
  ChatSession,
  ChatMessage,
  MemoryNode,
  MemoryEdge,
  ApiKeyConfig,
  TextStylePreset,
  AppSettings,
  ThemeConfig,
} from '../types';

export class SilkloraDatabase extends Dexie {
  characters!: Table<Character, string>;
  folders!: Table<Folder, string>;
  groups!: Table<Group, string>;
  chats!: Table<ChatSession, string>;
  messages!: Table<ChatMessage, string>;
  memoryNodes!: Table<MemoryNode, string>;
  memoryEdges!: Table<MemoryEdge, string>;
  apiKeys!: Table<ApiKeyConfig, string>;
  textStyles!: Table<TextStylePreset, string>;
  settings!: Table<AppSettings, string>;

  constructor() {
    super('SilkloraAIDatabase');
    this.version(1).stores({
      characters: 'id, name, folderId, createdAt, updatedAt',
      folders: 'id, name, createdAt',
      groups: 'id, name, createdAt, updatedAt',
      chats: 'id, type, targetId, createdAt, updatedAt',
      messages: 'id, chatId, senderId, createdAt',
      memoryNodes: 'id, chatId, type, createdAt',
      memoryEdges: 'id, chatId, source, target',
      apiKeys: 'id, provider, isActive',
      textStyles: 'id, isCustom',
      settings: 'id',
    });
    this.version(2).stores({
      memoryNodes: 'id, chatId, messageId, type, createdAt',
    });
  }
}

export const db = new SilkloraDatabase();

export const DEFAULT_THEME: ThemeConfig = {
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

export interface LocalizedStyleDef {
  name: string;
  description: string;
  instruction: string;
}

export const LOCALIZED_DEFAULT_STYLES: Record<'en' | 'ru', Record<string, LocalizedStyleDef>> = {
  en: {
    literary: {
      name: 'Literary Prose',
      description: 'Rich vocabulary, evocative sensory descriptions of surroundings, gestures, atmosphere, and psychological nuance.',
      instruction: 'Write in an expressive, high-literary prose style. Emphasize sensory details (sounds, scents, textures, gazes), atmosphere, and emotional depth. Avoid clichés and artificial formulas.',
    },
    immersive: {
      name: 'Immersive Roleplay',
      description: 'Dynamic interplay between natural speech, bodily action, and immediate character reactions.',
      instruction: 'Act naturally and unpredictably like a real person. React dynamically to your partner’s every movement. Enclose physical actions and descriptions in asterisks *like this*. Write spoken dialogue directly without quotation marks.',
    },
    concise: {
      name: 'Dynamic & Crisp',
      description: 'Fast narrative pace, sharp dialogue, and lively scene tension without overlong descriptions.',
      instruction: 'Keep dialogue and narration fast-paced and crisp. Focus on sharp exchanges, immediate tension, and decisive physical reactions without overlong exposition.',
    },
    gritty: {
      name: 'Dark & Gritty',
      description: 'Raw realism, unvarnished human nature, psychological intensity, and uncensored dark atmosphere.',
      instruction: 'Embrace unvarnished, gritty realism. Do not soften sharp edges; convey raw human nature, exhaustion, roughness, vulnerability, or hidden passion honestly.',
    },
  },
  ru: {
    literary: {
      name: 'Литературный роман',
      description: 'Богатый словарный запас, глубокие описания окружения, жестов, атмосферы и эмоций.',
      instruction: 'Пиши в выразительном литературном стиле высокого качества. Уделяй внимание сенсорным деталям (звуки, запахи, прикосновения, взгляды), атмосфере и психологизму. Избегай клише и шаблонов.',
    },
    immersive: {
      name: 'Иммерсивный отыгрыш',
      description: 'Баланс между живой речью, физическими действиями и реакциями на действия собеседника.',
      instruction: 'Действуй естественно и непредсказуемо, как живой человек. Реагируй на каждое движение собеседника. Выделяй действия и описания звездочками *вот так*. Реплики пиши без кавычек.',
    },
    concise: {
      name: 'Динамичный и лаконичный',
      description: 'Быстрый темп, острые реплики, акцент на динамике сцены.',
      instruction: 'Держи высокий темп повествования. Не растягивай описания, делай упор на острые реплики, напряжение и непосредственные реакции персонажей.',
    },
    gritty: {
      name: 'Мрачный и реалистичный',
      description: 'Сырой реализм, психологическое напряжение, темная атмосфера без цензуры.',
      instruction: 'Используй жесткий, не идеализированный реализм. Не сглаживай острые углы, передавай темные стороны человеческой натуры, физическую усталость, грубость или скрытую страсть.',
    },
  },
};

export function getLocalizedTextStyle(style: TextStylePreset, language: 'en' | 'ru'): TextStylePreset {
  if (style.isCustom) return style;
  const loc = LOCALIZED_DEFAULT_STYLES[language]?.[style.id];
  if (!loc) return style;
  return {
    ...style,
    name: loc.name,
    description: loc.description,
    instruction: loc.instruction,
  };
}

export const DEFAULT_STYLES: TextStylePreset[] = [
  {
    id: 'literary',
    name: 'Literary Prose',
    description: 'Rich vocabulary, evocative sensory descriptions of surroundings, gestures, atmosphere, and psychological nuance.',
    instruction:
      'Write in an expressive, high-literary prose style. Emphasize sensory details (sounds, scents, textures, gazes), atmosphere, and emotional depth. Avoid clichés and artificial formulas.',
    isCustom: false,
  },
  {
    id: 'immersive',
    name: 'Immersive Roleplay',
    description: 'Dynamic interplay between natural speech, bodily action, and immediate character reactions.',
    instruction:
      'Act naturally and unpredictably like a real person. React dynamically to your partner’s every movement. Enclose physical actions and descriptions in asterisks *like this*. Write spoken dialogue directly without quotation marks.',
    isCustom: false,
  },
  {
    id: 'concise',
    name: 'Dynamic & Crisp',
    description: 'Fast narrative pace, sharp dialogue, and lively scene tension without overlong descriptions.',
    instruction:
      'Keep dialogue and narration fast-paced and crisp. Focus on sharp exchanges, immediate tension, and decisive physical reactions without overlong exposition.',
    isCustom: false,
  },
  {
    id: 'gritty',
    name: 'Dark & Gritty',
    description: 'Raw realism, unvarnished human nature, psychological intensity, and uncensored dark atmosphere.',
    instruction:
      'Embrace unvarnished, gritty realism. Do not soften sharp edges; convey raw human nature, exhaustion, roughness, vulnerability, or hidden passion honestly.',
    isCustom: false,
  },
];

export const APP_THEMES: Array<{ id: string; name: string; theme: ThemeConfig }> = [
  {
    id: 'graphite',
    name: 'Graphite (Графит)',
    theme: {
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
    },
  },
  {
    id: 'oled-black',
    name: 'OLED Pure Black (OLED Чёрный)',
    theme: {
      id: 'oled-black',
      name: 'OLED Pure Black',
      accentColor: '#3f3f46',
      actionColor: '#d4d4d8',
      appBgColor: '#000000',
      appSurfaceColor: '#08080a',
      bubbleUserBg: '#16161a',
      bubbleBotBg: '#0a0a0d',
      bubbleRadius: 14,
      bubbleOpacity: 1.0,
      fontSize: 15,
      backgroundTint: 0.96,
      fontFamily: 'sans',
      usePixelUiFont: false,
      lineHeight: 'relaxed',
    },
  },
  {
    id: 'sapphire-ocean',
    name: 'Nordic Slate (Нордический сланец)',
    theme: {
      id: 'sapphire-ocean',
      name: 'Nordic Slate',
      accentColor: '#2c5282',
      actionColor: '#8aaad0',
      appBgColor: '#080c12',
      appSurfaceColor: '#0f151f',
      bubbleUserBg: '#162231',
      bubbleBotBg: '#111722',
      bubbleRadius: 16,
      bubbleOpacity: 0.92,
      fontSize: 15,
      backgroundTint: 0.75,
      fontFamily: 'sans',
      usePixelUiFont: false,
      lineHeight: 'relaxed',
    },
  },
  {
    id: 'emerald-abyss',
    name: 'Forest Pine (Хвойный сланец)',
    theme: {
      id: 'emerald-abyss',
      name: 'Forest Pine',
      accentColor: '#276749',
      actionColor: '#7eb297',
      appBgColor: '#080e0b',
      appSurfaceColor: '#0f1713',
      bubbleUserBg: '#16261e',
      bubbleBotBg: '#101714',
      bubbleRadius: 16,
      bubbleOpacity: 0.92,
      fontSize: 15,
      backgroundTint: 0.75,
      fontFamily: 'sans',
      usePixelUiFont: false,
      lineHeight: 'relaxed',
    },
  },
  {
    id: 'crimson-noir',
    name: 'Oxblood Ink (Бордовый бархат)',
    theme: {
      id: 'crimson-noir',
      name: 'Oxblood Ink',
      accentColor: '#7f2d3e',
      actionColor: '#c98895',
      appBgColor: '#0d090b',
      appSurfaceColor: '#161013',
      bubbleUserBg: '#27151a',
      bubbleBotBg: '#151012',
      bubbleRadius: 16,
      bubbleOpacity: 0.92,
      fontSize: 15,
      backgroundTint: 0.78,
      fontFamily: 'sans',
      usePixelUiFont: false,
      lineHeight: 'relaxed',
    },
  },
  {
    id: 'amber-sunset',
    name: 'Warm Umber (Тёплая охра)',
    theme: {
      id: 'amber-sunset',
      name: 'Warm Umber',
      accentColor: '#855326',
      actionColor: '#cfa679',
      appBgColor: '#0d0b09',
      appSurfaceColor: '#16130f',
      bubbleUserBg: '#261d15',
      bubbleBotBg: '#161310',
      bubbleRadius: 16,
      bubbleOpacity: 0.92,
      fontSize: 15,
      backgroundTint: 0.75,
      fontFamily: 'sans',
      usePixelUiFont: false,
      lineHeight: 'relaxed',
    },
  },
];

export async function initDatabaseDefaults() {
  // Upgrade legacy neon/violet defaults and sync updated matte color palettes
  // while keeping custom color overrides and all user typography preferences intact.
  const existing = await db.settings.get('default');
  if (existing && existing.themeMigration !== 'matte-ui-v2') {
    const curId = existing.theme?.id;
    const isRemovedNeon = curId === 'violet-dark' || curId === 'cyberpunk-neon';
    const matchingPreset = APP_THEMES.find((p) => p.id === curId)?.theme;
    const nextPalette = isRemovedNeon ? DEFAULT_THEME : matchingPreset;

    await db.settings.update('default', {
      themeMigration: 'matte-ui-v2',
      ...(nextPalette
        ? {
            theme: {
              ...nextPalette,
              bubbleRadius: existing.theme?.bubbleRadius ?? nextPalette.bubbleRadius,
              bubbleOpacity: existing.theme?.bubbleOpacity ?? nextPalette.bubbleOpacity,
              fontSize: existing.theme?.fontSize ?? nextPalette.fontSize,
              backgroundTint: existing.theme?.backgroundTint ?? nextPalette.backgroundTint,
              fontFamily: existing.theme?.fontFamily ?? nextPalette.fontFamily,
              usePixelUiFont: existing.theme?.usePixelUiFont ?? false,
              lineHeight: existing.theme?.lineHeight ?? nextPalette.lineHeight,
            },
          }
        : {}),
    });
  }

  const settingsCount = await db.settings.count();
  if (settingsCount === 0) {
    await db.settings.put({
      id: 'default',
      language: 'en',
      textModel: 'deepseek/deepseek-chat',
      visionModel: 'google/gemini-flash-1.5',
      textStyleId: 'immersive',
      theme: DEFAULT_THEME,
      contextWindowSize: 20,
      customSystemPrompt: '',
      customSystemPromptMode: 'augment',
      aiEngineMode: 'cloud',
      localHubUrl: 'http://192.168.1.55:8080/v1',
    });
  }

  const stylesCount = await db.textStyles.count();
  if (stylesCount === 0) {
    await db.textStyles.bulkPut(DEFAULT_STYLES);
  }

  // Pre-seed default API provider config if empty
  const keysCount = await db.apiKeys.count();
  if (keysCount === 0) {
    await db.apiKeys.put({
      id: 'openrouter-default',
      provider: 'openrouter',
      name: 'OpenRouter (Default)',
      key: '',
      isActive: true,
    });
  }

  // Clean up any previously seeded starter character & starter folder
  try {
    const evelyn = await db.characters.get('char-evelyn');
    if (evelyn) {
      await db.characters.delete('char-evelyn');
      await db.chats.where('targetId').equals('char-evelyn').delete();
    }
    const starterFld = await db.folders.get('fld-starter');
    if (starterFld) {
      await db.folders.delete('fld-starter');
    }
  } catch {
    // ignore
  }
}
