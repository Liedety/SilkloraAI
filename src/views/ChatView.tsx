import React, { useState, useEffect, useLayoutEffect, useRef } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import {
  ArrowLeft,
  Settings as SettingsIcon,
  Send,
  Image as ImageIcon,
  Wand2,
  Bot,
  Copy,
  Edit3,
  RotateCcw,
  RefreshCw,
  ChevronLeft,
  ChevronRight,
  X,
  Sparkles,
  Check,
  Eye,
  EyeOff,
  CornerDownRight,
  Smile,
  ArrowDown,
  Camera,
  Download,
  Pin,
  PinOff,
} from 'lucide-react';
import { db, DEFAULT_THEME, getLocalizedTextStyle } from '../db';
import type {
  ApiKeyConfig,
  Character,
  ChatMessage,
  ChatSession,
  Group,
  Language,
  MessageVariant,
  SceneAsset,
  SceneState,
  ThemeConfig,
} from '../types';
import { translations } from '../i18n';
import {
  streamChatCompletion,
  suggestUserReply,
  summarizeScene,
  compressChatHistory,
  fetchLocalContextInfo,
  cleanArtifacts,
  extractEmotionAndCleanResponse,
  parseStreamingBotResponse,
  stripEmotionTags,
  enforceParagraphLimit,
  getEffectiveAiConfig,
  getComponentAiConfig,
  getComponentBackend,
  resolveSamplerConfig,
  speakerStopStrings,
  resolveEmotion,
  stripLeadingSpeakerName,
  stripEchoedUserPrefix,
} from '../services/ai';
import {
  buildSystemPrompt,
  buildSceneNote,
  buildTurnGuidanceBlock,
  parseLengthOverride,
  substitutePromptMacros,
  inferGrammaticalGender,
} from '../services/promptBuilder';
import {
  estimateTokens,
  PER_MESSAGE_TOKENS,
  planWindow,
  planSummaryBatch,
  sceneNoteLines,
  summaryLimits,
} from '../services/contextBudget';
import { cloneMemoryGraphRecords, extractMemoryAndAffinity, removeMemoriesWithBridge } from '../services/memoryGraph';
import { finalizeReplyText } from '../services/replyGuard';
import { parseSceneCommand } from '../services/sceneState';
import { executeSceneGenerationPipeline, selectSceneCharacters } from '../services/sceneDirector';
import { normalizeSceneOutputImage } from '../utils/imageUtils';
import {
  filterSlashCommands,
  parseWandCommand,
  resolveCanonicalSlashCommand,
} from '../utils/slashCommands';
import {
  hexToRgba,
  lineHeightNumeric,
  readCachedTheme,
  resolveActiveTheme,
} from '../utils/themePersistence';
import { ChatSettingsModal } from './ChatSettingsModal';
import { AvatarImage } from '../components/AvatarImage';
import { ActivityProgressBar } from '../components/ActivityProgressBar';
import { SceneGuideModal, SceneHelpButton } from '../components/SceneHelp';

interface ChatViewProps {
  type: 'character' | 'group';
  targetId: string;
  language: Language;
  theme?: ThemeConfig;
  onBack: () => void;
}

// Prompt budgets in tokens. Local models take their budget from the hub; cloud models use a fixed target.
const CLOUD_PROMPT_TARGET = 6000;
const CLOUD_MAX_VERBATIM = 8;
const LOCAL_FALLBACK_PROMPT_TARGET = 3072;
const LOCAL_MAX_VERBATIM = 40;
const SYNOPSIS_ALLOWANCE = 200;
const SCENE_NOTE_ALLOWANCE = 220;

// Strips hidden thoughts and emotion tags so past turns do not inflate the prompt or trigger ballooning replies
function cleanHistoryText(text: string): string {
  const withoutThoughts = (text || '')
    .replace(/<thought>[\s\S]*?<\/thought>/gi, '')
    .replace(/<thought>[\s\S]*$/gi, '');
  return stripEmotionTags(withoutThoughts, undefined, { stripLeadingUnknownAngleTag: true }).trim();
}

function truncateOnWordBoundary(text: string, maxLen = 140): string {
  if (!text || text.length <= maxLen) return text;
  const slice = text.slice(0, maxLen);
  const lastSpace = slice.lastIndexOf(' ');
  return (lastSpace > maxLen * 0.5 ? slice.slice(0, lastSpace) : slice).trim() + '...';
}

