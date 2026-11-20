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

export interface CharacterImageGenConfig {
  enabled: boolean;
  mode: 'reference' | 'lora'; // Option A: reference pack, Option B: trained LoRA
  referenceImages?: string[]; // 1..4 compressed JPEG data URLs
  appearancePrompt?: string; // Stable visual description in English for prompt grounding
  styleHint?: string;
  loraName?: string; // Filename inside server/models/loras/
  loraTrigger?: string;
  loraWeight?: number;
}

export interface Character {
  id: string;
  name: string;
  description: string;
  scenario?: string;
  exampleDialogue?: string;
  avatar: string;
  avatarOffset?: ImageCropOffset;
  chatBackground?: string;
  chatBackgroundOffset?: ImageCropOffset;
  greeting?: string;
  greetingEnabled: boolean;
  folderId?: string | null;
  emotions?: CharacterEmotion[];
  imageGen?: CharacterImageGenConfig;
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

export interface SceneLocationAnchor {
  locationId: string;
  locationName: string;
  visualAnchor: string; // Locked static environment description in English
  lighting: string;
  weatherOrAtmosphere?: string;
  locked: boolean;
}

export interface SceneActorState {
  characterId: string;
  name: string;
  appearance?: string;
  clothing: string;
  poseOrAction: string;
  expression: string;
  positionInScene?: string;
}

export interface SceneState {
  location: SceneLocationAnchor;
  actors: SceneActorState[];
  props: string[];
  lastCameraAngle?: string;
  lastCompositionPrompt?: string;
  lastAnalyzedMsgId?: string;
  updatedAt: number;
}

export interface SceneAsset {
  id: string;
  chatId: string;
  messageId?: string;
  imageData: string; // Base64 data URL
  prompt: string;
  negativePrompt?: string;
  perspective?: string;
  seed?: number;
  width?: number;
  height?: number;
  modelUsed?: string;
  backendUsed?: 'local' | 'cloud';
  skippedLoras?: Array<{ filename: string; lora_arch: string; model_family: string }>;
  createdAt: number;
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
  sceneAssetIds?: string[]; // Generated scene image IDs stored in db.sceneAssets
  activeSceneAssetIndex?: number;
  createdAt: number;
}

export interface RelationshipDetail {
  /** Custom or preset bond role/status (e.g. "Rivals", "Partners", "Childhood Friends"). */
  customTitle?: string;
  /** Concise relationship dynamic / attitude note injected into roleplay prompts. */
  note?: string;
  /** Locks affinity score against automatic post-turn AI changes. */
  locked?: boolean;
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
  relationshipDetails?: Record<string, RelationshipDetail>; // characterId -> bond customization & lock
  rollingSummary?: string; // compressed rolling summary of older messages
  lastSummarizedMsgId?: string; // id of the latest message covered by rolling summary
  sceneState?: SceneState; // persistent location anchor + actors/clothing for scene generation
  createdAt: number;
  updatedAt: number;
}

export interface MemoryNode {
  id: string;
  chatId: string;
  messageId?: string; // Associated bot message ID for turn tracking
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
  fontFamily?: 'sans' | 'serif' | 'mono' | 'pixel'; // dialogue font family
  usePixelUiFont?: boolean; // apply pixel font to UI headings & buttons
  lineHeight?: 'normal' | 'relaxed' | 'loose'; // dialogue line height
}

export type AiEngineMode = 'cloud' | 'local';

/** Parts of the app that call a language model. Each one can run on the cloud or on the local PC. */
export type AiComponent =
  | 'chat'
  | 'ghostwriter'
  | 'memory'
  | 'summary'
  | 'sceneAnalysis'
  | 'sceneImage'
  | 'characterGen'
  | 'groupGen'
  | 'vision';

export type AiBackend = 'cloud' | 'local';

export type GenerationPreset = 'roleplay' | 'balanced' | 'creative' | 'precise' | 'custom';

export interface AppSettings {
  id: string; // singleton 'default'
  language: Language;
  textModel: string;
  visionModel: string;
  sceneImageModel?: string;
  sceneAspectRatio?: 'portrait' | 'landscape' | 'square';
  textStyleId: string;
  theme: ThemeConfig;
  contextWindowSize: number;
  customSystemPrompt?: string;
  customSystemPromptMode?: 'override' | 'augment';
  aiEngineMode?: AiEngineMode;
  /** Per-component backend. Missing entries follow aiEngineMode. */
  aiRouting?: Partial<Record<AiComponent, AiBackend>>;
  /** Name the AI should use for the person chatting when no persona is selected for the chat. */
  userName?: string;
  localHubUrl?: string;
  /** Marks one-time default migrations that were already applied to this install. */
  themeMigration?: string;
  /** Last opened 1-on-1 or group chat to auto-restore on launch. */
  lastOpenedChat?: { type: 'character' | 'group'; targetId: string } | null;
  generationPreset?: GenerationPreset;
  temperature?: number;
  topP?: number;
  minP?: number;
  repeatPenalty?: number;
  frequencyPenalty?: number;
  presencePenalty?: number;
  maxResponseTokens?: number;
}
