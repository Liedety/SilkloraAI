import React, { useState, useEffect, useRef } from 'react';
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
} from 'lucide-react';
import { db, DEFAULT_THEME } from '../db';
import type {
  Character,
  ChatMessage,
  ChatSession,
  Group,
  Language,
  MessageVariant,
} from '../types';
import { translations } from '../i18n';
import { streamChatCompletion, suggestUserReply, summarizeScene, cleanArtifacts } from '../services/ai';
import { buildSystemPrompt } from '../services/promptBuilder';
import { extractMemoryAndAffinity } from '../services/memoryGraph';
import { ChatSettingsModal } from './ChatSettingsModal';
import { AvatarImage } from '../components/AvatarImage';

interface ChatViewProps {
  type: 'character' | 'group';
  targetId: string;
  language: Language;
  onBack: () => void;
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
          const greetingMsg: ChatMessage = {
            id: 'msg-' + Math.random().toString(36).substring(2, 10),
            chatId: newSession.id,
            senderId: character.id,
            senderName: character.name,
            senderAvatar: character.avatar,
            variants: [
              {
                text: character.greeting,
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
  const abortControllerRef = useRef<AbortController | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  // Modals & Panels
  const [showSettingsModal, setShowSettingsModal] = useState(false);
  const [showSpeakerModal, setShowSpeakerModal] = useState(false);
  const [showUserWandModal, setShowUserWandModal] = useState(false);
  const [userWandPrompt, setUserWandPrompt] = useState('');
  const [isWandGenerating, setIsWandGenerating] = useState(false);

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

  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const currentTheme = settings?.theme || DEFAULT_THEME;

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages, streamingText]);

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
        (e) => e.name.toLowerCase() === emLower || e.label?.toLowerCase() === emLower
      );
      if (direct?.avatar) return direct.avatar;

      // 2. Fuzzy synonym match (Russian & English)
      const synonymGroups: Record<string, string[]> = {
        happy: ['happy', 'joy', 'smile', 'радость', 'улыбка', 'веселье', 'счастье'],
        sad: ['sad', 'sorrow', 'crying', 'грусть', 'печаль', 'слезы', 'тоска'],
        angry: ['angry', 'furious', 'rage', 'гнев', 'злость', 'ярость', 'раздражение'],
        blushing: ['blushing', 'shy', 'embarrassed', 'смущение', 'стыд', 'румянец'],
        smirk: ['smirk', 'tease', 'playful', 'усмешка', 'сарказм', 'ухмылка'],
        surprised: ['surprised', 'shocked', 'удивление', 'шок', 'испуг'],
        thoughtful: ['thoughtful', 'pensive', 'задумчивость', 'размышление'],
        neutral: ['neutral', 'calm', 'нейтральный', 'спокойствие'],
      };

