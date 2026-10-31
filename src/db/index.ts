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
  }
}

export const db = new SilkloraDatabase();

export const DEFAULT_THEME = {
  id: 'violet-dark',
  name: 'Midnight Velvet',
  accentColor: '#8b5cf6', // Violet
  actionColor: '#f43f5e', // Rose accent for *actions*
  bubbleUserBg: '#1e1b4b', // Deep indigo
  bubbleBotBg: '#1e293b', // Slate 800
  bubbleRadius: 18,
  bubbleOpacity: 0.85,
  fontSize: 15,
  backgroundTint: 0.65,
};

export const DEFAULT_STYLES: TextStylePreset[] = [
  {
    id: 'literary',
    name: 'Литературный / Literary',
    description: 'Богатый словарный запас, глубокие описания окружения, жестов и эмоций.',
    instruction:
      'Пиши в выразительном литературном стиле высокого качества. Уделяй внимание сенсорным деталям (звуки, запахи, прикосновения, взгляды), атмосфере и психологизму. Избегай клише и шаблонов.',
    isCustom: false,
  },
  {
    id: 'immersive',
    name: 'Иммерсивный RP / Immersive RP',
    description: 'Баланс между живой речью, физическими действиями и реакциями на действия собеседника.',
    instruction:
      'Действуй естественно и непредсказуемо, как живой человек. Реагируй на каждое движение собеседника. Выделяй действия и описания звездочками *вот так*. Реплики пиши без кавычек.',
    isCustom: false,
  },
  {
    id: 'concise',
    name: 'Динамичный / Dynamic & Crisp',
    description: 'Быстрый темп, лаконичные реплики, акцент на динамике сцены.',
    instruction:
      'Держи высокий темп повествования. Не растягивай описания, делай упор на острые реплики, напряжение и непосредственные реакции персонажей.',
    isCustom: false,
  },
  {
    id: 'gritty',
    name: 'Мрачный и Реалистичный / Dark & Gritty',
    description: 'Сырой реализм, психологическое напряжение, темная атмосфера без цензуры.',
    instruction:
      'Используй жесткий, не идеализированный реализм. Не сглаживай острые углы, передавай темные стороны человеческой натуры, физическую усталость, грубость или скрытую страсть.',
    isCustom: false,
  },
];

export const APP_THEMES = [
  {
    id: 'violet-dark',
    name: 'Midnight Violet (Фиолетовый)',
    theme: {
      id: 'violet-dark',
      name: 'Midnight Violet',
      accentColor: '#8b5cf6',
      actionColor: '#fb7185',
      bubbleUserBg: '#1e1b4b',
      bubbleBotBg: '#1e293b',
      bubbleRadius: 18,
      bubbleOpacity: 0.85,
      fontSize: 15,
      backgroundTint: 0.65,
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
      bubbleUserBg: '#082f49',
      bubbleBotBg: '#0f172a',
      bubbleRadius: 18,
      bubbleOpacity: 0.88,
      fontSize: 15,
      backgroundTint: 0.7,
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
      bubbleUserBg: '#064e3b',
      bubbleBotBg: '#0f172a',
      bubbleRadius: 18,
      bubbleOpacity: 0.85,
      fontSize: 15,
      backgroundTint: 0.7,
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
      bubbleUserBg: '#4c0519',
      bubbleBotBg: '#18181b',
      bubbleRadius: 16,
      bubbleOpacity: 0.9,
      fontSize: 15,
      backgroundTint: 0.75,
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
      bubbleUserBg: '#451a03',
      bubbleBotBg: '#1c1917',
      bubbleRadius: 18,
      bubbleOpacity: 0.88,
      fontSize: 15,
      backgroundTint: 0.7,
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
      bubbleUserBg: '#500724',
      bubbleBotBg: '#18181b',
      bubbleRadius: 18,
      bubbleOpacity: 0.9,
      fontSize: 15,
      backgroundTint: 0.8,
    },
  },
  {
    id: 'amethyst-royal',
    name: 'Amethyst Royal (Аметистовый)',
    theme: {
      id: 'amethyst-royal',
      name: 'Amethyst Royal',
      accentColor: '#a855f7',
      actionColor: '#d8b4fe',
      bubbleUserBg: '#2e1065',
      bubbleBotBg: '#1e1b4b',
      bubbleRadius: 18,
      bubbleOpacity: 0.85,
      fontSize: 15,
      backgroundTint: 0.7,
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
      bubbleUserBg: '#18181b',
      bubbleBotBg: '#09090b',
      bubbleRadius: 16,
      bubbleOpacity: 1.0,
      fontSize: 15,
      backgroundTint: 0.98,
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
