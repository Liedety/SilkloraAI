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
  id: 'violet-dark',
  name: 'Midnight Velvet',
  accentColor: '#8b5cf6', // Violet
  actionColor: '#f43f5e', // Rose accent for *actions*
  appBgColor: '#0a0814', // Rich deep violet-black
  appSurfaceColor: '#141126', // Panel/card surface
  bubbleUserBg: '#1e1b4b', // Deep indigo
  bubbleBotBg: '#1e293b', // Slate 800
  bubbleRadius: 18,
  bubbleOpacity: 0.85,
  fontSize: 15,
  backgroundTint: 0.65,
  fontFamily: 'sans',
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
    id: 'violet-dark',
    name: 'Midnight Violet (Фиолетовый)',
    theme: {
      id: 'violet-dark',
      name: 'Midnight Violet',
      accentColor: '#8b5cf6',
      actionColor: '#fb7185',
      appBgColor: '#0a0814',
      appSurfaceColor: '#141126',
      bubbleUserBg: '#1e1b4b',
      bubbleBotBg: '#1e293b',
      bubbleRadius: 18,
      bubbleOpacity: 0.85,
      fontSize: 15,
      backgroundTint: 0.65,
      fontFamily: 'sans',
      lineHeight: 'relaxed',
    },
  },
  {
    id: 'sapphire-ocean',
    name: 'Sapphire Ocean (Сапфировый)',
    theme: {
      id: 'sapphire-ocean',
      name: 'Sapphire Ocean',
      accentColor: '#0284c7',
      actionColor: '#38bdf8',
      appBgColor: '#040d1a',
      appSurfaceColor: '#0a1a2f',
      bubbleUserBg: '#082f49',
      bubbleBotBg: '#0f172a',
      bubbleRadius: 18,
      bubbleOpacity: 0.88,
      fontSize: 15,
      backgroundTint: 0.7,
      fontFamily: 'sans',
      lineHeight: 'relaxed',
    },
  },
  {
    id: 'emerald-abyss',
    name: 'Emerald Abyss (Изумрудный)',
    theme: {
      id: 'emerald-abyss',
      name: 'Emerald Abyss',
      accentColor: '#10b981',
      actionColor: '#34d399',
      appBgColor: '#03140e',
      appSurfaceColor: '#08261b',
      bubbleUserBg: '#064e3b',
      bubbleBotBg: '#0f172a',
      bubbleRadius: 18,
      bubbleOpacity: 0.85,
      fontSize: 15,
      backgroundTint: 0.7,
      fontFamily: 'sans',
      lineHeight: 'relaxed',
    },
  },
  {
    id: 'crimson-noir',
    name: 'Crimson Noir (Рубиновый)',
    theme: {
      id: 'crimson-noir',
      name: 'Crimson Noir',
      accentColor: '#e11d48',
      actionColor: '#f43f5e',
      appBgColor: '#140408',
      appSurfaceColor: '#240a10',
      bubbleUserBg: '#4c0519',
      bubbleBotBg: '#18181b',
      bubbleRadius: 16,
      bubbleOpacity: 0.9,
      fontSize: 15,
      backgroundTint: 0.75,
      fontFamily: 'sans',
      lineHeight: 'relaxed',
    },
  },
  {
    id: 'amber-sunset',
    name: 'Amber Sunset (Янтарный)',
    theme: {
      id: 'amber-sunset',
      name: 'Amber Sunset',
      accentColor: '#f59e0b',
      actionColor: '#fbbf24',
      appBgColor: '#140c03',
      appSurfaceColor: '#241708',
      bubbleUserBg: '#451a03',
      bubbleBotBg: '#1c1917',
      bubbleRadius: 18,
      bubbleOpacity: 0.88,
      fontSize: 15,
      backgroundTint: 0.7,
      fontFamily: 'sans',
      lineHeight: 'relaxed',
    },
  },
  {
    id: 'cyberpunk-neon',
    name: 'Cyberpunk Neon (Розовый Неон)',
    theme: {
      id: 'cyberpunk-neon',
      name: 'Cyberpunk Neon',
      accentColor: '#ec4899',
      actionColor: '#06b6d4',
      appBgColor: '#120217',
      appSurfaceColor: '#22062b',
      bubbleUserBg: '#500724',
      bubbleBotBg: '#18181b',
      bubbleRadius: 18,
      bubbleOpacity: 0.9,
      fontSize: 15,
      backgroundTint: 0.8,
      fontFamily: 'sans',
      lineHeight: 'relaxed',
    },
  },
  {
    id: 'oled-black',
    name: 'Pure OLED Obsidian (Глубокий черный)',
    theme: {
      id: 'oled-black',
      name: 'Pure OLED Obsidian',
      accentColor: '#6366f1',
      actionColor: '#ec4899',
      appBgColor: '#000000',
      appSurfaceColor: '#0a0a0c',
      bubbleUserBg: '#18181b',
      bubbleBotBg: '#09090b',
      bubbleRadius: 16,
      bubbleOpacity: 1.0,
      fontSize: 15,
      backgroundTint: 0.98,
      fontFamily: 'sans',
      lineHeight: 'relaxed',
    },
  },
];

export async function initDatabaseDefaults() {
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