      for (const [, words] of Object.entries(synonymGroups)) {
        if (words.some((w) => emLower.includes(w))) {
          const match = char.emotions.find((e) => {
            const eName = (e.name + ' ' + (e.label || '')).toLowerCase();
            return words.some((w) => eName.includes(w));
          });
          if (match?.avatar) return match.avatar;
        }
      }
    }
    return char.avatar || fallbackAvatar || '';
  };

  // Build current dialogue context string for AI
  const buildContextHistory = (msgList: ChatMessage[]): string => {
    return msgList
      .slice(-12)
      .map((m) => {
        const v = m.variants[m.activeVariantIndex];
        return `${m.senderName}: ${v ? v.text : ''}`;
      })
      .join('\n');
  };

  // Helper to execute generation
  const runBotGeneration = async (
    targetSpeaker?: Character,
    guidancePrompt?: string,
    existingBotMsgToVariant?: ChatMessage
  ) => {
    if (!activeApiKey || !activeApiKey.key.trim()) {
      alert(language === 'ru' ? 'Пожалуйста, настройте активный API ключ в Настройках.' : 'Please configure an active API key in Settings.');
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
        // Pick character from group
        const groupChars = allCharacters.filter((c) => group?.characterIds.includes(c.id));
        speaker = groupChars[Math.floor(Math.random() * groupChars.length)] || allCharacters[0];
      }
    }

    if (!speaker || !session) return;

    setIsGenerating(true);
    setStreamingText('');
    setStreamingThought('');
    setStreamingEmotion(null);
    setStreamingSender(speaker);

    const abortController = new AbortController();
    abortControllerRef.current = abortController;

    // Retrieve user persona
    const userPersona = session.personaId
      ? allCharacters.find((c) => c.id === session.personaId) || null
      : null;

    // Retrieve affinity score
    const affinity = session.relationships?.[speaker.id] || 0;

    // Build system prompt
    const groupMembers = type === 'group' ? allCharacters.filter((c) => group?.characterIds.includes(c.id)) : [];
    let systemPrompt = buildSystemPrompt({
      character: speaker,
      group: group || undefined,
      groupCharacters: groupMembers,
      userPersona,
      textStyle: activeStyle,
      chatDirectives: session.chatDirectives,
      thoughtsEnabled: session.thoughtsEnabled,
      memoryNodes,
      relationshipScore: affinity,
      speakerCharacter: speaker,
    });

    if (guidancePrompt && guidancePrompt.trim()) {
      systemPrompt += `\n### USER GUIDED GENERATION INSTRUCTION FOR THIS TURN:\n${guidancePrompt.trim()}\n`;
    }

    // Build message array for API
    const apiMessages: any[] = [{ role: 'system', content: systemPrompt }];

    // Context sliding window (query fresh messages directly from DB)
    const freshDbMsgs = await db.messages.where('chatId').equals(session.id).sortBy('createdAt');
    const contextMsgs = freshDbMsgs.slice(-16);
    for (const msg of contextMsgs) {
      const activeVariant = msg.variants[msg.activeVariantIndex];
      if (!activeVariant) continue;

      const role = msg.senderId === 'user' ? 'user' : 'assistant';
      let content = activeVariant.text;
      if (msg.senderId !== 'user' && activeVariant.thought) {
        content = `<thought>${activeVariant.thought}</thought>\n${content}`;
      }

      if (msg.image && msg.senderId === 'user') {
        apiMessages.push({
          role: 'user',
          content: [
            { type: 'text', text: content },
            { type: 'image_url', image_url: { url: msg.image } },
          ],
        });
      } else {
        apiMessages.push({ role, content });
      }
    }

    let fullGenerated = '';

    await streamChatCompletion({
      apiKeyConfig: activeApiKey,
      model: settings?.textModel || 'deepseek/deepseek-chat',
      messages: apiMessages,
      signal: abortController.signal,
      onToken: (tok) => {
        fullGenerated += tok;
        let currentThought = '';
        let display = fullGenerated;

        const thoughtMatch = display.match(/<thought>([\s\S]*?)<\/thought>/);
        if (thoughtMatch) {
          currentThought = thoughtMatch[1].trim();
          display = display.replace(/<thought>[\s\S]*?<\/thought>/, '').trimStart();
        } else if (display.startsWith('<thought>')) {
          currentThought = display.replace('<thought>', '');
          display = '';
        }

        const emotionMatch = display.match(/<emotion>([^<]+)<\/emotion>/i);
        if (emotionMatch) {
          setStreamingEmotion(emotionMatch[1].trim().toLowerCase());
          display = display.replace(/<emotion>[\s\S]*?<\/emotion>/gi, '').trimStart();
        }

        setStreamingThought(currentThought);
        setStreamingText(cleanArtifacts(display));
      },
      onComplete: async (completed) => {
        setIsGenerating(false);
        abortControllerRef.current = null;

        let finalThought = '';
        let finalText = completed;
        let finalEmotion: string | undefined = undefined;

        const match = completed.match(/<thought>([\s\S]*?)<\/thought>/);
        if (match) {
          finalThought = match[1].trim();
          finalText = completed.replace(/<thought>[\s\S]*?<\/thought>/, '').trim();
        }

        const emotionMatch = finalText.match(/<emotion>([^<]+)<\/emotion>/i);
        if (emotionMatch) {
          finalEmotion = emotionMatch[1].trim().toLowerCase();
          finalText = finalText.replace(/<emotion>[\s\S]*?<\/emotion>/gi, '').trim();
        }

        finalText = cleanArtifacts(finalText);

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

        // Run automated memory graph extraction and affinity change in background with fresh DB messages
        const freshHistory = await db.messages.where('chatId').equals(session.id).sortBy('createdAt');
        extractMemoryAndAffinity(
          session.id,
          speaker.id,
          affinity,
          freshHistory,
          activeApiKey,
          settings?.textModel
        ).then(async ({ newAffinity }) => {
          if (newAffinity !== affinity) {
            const currentLatest = await db.chats.get(session.id);
            if (currentLatest) {
              const updatedR = { ...(currentLatest.relationships || {}), [speaker.id]: newAffinity };
              await db.chats.update(session.id, { relationships: updatedR });
            }
          }
        });
      },
      onError: (err) => {
        setIsGenerating(false);
        abortControllerRef.current = null;
        alert((language === 'ru' ? 'Ошибка генерации: ' : 'Generation Error: ') + err.message);
      },
    });
  };

  // Send User Message
  const handleSendMessage = async () => {
    if ((!inputText.trim() && !attachedImage) || isGenerating || !session) return;

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

    // Trigger bot reply
    runBotGeneration();
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

  // User Magic Wand Ghostwriter
  const handleExecuteUserWand = async () => {
    if (!activeApiKey || !userWandPrompt.trim()) return;
    setIsWandGenerating(true);
    try {
      const history = buildContextHistory(messages);
      const userPersona = session?.personaId
        ? allCharacters.find((c) => c.id === session.personaId) || null
        : null;

      const suggested = await suggestUserReply(
        activeApiKey,
        settings?.textModel || 'deepseek/deepseek-chat',
        userPersona,
        userWandPrompt,
        history
      );

      setInputText(suggested);
      setShowUserWandModal(false);
      setUserWandPrompt('');
    } catch (err: any) {
      alert((language === 'ru' ? 'Ошибка подсказки реплики: ' : 'Ghostwriter failed: ') + err.message);
    } finally {
      setIsWandGenerating(false);
    }
  };

  // Slash commands handler
  const handleSelectSlashCommand = async (cmd: string) => {
    setShowSlashMenu(false);
    if (cmd === '/continue') {
      setInputText('');
      runBotGeneration();
    } else if (cmd === '/summary') {
      setInputText('');
      if (!activeApiKey) {
        alert(language === 'ru' ? 'Требуется API ключ для генерации сводки.' : 'API key required for summary.');
        return;
      }
      setSummaryModalText(language === 'ru' ? 'Генерация сводки сцены...' : 'Generating scene recap...');
      try {
        const history = buildContextHistory(messages);
        const recap = await summarizeScene(
          activeApiKey,
          settings?.textModel || 'deepseek/deepseek-chat',
          history
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
      if (window.confirm(language === 'ru' ? 'Очистить все сообщения в этой сессии?' : 'Clear messages in this chat session?')) {
        if (session) {
          await db.messages.where('chatId').equals(session.id).delete();
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
          backgroundColor: `rgba(7, 9, 14, ${currentTheme.backgroundTint})`,
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
      <div className="relative z-10 flex-1 overflow-y-auto p-4 space-y-4 pb-4">
        {messages.map((msg) => {
          const isUser = msg.senderId === 'user';
          const activeVariant = msg.variants[msg.activeVariantIndex] || { text: '' };
          const isEditing = editingMsgId === msg.id;
          const hasVariants = msg.variants.length > 1;
          const isThoughtExpanded = !!expandedThoughts[msg.id];

          const botAvatar = !isUser
            ? getSpeakerAvatar(msg.senderId, activeVariant.emotion || msg.emotion, msg.senderAvatar)
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
                {/* Sender Name & Active Emotion Badge */}
                {!isUser && (
                  <div className="flex items-center gap-1.5 text-[11px] font-semibold text-violet-300 ml-1">
                    {type === 'group' && <span>{msg.senderName}</span>}
                    {(activeVariant.emotion || msg.emotion) && (
                      <span className="px-2 py-0.5 rounded-full bg-violet-950/60 border border-violet-700/50 text-[10px] text-violet-300 font-medium">
                        {activeVariant.emotion || msg.emotion}
                      </span>
                    )}
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
                    <div className="leading-relaxed whitespace-pre-wrap break-words">
                      {formatMessageText(activeVariant.text)}
                    </div>
                  )}
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

                  {/* Edit */}
                  <button
                    onClick={() => handleStartEdit(msg)}
                    type="button"
                    className="p-1 hover:text-violet-400 rounded hover:bg-silk-800"
                    title={t.editMessage}
                  >
                    <Edit3 className="w-3.5 h-3.5" />
                  </button>

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

                  {/* Bot-specific actions: Wand & Regenerate */}
                  {!isUser && (
                    <>
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

                      <button
                        onClick={() => handleRegenerate(msg)}
                        type="button"
                        className="p-1 hover:text-white rounded hover:bg-silk-800"
                        title={t.regenerate}
                      >
                        <RefreshCw className="w-3.5 h-3.5" />
                      </button>
                    </>
                  )}
                </div>
              </div>
            </div>
          );
        })}

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
              <div className="flex items-center gap-1.5 text-[11px] font-semibold text-violet-300 ml-1">
                {type === 'group' && <span>{streamingSender.name}</span>}
                {streamingEmotion && (
                  <span className="px-2 py-0.5 rounded-full bg-violet-950/60 border border-violet-700/50 text-[10px] text-violet-300 font-medium">
                    {streamingEmotion}
                  </span>
                )}
              </div>
              <div
                className="p-3.5 shadow-xl text-slate-200"
                style={{
                  backgroundColor: currentTheme.bubbleBotBg,
                  borderRadius: `${currentTheme.bubbleRadius}px`,
                  opacity: currentTheme.bubbleOpacity,
                  fontSize: `${currentTheme.fontSize}px`,
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

                <div className="leading-relaxed whitespace-pre-wrap break-words">
                  {formatMessageText(streamingText || '...')}
                  <span className="inline-block w-1.5 h-4 ml-0.5 bg-violet-400 animate-pulse align-middle" />
                </div>
              </div>
            </div>
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

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
          <div className="w-full max-w-sm bg-silk-900 border border-silk-700 rounded-2xl p-4 shadow-2xl space-y-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Wand2 className="w-4 h-4 text-violet-400" />
                <h3 className="font-semibold text-sm text-white">{t.ghostwriterTitle}</h3>
              </div>
              <button
                onClick={() => setShowUserWandModal(false)}
                className="text-slate-400 hover:text-white"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <textarea
              rows={3}
              value={userWandPrompt}
              onChange={(e) => setUserWandPrompt(e.target.value)}
              placeholder={t.ghostwriterPromptPlaceholder}
              className="w-full px-3 py-2 bg-silk-800 border border-silk-700 rounded-xl text-xs text-white resize-none"
              autoFocus
            />

            <div className="flex justify-end gap-2">
              <button
                onClick={() => setShowUserWandModal(false)}
                type="button"
                className="px-3 py-1.5 text-xs text-slate-400 hover:text-white"
              >
                {t.cancel}
              </button>
              <button
                onClick={handleExecuteUserWand}
                disabled={isWandGenerating || !userWandPrompt.trim()}
                type="button"
                className="flex items-center gap-1.5 px-4 py-1.5 bg-violet-600 hover:bg-violet-500 text-white rounded-xl text-xs font-semibold shadow-md"
              >
                <Sparkles className="w-3.5 h-3.5" />
                <span>{isWandGenerating ? (language === 'ru' ? 'Формулирую...' : 'Formulating...') : t.applyToInput}</span>
              </button>
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
                disabled={!guidedRegenPrompt.trim()}
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
                .filter((c) => group?.characterIds.includes(c.id))
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
