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
  getEffectiveAiConfig,
  getComponentAiConfig,
  speakerStopStrings,
  stripLeadingSpeakerName,
} from '../services/ai';
import { buildSystemPrompt, buildSceneNote } from '../services/promptBuilder';
import {
  estimateTokens,
  PER_MESSAGE_TOKENS,
  planWindow,
  planSummaryBatch,
  sceneNoteLines,
  summaryLimits,
} from '../services/contextBudget';
import { extractMemoryAndAffinity } from '../services/memoryGraph';
import { ChatSettingsModal } from './ChatSettingsModal';
import { AvatarImage } from '../components/AvatarImage';

interface ChatViewProps {
  type: 'character' | 'group';
  targetId: string;
  language: Language;
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
  return (text || '')
    .replace(/<thought>[\s\S]*?<\/thought>/gi, '')
    .replace(/<thought>[\s\S]*$/gi, '')
    .replace(/<emotion>[\s\S]*?<\/emotion>/gi, '')
    .replace(/<\s*emotion[:\s][^>]+>/gi, '')
    .replace(/(?:\[|<|\()(?:эмоция|emotion):\s*[^\]>\)]+(?:\]|>|\))/gi, '')
    .trim();
}

export const ChatView: React.FC<ChatViewProps> = ({
  type,
  targetId,
  language,
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

  // Initialize or fetch active session
  useEffect(() => {
    async function initSession() {
      const existing = await db.chats
        .where('targetId')
        .equals(targetId)
        .reverse()
        .first();

      if (existing) {
        setCurrentSessionId(existing.id);
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

        // Seed initial greeting if character has greeting enabled
        if (type === 'character' && character && character.greeting && character.greetingEnabled) {
          const parsedGreeting = extractEmotionAndCleanResponse(character.greeting, character.emotions);
          const greetingMsg: ChatMessage = {
            id: 'msg-' + Math.random().toString(36).substring(2, 10),
            chatId: newSession.id,
            senderId: character.id,
            senderName: character.name,
            senderAvatar: character.avatar,
            emotion: parsedGreeting.emotion,
            variants: [
              {
                text: parsedGreeting.text || character.greeting,
                emotion: parsedGreeting.emotion,
                thought: parsedGreeting.thought,
                timestamp: Date.now(),
              },
            ],
            activeVariantIndex: 0,
            createdAt: Date.now(),
          };
          await db.messages.put(greetingMsg);
        }
      }
    }

    if (character || group) {
      initSession();
    }
  }, [type, targetId, character, group]);

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

  // UI state
  const [inputText, setInputText] = useState('');
  const [attachedImage, setAttachedImage] = useState<string | null>(null);
  const [isGenerating, setIsGenerating] = useState(false);
  const [streamingText, setStreamingText] = useState<string>('');
  const [streamingThought, setStreamingThought] = useState<string>('');
  const [streamingEmotion, setStreamingEmotion] = useState<string | null>(null);
  const [streamingSender, setStreamingSender] = useState<Character | null>(null);
  const compressionRunningRef = useRef(false);
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

  // Copy feedback
  const [copiedId, setCopiedId] = useState<string | null>(null);

  // Folded thoughts state
  const [expandedThoughts, setExpandedThoughts] = useState<Record<string, boolean>>({});

  // Bot message manual emotion sprite picker
  const [emotionPickerMsgId, setEmotionPickerMsgId] = useState<string | null>(null);

  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const currentTheme = settings?.theme || DEFAULT_THEME;

  const fontFamilyStyle =
    currentTheme.fontFamily === 'serif'
      ? 'Georgia, Cambria, "Times New Roman", serif'
      : currentTheme.fontFamily === 'mono'
      ? 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace'
      : 'inherit';

  const lineHeightStyle =
    currentTheme.lineHeight === 'loose'
      ? 1.8
      : currentTheme.lineHeight === 'relaxed'
      ? 1.6
      : 1.45;

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

  useEffect(() => {
    setVisibleCount(PAGE_SIZE);
    hasInitialScrolledRef.current = false;
    setShowScrollBottom(false);
    isSmoothScrollingToBottomRef.current = false;
  }, [currentSessionId]);

  const totalMessagesCount = messages.length;
  const hasMoreMessages = totalMessagesCount > visibleCount;
  const displayedMessages = hasMoreMessages
    ? messages.slice(totalMessagesCount - visibleCount)
    : messages;

  const scrollToBottom = (smooth = true) => {
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

  // Keep pinned to bottom during generation / new message ONLY if user hasn't scrolled up
  useEffect(() => {
    if (hasInitialScrolledRef.current && !showScrollBottom && chatContainerRef.current) {
      chatContainerRef.current.scrollTop = chatContainerRef.current.scrollHeight;
    }
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

    // Check if scrolled away from bottom (> 140px)
    const isAway = scrollHeight - scrollTop - clientHeight > 140;

    if (isSmoothScrollingToBottomRef.current) {
      if (!isAway) {
        isSmoothScrollingToBottomRef.current = false;
      }
      setShowScrollBottom(false);
      return;
    }

    setShowScrollBottom(isAway);

    // Progressive lazy loading when user scrolls near top (< 60px)
    if (scrollTop < 60 && hasMoreMessages && !isLoadingOlderRef.current) {
      triggerLoadOlderMessages();
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

  // Slash command trigger & auto-expanding textarea
  const handleInputChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const val = e.target.value;
    setInputText(val);
    if (val.startsWith('/')) {
      setShowSlashMenu(true);
    } else {
      setShowSlashMenu(false);
    }
    adjustTextareaHeight();
  };

  const getSpeakerAvatar = (
    senderId: string,
    emotion?: string,
    fallbackAvatar?: string
  ): string => {
    const char = allCharacters.find((c) => c.id === senderId) || (type === 'character' ? character : undefined);
    if (!char) return fallbackAvatar || '';
    if (emotion && char.emotions && char.emotions.length > 0) {
      const emLower = emotion.trim().toLowerCase();
      // 1. Direct match on name or label
      const direct = char.emotions.find(
        (e) => (e.name.toLowerCase() === emLower || e.label?.toLowerCase() === emLower) && e.avatar
      );
      if (direct?.avatar) return direct.avatar;

      // 2. Fuzzy synonym match (Russian & English)
      const synonymGroups: Record<string, string[]> = {
        happy: ['happy', 'joy', 'smile', 'радость', 'улыбка', 'веселье', 'счастье', 'радостный', 'веселый'],
        sad: ['sad', 'sorrow', 'crying', 'грусть', 'печаль', 'слезы', 'тоска', 'грустный', 'печальный'],
        angry: ['angry', 'furious', 'rage', 'гнев', 'злость', 'ярость', 'раздражение', 'злой', 'сердитый'],
        blushing: ['blushing', 'shy', 'embarrassed', 'смущение', 'стыд', 'румянец', 'смущенный'],
        smirk: ['smirk', 'tease', 'playful', 'усмешка', 'сарказм', 'ухмылка', 'ухмыляющийся'],
        surprised: ['surprised', 'shocked', 'удивление', 'шок', 'испуг', 'удивленный'],
        thoughtful: ['thoughtful', 'pensive', 'задумчивость', 'размышление', 'задумчивый'],
        neutral: ['neutral', 'calm', 'нейтральный', 'спокойствие', 'спокойный'],
      };

      for (const [, words] of Object.entries(synonymGroups)) {
        if (words.some((w) => emLower.includes(w) || w.includes(emLower))) {
          const match = char.emotions.find((e) => {
            const eName = (e.name + ' ' + (e.label || '')).toLowerCase();
            return e.avatar && words.some((w) => eName.includes(w) || w.includes(eName));
          });
          if (match?.avatar) return match.avatar;
        }
      }
    }
    return char.avatar || fallbackAvatar || '';
  };

  // Dedicated helper to retrieve emotion sprite illustrations
  const getEmotionSprite = (
    senderId: string,
    emotion?: string
  ): { avatar: string; name: string } | null => {
    const char = allCharacters.find((c) => c.id === senderId) || (type === 'character' ? character : undefined);
    if (!char || !char.emotions || char.emotions.length === 0) return null;

    if (emotion && emotion.trim() && emotion.trim().toLowerCase() !== 'none') {
      const emLower = emotion.trim().toLowerCase();
      // 1. Direct match on name or label
      const direct = char.emotions.find(
        (e) => (e.name.toLowerCase() === emLower || e.label?.toLowerCase() === emLower) && e.avatar
      );
      if (direct?.avatar) return { avatar: direct.avatar, name: direct.label || direct.name };

      // 2. Fuzzy synonym match (Russian & English)
      const synonymGroups: Record<string, string[]> = {
        happy: ['happy', 'joy', 'smile', 'радость', 'улыбка', 'веселье', 'счастье', 'радостный', 'веселый'],
        sad: ['sad', 'sorrow', 'crying', 'грусть', 'печаль', 'слезы', 'тоска', 'грустный', 'печальный'],
        angry: ['angry', 'furious', 'rage', 'гнев', 'злость', 'ярость', 'раздражение', 'злой', 'сердитый'],
        blushing: ['blushing', 'shy', 'embarrassed', 'смущение', 'стыд', 'румянец', 'смущенный'],
        smirk: ['smirk', 'tease', 'playful', 'усмешка', 'сарказм', 'ухмылка', 'ухмыляющийся'],
        surprised: ['surprised', 'shocked', 'удивление', 'шок', 'испуг', 'удивленный'],
        thoughtful: ['thoughtful', 'pensive', 'задумчивость', 'размышление', 'задумчивый'],
        neutral: ['neutral', 'calm', 'нейтральный', 'спокойствие', 'спокойный'],
      };

      for (const [, words] of Object.entries(synonymGroups)) {
        if (words.some((w) => emLower.includes(w) || w.includes(emLower))) {
          const match = char.emotions.find((e) => {
            const eName = (e.name + ' ' + (e.label || '')).toLowerCase();
            return e.avatar && words.some((w) => eName.includes(w) || w.includes(eName));
          });
          if (match?.avatar) return { avatar: match.avatar, name: match.label || match.name };
        }
      }
    }

    // 3. Fallback: only if emotion is explicitly 'neutral'
    if (emotion && emotion.trim().toLowerCase() === 'neutral') {
      const fallback = char.emotions.find((e) => e.name === 'neutral' && e.avatar);
      if (fallback?.avatar) {
        return { avatar: fallback.avatar, name: fallback.label || fallback.name };
      }
    }

    return null;
  };

  // Build current dialogue context string for AI
  const buildContextHistory = (msgList: ChatMessage[]): string => {
    return msgList
      .slice(-8)
      .map((m) => {
        const v = m.variants[m.activeVariantIndex];
        const raw = v ? v.text : '';
        const cleaned = raw
          .replace(/<thought>[\s\S]*?<\/thought>/gi, '')
          .replace(/<thought>[\s\S]*$/gi, '')
          .replace(/<emotion>[\s\S]*?<\/emotion>/gi, '')
          .replace(/<\s*emotion[:\s][^>]+>/gi, '')
          .replace(/(?:\[|<|\()(?:эмоция|emotion):\s*[^\]>\)]+(?:\]|>|\))/gi, '')
          .trim();
        return `${m.senderName}: ${cleaned}`;
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

    setIsGenerating(true);
    setStreamingText('');
    setStreamingThought('');
    setStreamingEmotion(null);
    setStreamingSender(speaker);

    const abortController = new AbortController();
    abortControllerRef.current = abortController;

    try {
      // Retrieve user persona
      const userPersona = session.personaId
        ? allCharacters.find((c) => c.id === session.personaId) || null
        : null;

      // Retrieve affinity score
      const affinity = session.relationships?.[speaker.id] || 0;

      // Query fresh settings & text style from database
      const freshSettings = await db.settings.get('default');
      const styleId = session.textStyleId || freshSettings?.textStyleId || 'literary';
      const rawStyle = (await db.textStyles.get(styleId)) || activeStyle;

      // Context sliding window with context compression
      const freshDbMsgs = await db.messages.where('chatId').equals(session.id).sortBy('createdAt');
      let msgsForContext = freshDbMsgs;
      if (existingBotMsgToVariant) {
        const targetIdx = freshDbMsgs.findIndex((m) => m.id === existingBotMsgToVariant.id);
        if (targetIdx !== -1) {
          msgsForContext = freshDbMsgs.slice(0, targetIdx);
        }
      }

      // Determine dialogue language based on user's recent input to match narrative style language
      const lastUserMsgInContext = [...msgsForContext].reverse().find((m) => m.senderId === 'user');
      const lastUserText = lastUserMsgInContext?.variants[lastUserMsgInContext.activeVariantIndex]?.text || '';
      const dialogueLang: 'en' | 'ru' = /[а-яА-ЯёЁ]/.test(lastUserText) ? 'ru' : (/[a-zA-Z]/.test(lastUserText) ? 'en' : language);
      const textStyleToUse = rawStyle ? getLocalizedTextStyle(rawStyle, dialogueLang) : undefined;

      // Context = stable system prompt + rolling summary + verbatim window (grows by appending) + scene note.
      const freshChat = await db.chats.get(session.id);
      const storedSummary = freshChat?.rollingSummary?.trim() || session.rollingSummary?.trim() || '';
      const lastSummarizedId = freshChat?.lastSummarizedMsgId || session.lastSummarizedMsgId;

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

      const groupMembers = type === 'group' ? allCharacters.filter((c) => group?.characterIds.includes(c.id)) : [];
      const makeSystemPrompt = (summaryText: string) => buildSystemPrompt({
        character: speaker,
        group: group || undefined,
        groupCharacters: groupMembers,
        userPersona,
        textStyle: textStyleToUse,
        chatDirectives: session.chatDirectives,
        thoughtsEnabled: session.thoughtsEnabled === true,
        memoryNodes,
        relationshipScore: affinity,
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
            return `${m.senderName}: ${cleaned.length > 80 ? cleaned.slice(0, 80) + '...' : cleaned}`;
          })
          .join('\n');
        const header = dialogueLang === 'ru' ? 'Недавние события диалога:\n' : 'Recent dialogue events:\n';
        contextSummary = (storedSummary ? storedSummary + '\n\n' : '') + header + synopsis;
        systemPrompt = makeSystemPrompt(contextSummary);
      }

      const sceneNote = sceneNoteLines([
        buildSceneNote({
          speakerName: speaker.name,
          relationshipScore: affinity,
          memoryNodes,
          guidance: guidancePrompt,
        }),
      ]);

      // Build message array for API
      const apiMessages: any[] = [{ role: 'system', content: systemPrompt }];

      // Process raw dialogue turns with clear speaker attribution
      const rawTurns: Array<{ role: 'user' | 'assistant'; text: string; image?: string }> = [];
      for (const msg of contextMsgs) {
        const activeVariant = msg.variants[msg.activeVariantIndex];
        if (!activeVariant || !activeVariant.text?.trim()) continue;

        const isMe = type === 'group' ? msg.senderId === speaker.id : msg.senderId !== 'user';
        const role: 'user' | 'assistant' = isMe ? 'assistant' : 'user';

        // Strip any hidden <thought> tags and leaked emotion tags from history so past turns do not inflate prompt tokens or trigger ballooning responses
        let textContent = cleanHistoryText(activeVariant.text);
        if (type === 'group' && !isMe) {
          textContent = `[${msg.senderName}]: ${textContent}`;
        }

        rawTurns.push({
          role,
          text: textContent,
          image: msg.image && msg.senderId === 'user' ? msg.image : undefined,
        });
      }

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

      // Ensure start turn
      if (alternatingTurns.length > 0 && alternatingTurns[0].role === 'assistant') {
        alternatingTurns.unshift({
          role: 'user',
          content: type === 'group'
            ? (language === 'ru' ? '[Сцена начинается]' : '[Scene begins]')
            : (language === 'ru' ? 'Привет.' : 'Hello.'),
        });
      }

      if (alternatingTurns.length === 0) {
        alternatingTurns.push({
          role: 'user',
          content: language === 'ru' ? '[Сцена начинается. Начни разговор.]' : '[Scene begins. Start conversation.]',
        });
      }

      apiMessages.push(...alternatingTurns);

      // Scene note goes to the end of the last user message, so the stable beginning stays cacheable
      if (sceneNote) {
        const noteTitle = dialogueLang === 'ru' ? 'Заметка сцены (не цитируй и не упоминай)' : 'Scene note (do not quote or mention)';
        const note = `[${noteTitle}:\n${sceneNote}]`;
        const last = apiMessages[apiMessages.length - 1];
        if (last && last.role === 'user' && typeof last.content === 'string') {
          last.content = `${last.content}\n\n${note}`;
        } else if (last && last.role === 'user' && Array.isArray(last.content)) {
          last.content.push({ type: 'text', text: note });
        } else {
          apiMessages[0] = { role: 'system', content: `${systemPrompt}\n\n${note}` };
        }
      }

      let fullGenerated = '';

      // Photos in the context go to the vision backend; plain text stays on the chat backend
      const hasImages = apiMessages.some((m: any) => Array.isArray(m.content) && m.content.some((p: any) => p.type === 'image_url'));
      const turnConfig = hasImages ? getComponentAiConfig(settings, activeApiKey, 'vision') : null;

      const otherNames = [
        speaker.name,
        userPersona?.name || '',
        ...allCharacters.filter((c) => c.id !== speaker.id && group?.characterIds.includes(c.id)).map((c) => c.name),
      ];
      const speakerNames = [speaker.name, userPersona?.name || ''];

      await streamChatCompletion({
        apiKeyConfig: (turnConfig ? turnConfig.apiKeyConfig : effectiveApiKey) as ApiKeyConfig,
        model: turnConfig ? turnConfig.textModel : effectiveModel,
        // Also stop if the model starts quoting the hidden scene note
        extraStops: [...speakerStopStrings(otherNames), '[Scene note', '[Заметка сцены'],
        messages: apiMessages,
        temperature: isLocal ? 0.7 : 0.85,
        maxTokens: 1024,
        signal: abortController.signal,
        onToken: (tok) => {
          fullGenerated += tok;
          let currentThought = '';
          let display = stripLeadingSpeakerName(fullGenerated, speakerNames);

          // Only an explicit <emotion> tag changes the avatar; prose never does
          const emotionMatch = fullGenerated.match(/<emotion>([^<]+)<\/emotion>/i);
          if (emotionMatch) {
            setStreamingEmotion(emotionMatch[1].trim().toLowerCase());
          }

          const thoughtMatch = display.match(/<thought>([\s\S]*?)<\/thought>/);
          if (thoughtMatch) {
            currentThought = thoughtMatch[1].replace(/<emotion>[\s\S]*?<\/emotion>/gi, '').trim();
            display = display.replace(/<thought>[\s\S]*?<\/thought>/, '').trimStart();
          } else if (display.startsWith('<thought>')) {
            currentThought = display.replace('<thought>', '').replace(/<emotion>[\s\S]*?<\/emotion>/gi, '');
            display = '';
          }

          display = display
            .replace(/<emotion>[\s\S]*?<\/emotion>/gi, '')
            .replace(/<\s*emotion[:\s][^>]+>/gi, '')
            .replace(/(?:\[|<|\()(?:эмоция|emotion):\s*[^\]>\)]+(?:\]|>|\))/gi, '')
            .trimStart();

          setStreamingThought(currentThought);
          setStreamingText(cleanArtifacts(display));
        },
        onComplete: async (rawCompleted) => {
          setIsGenerating(false);
          abortControllerRef.current = null;
          const completed = stripLeadingSpeakerName(rawCompleted, speakerNames);

          try {
            if (!completed || !completed.trim()) {
              alert(language === 'ru' ? 'Модель вернула пустой ответ. Проверьте лимиты модели или повторите попытку.' : 'Model returned an empty response. Please try again.');
              return;
            }

            const { text: finalText, thought: finalThought, emotion: finalEmotion } =
              extractEmotionAndCleanResponse(completed, speaker.emotions);

            const newVariant: MessageVariant = {
              text: finalText || cleanArtifacts(completed),
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
            const freshHistory = await db.messages.where('chatId').equals(session.id).sortBy('createdAt');
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
                if (currentLatest) {
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
                  isLocal ? { maxChars: limits.maxChars, maxTokens: limits.maxTokens, timeoutMs: 120000 } : undefined
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
      setIsGenerating(false);
      abortControllerRef.current = null;
    }
  };

  // Send User Message
  const handleSendMessage = async () => {
    if ((!inputText.trim() && !attachedImage) || isGenerating || !session) return;

    // Intercept slash commands typed into the input
    const trimmedInput = inputText.trim();
    if (trimmedInput.startsWith('/') && !attachedImage) {
      const cmd = trimmedInput.split(/\s+/)[0].toLowerCase();
      if (['/continue', '/summary', '/memory', '/reset', '/action'].includes(cmd)) {
        await handleSelectSlashCommand(cmd);
        return;
      }
    }

    const userPersona = session.personaId
      ? allCharacters.find((c) => c.id === session.personaId) || null
      : null;

    const userMsg: ChatMessage = {
      id: 'msg-' + Math.random().toString(36).substring(2, 10),
      chatId: session.id,
      senderId: 'user',
      senderName: userPersona ? userPersona.name : (language === 'ru' ? 'Вы' : 'You'),
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
    requestAnimationFrame(() => {
      scrollToBottom(false);
    });

    // Trigger bot reply: only in 1-on-1 chat!
    // In group chats, characters ONLY respond when invoked explicitly by the user!
    if (type === 'character') {
      runBotGeneration();
    }
  };

  // Rollback and Fork chat session
  const handleRollback = async (targetMsg: ChatMessage) => {
    if (!session) return;
    const targetIdx = messages.findIndex((m) => m.id === targetMsg.id);
    if (targetIdx === -1) return;

    const messagesToKeep = messages.slice(0, targetIdx + 1);

    // Create a new branched session
    const newSessionId = 'chat-fork-' + Math.random().toString(36).substring(2, 9);
    const newTitle = `${session.title} (Fork ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })})`;

    const forkedSession: ChatSession = {
      ...session,
      id: newSessionId,
      title: newTitle,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    await db.chats.put(forkedSession);

    // Clone messages into the new session
    for (const msg of messagesToKeep) {
      await db.messages.put({
        ...msg,
        id: 'msg-' + Math.random().toString(36).substring(2, 10),
        chatId: newSessionId,
      });
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
        for (const d of toDelete) {
          await db.messages.delete(d.id);
          try {
            const staleNodes = await db.memoryNodes
              .where('chatId')
              .equals(msg.chatId)
              .filter((n) => n.messageId === d.id)
              .toArray();
            for (const sn of staleNodes) {
              await db.memoryEdges.where('source').equals(sn.id).delete();
              await db.memoryEdges.where('target').equals(sn.id).delete();
              await db.memoryNodes.delete(sn.id);
            }
          } catch {
            // ignore
          }
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
  const handleExecuteUserWand = async () => {
    if (!effectiveApiKey || (!effectiveApiKey.key.trim() && !isLocal)) {
      alert(language === 'ru' ? 'Сначала настройте подключение к ИИ в настройках' : 'Please configure AI connection in settings first');
      return;
    }
    const controller = new AbortController();
    wandAbortRef.current = controller;
    setWandPreview('');
    setIsWandGenerating(true);
    try {
      const history = buildContextHistory(messages);
      const userPersona = session?.personaId
        ? allCharacters.find((c) => c.id === session.personaId) || null
        : null;

      const ghostCfg = getComponentAiConfig(settings, activeApiKey, 'ghostwriter');
      const suggested = await suggestUserReply(
        ghostCfg.apiKeyConfig as any,
        ghostCfg.textModel,
        userPersona,
        userWandPrompt,
        history,
        { onPartial: (text) => setWandPreview(text), signal: controller.signal }
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
    if (cmd === '/continue') {
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
      setSummaryModalText(language === 'ru' ? 'Генерация сводки сцены...' : 'Generating scene recap...');
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
          const unpinned = await db.memoryNodes.where('chatId').equals(session.id).filter((n) => !n.isPinned).toArray();
          for (const u of unpinned) {
            await db.memoryEdges.where('source').equals(u.id).delete();
            await db.memoryEdges.where('target').equals(u.id).delete();
            await db.memoryNodes.delete(u.id);
          }
          await db.chats.update(session.id, {
            rollingSummary: undefined,
            lastSummarizedMsgId: undefined,
            relationships: {},
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
            style={{ color: currentTheme.actionColor || '#fb7185' }}
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
        <div className="flex items-center gap-3">
          <button
            onClick={onBack}
            type="button"
            className="p-1.5 -ml-1 text-slate-400 hover:text-white rounded-xl hover:bg-silk-800"
          >
            <ArrowLeft className="w-5 h-5" />
          </button>

          {/* Avatar & Title */}
          <div className="flex items-center gap-2.5">
            <div className="relative w-9 h-9 rounded-xl overflow-hidden bg-silk-800 border border-silk-700 shrink-0">
              <AvatarImage
                src={type === 'character' ? character?.avatar : group?.avatar}
                alt={type === 'character' ? character?.name : group?.name}
                isGroup={type === 'group'}
                className="w-full h-full object-cover"
              />
            </div>

            <div>
              <div className="flex items-center gap-2">
                <h2 className="text-sm font-bold text-white leading-tight truncate max-w-[180px]">
                  {type === 'character' ? character?.name : group?.name}
                </h2>
              </div>
              <span className="text-[10px] text-emerald-400 flex items-center gap-1">
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 inline-block" />
                <span>{type === 'character' ? (language === 'ru' ? 'В ролевой' : 'In Roleplay') : (language === 'ru' ? 'Групповая сессия' : 'Group Session')}</span>
              </span>
            </div>
          </div>
        </div>

        {/* Top Right RP Settings */}
        <button
          onClick={() => setShowSettingsModal(true)}
          type="button"
          className="p-2 text-slate-400 hover:text-white rounded-xl hover:bg-silk-800"
          title={t.chatSettings}
        >
          <SettingsIcon className="w-5 h-5" />
        </button>
      </div>

      {/* 2. Messages Scroll Area */}
      <div
        ref={chatContainerRef}
        onScroll={handleScroll}
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
          const latestBotMsg = [...messages].reverse().find((m) => m.senderId !== 'user');
          return displayedMessages.map((msg) => {
            const isUser = msg.senderId === 'user';
            const isLatestBotMsg = !isUser && latestBotMsg?.id === msg.id;
            const activeVariant = msg.variants[msg.activeVariantIndex] || { text: '' };
            const isEditing = editingMsgId === msg.id;
            const hasVariants = msg.variants.length > 1;
            const isThoughtExpanded = !!expandedThoughts[msg.id];

            const botChar = !isUser ? allCharacters.find((c) => c.id === msg.senderId) || (type === 'character' ? character : undefined) : undefined;
            const botAvatar = !isUser
              ? getSpeakerAvatar(msg.senderId, activeVariant.emotion || msg.emotion, botChar?.avatar || msg.senderAvatar || '')
              : undefined;

            return (
              <div
                key={msg.id}
                className={`flex ${isUser ? 'justify-end' : 'justify-start'} items-end gap-2.5 group`}
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
                  className={`relative p-3.5 shadow-xl transition-all ${
                    isUser ? 'text-slate-100' : 'text-slate-200'
                  }`}
                  style={{
                    backgroundColor: isUser ? currentTheme.bubbleUserBg : currentTheme.bubbleBotBg,
                    borderRadius: `${currentTheme.bubbleRadius}px`,
                    opacity: currentTheme.bubbleOpacity,
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
                    <div className="mb-2 p-2 rounded-xl bg-silk-950/70 border border-violet-500/30 text-xs">
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
                        <div className="relative rounded-2xl overflow-hidden border border-violet-500/30 bg-black/40 shadow-lg transition-transform hover:scale-105">
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
                              <div className="absolute left-0 bottom-full mb-2 z-30 p-2 bg-silk-900 border border-silk-700 rounded-xl shadow-2xl flex items-center gap-2 animate-fade-in max-w-xs overflow-x-auto no-scrollbar">
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
                src={getSpeakerAvatar(streamingSender.id, streamingEmotion || undefined, streamingSender.avatar)}
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
                className="p-3.5 shadow-xl text-slate-200"
                style={{
                  backgroundColor: currentTheme.bubbleBotBg,
                  borderRadius: `${currentTheme.bubbleRadius}px`,
                  opacity: currentTheme.bubbleOpacity,
                  fontSize: `${currentTheme.fontSize}px`,
                  fontFamily: fontFamilyStyle,
                  lineHeight: lineHeightStyle,
                }}
              >
                {streamingThought && (
                  <div className="mb-2 p-2 rounded-xl bg-silk-950/70 border border-violet-500/30 text-xs">
                    <div className="flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wider text-violet-400 mb-1">
                      <Sparkles className="w-3 h-3 animate-spin" />
                      <span>{t.thinkingBlock}</span>
                    </div>
                    <p className="text-slate-300 italic text-[11px] leading-relaxed">
                      {streamingThought}
                    </p>
                  </div>
                )}

                <div className="whitespace-pre-wrap break-words" style={{ lineHeight: lineHeightStyle }}>
                  {formatMessageText(streamingText || '...')}
                  <span className="inline-block w-1.5 h-4 ml-0.5 bg-violet-400 animate-pulse align-middle" />
                </div>

                {/* Streaming Emotion Sprite */}
                {(() => {
                  const sprite = getEmotionSprite(streamingSender.id, streamingEmotion || undefined);
                  if (!sprite || !sprite.avatar) return null;
                  return (
                    <div className="mt-3 pt-2.5 border-t border-white/10 flex items-center">
                      <div className="relative rounded-2xl overflow-hidden border border-violet-500/30 bg-black/40 shadow-lg">
                        <img
                          src={sprite.avatar}
                          alt=""
                          className="max-h-48 max-w-[200px] w-auto h-auto object-contain rounded-xl block animate-pulse"
                        />
                      </div>
                    </div>
                  );
                })()}
              </div>
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
          className="absolute right-5 bottom-20 z-30 p-2.5 rounded-full bg-silk-850/95 hover:bg-silk-800 text-violet-400 hover:text-white border border-silk-700/90 shadow-2xl backdrop-blur-md transition-all duration-200 animate-fade-in hover:scale-110 active:scale-95 flex items-center justify-center group"
          title={t.scrollToBottomLabel}
        >
          <ArrowDown className="w-4 h-4 group-hover:translate-y-0.5 transition-transform" />
        </button>
      )}

      {/* Slash Command Autocomplete Menu */}
      {showSlashMenu && (
        <div className="relative z-20 mx-4 mb-2 bg-silk-900 border border-silk-700 rounded-2xl shadow-2xl overflow-hidden animate-slide-up text-xs">
          <div className="p-2.5 font-semibold text-[11px] uppercase tracking-wider text-slate-400 border-b border-silk-800">
            {t.slashCommandHeader}
          </div>
          <button
            onClick={() => handleSelectSlashCommand('/continue')}
            type="button"
            className="w-full flex items-center gap-2.5 px-3.5 py-2 hover:bg-silk-800 text-left text-slate-200"
          >
            <span className="font-mono text-violet-400 font-semibold">/continue</span>
            <span className="text-slate-400 text-[11px]">{t.cmdContinue}</span>
          </button>
          <button
            onClick={() => handleSelectSlashCommand('/summary')}
            type="button"
            className="w-full flex items-center gap-2.5 px-3.5 py-2 hover:bg-silk-800 text-left text-slate-200"
          >
            <span className="font-mono text-emerald-400 font-semibold">/summary</span>
            <span className="text-slate-400 text-[11px]">{t.cmdSummary}</span>
          </button>
          <button
            onClick={() => handleSelectSlashCommand('/action')}
            type="button"
            className="w-full flex items-center gap-2.5 px-3.5 py-2 hover:bg-silk-800 text-left text-slate-200"
          >
            <span className="font-mono text-rose-400 font-semibold">/action</span>
            <span className="text-slate-400 text-[11px]">{t.cmdAction}</span>
          </button>
          <button
            onClick={() => handleSelectSlashCommand('/memory')}
            type="button"
            className="w-full flex items-center gap-2.5 px-3.5 py-2 hover:bg-silk-800 text-left text-slate-200"
          >
            <span className="font-mono text-sky-400 font-semibold">/memory</span>
            <span className="text-slate-400 text-[11px]">{t.cmdMemory}</span>
          </button>
          <button
            onClick={() => handleSelectSlashCommand('/reset')}
            type="button"
            className="w-full flex items-center gap-2.5 px-3.5 py-2 hover:bg-silk-800 text-left text-slate-200"
          >
            <span className="font-mono text-red-400 font-semibold">/reset</span>
            <span className="text-slate-400 text-[11px]">{t.cmdReset}</span>
          </button>
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

          {/* User Magic Wand Ghostwriter */}
          <button
            onClick={() => setShowUserWandModal(true)}
            type="button"
            className="p-2.5 text-slate-400 hover:text-violet-400 rounded-xl hover:bg-silk-800 shrink-0"
            title={t.magicWandUser}
          >
            <Wand2 className="w-5 h-5" />
          </button>

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
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-md">
          <div className="w-full max-w-md bg-silk-900 border border-silk-700 rounded-2xl p-4 shadow-2xl space-y-3">
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

            {(isWandGenerating || wandPreview) && (
              <div className="max-h-56 overflow-y-auto px-3 py-2 bg-silk-800/60 border border-silk-700 rounded-xl text-sm text-slate-100 whitespace-pre-wrap leading-relaxed">
                {wandPreview || (
                  <span className="text-slate-500 text-xs">{language === 'ru' ? 'Ожидание первого слова...' : 'Waiting for the first words...'}</span>
                )}
                {isWandGenerating && <span className="inline-block w-1.5 h-4 ml-0.5 align-middle bg-violet-400 animate-pulse" />}
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
                    className="flex items-center gap-1.5 px-4 py-1.5 bg-violet-600 hover:bg-violet-500 text-white rounded-xl text-xs font-semibold shadow-md"
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
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-md">
          <div className="w-full max-w-sm bg-silk-900 border border-silk-700 rounded-2xl p-4 shadow-2xl space-y-3">
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
                className="px-4 py-1.5 bg-violet-600 hover:bg-violet-500 text-white rounded-xl text-xs font-semibold shadow-md"
              >
                {t.regenerate}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Group Next Speaker Selector Modal */}
      {showSpeakerModal && type === 'group' && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-md">
          <div className="w-full max-w-xs bg-silk-900 border border-silk-700 rounded-2xl p-4 shadow-2xl space-y-3">
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
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-md">
          <div className="w-full max-w-sm bg-silk-900 border border-silk-700 rounded-2xl p-4 shadow-2xl space-y-3">
            <div className="flex items-center justify-between">
              <h3 className="font-semibold text-sm text-white">{t.summaryModalTitle}</h3>
              <button
                onClick={() => setSummaryModalText(null)}
                className="text-slate-400 hover:text-white"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="text-xs text-slate-300 leading-relaxed whitespace-pre-wrap max-h-72 overflow-y-auto">
              {summaryModalText}
            </div>
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
    </div>
  );
};
