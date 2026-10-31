export type Language = 'en' | 'ru';

export interface Folder {
  id: string;
  name: string;
  createdAt: number;
}

export interface ImageCropOffset {
  x: number;
  y: number;
  scale: number;
}

export interface CharacterEmotion {
  id: string;
  name: string; // e.g. "neutral", "happy", "angry", "sad", "blushing", "smirk", "surprised", "thoughtful"
  label?: string; // Display label in UI
  avatar: string; // Base64 data URL
}

export interface Character {
  id: string;
  name: string;
  description: string;
  avatar: string;
  avatarOffset?: ImageCropOffset;
  chatBackground?: string;
  chatBackgroundOffset?: ImageCropOffset;
  greeting?: string;
  greetingEnabled: boolean;
  folderId?: string | null;
  emotions?: CharacterEmotion[];
  createdAt: number;
  updatedAt: number;
}

export interface Group {
  id: string;
  name: string;
  description: string;
  backstory?: string;
  backstoryEnabled: boolean;
  avatar?: string;
  avatarOffset?: ImageCropOffset;
  chatBackground?: string;
  chatBackgroundOffset?: ImageCropOffset;
  characterIds: string[];
  characterRoles?: Record<string, string>; // characterId -> role description
  folderIds: string[];
  createdAt: number;
  updatedAt: number;
}

export interface MessageVariant {
  text: string;
  thought?: string;
  emotion?: string;
  timestamp: number;
}

export interface ChatMessage {
  id: string;
  chatId: string;
  senderId: string; // 'user' or characterId
  senderName: string;
  senderAvatar?: string;
  variants: MessageVariant[];
  activeVariantIndex: number;
  emotion?: string; // Active emotion tag if bot
  image?: string; // base64 / url attachment
  createdAt: number;
}

export interface ChatSession {
  id: string;
  title: string;
  type: 'character' | 'group';
  targetId: string; // characterId or groupId
  personaId?: string | null; // characterId representing the user
  textStyleId?: string | null; // per-chat text style override
  thoughtsEnabled: boolean;
  chatDirectives?: string;
  relationships: Record<string, number>; // characterId -> affinity (-100 to 100)
  createdAt: number;
  updatedAt: number;
}

export interface MemoryNode {
  id: string;
  chatId: string;
  label: string;
  type: 'event' | 'relationship' | 'fact' | 'location' | 'secret';
  detail: string;
  x?: number;
  y?: number;
  vx?: number;
  vy?: number;
  isPinned?: boolean;
  createdAt: number;
}

export interface MemoryEdge {
  id: string;
  chatId: string;
  source: string; // node id
  target: string; // node id
  label?: string;
}

export type ApiProvider =
  | 'openrouter'
  | 'openai'
  | 'anthropic'
  | 'gemini'
  | 'groq'
  | 'deepseek'
  | 'custom';

export interface ApiKeyConfig {
  id: string;
  provider: ApiProvider;
  name: string;
  key: string;
  baseUrl?: string;
  isActive: boolean;
}

export interface TextStylePreset {
  id: string;
  name: string;
  description: string;
  instruction: string;
  isCustom: boolean;
}

export interface ThemeConfig {
  id: string;
  name: string;
  accentColor: string; // e.g. #7c3aed or #38bdf8
  actionColor: string; // color for *actions*
  appBgColor?: string; // full application background (e.g. #09090b)
  appSurfaceColor?: string; // panel/card surface (e.g. #13141f)
  bubbleUserBg: string;
  bubbleBotBg: string;
  bubbleRadius: number; // 0 to 28
  bubbleOpacity: number; // 0.3 to 1.0
  fontSize: number; // 13 to 20
  backgroundTint: number; // 0.0 to 0.95
}

export interface AppSettings {
  id: string; // singleton 'default'
  language: Language;
  textModel: string;
  visionModel: string;
  textStyleId: string;
  theme: ThemeConfig;
  contextWindowSize: number;
}