export const ChatView: React.FC<ChatViewProps> = ({
  type,
  targetId,
  language,
  theme: propTheme,
  onBack,
}) => {
  const t = translations[language];

  // Queries
  const character = useLiveQuery(
    () => (type === 'character' ? db.characters.get(targetId) : undefined),
    [type, targetId]
  );
  const group = useLiveQuery(
    () => (type === 'group' ? db.groups.get(targetId) : undefined),
    [type, targetId]
  );
  const allCharacters = useLiveQuery(() => db.characters.toArray()) || [];
  const settings = useLiveQuery(() => db.settings.get('default'));
  const activeApiKey = useLiveQuery(() => db.apiKeys.filter((k) => k.isActive).first());
  const { apiKeyConfig: effectiveApiKey, textModel: effectiveModel, isLocal } = getEffectiveAiConfig(settings, activeApiKey);

  // Active Session state
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(null);

  // Sessions whose greeting was already being inserted, so a re-render cannot add it twice
  const greetingSeedingRef = useRef<Set<string>>(new Set());

  // Adds the character's opening line when the chat has no messages yet.
  // Runs also for chats created before the character data finished loading, which used to leave them empty.
  const seedGreetingIfEmpty = async (chatId: string) => {
    if (type !== 'character' || !character || !character.greeting || !character.greetingEnabled) return;
    if (greetingSeedingRef.current.has(chatId)) return;
    greetingSeedingRef.current.add(chatId);
    try {
      const count = await db.messages.where('chatId').equals(chatId).count();
      if (count > 0) return;
      const macroUserName = settings?.userName?.trim() || (language === 'ru' ? 'Игрок' : 'User');
      const expandedGreeting = substitutePromptMacros(character.greeting, character.name, macroUserName);
      const parsedGreeting = extractEmotionAndCleanResponse(expandedGreeting, character.emotions, character.name);
      const greetingMsg: ChatMessage = {
        id: 'msg-' + Math.random().toString(36).substring(2, 10),
        chatId,
        senderId: character.id,
        senderName: character.name,
        senderAvatar: character.avatar,
        emotion: parsedGreeting.emotion,
        variants: [
          {
            text: parsedGreeting.text || expandedGreeting,
            emotion: parsedGreeting.emotion,
            thought: parsedGreeting.thought,
            timestamp: Date.now(),
          },
        ],
        activeVariantIndex: 0,
        createdAt: Date.now(),
      };
      await db.messages.put(greetingMsg);
      await db.chats.update(chatId, { updatedAt: Date.now() });
    } finally {
      greetingSeedingRef.current.delete(chatId);
    }
  };

  // Initialize or fetch active session: reopen the session the user was last in for this character or group
  const lastSessionKey = `silklora_last_session_${targetId}`;
  const sessionInitForRef = useRef<string | null>(null);
  const targetReady = type === 'character' ? Boolean(character) : Boolean(group);

  useEffect(() => {
    if (!targetReady) return;
    // Run once per opened chat: later updates of the character or group must not reset the session
    if (sessionInitForRef.current === `${type}:${targetId}`) return;
    sessionInitForRef.current = `${type}:${targetId}`;

    async function initSession() {
      const sessions = await db.chats.where('targetId').equals(targetId).toArray();
      let stored: string | null = null;
      try {
        stored = window.localStorage.getItem(lastSessionKey);
      } catch {
        // ignore storage errors
      }
      const remembered = stored ? sessions.find((x) => x.id === stored) : undefined;
      const newest = [...sessions].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))[0];
      const existing = remembered || newest;

      if (existing) {
        setCurrentSessionId(existing.id);
        await seedGreetingIfEmpty(existing.id);
      } else {
        const title = type === 'character'
          ? (character?.name || (language === 'ru' ? 'Чат' : 'Chat'))
          : (group?.name || (language === 'ru' ? 'Групповой чат' : 'Group Chat'));
        const newSession: ChatSession = {
          id: 'chat-' + Math.random().toString(36).substring(2, 10),
          title,
          type,
          targetId,
          personaId: null,
          thoughtsEnabled: false,
          relationships: {},
          createdAt: Date.now(),
          updatedAt: Date.now(),
        };
        await db.chats.put(newSession);
        setCurrentSessionId(newSession.id);
        await seedGreetingIfEmpty(newSession.id);
      }
    }

    initSession();
  }, [type, targetId, targetReady]);

  // Remember the open session for this character or group
  useEffect(() => {
    if (!currentSessionId) return;
    try {
      window.localStorage.setItem(lastSessionKey, currentSessionId);
    } catch {
      // ignore storage errors
    }
    // Opening a session makes it the most recent one, which also orders the history list
    db.chats.update(currentSessionId, { updatedAt: Date.now() }).catch(() => {});
  }, [currentSessionId, lastSessionKey]);

  // Current session query
  const session = useLiveQuery(
    () => (currentSessionId ? db.chats.get(currentSessionId) : undefined),
    [currentSessionId]
  );

  const activeStyle = useLiveQuery(
    () => (settings ? db.textStyles.get(session?.textStyleId || settings.textStyleId) : undefined),
    [settings, session?.textStyleId]
  );

  // Messages in this session
  const messages = useLiveQuery(
    () => (currentSessionId ? db.messages.where('chatId').equals(currentSessionId).sortBy('createdAt') : []),
    [currentSessionId]
  ) || [];

  // Memory nodes for context injection
  const memoryNodes = useLiveQuery(
    () => (currentSessionId ? db.memoryNodes.where('chatId').equals(currentSessionId).toArray() : []),
    [currentSessionId]
  ) || [];

  // Scene assets rendered for /scene commands in this session
  const sceneAssets = useLiveQuery(
    () => (currentSessionId ? db.sceneAssets.where('chatId').equals(currentSessionId).toArray() : []),
    [currentSessionId]
  ) || [];
  const sceneAssetsById: Record<string, SceneAsset> = {};
  for (const asset of sceneAssets) {
    sceneAssetsById[asset.id] = asset;
  }

  // UI state
  const [inputText, setInputText] = useState('');
  const [attachedImage, setAttachedImage] = useState<string | null>(null);
  const [isGenerating, setIsGenerating] = useState(false);
  const [streamingText, setStreamingText] = useState<string>('');
  const [streamingThought, setStreamingThought] = useState<string>('');
  const [streamingEmotion, setStreamingEmotion] = useState<string | null>(null);
  const [streamingSender, setStreamingSender] = useState<Character | null>(null);
  const compressionRunningRef = useRef(false);
  const isSubmittingRef = useRef(false);
  const abortControllerRef = useRef<AbortController | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  // Modals & Panels
  const [showSettingsModal, setShowSettingsModal] = useState(false);
  const [showSpeakerModal, setShowSpeakerModal] = useState(false);
  const [showUserWandModal, setShowUserWandModal] = useState(false);
  const [userWandPrompt, setUserWandPrompt] = useState('');
  const [isWandGenerating, setIsWandGenerating] = useState(false);
  const [wandPreview, setWandPreview] = useState('');
  const wandAbortRef = useRef<AbortController | null>(null);

  // Guided Regen modal
  const [guidedRegenTargetMsgId, setGuidedRegenTargetMsgId] = useState<string | null>(null);
  const [guidedRegenPrompt, setGuidedRegenPrompt] = useState('');

  // Editing message state
  const [editingMsgId, setEditingMsgId] = useState<string | null>(null);
  const [editText, setEditText] = useState('');

  // Slash command dropdown
  const [showSlashMenu, setShowSlashMenu] = useState(false);
  const [summaryModalText, setSummaryModalText] = useState<string | null>(null);
  const [isSummarizing, setIsSummarizing] = useState(false);
  const [summaryStartedAt, setSummaryStartedAt] = useState(0);
  const [botGenStartedAt, setBotGenStartedAt] = useState(0);
  const [wandStartedAt, setWandStartedAt] = useState(0);

  // Copy feedback
  const [copiedId, setCopiedId] = useState<string | null>(null);

  // Folded thoughts state
  const [expandedThoughts, setExpandedThoughts] = useState<Record<string, boolean>>({});

  // Bot message manual emotion sprite picker
  const [emotionPickerMsgId, setEmotionPickerMsgId] = useState<string | null>(null);

  // Scene Generation UI state (/scene)
  const [isGeneratingScene, setIsGeneratingScene] = useState(false);
  const [sceneStageText, setSceneStageText] = useState('');
  const [sceneProgressPct, setSceneProgressPct] = useState(0);
  const [sceneStartedAt, setSceneStartedAt] = useState(0);
  const [sceneStepInfo, setSceneStepInfo] = useState<{ step: number; totalSteps: number } | null>(null);
  const [activeSceneTargetMsgId, setActiveSceneTargetMsgId] = useState<string | null>(null);
  const sceneAbortRef = useRef<AbortController | null>(null);
  const imageModeActiveRef = useRef(false);
  const [restoringLlmNotice, setRestoringLlmNotice] = useState(false);
  const [lightboxAsset, setLightboxAsset] = useState<{ asset: SceneAsset; msgId: string } | null>(null);
  const [angleInputMsgId, setAngleInputMsgId] = useState<string | null>(null);
  const [angleInputText, setAngleInputText] = useState('');
  const [showSceneGuide, setShowSceneGuide] = useState(false);

  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const cachedThemeRef = useRef<ThemeConfig | null>(readCachedTheme(undefined, DEFAULT_THEME));
  const currentTheme = resolveActiveTheme({
    dbTheme: settings?.theme,
    propTheme,
    cachedTheme: cachedThemeRef.current,
    fallback: DEFAULT_THEME,
  });
  cachedThemeRef.current = currentTheme;

  // The selected font applies to the whole app, so message text simply inherits it
  const fontFamilyStyle = 'inherit';
  const lineHeightStyle = lineHeightNumeric(currentTheme.lineHeight);

  // Pagination & Scroll navigation state
  const PAGE_SIZE = 25;
  const [visibleCount, setVisibleCount] = useState<number>(PAGE_SIZE);
  const [showScrollBottom, setShowScrollBottom] = useState(false);
  const chatContainerRef = useRef<HTMLDivElement | null>(null);
  const hasInitialScrolledRef = useRef(false);
  const isLoadingOlderRef = useRef(false);
  const prevScrollHeightRef = useRef<number>(0);
  const prevScrollTopRef = useRef<number>(0);
  const isSmoothScrollingToBottomRef = useRef(false);
  // True as soon as the reader scrolls up: streaming must never pull the view back down
  const userScrolledUpRef = useRef(false);
  const lastScrollTopRef = useRef(0);

  useEffect(() => {
    setVisibleCount(PAGE_SIZE);
    hasInitialScrolledRef.current = false;
    setShowScrollBottom(false);
    isSmoothScrollingToBottomRef.current = false;
    userScrolledUpRef.current = false;
    lastScrollTopRef.current = 0;
    setAngleInputMsgId(null);
    setAngleInputText('');
    setLightboxAsset(null);
  }, [currentSessionId]);

  const totalMessagesCount = messages.length;
  const hasMoreMessages = totalMessagesCount > visibleCount;
  const displayedMessages = hasMoreMessages
    ? messages.slice(totalMessagesCount - visibleCount)
    : messages;

  const scrollToBottom = (smooth = true) => {
    userScrolledUpRef.current = false;
    if (chatContainerRef.current) {
      if (smooth) {
        isSmoothScrollingToBottomRef.current = true;
      }
      chatContainerRef.current.scrollTo({
        top: chatContainerRef.current.scrollHeight,
        behavior: smooth ? 'smooth' : 'auto',
      });
    } else {
      messagesEndRef.current?.scrollIntoView({ behavior: smooth ? 'smooth' : 'auto' });
    }
  };

  // Immediate jump to bottom when session opens or messages first load
  useLayoutEffect(() => {
    if (!hasInitialScrolledRef.current && displayedMessages.length > 0 && chatContainerRef.current) {
      chatContainerRef.current.scrollTop = chatContainerRef.current.scrollHeight;
      hasInitialScrolledRef.current = true;
    }
  }, [displayedMessages.length, currentSessionId]);

  // Adjust scroll position synchronously after loading older messages (avoids flicker and multiple triggers)
  useLayoutEffect(() => {
    if (isLoadingOlderRef.current && chatContainerRef.current) {
      const newScrollHeight = chatContainerRef.current.scrollHeight;
      chatContainerRef.current.scrollTop = newScrollHeight - prevScrollHeightRef.current + prevScrollTopRef.current;
      isLoadingOlderRef.current = false;
    }
  }, [visibleCount]);

  // Keep pinned to bottom during generation / new message ONLY if the reader has not scrolled up
  useEffect(() => {
    const el = chatContainerRef.current;
    if (!el || !hasInitialScrolledRef.current || userScrolledUpRef.current) return;
    el.scrollTop = el.scrollHeight;
  }, [totalMessagesCount, streamingText]);

  const triggerLoadOlderMessages = () => {
    if (!hasMoreMessages || isLoadingOlderRef.current || !chatContainerRef.current) return;
    isLoadingOlderRef.current = true;
    prevScrollHeightRef.current = chatContainerRef.current.scrollHeight;
    prevScrollTopRef.current = chatContainerRef.current.scrollTop;
    setVisibleCount((prev) => Math.min(prev + PAGE_SIZE, totalMessagesCount));
  };

  const handleScroll = (e: React.UIEvent<HTMLDivElement>) => {
    const target = e.currentTarget;
    const { scrollTop, scrollHeight, clientHeight } = target;
    const distanceFromBottom = scrollHeight - scrollTop - clientHeight;

    // Any upward movement hands control to the reader, even a few pixels
    const movedUp = scrollTop < lastScrollTopRef.current - 2;
    lastScrollTopRef.current = scrollTop;
    if (movedUp && !isLoadingOlderRef.current) {
      userScrolledUpRef.current = true;
      isSmoothScrollingToBottomRef.current = false;
    } else if (distanceFromBottom <= 32) {
      userScrolledUpRef.current = false;
    }

    if (isSmoothScrollingToBottomRef.current) {
      if (distanceFromBottom <= 140) {
        isSmoothScrollingToBottomRef.current = false;
      }
      setShowScrollBottom(false);
      return;
    }

    setShowScrollBottom(distanceFromBottom > 140 || (userScrolledUpRef.current && distanceFromBottom > 48));

    // Progressive lazy loading when user scrolls near top (< 60px)
    if (scrollTop < 60 && hasMoreMessages && !isLoadingOlderRef.current) {
      triggerLoadOlderMessages();
    }
  };

  // A finger or wheel on the message list always cancels automatic following
  const handleUserScrollIntent = (deltaY?: number) => {
    isSmoothScrollingToBottomRef.current = false;
    if (deltaY === undefined || deltaY < 0) {
      userScrolledUpRef.current = deltaY === undefined ? userScrolledUpRef.current : true;
    }
  };

  const adjustTextareaHeight = () => {
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
      textareaRef.current.style.height = `${Math.min(textareaRef.current.scrollHeight, 140)}px`;
    }
  };

  useEffect(() => {
    adjustTextareaHeight();
  }, [inputText]);

  const matchingSlashCommands = filterSlashCommands(inputText);

  // Slash command trigger & auto-expanding textarea
  const handleInputChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const val = e.target.value;
    setInputText(val);
    setShowSlashMenu(filterSlashCommands(val).length > 0);
    adjustTextareaHeight();
  };

  // Emotion sprite shown under the message text. The avatar itself never changes.
  const getEmotionSprite = (
    senderId: string,
    emotion?: string
  ): { avatar: string; name: string } | null => {
    const char = allCharacters.find((c) => c.id === senderId) || (type === 'character' ? character : undefined);
    if (!char || !char.emotions || char.emotions.length === 0) return null;
    const name = resolveEmotion(emotion || '', char.emotions, char.name);
    if (!name) return null;
    const sprite = char.emotions.find((e) => e.name.toLowerCase() === name && e.avatar);
    return sprite?.avatar ? { avatar: sprite.avatar, name: sprite.label || sprite.name } : null;
  };

  // Build current dialogue context string for AI
  const buildContextHistory = (msgList: ChatMessage[], userLabelOverride?: string): string => {
    return msgList
      .filter((m) => m.senderId !== 'scene-director')
      .slice(-8)
      .map((m) => {
        const v = m.variants[m.activeVariantIndex];
        const cleaned = cleanHistoryText(v ? v.text : '');
        const label = m.senderId === 'user' && userLabelOverride
          ? userLabelOverride
          : m.senderName;
        return `${label}: ${cleaned}`;
      })
      .join('\n');
  };

  // Helper to execute generation
  const runBotGeneration = async (
    targetSpeaker?: Character,
    guidancePrompt?: string,
    existingBotMsgToVariant?: ChatMessage
  ) => {
    if (!session) return;
    if (!effectiveApiKey || (!effectiveApiKey.key.trim() && !isLocal)) {
      alert(language === 'ru' ? 'Пожалуйста, настройте подключение к ИИ в Настройках.' : 'Please configure AI connection in Settings.');
      return;
    }

    // Determine speaker
    let speaker: Character;
    if (type === 'character') {
      if (!character) return;
      speaker = character;
    } else {
      if (targetSpeaker) {
        speaker = targetSpeaker;
      } else {
        // Pick character from group, strictly excluding user persona!
        const groupChars = allCharacters.filter(
          (c) => group?.characterIds.includes(c.id) && c.id !== session.personaId
        );
        if (groupChars.length === 0) return;
        speaker = groupChars[Math.floor(Math.random() * groupChars.length)];
      }
    }

    // Safety guard: User's persona must NEVER speak as a bot
    if (session.personaId && speaker.id === session.personaId) {
      console.warn('Blocked user persona from speaking as bot');
      return;
    }

    if (!speaker) return;

    if (imageModeActiveRef.current) {
      imageModeActiveRef.current = false;
      setRestoringLlmNotice(true);
    }

    setBotGenStartedAt(Date.now());
    setIsGenerating(true);
    setStreamingText('');
    setStreamingThought('');
    setStreamingEmotion(null);
    setStreamingSender(speaker);

    const abortController = new AbortController();
    abortControllerRef.current = abortController;

    try {
      // Load freshest chat session & settings so recently updated directives/persona take effect immediately
      const freshChat = await db.chats.get(session.id);
      const activeChat = freshChat || session;

      // Retrieve user persona
      const userPersona = activeChat.personaId
        ? allCharacters.find((c) => c.id === activeChat.personaId) || null
        : null;

      // Retrieve affinity score & custom bond details
      const affinity = activeChat.relationships?.[speaker.id] || 0;
      const speakerRelDetail = activeChat.relationshipDetails?.[speaker.id] || null;

      // Query fresh settings & text style from database
      const freshSettings = await db.settings.get('default');
      if (getComponentBackend(freshSettings || settings, 'chat') !== 'local') {
        setRestoringLlmNotice(false);
      }
      const styleId = activeChat.textStyleId || freshSettings?.textStyleId || 'literary';
      const rawStyle = (await db.textStyles.get(styleId)) || activeStyle;

      // Context sliding window with context compression
      const freshDbMsgs = await db.messages.where('chatId').equals(session.id).sortBy('createdAt');
      let msgsForContext = freshDbMsgs.filter((m) => m.senderId !== 'scene-director');
      if (existingBotMsgToVariant) {
        const targetIdx = msgsForContext.findIndex((m) => m.id === existingBotMsgToVariant.id);
        if (targetIdx !== -1) {
          msgsForContext = msgsForContext.slice(0, targetIdx);
        }
      }

      // Determine dialogue language based on user's recent input (falling back to recent messages / character lore)
      const lastUserMsgInContext = [...msgsForContext].reverse().find((m) => m.senderId === 'user');
      const lastUserText = lastUserMsgInContext?.variants[lastUserMsgInContext.activeVariantIndex]?.text || '';
      const langProbe =
        lastUserText ||
        msgsForContext.slice(-3).map((m) => m.variants[m.activeVariantIndex]?.text || '').join(' ') ||
        speaker.description ||
        '';
      const dialogueLang: 'en' | 'ru' = /[а-яА-ЯёЁ]/.test(langProbe) ? 'ru' : (/[a-zA-Z]/.test(langProbe) ? 'en' : language);
      const textStyleToUse = rawStyle ? getLocalizedTextStyle(rawStyle, dialogueLang) : undefined;

      // Context = stable system prompt + rolling summary + verbatim window (grows by appending) + scene note.
      const storedSummary = activeChat.rollingSummary?.trim() || '';
      const lastSummarizedId = activeChat.lastSummarizedMsgId;

      let promptTarget = CLOUD_PROMPT_TARGET;
      let maxVerbatim = CLOUD_MAX_VERBATIM;
      if (isLocal && effectiveApiKey?.baseUrl) {
        const localInfo = await fetchLocalContextInfo(effectiveApiKey.baseUrl);
        promptTarget = localInfo
          ? localInfo.recommendedPromptTokens || Math.max(1024, localInfo.nCtx - 1280)
          : LOCAL_FALLBACK_PROMPT_TARGET;
        maxVerbatim = LOCAL_MAX_VERBATIM;
      }

      const historyTokens = msgsForContext.map((m) => {
        const text = cleanHistoryText(m.variants[m.activeVariantIndex]?.text || '');
        return text ? estimateTokens(text) + PER_MESSAGE_TOKENS : 0;
      });
      let summarizedCount = 0;
      if (lastSummarizedId) {
        const idx = msgsForContext.findIndex((m) => m.id === lastSummarizedId);
        summarizedCount = idx !== -1 ? idx + 1 : 0;
      }

      const resolvedUserName = (userPersona?.name || freshSettings?.userName || '').trim();
      const groupMembers = type === 'group' ? allCharacters.filter((c) => group?.characterIds.includes(c.id)) : [];
      const turnHasLengthOverride = Boolean(guidancePrompt && parseLengthOverride(guidancePrompt));

      const freshMemoryNodes = await db.memoryNodes.where('chatId').equals(session.id).toArray();
      const freshMemoryEdges = await db.memoryEdges.where('chatId').equals(session.id).toArray();
      const memoryQueryContext = msgsForContext
        .slice(-3)
        .map((m) => m.variants[m.activeVariantIndex]?.text || '')
        .join(' ')
        .trim();

      const makeSystemPrompt = (summaryText: string) => buildSystemPrompt({
        character: speaker,
        group: group || undefined,
        groupCharacters: groupMembers,
        userPersona,
        userName: resolvedUserName || undefined,
        textStyle: textStyleToUse,
        chatDirectives: activeChat.chatDirectives,
        turnGuidance: turnHasLengthOverride ? guidancePrompt : undefined,
        thoughtsEnabled: activeChat.thoughtsEnabled === true,
        memoryNodes: freshMemoryNodes,
        memoryEdges: freshMemoryEdges,
        queryContext: memoryQueryContext,
        relationshipScore: affinity,
        relationshipDetail: speakerRelDetail,
        speakerCharacter: speaker,
        customSystemPrompt: freshSettings?.customSystemPrompt,
        customSystemPromptMode: freshSettings?.customSystemPromptMode,
        contextSummary: summaryText || undefined,
        language: dialogueLang,
        dynamicTail: true,
      });

      let systemPrompt = makeSystemPrompt(storedSummary);
      const dialogueBudget = Math.max(600, promptTarget - estimateTokens(systemPrompt) - SYNOPSIS_ALLOWANCE - SCENE_NOTE_ALLOWANCE);
      const windowPlan = planWindow(historyTokens, summarizedCount, dialogueBudget, maxVerbatim);
      const contextMsgs = msgsForContext.slice(windowPlan.windowFrom);

      // Only when the window had to skip messages before the next summary batch: a short synopsis covers them
      const skippedMsgs = msgsForContext
        .slice(summarizedCount, windowPlan.windowFrom)
        .filter((m) => m.variants[m.activeVariantIndex]?.text?.trim());
      let contextSummary = storedSummary;
      if (skippedMsgs.length > 0) {
        const synopsis = skippedMsgs
          .slice(-8)
          .map((m) => {
            const cleaned = cleanHistoryText(m.variants[m.activeVariantIndex]?.text || '');
            const displaySender = m.senderId === 'user' && resolvedUserName ? resolvedUserName : m.senderName;
            return `${displaySender}: ${truncateOnWordBoundary(cleaned, 140)}`;
          })
          .join('\n');
        const header = dialogueLang === 'ru' ? 'Недавние события диалога:\n' : 'Recent dialogue events:\n';
        contextSummary = (storedSummary ? storedSummary + '\n\n' : '') + header + synopsis;
        systemPrompt = makeSystemPrompt(contextSummary);
      }

      const sceneNote = sceneNoteLines([
        buildSceneNote({
          speakerName: speaker.name,
          userName: resolvedUserName || (dialogueLang === 'ru' ? 'собеседник' : 'the other person'),
          speakerGender: inferGrammaticalGender(speaker.description),
          userGender: inferGrammaticalGender(userPersona?.description),
          language: dialogueLang,
          relationshipScore: affinity,
          relationshipDetail: speakerRelDetail,
          memoryNodes: freshMemoryNodes,
          memoryEdges: freshMemoryEdges,
          queryContext: memoryQueryContext,
          emotionNames: speaker.emotions?.map((e) => e.name),
          presentNames: type === 'group'
            ? groupMembers.filter((c) => c.id !== speaker.id && c.id !== userPersona?.id).map((c) => c.name)
            : undefined,
          sceneState: activeChat.sceneState,
          mentionedNames: type === 'group'
            ? groupMembers
                .filter((c) => c.id !== speaker.id && c.id !== userPersona?.id)
                .map((c) => c.name)
                .filter((n) => lastUserText.toLowerCase().includes(n.toLowerCase().slice(0, Math.max(3, n.length - 2))))
            : undefined,
        }),
      ]);
      const turnGuidanceBlock = guidancePrompt?.trim()
        ? buildTurnGuidanceBlock(guidancePrompt, dialogueLang)
        : '';
      const effectiveLengthRule = parseLengthOverride(guidancePrompt) || parseLengthOverride(activeChat.chatDirectives);

      // Build message array for API
      const apiMessages: any[] = [{ role: 'system', content: systemPrompt }];

      // Re-attach valid <emotion> tags to the last 2 assistant replies of this speaker when sprites are enabled,
      // so small local models have crisp in-context examples without breaking format.
      const speakerHasEmotions = Boolean(speaker.emotions && speaker.emotions.length > 0);
      const myAssistantIndices: number[] = [];
      if (speakerHasEmotions) {
        contextMsgs.forEach((m, i) => {
          const isMeMsg = type === 'group' ? m.senderId === speaker.id : m.senderId !== 'user';
          if (isMeMsg && m.variants[m.activeVariantIndex]?.text?.trim()) {
            myAssistantIndices.push(i);
          }
        });
      }
      const recentEmotionKeepSet = new Set(myAssistantIndices.slice(-2));

      // Process raw dialogue turns with clear speaker attribution
      const rawTurns: Array<{ role: 'user' | 'assistant'; text: string; image?: string }> = [];
      let lastUserRawText = '';
      contextMsgs.forEach((msg, idx) => {
        const activeVariant = msg.variants[msg.activeVariantIndex];
        if (!activeVariant || !activeVariant.text?.trim()) return;

        const isMe = type === 'group' ? msg.senderId === speaker.id : msg.senderId !== 'user';
        const role: 'user' | 'assistant' = isMe ? 'assistant' : 'user';

        let textContent = cleanHistoryText(activeVariant.text);
        if (!isMe && msg.senderId === 'user') {
          lastUserRawText = textContent;
        }
        if (isMe && recentEmotionKeepSet.has(idx) && activeVariant.emotion) {
          const validEmo = resolveEmotion(activeVariant.emotion, speaker.emotions, speaker.name);
          if (validEmo) {
            textContent = `<emotion>${validEmo}</emotion> ${textContent}`;
          }
        }
        if (type === 'group' && !isMe) {
          const displaySender = msg.senderId === 'user' && resolvedUserName ? resolvedUserName : msg.senderName;
          textContent = `[${displaySender}]: ${textContent}`;
        }

        rawTurns.push({
          role,
          text: textContent,
          image: msg.image && msg.senderId === 'user' ? msg.image : undefined,
        });
      });

      // Merge adjacent turns of the same role
      const alternatingTurns: any[] = [];
      for (const turn of rawTurns) {
        const last = alternatingTurns[alternatingTurns.length - 1];
        if (last && last.role === turn.role) {
          if (typeof last.content === 'string') {
            last.content += `\n\n${turn.text}`;
          } else if (Array.isArray(last.content)) {
            last.content[0].text += `\n\n${turn.text}`;
          }
          if (turn.image) {
            if (typeof last.content === 'string') {
              last.content = [
                { type: 'text', text: last.content },
                { type: 'image_url', image_url: { url: turn.image } },
              ];
            } else if (Array.isArray(last.content)) {
              last.content.push({ type: 'image_url', image_url: { url: turn.image } });
            }
          }
        } else {
          if (turn.image && turn.role === 'user') {
            alternatingTurns.push({
              role: 'user',
              content: [
                { type: 'text', text: turn.text },
                { type: 'image_url', image_url: { url: turn.image } },
              ],
            });
          } else {
            alternatingTurns.push({
              role: turn.role,
              content: turn.text,
            });
          }
        }
      }

      // Ensure start turn without bracketed meta wrappers that small local models mimic at Turn 0
      if (alternatingTurns.length > 0 && alternatingTurns[0].role === 'assistant') {
        alternatingTurns.unshift({
          role: 'user',
          content: type === 'group'
            ? (dialogueLang === 'ru' ? 'Начало сцены.' : 'Scene begins.')
            : (dialogueLang === 'ru' ? 'Привет.' : 'Hello.'),
        });
      }

      if (alternatingTurns.length === 0) {
        alternatingTurns.push({
          role: 'user',
          content: dialogueLang === 'ru' ? 'Начало сцены. Опиши первый шаг персонажа.' : 'Scene begins. Open naturally in character.',
        });
      }

      // Ensure conversation ends with a user turn (e.g. /continue or chained group turn)
      if (alternatingTurns[alternatingTurns.length - 1]?.role === 'assistant' && (sceneNote || turnGuidanceBlock)) {
        alternatingTurns.push({
          role: 'user',
          content: dialogueLang === 'ru'
            ? `Продолжи ответ ${speaker.name} естественно с текущего момента сцены, не повторяя прошлые фразы.`
            : `Continue ${speaker.name}'s turn naturally from the current moment without repeating earlier lines.`,
        });
      }

      apiMessages.push(...alternatingTurns);

      // Volatile tail (scene note + turn guidance) sits inside system[0] on Turn 0 (empty history)
      // so the first user turn stays pure prose with no technical dividers for small models to mimic.
      // On multi-turn chats it precedes the final user utterance so system[0] stays KV-cacheable.
      const tailBlocks: string[] = [];
      if (sceneNote) {
        const noteTitle = dialogueLang === 'ru' ? 'Контекст текущей сцены (не цитируй):' : 'Current scene context (do not quote):';
        tailBlocks.push(`${noteTitle}\n${sceneNote}`);
      }
      if (turnGuidanceBlock) {
        tailBlocks.push(turnGuidanceBlock);
      }

      if (tailBlocks.length > 0) {
        const tailText = tailBlocks.join('\n\n');
        const isFirstTurnOnly = alternatingTurns.length <= 1;
        const last = apiMessages[apiMessages.length - 1];
        if (!isFirstTurnOnly && last && last.role === 'user' && typeof last.content === 'string') {
          last.content = `${tailText}\n\n${last.content}`;
        } else if (!isFirstTurnOnly && last && last.role === 'user' && Array.isArray(last.content)) {
          last.content = [{ type: 'text', text: tailText }, ...last.content];
        } else {
          apiMessages[0] = { role: 'system', content: `${systemPrompt}\n\n${tailText}` };
        }
      }

      let fullGenerated = '';

      // Photos in the context go to the vision backend; plain text stays on the chat backend
      const hasImages = apiMessages.some((m: any) => Array.isArray(m.content) && m.content.some((p: any) => p.type === 'image_url'));
      const turnConfig = hasImages ? getComponentAiConfig(settings, activeApiKey, 'vision') : null;
      const samplers = resolveSamplerConfig(freshSettings || settings, isLocal);

      // Only the speaker's own name is stripped from the start; the stop list must not contain it,
      // otherwise a reply that begins with "Name:" is cut to nothing.
      const otherSpeakers = [
        resolvedUserName,
        ...allCharacters
          .filter((c) => c.id !== speaker.id && c.id !== userPersona?.id && group?.characterIds.includes(c.id))
          .map((c) => c.name),
      ].filter(Boolean);

      await streamChatCompletion({
        apiKeyConfig: (turnConfig ? turnConfig.apiKeyConfig : effectiveApiKey) as ApiKeyConfig,
        model: turnConfig ? turnConfig.textModel : effectiveModel,
        foreignNames: otherSpeakers,
        // Also stop if the model starts quoting the hidden scene note, turn directive, or fake multi-turn headers
        extraStops: [
          ...speakerStopStrings(otherSpeakers),
          '\n>user',
          '\n>fuser',
          '\n>assistant',
          '>**Имя:',
          '>**Name:',
          '\n[Собеседник:',
          '\n[Реплика',
          'Контекст текущей сцены',
          'Текущий контекст сцены',
          'Current scene context',
          '[Scene note',
          '[Scene context',
          '[Заметка сцены',
          '[Контекст сцены',
          '[УКАЗАНИЕ ПОЛЬЗОВАТЕЛЯ',
          'УКАЗАНИЕ ПОЛЬЗОВАТЕЛЯ НА ЭТОТ ХОД',
          'USER TURN DIRECTIVE',
        ],
        messages: apiMessages,
        temperature: samplers.temperature,
        topP: samplers.topP,
        minP: samplers.minP,
        topK: samplers.topK,
        repeatPenalty: samplers.repeatPenalty,
        repeatLastN: samplers.repeatLastN,
        frequencyPenalty: samplers.frequencyPenalty,
        presencePenalty: samplers.presencePenalty,
        maxTokens: samplers.maxTokens,
        includeReasoning: activeChat.thoughtsEnabled === true,
        signal: abortController.signal,
        onToken: (tok) => {
          setRestoringLlmNotice(false);
          fullGenerated += tok;
          const parsed = parseStreamingBotResponse(fullGenerated, speaker.emotions, speaker.name, [speaker.name]);
          if (parsed.emotion) {
            setStreamingEmotion(parsed.emotion);
          }
          setStreamingThought(parsed.thought || '');
          setStreamingText(parsed.text);
        },
        onComplete: async (rawCompleted) => {
          setRestoringLlmNotice(false);
          setIsGenerating(false);
          abortControllerRef.current = null;
          const completed = stripLeadingSpeakerName(rawCompleted, [speaker.name]);

          try {
            if (!completed || !completed.trim()) {
              alert(language === 'ru' ? 'Модель вернула пустой ответ. Проверьте лимиты модели или повторите попытку.' : 'Model returned an empty response. Please try again.');
              return;
            }

            const { text: extractedText, thought: finalThought, emotion: finalEmotion } =
              extractEmotionAndCleanResponse(completed, speaker.emotions, speaker.name);
            const deEchoed = finalizeReplyText(
              stripEchoedUserPrefix(
                extractedText || cleanArtifacts(completed, speaker.emotions),
                lastUserRawText
              ),
              { foreignNames: otherSpeakers }
            );
            const boundedText = enforceParagraphLimit(
              deEchoed,
              effectiveLengthRule?.maxParagraphs,
              effectiveLengthRule?.mode === 'shorter'
            );

            const newVariant: MessageVariant = {
              text: boundedText,
              thought: finalThought || undefined,
              emotion: finalEmotion,
              timestamp: Date.now(),
            };

            let updatedMsgList = [...messages];

            if (existingBotMsgToVariant) {
              // Append as a new variant to existing message
              const variants = [...existingBotMsgToVariant.variants, newVariant];
              await db.messages.update(existingBotMsgToVariant.id, {
                variants,
                activeVariantIndex: variants.length - 1,
                emotion: finalEmotion || existingBotMsgToVariant.emotion,
              });
            } else {
              // Create new bot message
              const newBotMsg: ChatMessage = {
                id: 'msg-' + Math.random().toString(36).substring(2, 10),
                chatId: session.id,
                senderId: speaker.id,
                senderName: speaker.name,
                senderAvatar: speaker.avatar,
                emotion: finalEmotion,
                variants: [newVariant],
                activeVariantIndex: 0,
                createdAt: Date.now(),
              };
              await db.messages.put(newBotMsg);
              updatedMsgList.push(newBotMsg);
            }

            await db.chats.update(session.id, { updatedAt: Date.now() });

            const targetTurnMsgId = existingBotMsgToVariant
              ? existingBotMsgToVariant.id
              : updatedMsgList[updatedMsgList.length - 1]?.id;

            const memoryConfig = getComponentAiConfig(settings, activeApiKey, 'memory');
            const summaryConfig = getComponentAiConfig(settings, activeApiKey, 'summary');

            // Run automated memory graph extraction and affinity change in background with fresh DB messages
            const freshHistory = (await db.messages.where('chatId').equals(session.id).sortBy('createdAt')).filter(
              (m) => m.senderId !== 'scene-director'
            );
            extractMemoryAndAffinity(
              session.id,
              speaker.id,
              affinity,
              freshHistory,
              memoryConfig.apiKeyConfig,
              memoryConfig.textModel,
              targetTurnMsgId
            ).then(async ({ newAffinity }) => {
              if (newAffinity !== affinity) {
                const currentLatest = await db.chats.get(session.id);
                if (currentLatest && !currentLatest.relationshipDetails?.[speaker.id]?.locked) {
                  const updatedR = { ...(currentLatest.relationships || {}), [speaker.id]: newAffinity };
                  await db.chats.update(session.id, { relationships: updatedR });
                }
              }
            }).catch((err) => {
              console.warn('Background memory extraction error:', err);
            });

            // Fold older turns into the rolling summary in batches so that no turn is left uncovered
            if ((effectiveApiKey?.key || isLocal) && !compressionRunningRef.current) {
              const latestChat = await db.chats.get(session.id);
              const histTokens = freshHistory.map((m) => {
                const text = cleanHistoryText(m.variants[m.activeVariantIndex]?.text || '');
                return text ? estimateTokens(text) + PER_MESSAGE_TOKENS : 0;
              });
              let covered = 0;
              let prevSummary = latestChat?.rollingSummary;
              if (latestChat?.lastSummarizedMsgId) {
                const idx = freshHistory.findIndex((m) => m.id === latestChat.lastSummarizedMsgId);
                if (idx !== -1) {
                  covered = idx + 1;
                } else {
                  prevSummary = undefined;
                }
              }

              const end = planSummaryBatch(histTokens, covered, dialogueBudget, maxVerbatim);
              if (end !== null) {
                // Keep the summarization request itself inside the model context
                const inputBudget = Math.round(promptTarget * 0.6);
                let stop = covered;
                let used = 0;
                while (stop < end && (stop === covered || used + histTokens[stop] <= inputBudget)) {
                  used += histTokens[stop];
                  stop++;
                }
                const batch = freshHistory.slice(covered, stop);
                const lastCovered = batch[batch.length - 1];
                const toSummarize = batch.map((m) => ({
                  senderName: m.senderName,
                  text: cleanHistoryText(m.variants[m.activeVariantIndex]?.text || ''),
                }));
                const limits = summaryLimits(promptTarget);
                compressionRunningRef.current = true;
                compressChatHistory(
                  summaryConfig.apiKeyConfig as any,
                  summaryConfig.textModel,
                  toSummarize,
                  prevSummary,
                  isLocal
                    ? { maxChars: limits.maxChars, maxTokens: limits.maxTokens, timeoutMs: 120000, isBackground: true }
                    : { isBackground: true }
                ).then(async (summary) => {
                  if (summary && summary.trim()) {
                    await db.chats.update(session.id, {
                      rollingSummary: summary.trim(),
                      lastSummarizedMsgId: lastCovered.id,
                    });
                  }
                }).catch((err) => {
                  console.warn('Background compression error:', err);
                }).finally(() => {
                  compressionRunningRef.current = false;
                });
              }
            }
          } catch (err: any) {
            console.error('Error finalizing bot generation:', err);
          }
        },
        onError: (err) => {
          setRestoringLlmNotice(false);
          setIsGenerating(false);
          abortControllerRef.current = null;
          if (!abortController.signal.aborted) {
            alert((language === 'ru' ? 'Ошибка генерации: ' : 'Generation Error: ') + err.message);
          }
        },
      });
    } catch (err: any) {
      if (!abortController.signal.aborted) {
        alert((language === 'ru' ? 'Ошибка запуска генерации: ' : 'Failed to generate: ') + (err?.message || err));
      }
    } finally {
      setRestoringLlmNotice(false);
      setIsGenerating(false);
      abortControllerRef.current = null;
    }
  };

  // Scene generation handler (/scene [perspective])
  const handleToggleSceneAnchorPin = async () => {
    if (!session?.sceneState) return;
    const nextLocked = !session.sceneState.location.locked;
    await db.chats.update(session.id, {
      sceneState: {
        ...session.sceneState,
        location: { ...session.sceneState.location, locked: nextLocked },
      },
      updatedAt: Date.now(),
    });
  };

  const runSceneGeneration = async (options?: {
    perspective?: string;
    targetMsg?: ChatMessage;
    skipAnalysis?: boolean;
    customPromptOverride?: string;
    seed?: number;
  }) => {
    if (!session || isGenerating || isGeneratingScene) return;

    const freshSettings = await db.settings.get('default');
    const effSettings = freshSettings || settings;
    const analysisCfg = getComponentAiConfig(effSettings, activeApiKey, 'sceneAnalysis');
    const imageCfg = getComponentAiConfig(effSettings, activeApiKey, 'sceneImage');

    if (!options?.skipAnalysis && !analysisCfg.isLocal && !analysisCfg.apiKeyConfig?.key?.trim()) {
      alert(language === 'ru' ? 'Настройте ИИ для анализа сцен в Настройках.' : 'Please configure AI connection for Scene Director in Settings.');
      return;
    }
    if (!imageCfg.isLocal && !imageCfg.apiKeyConfig?.key?.trim()) {
      alert(language === 'ru' ? 'Настройте ИИ для генерации изображений в Настройках.' : 'Please configure AI or Local Hub for Scene Images in Settings.');
      return;
    }

    const sceneCharacters = selectSceneCharacters({
      chatType: type,
      character,
      group,
      allCharacters,
      personaId: session.personaId,
    });

    if (sceneCharacters.length === 0) {
      if (type === 'group') {
        alert(t.sceneGroupNoEnabled);
      }
      return;
    }

    const controller = new AbortController();
    sceneAbortRef.current = controller;
    setSceneStartedAt(Date.now());
    setSceneStepInfo(null);
    setActiveSceneTargetMsgId(options?.targetMsg?.id || null);
    setIsGeneratingScene(true);
    setSceneStageText(options?.skipAnalysis ? t.sceneGeneratingStage : t.sceneAnalyzingStage);
    setSceneProgressPct(options?.skipAnalysis ? 25 : 8);

    try {
      const freshChat = (await db.chats.get(session.id)) || session;
      const freshMsgs = (await db.messages.where('chatId').equals(session.id).sortBy('createdAt')).filter(
        (m) => m.senderId !== 'scene-director'
      );
      const userPersona = freshChat.personaId
        ? allCharacters.find((c) => c.id === freshChat.personaId) || null
        : null;

      const result = await executeSceneGenerationPipeline({
        session: freshChat,
        messages: freshMsgs,
        characters: sceneCharacters,
        userPersona,
        perspective: options?.perspective || '',
        settings: effSettings,
        activeApiKey,
        skipAnalysis: options?.skipAnalysis,
        customPromptOverride: options?.customPromptOverride,
        seed: options?.seed,
        signal: controller.signal,
        onStage: (info) => {
          if (info.stage === 'analyzing') {
            setSceneStageText(t.sceneAnalyzingStage);
            setSceneStepInfo(null);
            setSceneProgressPct(info.progress ?? 12);
          } else if (info.stage === 'switching_memory') {
            if (imageCfg.isLocal) {
              imageModeActiveRef.current = true;
            }
            setSceneStageText(t.sceneMemorySwapStage);
            setSceneStepInfo(null);
            setSceneProgressPct(info.progress ?? 18);
          } else if (info.stage === 'loading_model') {
            if (imageCfg.isLocal) {
              imageModeActiveRef.current = true;
            }
            setSceneStageText(t.sceneLoadingModelStage);
            setSceneStepInfo(null);
            setSceneProgressPct(info.progress ?? 22);
          } else if (info.stage === 'encoding_prompt') {
            if (imageCfg.isLocal) {
              imageModeActiveRef.current = true;
            }
            setSceneStageText(t.sceneEncodingPromptStage);
            setSceneStepInfo(null);
            setSceneProgressPct(info.progress ?? 26);
          } else if (info.stage === 'decoding') {
            if (imageCfg.isLocal) {
              imageModeActiveRef.current = true;
            }
            setSceneStageText(t.sceneDecodingStage);
            setSceneProgressPct(info.progress ?? 96);
          } else {
            if (imageCfg.isLocal) {
              imageModeActiveRef.current = true;
            }
            if (info.totalSteps && info.step) {
              setSceneStepInfo({ step: info.step, totalSteps: info.totalSteps });
            }
            setSceneStageText(t.sceneGeneratingStage);
            setSceneProgressPct(info.progress ?? 50);
          }
        },
        onSceneStateUpdated: async (nextState) => {
          await db.chats.update(session.id, { sceneState: nextState, updatedAt: Date.now() });
        },
      });

      const compressed =
        (await normalizeSceneOutputImage(result.assetDraft.imageData, 1280, 0.9).catch(
          () => result.assetDraft.imageData
        )) || result.assetDraft.imageData;

      const now = Date.now();
      const assetId = 'scene-' + Math.random().toString(36).substring(2, 10);

      if (options?.targetMsg) {
        const latestTarget = (await db.messages.get(options.targetMsg.id)) || options.targetMsg;
        const nextIds = [...(latestTarget.sceneAssetIds || []), assetId];
        const newAsset: SceneAsset = {
          ...result.assetDraft,
          id: assetId,
          messageId: latestTarget.id,
          imageData: compressed,
          createdAt: now,
        };
        await db.sceneAssets.put(newAsset);
        await db.messages.update(latestTarget.id, {
          sceneAssetIds: nextIds,
          activeSceneAssetIndex: nextIds.length - 1,
        });
      } else {
        const msgId = 'msg-' + Math.random().toString(36).substring(2, 10);
        const newAsset: SceneAsset = {
          ...result.assetDraft,
          id: assetId,
          messageId: msgId,
          imageData: compressed,
          createdAt: now,
        };
        const label =
          options?.perspective?.trim() ||
          result.sceneState.location.locationName ||
          (language === 'ru' ? 'Сцена' : 'Scene');
        const sceneMsg: ChatMessage = {
          id: msgId,
          chatId: session.id,
          senderId: 'scene-director',
          senderName: language === 'ru' ? 'Режиссёр сцен' : 'Scene Director',
          variants: [{ text: label, timestamp: now }],
          activeVariantIndex: 0,
          sceneAssetIds: [assetId],
          activeSceneAssetIndex: 0,
          createdAt: now,
        };
        await db.sceneAssets.put(newAsset);
        await db.messages.put(sceneMsg);
        await db.chats.update(session.id, { updatedAt: now });
        requestAnimationFrame(() => scrollToBottom(false));
      }
    } catch (err: any) {
      if (!controller.signal.aborted) {
        const rawErr = String(err?.message || err || '');
        const missMatch = rawErr.match(/Model '([^']+)' \([^)]+\) is missing required companion files[^:]*:\s*([^.]+)/i);
        if (missMatch) {
          alert(
            `${t.sceneFailedPrefix}${t.sceneErrMissingCompanions
              .replace('{model}', missMatch[1])
              .replace('{roles}', missMatch[2].trim())}`
          );
        } else {
          alert(`${t.sceneFailedPrefix}${rawErr}`);
        }
      }
    } finally {
      sceneAbortRef.current = null;
      setIsGeneratingScene(false);
      setSceneStageText('');
      setSceneProgressPct(0);
      setSceneStepInfo(null);
      setActiveSceneTargetMsgId(null);
    }
  };

  // Send User Message
  const handleSendMessage = async () => {
    if ((!inputText.trim() && !attachedImage) || isGenerating || isGeneratingScene || isSubmittingRef.current || !session) return;

    // Intercept slash commands typed into the input
    const trimmedInput = inputText.trim();
    if (trimmedInput.startsWith('/') && !attachedImage) {
      const parsedScene = parseSceneCommand(trimmedInput);
      if (parsedScene.isSceneCommand) {
        setInputText('');
        setShowSlashMenu(false);
        if (textareaRef.current) {
          textareaRef.current.style.height = 'auto';
        }
        await runSceneGeneration({ perspective: parsedScene.perspective });
        return;
      }
      const parsedWand = parseWandCommand(trimmedInput);
      if (parsedWand.isWandCommand) {
        setInputText('');
        setShowSlashMenu(false);
        if (textareaRef.current) {
          textareaRef.current.style.height = 'auto';
        }
        setUserWandPrompt(parsedWand.hint);
        setWandPreview('');
        setShowUserWandModal(true);
        if (parsedWand.hint) {
          void handleExecuteUserWand(parsedWand.hint);
        }
        return;
      }
      const canonicalCmd = resolveCanonicalSlashCommand(trimmedInput.split(/\s+/)[0]);
      if (canonicalCmd && canonicalCmd !== '/scene' && canonicalCmd !== '/wand') {
        await handleSelectSlashCommand(canonicalCmd);
        return;
      }
    }

    isSubmittingRef.current = true;
    try {
      const userPersona = session.personaId
        ? allCharacters.find((c) => c.id === session.personaId) || null
        : null;

      const userMsg: ChatMessage = {
        id: 'msg-' + Math.random().toString(36).substring(2, 10),
        chatId: session.id,
        senderId: 'user',
        senderName: userPersona ? userPersona.name : (settings?.userName?.trim() || (language === 'ru' ? 'Вы' : 'You')),
        senderAvatar: userPersona ? userPersona.avatar : undefined,
        variants: [
          {
            text: inputText.trim(),
            timestamp: Date.now(),
          },
        ],
        activeVariantIndex: 0,
        image: attachedImage || undefined,
        createdAt: Date.now(),
      };

      await db.messages.put(userMsg);
      await db.chats.update(session.id, { updatedAt: Date.now() });

      setInputText('');
      setAttachedImage(null);
      setShowSlashMenu(false);
      if (textareaRef.current) {
        textareaRef.current.style.height = 'auto';
      }

      setShowScrollBottom(false);
      isSmoothScrollingToBottomRef.current = false;
      userScrolledUpRef.current = false;
      requestAnimationFrame(() => {
        scrollToBottom(false);
      });

      // Trigger bot reply: only in 1-on-1 chat!
      // In group chats, characters ONLY respond when invoked explicitly by the user!
      if (type === 'character') {
        runBotGeneration();
      }
    } finally {
      isSubmittingRef.current = false;
    }
  };

  // Rollback and Fork chat session (preserving memory nodes, bridged edges, and scene state!)
  const handleRollback = async (targetMsg: ChatMessage) => {
    if (!session) return;
    const targetIdx = messages.findIndex((m) => m.id === targetMsg.id);
    if (targetIdx === -1) return;

    const messagesToKeep = messages.slice(0, targetIdx + 1);

    // Create a new branched session
    const newSessionId = 'chat-fork-' + Math.random().toString(36).substring(2, 9);
    const newTitle = `${session.title} (Fork ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })})`;

    const msgIdMap = new Map<string, string>();
    for (const msg of messagesToKeep) {
      msgIdMap.set(msg.id, 'msg-' + Math.random().toString(36).substring(2, 10));
    }

    const forkedSceneState: SceneState | undefined = session.sceneState
      ? {
          ...session.sceneState,
          lastAnalyzedMsgId: session.sceneState.lastAnalyzedMsgId
            ? msgIdMap.get(session.sceneState.lastAnalyzedMsgId)
            : undefined,
        }
      : undefined;

    const forkedSession: ChatSession = {
      ...session,
      id: newSessionId,
      title: newTitle,
      sceneState: forkedSceneState,
      lastSummarizedMsgId: session.lastSummarizedMsgId
        ? msgIdMap.get(session.lastSummarizedMsgId)
        : undefined,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    await db.chats.put(forkedSession);

    // Clone messages into the new session
    for (const msg of messagesToKeep) {
      const clonedMsgId = msgIdMap.get(msg.id)!;
      let clonedSceneIds: string[] | undefined;
      if (msg.sceneAssetIds && msg.sceneAssetIds.length > 0) {
        clonedSceneIds = [];
        for (const aid of msg.sceneAssetIds) {
          const orig = sceneAssetsById[aid];
          if (orig) {
            const newAid = 'scene-' + Math.random().toString(36).substring(2, 10);
            await db.sceneAssets.put({
              ...orig,
              id: newAid,
              chatId: newSessionId,
              messageId: clonedMsgId,
            });
            clonedSceneIds.push(newAid);
          }
        }
      }
      await db.messages.put({
        ...msg,
        id: clonedMsgId,
        chatId: newSessionId,
        sceneAssetIds: clonedSceneIds,
      });
    }

    // Clone memory graph nodes & edges up to the rollback point so long-chat memories never disappear!
    try {
      const [origNodes, origEdges] = await Promise.all([
        db.memoryNodes.where('chatId').equals(session.id).toArray(),
        db.memoryEdges.where('chatId').equals(session.id).toArray(),
      ]);
      if (origNodes.length > 0) {
        const clonedGraph = cloneMemoryGraphRecords(origNodes, origEdges, newSessionId, msgIdMap);
        if (clonedGraph.nodes.length > 0) {
          await db.memoryNodes.bulkPut(clonedGraph.nodes);
        }
        if (clonedGraph.edges.length > 0) {
          await db.memoryEdges.bulkPut(clonedGraph.edges);
        }
      }
    } catch (err) {
      console.warn('Failed to clone memory graph on rollback:', err);
    }

    // Switch to new session
    setCurrentSessionId(newSessionId);
  };

  // Edit Message
  const handleStartEdit = (msg: ChatMessage) => {
    setEditingMsgId(msg.id);
    const v = msg.variants[msg.activeVariantIndex];
    setEditText(v ? v.text : '');
  };

  const handleSaveEdit = async (msg: ChatMessage) => {
    if (!editText.trim()) return;

    const activeV = msg.variants[msg.activeVariantIndex];
    const updatedVariants = [...msg.variants];
    updatedVariants[msg.activeVariantIndex] = {
      ...activeV,
      text: editText.trim(),
      timestamp: Date.now(),
    };

    await db.messages.update(msg.id, { variants: updatedVariants });
    setEditingMsgId(null);

    // If edited user message, remove subsequent messages and re-trigger bot response!
    if (msg.senderId === 'user') {
      const msgIndex = messages.findIndex((m) => m.id === msg.id);
      if (msgIndex !== -1) {
        const toDelete = messages.slice(msgIndex + 1);
        const deletedIds: string[] = [];
        for (const d of toDelete) {
          deletedIds.push(d.id);
          await db.messages.delete(d.id);
          await db.sceneAssets.where('messageId').equals(d.id).delete().catch(() => {});
        }
        if (deletedIds.length > 0) {
          await removeMemoriesWithBridge({
            chatId: msg.chatId,
            messageIds: deletedIds,
            respectPinned: true,
          }).catch(() => {});
        }
      }
      runBotGeneration();
    }
  };

  // Copy message text
  const handleCopy = (msg: ChatMessage) => {
    const v = msg.variants[msg.activeVariantIndex];
    if (v) {
      navigator.clipboard.writeText(v.text);
      setCopiedId(msg.id);
      setTimeout(() => setCopiedId(null), 2000);
    }
  };

  // Variant Carousel switch
  const handleVariantSwitch = async (msg: ChatMessage, dir: -1 | 1) => {
    const nextIdx = msg.activeVariantIndex + dir;
    if (nextIdx >= 0 && nextIdx < msg.variants.length) {
      await db.messages.update(msg.id, { activeVariantIndex: nextIdx });
    }
  };

  // Regenerate bot message
  const handleRegenerate = async (msg: ChatMessage, guidance?: string) => {
    if (msg.senderId === 'user' || isGenerating) return;
    const speaker = allCharacters.find((c) => c.id === msg.senderId) || character;
    await runBotGeneration(speaker, guidance, msg);
  };

  // User Magic Wand Ghostwriter: streams the suggestion, can be stopped, keeps the partial text
  const handleExecuteUserWand = async (promptOverride?: string | React.MouseEvent) => {
    const effectiveWandPrompt = typeof promptOverride === 'string' ? promptOverride : userWandPrompt;
    const ghostCfg = getComponentAiConfig(settings, activeApiKey, 'ghostwriter');
    const ghostKey = ghostCfg.apiKeyConfig;
    if (!ghostKey || (!ghostKey.key?.trim() && !ghostCfg.isLocal)) {
      alert(language === 'ru' ? 'Сначала настройте подключение к ИИ в настройках' : 'Please configure AI connection in settings first');
      return;
    }
    const controller = new AbortController();
    wandAbortRef.current = controller;
    setWandPreview('');
    setWandStartedAt(Date.now());
    setIsWandGenerating(true);
    try {
      const userPersona = session?.personaId
        ? allCharacters.find((c) => c.id === session.personaId) || null
        : null;
      const wandUserName = (userPersona?.name || settings?.userName || '').trim() || undefined;
      const history = buildContextHistory(messages, wandUserName);
      const otherSpeakers = type === 'group'
        ? allCharacters
            .filter((c) => group?.characterIds.includes(c.id) && c.id !== userPersona?.id)
            .map((c) => c.name)
        : (character ? [character.name] : []);
      const langProbe = history || effectiveWandPrompt || character?.description || '';
      const wandLang: 'en' | 'ru' = /[а-яА-ЯёЁ]/.test(langProbe) ? 'ru' : (/[a-zA-Z]/.test(langProbe) ? 'en' : language);

      const suggested = await suggestUserReply(
        ghostKey as any,
        ghostCfg.textModel,
        userPersona,
        effectiveWandPrompt,
        history,
        {
          userName: wandUserName,
          otherSpeakers,
          language: wandLang,
          onPartial: (text) => setWandPreview(text),
          signal: controller.signal,
        }
      );
      setWandPreview(suggested.trim());
      if (!suggested.trim() && !controller.signal.aborted) {
        alert(language === 'ru' ? 'Модель вернула пустой ответ. Попробуйте еще раз.' : 'Model returned empty suggestion. Please try again.');
      }
    } catch (err: any) {
      alert((language === 'ru' ? 'Ошибка подсказки реплики: ' : 'Ghostwriter failed: ') + err.message);
    } finally {
      wandAbortRef.current = null;
      setIsWandGenerating(false);
    }
  };

  const applyWandPreview = () => {
    if (!wandPreview.trim()) return;
    setInputText(wandPreview.trim());
    setShowUserWandModal(false);
    setUserWandPrompt('');
    setWandPreview('');
    if (textareaRef.current) {
      requestAnimationFrame(() => {
        if (textareaRef.current) {
          textareaRef.current.style.height = 'auto';
          textareaRef.current.style.height = `${Math.min(textareaRef.current.scrollHeight, 192)}px`;
        }
      });
    }
  };

  const closeWandModal = () => {
    wandAbortRef.current?.abort();
    setShowUserWandModal(false);
    setWandPreview('');
  };

  // Slash commands handler
  const handleSelectSlashCommand = async (cmd: string) => {
    setShowSlashMenu(false);
    if (cmd === '/scene') {
      const parsed = parseSceneCommand(inputText.trim());
      setInputText('');
      await runSceneGeneration({ perspective: parsed.perspective });
    } else if (cmd === '/wand') {
      const parsedWand = parseWandCommand(inputText.trim());
      const hint = parsedWand.isWandCommand ? parsedWand.hint : '';
      setInputText('');
      setUserWandPrompt(hint);
      setWandPreview('');
      setShowUserWandModal(true);
      if (hint) {
        void handleExecuteUserWand(hint);
      }
    } else if (cmd === '/continue') {
      setInputText('');
      runBotGeneration();
    } else if (cmd === '/summary') {
      setInputText('');
      if (!messages || messages.length === 0) {
        setSummaryModalText(
          language === 'ru'
            ? 'В этом диалоге пока нет сообщений для сводки.'
            : 'There are no messages in this chat yet to summarize.'
        );
        return;
      }
      if (!effectiveApiKey || (!effectiveApiKey.key.trim() && !isLocal)) {
        alert(language === 'ru' ? 'Требуется подключение к ИИ для генерации сводки.' : 'AI connection required for summary.');
        return;
      }
      setSummaryStartedAt(Date.now());
      setIsSummarizing(true);
      setSummaryModalText(' ');
      try {
        const history = buildContextHistory(messages);
        const summaryCfg = getComponentAiConfig(settings, activeApiKey, 'summary');
        const recap = await summarizeScene(
          summaryCfg.apiKeyConfig as any,
          summaryCfg.textModel,
          history,
          language
        );
        setSummaryModalText(recap);
      } catch (err: any) {
        setSummaryModalText(language === 'ru' ? `Ошибка генерации сводки: ${err.message}` : `Failed to summarize: ${err.message}`);
      } finally {
        setIsSummarizing(false);
      }
    } else if (cmd === '/memory') {
      setInputText('');
      setShowSettingsModal(true);
    } else if (cmd === '/action') {
      setInputText('*action* ');
    } else if (cmd === '/reset') {
      if (window.confirm(language === 'ru' ? 'Очистить сообщения и не зафиксированные воспоминания в этой сессии?' : 'Clear messages and unpinned memories in this chat session?')) {
        if (session) {
          await db.messages.where('chatId').equals(session.id).delete();
          await db.sceneAssets.where('chatId').equals(session.id).delete().catch(() => {});
          const unpinned = await db.memoryNodes.where('chatId').equals(session.id).filter((n) => !n.isPinned).toArray();
          if (unpinned.length > 0) {
            await removeMemoriesWithBridge({
              chatId: session.id,
              nodeIds: unpinned.map((u) => u.id),
              respectPinned: true,
            }).catch(() => {});
          }
          const lockedRelationships: Record<string, number> = {};
          for (const [charId, val] of Object.entries(session.relationships || {})) {
            if (session.relationshipDetails?.[charId]?.locked) {
              lockedRelationships[charId] = val;
            }
          }
          await db.chats.update(session.id, {
            rollingSummary: undefined,
            lastSummarizedMsgId: undefined,
            sceneState: undefined,
            relationships: lockedRelationships,
            updatedAt: Date.now(),
          });
        }
      }
      setInputText('');
    }
  };

  // Formatter for *action*
  const formatMessageText = (rawText: string) => {
    const parts = rawText.split(/(\*[^*]+\*)/g);
    return parts.map((part, i) => {
      if (part.startsWith('*') && part.endsWith('*')) {
        return (
          <span
            key={i}
            className="italic font-normal"
            style={{ color: currentTheme.actionColor || 'var(--theme-action, #a1a1aa)' }}
          >
            {part}
          </span>
        );
      }
      return <span key={i}>{part}</span>;
    });
  };

  const bgImage = type === 'character' ? character?.chatBackground : group?.chatBackground;

  return (
    <div
      className="relative flex flex-col h-full overflow-hidden bg-silk-950 text-slate-100"
      style={{
        backgroundImage: bgImage ? `url(${bgImage})` : undefined,
        backgroundSize: 'cover',
        backgroundPosition: 'center',
      }}
    >
      {/* Background tint overlay */}
      <div
        className="absolute inset-0 pointer-events-none z-0"
        style={{
          backgroundColor: `rgba(var(--app-bg-rgb, 7, 9, 14), ${currentTheme.backgroundTint})`,
        }}
      />

      {/* 1. Header */}
      <div className="relative z-10 flex items-center justify-between px-4 py-3 bg-silk-900/80 backdrop-blur-xl border-b border-silk-800/80 shrink-0">
        <div className="flex items-center gap-3 min-w-0">
          <button
            onClick={onBack}
            type="button"
            className="p-1.5 -ml-1 text-slate-400 hover:text-white rounded-xl hover:bg-silk-800 shrink-0"
          >
            <ArrowLeft className="w-5 h-5" />
          </button>

          {/* Avatar & Title */}
          <div className="flex items-center gap-2.5 min-w-0">
            <div className="relative w-9 h-9 rounded-xl overflow-hidden bg-silk-800 border border-silk-700 shrink-0">
              <AvatarImage
                src={type === 'character' ? character?.avatar : group?.avatar}
                alt={type === 'character' ? character?.name : group?.name}
                isGroup={type === 'group'}
                className="w-full h-full object-cover"
              />
            </div>

            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <h2 className="text-sm font-bold text-white leading-tight truncate max-w-[150px] sm:max-w-[200px]">
                  {type === 'character' ? character?.name : group?.name}
                </h2>
              </div>
              <span className="text-[10px] text-emerald-400 flex items-center gap-1">
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 inline-block shrink-0" />
                <span className="truncate">{type === 'character' ? (language === 'ru' ? 'В ролевой' : 'In Roleplay') : (language === 'ru' ? 'Групповая сессия' : 'Group Session')}</span>
              </span>
            </div>
          </div>
        </div>

        {/* Top Right RP Settings */}
        <div className="flex items-center gap-1 shrink-0">
          <button
            onClick={() => setShowSettingsModal(true)}
            type="button"
            className="p-2 text-slate-400 hover:text-white rounded-xl hover:bg-silk-800"
            title={t.chatSettings}
          >
            <SettingsIcon className="w-5 h-5" />
          </button>
        </div>
      </div>

      {/* Sticky Activity Strip (visible even when scrolled up in history) */}
      {(isGeneratingScene || (isGenerating && !streamingText && !streamingThought)) && (
        <div className="relative z-20 px-3 py-1.5 bg-silk-950/90 border-b border-silk-800/80 shrink-0">
          {isGeneratingScene ? (
            <ActivityProgressBar
              compact
              accent="emerald"
              language={language}
              label={sceneStageText || t.sceneGeneratingStage}
              progress={sceneProgressPct}
              stepInfo={sceneStepInfo}
              startedAt={sceneStartedAt}
              onCancel={() => sceneAbortRef.current?.abort()}
              cancelLabel={t.cancel}
            />
          ) : (
            <ActivityProgressBar
              compact
              accent={restoringLlmNotice ? 'emerald' : 'violet'}
              language={language}
              label={restoringLlmNotice ? t.sceneRestoringLlmStage : t.chatPreparingReply}
              startedAt={botGenStartedAt}
              onCancel={() => abortControllerRef.current?.abort()}
              cancelLabel={t.stopGenerating}
            />
          )}
        </div>
      )}

      {/* 2. Messages Scroll Area */}
      <div
        ref={chatContainerRef}
        onScroll={handleScroll}
        onWheel={(e) => handleUserScrollIntent(e.deltaY)}
        onTouchStart={() => handleUserScrollIntent()}
        className="relative z-10 flex-1 overflow-y-auto p-4 space-y-4 pb-4"
      >
        {/* Load older messages button */}
        {hasMoreMessages && (
          <div className="flex justify-center pt-1 pb-2">
            <button
              type="button"
              onClick={triggerLoadOlderMessages}
              className="px-3.5 py-1.5 rounded-full bg-silk-850/90 hover:bg-silk-800 text-[11px] font-medium text-slate-400 hover:text-violet-300 border border-silk-700/80 transition-colors shadow-sm"
            >
              {t.loadOlderMessages} ({totalMessagesCount - displayedMessages.length})
            </button>
          </div>
        )}

        {(() => {
          const latestBotMsg = [...messages]
            .reverse()
            .find((m) => m.senderId !== 'user' && m.senderId !== 'scene-director');
          return displayedMessages.map((msg) => {
            if (msg.senderId === 'scene-director' || (msg.sceneAssetIds && msg.sceneAssetIds.length > 0)) {
              const assetIds = msg.sceneAssetIds || [];
              const activeIdx = Math.min(msg.activeSceneAssetIndex || 0, Math.max(0, assetIds.length - 1));
              const activeAsset = assetIds[activeIdx] ? sceneAssetsById[assetIds[activeIdx]] : undefined;
              const isPinned = Boolean(session?.sceneState?.location.locked);
              const sceneTitle =
                activeAsset?.perspective?.trim() ||
                msg.variants[msg.activeVariantIndex]?.text ||
                (language === 'ru' ? 'Сцена' : 'Scene');

              return (
                <div key={msg.id} className="flex justify-center animate-message-in my-1">
                  <div className="w-full max-w-md rounded-2xl bg-silk-900/95 border border-silk-700/80 overflow-hidden shadow-lg">
                    {/* Scene Header */}
                    <div className="flex items-center justify-between gap-2 px-3 py-2 border-b border-silk-800/80 bg-silk-950/60">
                      <div className="flex items-center gap-1.5 min-w-0">
                        <Camera className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
                        <span className="text-[11px] font-semibold text-slate-200 truncate">{sceneTitle}</span>
                        <SceneHelpButton
                          topic="sceneCard"
                          language={language}
                          onOpenGuide={() => setShowSceneGuide(true)}
                        />
                      </div>
                      <div className="flex items-center gap-1.5 shrink-0">
                        {assetIds.length > 1 && (
                          <div className="flex items-center gap-0.5 px-1.5 py-0.5 rounded-lg bg-silk-800 border border-silk-700 font-mono text-[10px] text-slate-300">
                            <button
                              type="button"
                              disabled={activeIdx <= 0}
                              onClick={() => db.messages.update(msg.id, { activeSceneAssetIndex: activeIdx - 1 })}
                              className="disabled:opacity-30 hover:text-white"
                            >
                              <ChevronLeft className="w-3 h-3" />
                            </button>
                            <span>{activeIdx + 1}/{assetIds.length}</span>
                            <button
                              type="button"
                              disabled={activeIdx >= assetIds.length - 1}
                              onClick={() => db.messages.update(msg.id, { activeSceneAssetIndex: activeIdx + 1 })}
                              className="disabled:opacity-30 hover:text-white"
                            >
                              <ChevronRight className="w-3 h-3" />
                            </button>
                          </div>
                        )}
                        {session?.sceneState && (
                          <div className="flex items-center gap-1">
                            <button
                              type="button"
                              onClick={handleToggleSceneAnchorPin}
                              className={`flex items-center gap-1 px-2 py-0.5 rounded-lg text-[10px] font-medium border transition-colors ${
                                isPinned
                                  ? 'bg-emerald-500/15 border-emerald-500/40 text-emerald-300'
                                  : 'bg-silk-800 border-silk-700 text-slate-400 hover:text-white'
                              }`}
                              title={isPinned ? t.sceneUnpinAnchorBtn : t.scenePinAnchorBtn}
                            >
                              {isPinned ? <Pin className="w-3 h-3" /> : <PinOff className="w-3 h-3" />}
                              <span>{isPinned ? t.sceneAnchorPinnedBadge : t.scenePinAnchorBtn}</span>
                            </button>
                            <SceneHelpButton
                              topic="locationAnchor"
                              language={language}
                              onOpenGuide={() => setShowSceneGuide(true)}
                            />
                          </div>
                        )}
                      </div>
                    </div>

                    {/* Rendered Image */}
                    {activeAsset?.imageData && (
                      <button
                        type="button"
                        onClick={() => setLightboxAsset({ asset: activeAsset, msgId: msg.id })}
                        className="block w-full bg-black/40 cursor-zoom-in"
                      >
                        <img
                          src={activeAsset.imageData}
                          alt={sceneTitle}
                          className="w-full max-h-96 object-contain mx-auto block"
                        />
                      </button>
                    )}

                    {/* Skipped Incompatible LoRA Notice (when switching base model families) */}
                    {activeAsset?.skippedLoras && activeAsset.skippedLoras.length > 0 && (
                      <div className="px-3 py-1.5 border-t border-silk-800/80 bg-amber-500/10 text-[10px] text-amber-200 leading-snug">
                        {activeAsset.skippedLoras.map((s) =>
                          t.sceneSkippedLoraNotice
                            .replace('{lora}', `${s.filename} [${s.lora_arch || '?'}]`)
                            .replace('{model}', s.model_family || 'active')
                        ).join(' · ')}
                      </div>
                    )}

                    {/* Inline Progress Bar when regenerating or changing camera angle on this card */}
                    {isGeneratingScene && activeSceneTargetMsgId === msg.id && (
                      <div className="p-2.5 border-t border-silk-800/80 bg-silk-950/75">
                        <ActivityProgressBar
                          compact
                          accent="emerald"
                          language={language}
                          label={sceneStageText || t.sceneGeneratingStage}
                          progress={sceneProgressPct}
                          stepInfo={sceneStepInfo}
                          startedAt={sceneStartedAt}
                          onCancel={() => sceneAbortRef.current?.abort()}
                          cancelLabel={t.cancel}
                        />
                      </div>
                    )}

                    {/* Action Controls */}
                    <div className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 border-t border-silk-800/80 bg-silk-950/40 text-[11px]">
                      <div className="flex items-center gap-1.5">
                        <button
                          type="button"
                          disabled={isGenerating || isGeneratingScene}
                          onClick={() =>
                            runSceneGeneration({
                              perspective: activeAsset?.perspective || '',
                              targetMsg: msg,
                              skipAnalysis: Boolean(session?.sceneState),
                            })
                          }
                          className="flex items-center gap-1 px-2.5 py-1 rounded-lg bg-silk-800 hover:bg-silk-700 disabled:opacity-40 text-slate-200 border border-silk-700"
                        >
                          <RefreshCw className="w-3 h-3" />
                          <span>{t.sceneRegenerateBtn}</span>
                        </button>
                        <button
                          type="button"
                          disabled={isGenerating || isGeneratingScene}
                          onClick={() => {
                            if (angleInputMsgId === msg.id) {
                              setAngleInputMsgId(null);
                              setAngleInputText('');
                            } else {
                              setAngleInputMsgId(msg.id);
                              setAngleInputText('');
                            }
                          }}
                          className={`flex items-center gap-1 px-2.5 py-1 rounded-lg disabled:opacity-40 border transition-colors ${
                            angleInputMsgId === msg.id
                              ? 'bg-emerald-600/20 border-emerald-500/60 text-emerald-200'
                              : 'bg-silk-800 hover:bg-silk-700 text-emerald-300 border-silk-700'
                          }`}
                        >
                          <Camera className="w-3 h-3" />
                          <span>{t.sceneChangeAngleBtn}</span>
                        </button>
                      </div>
                      <div className="flex items-center gap-1">
                        {activeAsset?.imageData && (
                          <a
                            href={activeAsset.imageData}
                            download={`scene-${activeAsset.id}.jpg`}
                            className="flex items-center gap-1 px-2 py-1 rounded-lg bg-silk-800 hover:bg-silk-700 text-slate-300 hover:text-white border border-silk-700"
                            title={t.sceneDownloadBtn}
                          >
                            <Download className="w-3 h-3" />
                            <span>{t.sceneDownloadBtn}</span>
                          </a>
                        )}
                        <button
                          type="button"
                          onClick={() => handleRollback(msg)}
                          className="p-1 text-slate-400 hover:text-amber-400 rounded hover:bg-silk-800"
                          title={t.rollback}
                        >
                          <RotateCcw className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </div>

                    {/* Inline Camera Angle Presets + Custom Input */}
                    {angleInputMsgId === msg.id && (
                      <div className="px-3 pb-3 pt-2 border-t border-silk-800/60 bg-silk-950/70 space-y-2">
                        <div className="flex flex-wrap gap-1.5">
                          {([
                            [t.sceneAngleCloseUp, language === 'ru' ? 'крупный план' : 'close-up portrait'],
                            [t.sceneAngleFromBehind, language === 'ru' ? 'со спины' : 'from behind'],
                            [t.sceneAngleFullBody, language === 'ru' ? 'в полный рост' : 'full-body wide shot'],
                            [t.sceneAngleSideView, language === 'ru' ? 'вид сбоку' : 'side profile'],
                            [t.sceneAngleLowAngle, language === 'ru' ? 'нижний ракурс' : 'low angle'],
                            [t.sceneAngleFirstPerson, language === 'ru' ? 'от первого лица' : 'first-person POV'],
                          ] as const).map(([chipLabel, chipAngle]) => (
                            <button
                              key={chipLabel}
                              type="button"
                              disabled={isGeneratingScene || isGenerating}
                              onClick={() => {
                                setAngleInputMsgId(null);
                                setAngleInputText('');
                                runSceneGeneration({
                                  perspective: chipAngle,
                                  targetMsg: msg,
                                  skipAnalysis: false,
                                });
                              }}
                              className="px-2.5 py-1 rounded-lg bg-silk-800 hover:bg-silk-700 border border-silk-700 text-[11px] text-slate-200 font-medium transition-colors"
                            >
                              {chipLabel}
                            </button>
                          ))}
                        </div>
                        <div className="flex items-center gap-1.5">
                          <input
                            type="text"
                            value={angleInputText}
                            onChange={(e) => setAngleInputText(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter' && angleInputText.trim()) {
                                e.preventDefault();
                                const p = angleInputText.trim();
                                setAngleInputMsgId(null);
                                setAngleInputText('');
                                runSceneGeneration({ perspective: p, targetMsg: msg, skipAnalysis: false });
                              }
                            }}
                            placeholder={t.sceneAnglePromptPlaceholder}
                            className="flex-1 min-w-0 px-2.5 py-1.5 rounded-lg bg-silk-800 border border-silk-700 text-xs text-white placeholder-slate-500 focus:outline-none focus:border-emerald-500"
                          />
                          <button
                            type="button"
                            disabled={!angleInputText.trim() || isGeneratingScene || isGenerating}
                            onClick={() => {
                              const p = angleInputText.trim();
                              setAngleInputMsgId(null);
                              setAngleInputText('');
                              runSceneGeneration({ perspective: p, targetMsg: msg, skipAnalysis: false });
                            }}
                            className="px-2.5 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 text-white text-xs font-medium shrink-0"
                          >
                            <Check className="w-3.5 h-3.5" />
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              setAngleInputMsgId(null);
                              setAngleInputText('');
                            }}
                            className="p-1.5 rounded-lg text-slate-400 hover:text-white"
                          >
                            <X className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              );
            }

            const isUser = msg.senderId === 'user';
            const isLatestBotMsg = !isUser && latestBotMsg?.id === msg.id;
            const activeVariant = msg.variants[msg.activeVariantIndex] || { text: '' };
            const isEditing = editingMsgId === msg.id;
            const hasVariants = msg.variants.length > 1;
            const isThoughtExpanded = !!expandedThoughts[msg.id];

            const botChar = !isUser ? allCharacters.find((c) => c.id === msg.senderId) || (type === 'character' ? character : undefined) : undefined;
            // The avatar never changes with emotion: the emotion is shown as a sprite under the text
            const botAvatar = !isUser ? (botChar?.avatar || msg.senderAvatar || '') : undefined;

            return (
              <div
                key={msg.id}
                className={`flex ${isUser ? 'justify-end' : 'justify-start'} items-end gap-2.5 group ${Date.now() - msg.createdAt < 2500 ? 'animate-message-in' : ''}`}
              >
              {/* Bot Avatar with Emotion Sprite */}
              {!isUser && (
                <div className="relative w-8 h-8 rounded-xl overflow-hidden shrink-0 border border-silk-700 bg-silk-800 mb-1">
                  <AvatarImage
                    src={botAvatar}
                    alt={msg.senderName}
                    className="w-full h-full object-cover"
                  />
                </div>
              )}

              <div className={`flex flex-col ${isUser ? 'items-end' : 'items-start'} max-w-[85%] space-y-1`}>
                {/* Sender Name in group chat */}
                {!isUser && type === 'group' && (
                  <div className="flex items-center gap-1.5 text-[11px] font-semibold text-violet-300 ml-1">
                    <span>{msg.senderName}</span>
                  </div>
                )}

                {/* Message Bubble Container */}
                <div
                  className={`relative p-3.5 border border-silk-800/70 transition-colors ${
                    isUser ? 'text-slate-100' : 'text-slate-200'
                  }`}
                  style={{
                    backgroundColor: hexToRgba(
                      isUser ? currentTheme.bubbleUserBg : currentTheme.bubbleBotBg,
                      currentTheme.bubbleOpacity
                    ),
                    borderRadius: `${currentTheme.bubbleRadius}px`,
                    fontSize: `${currentTheme.fontSize}px`,
                    fontFamily: fontFamilyStyle,
                    lineHeight: lineHeightStyle,
                  }}
                >
                  {/* Image attachment if any */}
                  {msg.image && (
                    <div className="mb-2 rounded-xl overflow-hidden max-h-56 border border-silk-700/60">
                      <img src={msg.image} alt="Attachment" className="w-full h-full object-cover" />
                    </div>
                  )}

                  {/* Inner Monologue / Thoughts Box */}
                  {!isUser && activeVariant.thought && (
                    <div className="mb-2 p-2 rounded-xl bg-silk-950/80 border border-silk-700 text-xs">
                      <button
                        type="button"
                        onClick={() =>
                          setExpandedThoughts((prev) => ({
                            ...prev,
                            [msg.id]: !prev[msg.id],
                          }))
                        }
                        className="flex items-center justify-between w-full text-[10px] font-semibold uppercase tracking-wider text-violet-400 mb-1"
                      >
                        <span className="flex items-center gap-1">
                          <Sparkles className="w-3 h-3" />
                          <span>{t.thinkingBlock}</span>
                        </span>
                        {isThoughtExpanded ? (
                          <EyeOff className="w-3 h-3" />
                        ) : (
                          <Eye className="w-3 h-3" />
                        )}
                      </button>
                      {isThoughtExpanded && (
                        <p className="text-slate-300 italic text-[11px] leading-relaxed">
                          {activeVariant.thought}
                        </p>
                      )}
                    </div>
                  )}

                  {/* Message Body or Edit Box */}
                  {isEditing ? (
                    <div className="space-y-2">
                      <textarea
                        rows={2}
                        ref={(el) => {
                          if (el) {
                            el.style.height = 'auto';
                            el.style.height = `${Math.min(el.scrollHeight, 260)}px`;
                          }
                        }}
                        value={editText}
                        onChange={(e) => {
                          setEditText(e.target.value);
                          e.target.style.height = 'auto';
                          e.target.style.height = `${Math.min(e.target.scrollHeight, 260)}px`;
                        }}
                        className="w-full p-2 bg-silk-950 border border-silk-700 rounded-lg text-xs text-white resize-none"
                      />
                      <div className="flex justify-end gap-1.5">
                        <button
                          onClick={() => setEditingMsgId(null)}
                          type="button"
                          className="px-2 py-1 text-[11px] text-slate-400 hover:text-white"
                        >
                          {t.cancelEdit}
                        </button>
                        <button
                          onClick={() => handleSaveEdit(msg)}
                          type="button"
                          className="px-3 py-1 bg-violet-600 hover:bg-violet-500 text-white rounded text-[11px] font-medium"
                        >
                          {isUser ? t.saveEdit : t.saveBotEdit}
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div className="whitespace-pre-wrap break-words" style={{ lineHeight: lineHeightStyle }}>
                      {formatMessageText(activeVariant.text)}
                    </div>
                  )}

                  {/* Emotion Sprite Image (displayed below message text without raw emotion text) */}
                  {!isUser && (() => {
                    const sprite = getEmotionSprite(msg.senderId, activeVariant.emotion || msg.emotion);
                    if (!sprite || !sprite.avatar) return null;
                    return (
                      <div className="mt-3 pt-2.5 border-t border-white/10 flex items-center">
                        <div className="relative rounded-xl overflow-hidden border border-silk-700 bg-black/40">
                          <img
                            src={sprite.avatar}
                            alt=""
                            className="max-h-48 max-w-[200px] w-auto h-auto object-contain rounded-xl block"
                          />
                        </div>
                      </div>
                    );
                  })()}
                </div>

                {/* Message Action Bar (Rollback, Edit, Copy, Wand, Carousel) */}
                <div
                  className={`flex items-center gap-1 text-[11px] text-slate-400 px-1 ${
                    isUser ? 'flex-row-reverse' : 'flex-row'
                  }`}
                >
                  {/* Variant Carousel Pagination (for bot responses) */}
                  {!isUser && hasVariants && (
                    <div className="flex items-center gap-1 mr-2 px-1.5 py-0.5 rounded-lg bg-silk-900/80 border border-silk-800 font-mono text-[10px]">
                      <button
                        onClick={() => handleVariantSwitch(msg, -1)}
                        disabled={msg.activeVariantIndex === 0}
                        className="disabled:opacity-20 hover:text-white"
                      >
                        <ChevronLeft className="w-3 h-3" />
                      </button>
                      <span>
                        {msg.activeVariantIndex + 1}/{msg.variants.length}
                      </span>
                      <button
                        onClick={() => handleVariantSwitch(msg, 1)}
                        disabled={msg.activeVariantIndex === msg.variants.length - 1}
                        className="disabled:opacity-20 hover:text-white"
                      >
                        <ChevronRight className="w-3 h-3" />
                      </button>
                    </div>
                  )}

                  {/* Rollback & Fork */}
                  <button
                    onClick={() => handleRollback(msg)}
                    type="button"
                    className="p-1 hover:text-amber-400 rounded hover:bg-silk-800"
                    title={t.rollback}
                  >
                    <RotateCcw className="w-3.5 h-3.5" />
                  </button>

                  {/* Edit: Available for user message or ONLY the very latest bot message */}
                  {(isUser || isLatestBotMsg) && (
                    <button
                      onClick={() => handleStartEdit(msg)}
                      type="button"
                      className="p-1 hover:text-violet-400 rounded hover:bg-silk-800"
                      title={t.editMessage}
                    >
                      <Edit3 className="w-3.5 h-3.5" />
                    </button>
                  )}

                  {/* Copy */}
                  <button
                    onClick={() => handleCopy(msg)}
                    type="button"
                    className="p-1 hover:text-white rounded hover:bg-silk-800"
                    title={t.copyMessage}
                  >
                    {copiedId === msg.id ? (
                      <Check className="w-3.5 h-3.5 text-emerald-400" />
                    ) : (
                      <Copy className="w-3.5 h-3.5" />
                    )}
                  </button>

                  {/* Bot-specific actions: Wand & Regenerate (ONLY on latest bot message) */}
                  {!isUser && (
                    <>
                      {isLatestBotMsg && (
                        <button
                          onClick={() => {
                            setGuidedRegenTargetMsgId(msg.id);
                            setGuidedRegenPrompt('');
                          }}
                          type="button"
                          className="p-1 hover:text-violet-400 rounded hover:bg-silk-800"
                          title={t.magicWandBot}
                        >
                          <Wand2 className="w-3.5 h-3.5" />
                        </button>
                      )}

                      {/* Manual Emotion Sprite Selector */}
                      {(() => {
                        const botChar = allCharacters.find((c) => c.id === msg.senderId) || (type === 'character' ? character : undefined);
                        if (!botChar?.emotions || botChar.emotions.length === 0) return null;
                        return (
                          <div className="relative">
                            <button
                              onClick={() => setEmotionPickerMsgId(emotionPickerMsgId === msg.id ? null : msg.id)}
                              type="button"
                              className={`p-1 rounded transition-colors ${
                                emotionPickerMsgId === msg.id ? 'text-violet-400 bg-silk-800' : 'hover:text-violet-400 hover:bg-silk-800'
                              }`}
                              title={language === 'ru' ? 'Выбрать эмоцию' : 'Choose Emotion'}
                            >
                              <Smile className="w-3.5 h-3.5" />
                            </button>

                            {emotionPickerMsgId === msg.id && (
                              <div className="absolute left-0 bottom-full mb-2 z-30 p-2 bg-silk-900 border border-silk-700 rounded-xl flex items-center gap-2 animate-fade-in max-w-xs overflow-x-auto no-scrollbar">
                                <button
                                  type="button"
                                  onClick={async () => {
                                    const updatedVariants = [...msg.variants];
                                    updatedVariants[msg.activeVariantIndex] = {
                                      ...updatedVariants[msg.activeVariantIndex],
                                      emotion: undefined,
                                    };
                                    await db.messages.update(msg.id, {
                                      variants: updatedVariants,
                                      emotion: undefined,
                                    });
                                    setEmotionPickerMsgId(null);
                                  }}
                                  className="px-2 py-1 rounded-lg bg-silk-800 text-[10px] text-slate-400 hover:text-white shrink-0"
                                >
                                  {language === 'ru' ? 'Без картинки' : 'None'}
                                </button>
                                {botChar.emotions.filter((e) => e.avatar).map((e) => (
                                  <button
                                    key={e.id}
                                    type="button"
                                    onClick={async () => {
                                      const updatedVariants = [...msg.variants];
                                      updatedVariants[msg.activeVariantIndex] = {
                                        ...updatedVariants[msg.activeVariantIndex],
                                        emotion: e.name,
                                      };
                                      await db.messages.update(msg.id, {
                                        variants: updatedVariants,
                                        emotion: e.name,
                                      });
                                      setEmotionPickerMsgId(null);
                                    }}
                                    className="relative w-8 h-8 rounded-lg overflow-hidden border border-silk-700 hover:border-violet-500 shrink-0 bg-silk-800 transition-transform active:scale-90"
                                    title={e.label || e.name}
                                  >
                                    <img src={e.avatar} alt={e.label || e.name} className="w-full h-full object-cover" />
                                  </button>
                                ))}
                              </div>
                            )}
                          </div>
                        );
                      })()}

                      {isLatestBotMsg && (
                        <button
                          onClick={() => handleRegenerate(msg)}
                          type="button"
                          className="p-1 hover:text-white rounded hover:bg-silk-800"
                          title={t.regenerate}
                        >
                          <RefreshCw className="w-3.5 h-3.5" />
                        </button>
                      )}
                    </>
                  )}
                </div>
              </div>
            </div>
          );
        });
      })()}

        {/* Live Streaming Bubble */}
        {isGenerating && streamingSender && (
          <div className="flex justify-start items-end gap-2.5 animate-fade-in">
            <div className="relative w-8 h-8 rounded-xl overflow-hidden shrink-0 border border-silk-700 bg-silk-800 mb-1">
              <AvatarImage
                src={streamingSender.avatar}
                alt={streamingSender.name}
                className="w-full h-full object-cover"
              />
            </div>
            <div className="flex flex-col items-start max-w-[85%] space-y-1">
              {type === 'group' && (
                <div className="flex items-center gap-1.5 text-[11px] font-semibold text-violet-300 ml-1">
                  <span>{streamingSender.name}</span>
                </div>
              )}
              <div
                className="p-3.5 border border-silk-800/70 text-slate-200"
                style={{
                  backgroundColor: hexToRgba(currentTheme.bubbleBotBg, currentTheme.bubbleOpacity),
                  borderRadius: `${currentTheme.bubbleRadius}px`,
                  fontSize: `${currentTheme.fontSize}px`,
                  fontFamily: fontFamilyStyle,
                  lineHeight: lineHeightStyle,
                }}
              >
                {streamingThought && (
                  <div className="mb-2 p-2 rounded-xl bg-silk-950/80 border border-silk-700 text-xs">
                    <div className="flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wider text-slate-400 mb-1">
                      <Sparkles className="w-3 h-3" />
                      <span>{t.thinkingBlock}</span>
                    </div>
                    <p className="text-slate-300 italic text-[11px] leading-relaxed">
                      {streamingThought}
                    </p>
                  </div>
                )}

                {!streamingText && !streamingThought ? (
                  <div className="min-w-[220px]">
                    <ActivityProgressBar
                      compact
                      accent={restoringLlmNotice ? 'emerald' : 'violet'}
                      language={language}
                      label={restoringLlmNotice ? t.sceneRestoringLlmStage : t.chatPreparingReply}
                      startedAt={botGenStartedAt}
                    />
                  </div>
                ) : (
                  <div className="whitespace-pre-wrap break-words" style={{ lineHeight: lineHeightStyle }}>
                    {formatMessageText(streamingText || '...')}
                    <span className="inline-block w-1.5 h-3.5 ml-0.5 bg-slate-300 align-middle" />
                  </div>
                )}

                {/* Streaming Emotion Sprite */}
                {(() => {
                  const sprite = getEmotionSprite(streamingSender.id, streamingEmotion || undefined);
                  if (!sprite || !sprite.avatar) return null;
                  return (
                    <div className="mt-3 pt-2.5 border-t border-white/10 flex items-center">
                      <div className="relative rounded-xl overflow-hidden border border-silk-700 bg-black/40">
                        <img
                          src={sprite.avatar}
                          alt=""
                          className="max-h-48 max-w-[200px] w-auto h-auto object-contain rounded-xl block"
                        />
                      </div>
                    </div>
                  );
                })()}
              </div>
            </div>
          </div>
        )}

        {/* Scene Director Progress Bubble (for new /scene cards) */}
        {isGeneratingScene && !activeSceneTargetMsgId && (
          <div className="flex justify-center animate-fade-in my-1">
            <div className="w-full max-w-md">
              <ActivityProgressBar
                accent="emerald"
                language={language}
                label={sceneStageText || t.sceneGeneratingStage}
                progress={sceneProgressPct}
                stepInfo={sceneStepInfo}
                startedAt={sceneStartedAt}
                onCancel={() => sceneAbortRef.current?.abort()}
                cancelLabel={t.cancel}
              />
            </div>
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      {/* Floating Scroll-to-Bottom Arrow Button */}
      {showScrollBottom && (
        <button
          onClick={() => {
            scrollToBottom(true);
            setShowScrollBottom(false);
          }}
          type="button"
          className="absolute right-5 bottom-20 z-30 p-2.5 rounded-full bg-silk-900 hover:bg-silk-800 text-slate-300 hover:text-white border border-silk-700 transition-colors animate-fade-in active:scale-95 flex items-center justify-center group"
          title={t.scrollToBottomLabel}
        >
          <ArrowDown className="w-4 h-4 group-hover:translate-y-0.5 transition-transform" />
        </button>
      )}

      {/* Slash Command Autocomplete Menu */}
      {showSlashMenu && matchingSlashCommands.length > 0 && (
        <div className="relative z-20 mx-4 mb-2 bg-silk-900 border border-silk-700 rounded-2xl overflow-hidden animate-slide-up text-xs">
          <div className="p-2.5 font-semibold text-[11px] uppercase tracking-wider text-slate-400 border-b border-silk-800">
            {t.slashCommandHeader}
          </div>
          {matchingSlashCommands.includes('/scene') && (
            <button
              onClick={() => handleSelectSlashCommand('/scene')}
              type="button"
              className="w-full flex items-center gap-2.5 px-3.5 py-2 hover:bg-silk-800 text-left text-slate-200"
            >
              <span className="font-mono text-emerald-400 font-semibold shrink-0">/scene</span>
              <span className="text-slate-400 text-[11px] truncate">{t.slashSceneDesc}</span>
            </button>
          )}
          {matchingSlashCommands.includes('/wand') && (
            <button
              onClick={() => handleSelectSlashCommand('/wand')}
              type="button"
              className="w-full flex items-center gap-2.5 px-3.5 py-2 hover:bg-silk-800 text-left text-slate-200"
            >
              <span className="font-mono text-violet-400 font-semibold shrink-0">/wand</span>
              <span className="text-slate-400 text-[11px] truncate">{t.cmdWand}</span>
            </button>
          )}
          {matchingSlashCommands.includes('/continue') && (
            <button
              onClick={() => handleSelectSlashCommand('/continue')}
              type="button"
              className="w-full flex items-center gap-2.5 px-3.5 py-2 hover:bg-silk-800 text-left text-slate-200"
            >
              <span className="font-mono text-violet-400 font-semibold">/continue</span>
              <span className="text-slate-400 text-[11px]">{t.cmdContinue}</span>
            </button>
          )}
          {matchingSlashCommands.includes('/summary') && (
            <button
              onClick={() => handleSelectSlashCommand('/summary')}
              type="button"
              className="w-full flex items-center gap-2.5 px-3.5 py-2 hover:bg-silk-800 text-left text-slate-200"
            >
              <span className="font-mono text-emerald-400 font-semibold">/summary</span>
              <span className="text-slate-400 text-[11px]">{t.cmdSummary}</span>
            </button>
          )}
          {matchingSlashCommands.includes('/action') && (
            <button
              onClick={() => handleSelectSlashCommand('/action')}
              type="button"
              className="w-full flex items-center gap-2.5 px-3.5 py-2 hover:bg-silk-800 text-left text-slate-200"
            >
              <span className="font-mono text-rose-400 font-semibold">/action</span>
              <span className="text-slate-400 text-[11px]">{t.cmdAction}</span>
            </button>
          )}
          {matchingSlashCommands.includes('/memory') && (
            <button
              onClick={() => handleSelectSlashCommand('/memory')}
              type="button"
              className="w-full flex items-center gap-2.5 px-3.5 py-2 hover:bg-silk-800 text-left text-slate-200"
            >
              <span className="font-mono text-sky-400 font-semibold">/memory</span>
              <span className="text-slate-400 text-[11px]">{t.cmdMemory}</span>
            </button>
          )}
          {matchingSlashCommands.includes('/reset') && (
            <button
              onClick={() => handleSelectSlashCommand('/reset')}
              type="button"
              className="w-full flex items-center gap-2.5 px-3.5 py-2 hover:bg-silk-800 text-left text-slate-200"
            >
              <span className="font-mono text-red-400 font-semibold">/reset</span>
              <span className="text-slate-400 text-[11px]">{t.cmdReset}</span>
            </button>
          )}
        </div>
      )}

      {/* Attached image preview banner */}
      {attachedImage && (
        <div className="relative z-20 mx-4 mb-2 flex items-center gap-2 p-2 rounded-xl bg-silk-900 border border-silk-700">
          <img src={attachedImage} alt="Preview" className="w-10 h-10 rounded-lg object-cover" />
          <span className="text-xs text-slate-300 flex-1 truncate">Photo attached for AI vision</span>
          <button
            onClick={() => setAttachedImage(null)}
            type="button"
            className="p-1 text-slate-400 hover:text-white"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {/* 3. Bottom Chat Input Bar */}
      <div className="relative z-20 p-3 bg-silk-900/90 backdrop-blur-xl border-t border-silk-800/80">
        <div className="flex items-center gap-2 max-w-xl mx-auto">
          {/* Photo attach button */}
          <label className="p-2.5 text-slate-400 hover:text-white rounded-xl hover:bg-silk-800 cursor-pointer shrink-0">
            <ImageIcon className="w-5 h-5" />
            <input
              type="file"
              accept="image/*"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (!file) return;
                const r = new FileReader();
                r.onload = (ev) => setAttachedImage(ev.target?.result as string);
                r.readAsDataURL(file);
                e.target.value = '';
              }}
              className="hidden"
            />
          </label>

          {/* Group Chat: Robot icon to select speaker or converse */}
          {type === 'group' && (
            <button
              onClick={() => setShowSpeakerModal(true)}
              type="button"
              className="p-2.5 text-violet-400 hover:text-violet-300 rounded-xl hover:bg-silk-800 shrink-0"
              title={t.robotIcon}
            >
              <Bot className="w-5 h-5" />
            </button>
          )}

          {/* Auto-expanding Textarea */}
          <textarea
            ref={textareaRef}
            rows={1}
            value={inputText}
            onChange={handleInputChange}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                handleSendMessage();
              }
            }}
            placeholder={t.chatInputPlaceholder}
            className="flex-1 min-w-0 px-4 py-2.5 bg-silk-800 border border-silk-700/80 rounded-2xl text-xs text-white placeholder-slate-500 focus:outline-none focus:border-violet-500 resize-none max-h-48 overflow-y-auto leading-relaxed break-words whitespace-pre-wrap"
          />

          {/* Send or Stop button */}
          {isGenerating ? (
            <button
              onClick={() => abortControllerRef.current?.abort()}
              type="button"
              className="px-3.5 py-2.5 bg-rose-600 hover:bg-rose-500 text-white rounded-2xl text-xs font-semibold shrink-0 shadow-md"
            >
              {t.stopGenerating}
            </button>
          ) : isGeneratingScene ? (
            <button
              onClick={() => sceneAbortRef.current?.abort()}
              type="button"
              className="px-3.5 py-2.5 bg-amber-600 hover:bg-amber-500 text-white rounded-2xl text-xs font-semibold shrink-0 shadow-md"
            >
              {t.cancel}
            </button>
          ) : (
            <button
              onClick={handleSendMessage}
              disabled={!inputText.trim() && !attachedImage}
              type="button"
              className="p-2.5 bg-violet-600 hover:bg-violet-500 disabled:opacity-40 text-white rounded-2xl shadow-md shrink-0 active:scale-95 transition-all"
            >
              <Send className="w-4 h-4" />
            </button>
          )}
        </div>
      </div>

      {/* User Ghostwriter Wand Modal */}
      {showUserWandModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80">
          <div className="w-full max-w-md bg-silk-900 border border-silk-700 rounded-2xl p-4 space-y-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Wand2 className="w-4 h-4 text-violet-400" />
                <h3 className="font-semibold text-sm text-white">{t.ghostwriterTitle}</h3>
              </div>
              <button onClick={closeWandModal} className="text-slate-400 hover:text-white">
                <X className="w-4 h-4" />
              </button>
            </div>

            <textarea
              rows={2}
              value={userWandPrompt}
              onChange={(e) => setUserWandPrompt(e.target.value)}
              placeholder={t.ghostwriterPromptPlaceholder}
              disabled={isWandGenerating}
              className="w-full px-3 py-2 bg-silk-800 border border-silk-700 rounded-xl text-xs text-white resize-none disabled:opacity-60"
              autoFocus
            />

            {isWandGenerating && (
              <ActivityProgressBar
                compact
                accent="violet"
                language={language}
                label={t.wandGeneratingProgress}
                startedAt={wandStartedAt}
              />
            )}

            {(isWandGenerating || wandPreview) && (
              <div className="max-h-56 overflow-y-auto px-3 py-2 bg-silk-800/60 border border-silk-700 rounded-xl text-sm text-slate-100 whitespace-pre-wrap leading-relaxed">
                {wandPreview || (
                  <span className="text-slate-500 text-xs">{language === 'ru' ? 'Ожидание первого слова...' : 'Waiting for the first words...'}</span>
                )}
                {isWandGenerating && <span className="inline-block w-1.5 h-3.5 ml-0.5 align-middle bg-slate-300" />}
              </div>
            )}

            <div className="flex justify-end gap-2">
              {isWandGenerating ? (
                <button
                  onClick={() => wandAbortRef.current?.abort()}
                  type="button"
                  className="flex items-center gap-1.5 px-4 py-1.5 bg-silk-700 hover:bg-silk-600 text-white rounded-xl text-xs font-semibold"
                >
                  <X className="w-3.5 h-3.5" />
                  <span>{language === 'ru' ? 'Стоп' : 'Stop'}</span>
                </button>
              ) : (
                <>
                  <button
                    onClick={closeWandModal}
                    type="button"
                    className="px-3 py-1.5 text-xs text-slate-400 hover:text-white"
                  >
                    {t.cancel}
                  </button>
                  {wandPreview && (
                    <button
                      onClick={handleExecuteUserWand}
                      type="button"
                      className="px-3 py-1.5 text-xs text-slate-200 border border-silk-700 hover:border-violet-500 rounded-xl"
                    >
                      {language === 'ru' ? 'Ещё вариант' : 'Another version'}
                    </button>
                  )}
                  <button
                    onClick={wandPreview ? applyWandPreview : handleExecuteUserWand}
                    type="button"
                    className="flex items-center gap-1.5 px-4 py-1.5 bg-violet-600 hover:bg-violet-500 border border-white/10 text-white rounded-xl text-xs font-semibold"
                  >
                    <Sparkles className="w-3.5 h-3.5" />
                    <span>{wandPreview ? t.applyToInput : (language === 'ru' ? 'Сформулировать' : 'Generate')}</span>
                  </button>
                </>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Guided Bot Regeneration Modal */}
      {guidedRegenTargetMsgId && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80">
          <div className="w-full max-w-sm bg-silk-900 border border-silk-700 rounded-2xl p-4 space-y-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Wand2 className="w-4 h-4 text-violet-400" />
                <h3 className="font-semibold text-sm text-white">{t.guidedRegenTitle}</h3>
              </div>
              <button
                onClick={() => setGuidedRegenTargetMsgId(null)}
                className="text-slate-400 hover:text-white"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <textarea
              rows={3}
              value={guidedRegenPrompt}
              onChange={(e) => setGuidedRegenPrompt(e.target.value)}
              placeholder={t.guidedRegenPlaceholder}
              className="w-full px-3 py-2 bg-silk-800 border border-silk-700 rounded-xl text-xs text-white resize-none"
              autoFocus
            />

            <div className="flex justify-end gap-2">
              <button
                onClick={() => setGuidedRegenTargetMsgId(null)}
                type="button"
                className="px-3 py-1.5 text-xs text-slate-400 hover:text-white"
              >
                {t.cancel}
              </button>
              <button
                onClick={() => {
                  const targetMsg = messages.find((m) => m.id === guidedRegenTargetMsgId);
                  if (targetMsg) {
                    handleRegenerate(targetMsg, guidedRegenPrompt);
                  }
                  setGuidedRegenTargetMsgId(null);
                }}
                type="button"
                className="px-4 py-1.5 bg-violet-600 hover:bg-violet-500 border border-white/10 text-white rounded-xl text-xs font-semibold"
              >
                {t.regenerate}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Group Next Speaker Selector Modal */}
      {showSpeakerModal && type === 'group' && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80">
          <div className="w-full max-w-xs bg-silk-900 border border-silk-700 rounded-2xl p-4 space-y-3">
            <div className="flex items-center justify-between">
              <h3 className="font-semibold text-sm text-white">{t.nextSpeakerModalTitle}</h3>
              <button
                onClick={() => setShowSpeakerModal(false)}
                className="text-slate-400 hover:text-white"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="space-y-1.5 max-h-56 overflow-y-auto">
              {allCharacters
                .filter((c) => group?.characterIds.includes(c.id) && c.id !== session?.personaId)
                .map((c) => (
                  <button
                    key={c.id}
                    onClick={() => {
                      setShowSpeakerModal(false);
                      runBotGeneration(c);
                    }}
                    type="button"
                    className="w-full flex items-center gap-2.5 p-2 rounded-xl bg-silk-850 hover:bg-silk-800 border border-silk-800 text-left text-xs text-slate-200"
                  >
                    <div className="w-7 h-7 rounded-lg overflow-hidden bg-silk-800 shrink-0">
                      <AvatarImage src={c.avatar} alt={c.name} className="w-full h-full object-cover" />
                    </div>
                    <span className="font-semibold truncate flex-1">{c.name}</span>
                    <CornerDownRight className="w-3.5 h-3.5 text-slate-500" />
                  </button>
                ))}
              {allCharacters.filter((c) => group?.characterIds.includes(c.id) && c.id !== session?.personaId).length === 0 && (
                <div className="text-center py-4 text-xs text-slate-400">
                  {language === 'ru' ? 'Все персонажи группы выбраны как персона' : 'All group members are chosen as persona'}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Scene Summary Modal (/summary) */}
      {summaryModalText && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80">
          <div className="w-full max-w-sm bg-silk-900 border border-silk-700 rounded-2xl p-4 space-y-3">
            <div className="flex items-center justify-between">
              <h3 className="font-semibold text-sm text-white">{t.summaryModalTitle}</h3>
              <button
                onClick={() => setSummaryModalText(null)}
                className="text-slate-400 hover:text-white"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            {isSummarizing ? (
              <ActivityProgressBar
                accent="emerald"
                language={language}
                label={t.summaryGeneratingProgress}
                startedAt={summaryStartedAt}
              />
            ) : (
              <div className="text-xs text-slate-300 leading-relaxed whitespace-pre-wrap max-h-72 overflow-y-auto">
                {summaryModalText}
              </div>
            )}
            <div className="flex justify-end pt-1">
              <button
                onClick={() => setSummaryModalText(null)}
                type="button"
                className="px-4 py-1.5 bg-violet-600 hover:bg-violet-500 text-white rounded-xl text-xs font-medium"
              >
                {t.close}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* RP Settings Modal (Memory Graph, Roleplay, History) */}
      {session && (
        <ChatSettingsModal
          isOpen={showSettingsModal}
          onClose={() => setShowSettingsModal(false)}
          session={session}
          language={language}
          onSwitchSession={(newId) => setCurrentSessionId(newId)}
          onCreateNewSession={async () => {
            const newS: ChatSession = {
              id: 'chat-' + Math.random().toString(36).substring(2, 9),
              title: `${type === 'character' ? character?.name : group?.name} (${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })})`,
              type,
              targetId,
              personaId: session.personaId,
              thoughtsEnabled: session.thoughtsEnabled,
              relationships: {},
              createdAt: Date.now(),
              updatedAt: Date.now(),
            };
            await db.chats.put(newS);
            setCurrentSessionId(newS.id);
          }}
        />
      )}

      {/* Fullscreen Scene Lightbox Modal */}
      {lightboxAsset && (
        <div
          className="fixed inset-0 z-50 flex flex-col bg-black/95 p-3 sm:p-6"
          onClick={() => setLightboxAsset(null)}
        >
          <div className="flex items-center justify-between gap-2 pb-2" onClick={(e) => e.stopPropagation()}>
            <div className="min-w-0">
              <div className="text-xs font-semibold text-white truncate">
                {lightboxAsset.asset.perspective || (language === 'ru' ? 'Сцена' : 'Scene')}
              </div>
              {lightboxAsset.asset.modelUsed && (
                <div className="text-[10px] font-mono text-slate-400 truncate">
                  {lightboxAsset.asset.modelUsed} ({lightboxAsset.asset.backendUsed})
                </div>
              )}
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <a
                href={lightboxAsset.asset.imageData}
                download={`scene-${lightboxAsset.asset.id}.jpg`}
                className="flex items-center gap-1 px-3 py-1.5 rounded-xl bg-silk-800 hover:bg-silk-700 text-xs text-white border border-silk-700"
              >
                <Download className="w-3.5 h-3.5" />
                <span>{t.sceneDownloadBtn}</span>
              </a>
              <button
                type="button"
                onClick={() => setLightboxAsset(null)}
                className="p-2 rounded-xl bg-silk-800 hover:bg-silk-700 text-slate-300 hover:text-white"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
          </div>

          <div
            className="flex-1 flex items-center justify-center overflow-hidden"
            onClick={(e) => e.stopPropagation()}
          >
            <img
              src={lightboxAsset.asset.imageData}
              alt={lightboxAsset.asset.perspective || 'Scene'}
              className="max-w-full max-h-full object-contain rounded-xl"
            />
          </div>

          {lightboxAsset.asset.prompt && (
            <div
              className="mt-2 p-2.5 rounded-xl bg-silk-900/90 border border-silk-800 text-[10px] font-mono text-slate-400 max-h-24 overflow-y-auto"
              onClick={(e) => e.stopPropagation()}
            >
              {lightboxAsset.asset.prompt}
            </div>
          )}
        </div>
      )}

      <SceneGuideModal
        isOpen={showSceneGuide}
        onClose={() => setShowSceneGuide(false)}
        language={language}
      />
    </div>
  );
};
