import React, { useState, useRef, useEffect } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import {
  Plus,
  Folder as FolderIcon,
  FolderPlus,
  MessageSquare,
  Edit2,
  Trash2,
  Sparkles,
  Camera,
  Image as ImageIcon,
  Check,
  ChevronRight,
  AtSign,
  X,
  Smile,
} from 'lucide-react';
import { db } from '../db';
import type { Character, CharacterEmotion, Folder, Group, ImageCropOffset, Language } from '../types';
import { translations } from '../i18n';
import { ImageCropperModal } from '../components/ImageCropperModal';
import { AvatarImage } from '../components/AvatarImage';
import { generatePersonaWithAI, getEffectiveAiConfig } from '../services/ai';

interface CharactersViewProps {
  language: Language;
  onOpenChat: (characterId: string) => void;
  onDirtyChange: (dirty: boolean, saveAction?: () => Promise<void>) => void;
}

export const CharactersView: React.FC<CharactersViewProps> = ({
  language,
  onOpenChat,
  onDirtyChange,
}) => {
  const t = translations[language];

  // Dexie live queries
  const characters = useLiveQuery(() => db.characters.orderBy('createdAt').reverse().toArray()) || [];
  const folders = useLiveQuery(() => db.folders.orderBy('name').toArray()) || [];
  const groups = useLiveQuery(() => db.groups.toArray()) || [];
  const activeApiKey = useLiveQuery(() => db.apiKeys.filter((k) => k.isActive).first());
  const settings = useLiveQuery(() => db.settings.get('default'));
  const { apiKeyConfig: effectiveApiKey, textModel: effectiveModel, isLocal } = getEffectiveAiConfig(settings, activeApiKey);

  // Active folder filter: null = all, 'none' = no folder, or folderId
  const [selectedFolderId, setSelectedFolderId] = useState<string | null>(null);

  // Folder creation modal state
  const [showFolderModal, setShowFolderModal] = useState(false);
  const [newFolderName, setNewFolderName] = useState('');

  // Character editor modal state
  const [showEditModal, setShowEditModal] = useState(false);
  const [editingCharacterId, setEditingCharacterId] = useState<string | null>(null);

  // Form fields
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [greeting, setGreeting] = useState('');
  const [greetingEnabled, setGreetingEnabled] = useState(true);
  const [folderId, setFolderId] = useState<string | null>(null);
  const [avatar, setAvatar] = useState<string>('');
  const [avatarOffset, setAvatarOffset] = useState<ImageCropOffset>({ x: 0, y: 0, scale: 1 });
  const [chatBackground, setChatBackground] = useState<string>('');
  const [chatBackgroundOffset, setChatBackgroundOffset] = useState<ImageCropOffset>({ x: 0, y: 0, scale: 1 });
  const [emotions, setEmotions] = useState<CharacterEmotion[]>([]);
  const [activeEmotionCropperId, setActiveEmotionCropperId] = useState<string | null>(null);

  // Synchronous form ref to prevent stale closures during save
  const currentFormRef = useRef({
    name: '',
    description: '',
    greeting: '',
    greetingEnabled: true,
    folderId: null as string | null,
    avatar: '',
    avatarOffset: { x: 0, y: 0, scale: 1 } as ImageCropOffset,
    chatBackground: '',
    chatBackgroundOffset: { x: 0, y: 0, scale: 1 } as ImageCropOffset,
    emotions: [] as CharacterEmotion[],
  });

  const syncFormRef = (updates: Partial<typeof currentFormRef.current>) => {
    currentFormRef.current = { ...currentFormRef.current, ...updates };
  };

  useEffect(() => {
    return () => {
      onDirtyChange(false);
    };
  }, []);

  // Cropper modal state
  const [cropperOpen, setCropperOpen] = useState(false);
  const [cropperIsAvatar, setCropperIsAvatar] = useState(true);
  const [cropperRawSrc, setCropperRawSrc] = useState<string>('');

  // AI Generator modal state
  const [showGeneratorModal, setShowGeneratorModal] = useState(false);
  const [genConcept, setGenConcept] = useState('');
  const [genDo, setGenDo] = useState('');
  const [genDont, setGenDont] = useState('');
  const [genPhotoRef, setGenPhotoRef] = useState<string>('');
  const [isGenerating, setIsGenerating] = useState(false);
  const [mentionQuery, setMentionQuery] = useState<string | null>(null);
  const [showMentionDropdown, setShowMentionDropdown] = useState(false);

  // Open Create Character
  const handleOpenCreate = () => {
    setEditingCharacterId(null);
    setName('');
    setDescription('');
    setGreeting('');
    setGreetingEnabled(true);
    const initialFolder = selectedFolderId && selectedFolderId !== 'none' ? selectedFolderId : null;
    setFolderId(initialFolder);
    setAvatar('');
    setAvatarOffset({ x: 0, y: 0, scale: 1 });
    setChatBackground('');
    setChatBackgroundOffset({ x: 0, y: 0, scale: 1 });
    setEmotions([]);
    syncFormRef({
      name: '',
      description: '',
      greeting: '',
      greetingEnabled: true,
      folderId: initialFolder,
      avatar: '',
      avatarOffset: { x: 0, y: 0, scale: 1 },
      chatBackground: '',
      chatBackgroundOffset: { x: 0, y: 0, scale: 1 },
      emotions: [],
    });
    setShowEditModal(true);
  };

  // Open Edit Character
  const handleOpenEdit = (char: Character) => {
    setEditingCharacterId(char.id);
    setName(char.name);
    setDescription(char.description);
    setGreeting(char.greeting || '');
    setGreetingEnabled(char.greetingEnabled);
    setFolderId(char.folderId || null);
    setAvatar(char.avatar);
    setAvatarOffset(char.avatarOffset || { x: 0, y: 0, scale: 1 });
    setChatBackground(char.chatBackground || '');
    setChatBackgroundOffset(char.chatBackgroundOffset || { x: 0, y: 0, scale: 1 });
    const loadedEmotions = char.emotions || [];
    setEmotions(loadedEmotions);
    syncFormRef({
      name: char.name,
      description: char.description,
      greeting: char.greeting || '',
      greetingEnabled: char.greetingEnabled,
      folderId: char.folderId || null,
      avatar: char.avatar,
      avatarOffset: char.avatarOffset || { x: 0, y: 0, scale: 1 },
      chatBackground: char.chatBackground || '',
      chatBackgroundOffset: char.chatBackgroundOffset || { x: 0, y: 0, scale: 1 },
      emotions: loadedEmotions,
    });
    setShowEditModal(true);
  };

  // Close Character Modal
  const handleCloseModal = () => {
    setShowEditModal(false);
    onDirtyChange(false);
  };

  // Save Character
  const handleSaveCharacter = async () => {
    const data = currentFormRef.current;
    if (!data.name.trim()) return;

    const charData: Character = {
      id: editingCharacterId || 'char-' + Math.random().toString(36).substring(2, 10),
      name: data.name.trim(),
      description: data.description.trim(),
      greeting: data.greeting.trim(),
      greetingEnabled: data.greetingEnabled,
      folderId: data.folderId,
      avatar: data.avatar || 'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100" viewBox="0 0 24 24" fill="%238b5cf6"><circle cx="12" cy="8" r="4"/><path d="M4 20c0-4 4-6 8-6s8 2 8 6"/></svg>',
      avatarOffset: data.avatarOffset,
      chatBackground: data.chatBackground,
      chatBackgroundOffset: data.chatBackgroundOffset,
      emotions: data.emotions,
      createdAt: editingCharacterId ? (await db.characters.get(editingCharacterId))?.createdAt || Date.now() : Date.now(),
      updatedAt: Date.now(),
    };

    await db.characters.put(charData);
    setShowEditModal(false);
    onDirtyChange(false);
  };

  // Delete Character
  const handleDeleteCharacter = async (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (window.confirm(t.confirmDeleteCharacter)) {
      const associatedChats = await db.chats.where('targetId').equals(id).toArray();
      for (const chat of associatedChats) {
        await db.messages.where('chatId').equals(chat.id).delete();
        await db.memoryNodes.where('chatId').equals(chat.id).delete();
        await db.memoryEdges.where('chatId').equals(chat.id).delete();
        await db.chats.delete(chat.id);
      }
      await db.characters.delete(id);
    }
  };

  // Create Folder
  const handleCreateFolder = async () => {
    if (!newFolderName.trim()) return;
    const folder: Folder = {
      id: 'fld-' + Math.random().toString(36).substring(2, 9),
      name: newFolderName.trim(),
      createdAt: Date.now(),
    };
    await db.folders.put(folder);
    setNewFolderName('');
    setShowFolderModal(false);
    setSelectedFolderId(folder.id);
  };

  // Delete Folder
  const handleDeleteFolder = async (folderId: string, folderName: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (window.confirm(t.confirmDeleteFolder.replace('{name}', folderName))) {
      const charsInFolder = await db.characters.where('folderId').equals(folderId).toArray();
      for (const c of charsInFolder) {
        await db.characters.update(c.id, { folderId: null });
      }
      const allGroups = await db.groups.toArray();
      for (const g of allGroups) {
        if (g.folderIds && g.folderIds.includes(folderId)) {
          await db.groups.update(g.id, {
            folderIds: g.folderIds.filter((id) => id !== folderId),
          });
        }
      }
      await db.folders.delete(folderId);
      if (selectedFolderId === folderId) {
        setSelectedFolderId(null);
      }
    }
  };

  // Emotion handlers
  const handleAddEmotionPreset = (name: string, label: string) => {
    const newEm: CharacterEmotion = {
      id: 'emo-' + Math.random().toString(36).substring(2, 9),
      name,
      label,
      avatar: '',
    };
    const next = [...emotions, newEm];
    setEmotions(next);
    syncFormRef({ emotions: next });
  };

  const handleRemoveEmotion = (id: string) => {
    const next = emotions.filter((e) => e.id !== id);
    setEmotions(next);
    syncFormRef({ emotions: next });
  };

  const handleEmotionFileSelect = (e: React.ChangeEvent<HTMLInputElement>, emotionId: string) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (event) => {
      const result = event.target?.result as string;
      setCropperRawSrc(result);
      setCropperIsAvatar(true);
      setActiveEmotionCropperId(emotionId);
      setCropperOpen(true);
    };
    reader.readAsDataURL(file);
    e.target.value = '';
  };

  const handleRepositionEmotion = (em: CharacterEmotion) => {
    if (!em.avatar) return;
    setCropperRawSrc(em.avatar);
    setCropperIsAvatar(true);
    setActiveEmotionCropperId(em.id);
    setCropperOpen(true);
  };

  // Image Upload handler
  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>, isAvatarTarget: boolean) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (event) => {
      const result = event.target?.result as string;
      setCropperRawSrc(result);
      setCropperIsAvatar(isAvatarTarget);
      if (isAvatarTarget) {
        setAvatarOffset({ x: 0, y: 0, scale: 1 });
      } else {
        setChatBackgroundOffset({ x: 0, y: 0, scale: 1 });
      }
      setActiveEmotionCropperId(null);
      setCropperOpen(true);
    };
    reader.readAsDataURL(file);
    e.target.value = '';
  };

  const handleRepositionExisting = (isAvatarTarget: boolean) => {
    const src = isAvatarTarget ? avatar : chatBackground;
    if (!src) return;
    setCropperRawSrc(src);
    setCropperIsAvatar(isAvatarTarget);
    setActiveEmotionCropperId(null);
    setCropperOpen(true);
  };

  // AI Generator with @ mentions
  const handleConceptChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const val = e.target.value;
    setGenConcept(val);

    const lastAt = val.lastIndexOf('@');
    if (lastAt !== -1 && lastAt >= val.length - 15) {
      const query = val.slice(lastAt + 1);
      setMentionQuery(query);
      setShowMentionDropdown(true);
    } else {
      setShowMentionDropdown(false);
    }
  };

  const handleSelectMention = (entityName: string) => {
    if (!mentionQuery && mentionQuery !== '') return;
    const lastAt = genConcept.lastIndexOf('@');
    const before = genConcept.slice(0, lastAt);
    setGenConcept(`${before}@${entityName} `);
    setShowMentionDropdown(false);
  };

  const handleRunAiGenerator = async () => {
    if (!effectiveApiKey || (!effectiveApiKey.key.trim() && !isLocal)) {
      alert(language === 'ru' ? 'Сначала настройте подключение к ИИ во вкладке Настройки.' : 'Please configure AI connection in the Settings tab first.');
      return;
    }
    setIsGenerating(true);

    try {
      // Gather lore of any @mentioned characters or groups
      let contextLore = '';
      for (const c of characters) {
        if (genConcept.includes(`@${c.name}`)) {
          contextLore += `Character [${c.name}]: ${c.description}\n`;
        }
      }
      for (const g of groups) {
        if (genConcept.includes(`@${g.name}`)) {
          contextLore += `Group [${g.name}]: ${g.description}\n`;
        }
      }

      const generated = await generatePersonaWithAI(
        effectiveApiKey,
        effectiveModel,
        genConcept,
        genDo,
        genDont,
        genPhotoRef,
        contextLore,
        language
      );

      setName(generated.name);
      setDescription(generated.description);
      setGreeting(generated.greeting);
      setGreetingEnabled(true);
      syncFormRef({
        name: generated.name,
        description: generated.description,
        greeting: generated.greeting,
        greetingEnabled: true,
      });

      if (genPhotoRef && !avatar) {
        setAvatar(genPhotoRef);
        syncFormRef({ avatar: genPhotoRef });
      }
      setShowGeneratorModal(false);
    } catch (err: any) {
      alert(language === 'ru' ? `Ошибка генерации: ${err.message}` : `Generation failed: ${err.message}`);
    } finally {
      setIsGenerating(false);
    }
  };

  // Filtered list
  const filteredCharacters = characters.filter((c) => {
    if (!selectedFolderId) return true;
    if (selectedFolderId === 'none') return !c.folderId;
    return c.folderId === selectedFolderId;
  });

  return (
    <div className="flex flex-col h-full overflow-hidden bg-silk-950 text-slate-100">
      {/* Top Action Header */}
      <div className="p-4 border-b border-silk-800/80 bg-silk-900/60 backdrop-blur-md space-y-3">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-xl font-bold tracking-tight text-white flex items-center gap-2">
              <span>{t.navCharacters}</span>
              <span className="text-xs px-2 py-0.5 rounded-full bg-silk-800 text-slate-400 font-normal">
                {characters.length}
              </span>
            </h1>
          </div>

          <button
            onClick={handleOpenCreate}
            type="button"
            className="flex items-center gap-2 px-4 py-2 bg-gradient-to-r from-violet-600 to-indigo-600 hover:from-violet-500 hover:to-indigo-500 text-white rounded-xl text-xs font-semibold shadow-lg shadow-indigo-600/30 active:scale-95 transition-all"
          >
            <Plus className="w-4 h-4" />
            <span>{t.createCharacter}</span>
          </button>
        </div>

        {/* Folder Navigation Pills */}
        <div className="flex items-center gap-2 overflow-x-auto no-scrollbar py-1">
          <button
            onClick={() => setSelectedFolderId(null)}
            type="button"
            className={`px-3 py-1.5 rounded-lg text-xs font-medium whitespace-nowrap transition-all ${
              selectedFolderId === null
                ? 'bg-violet-600 text-white shadow-md'
                : 'bg-silk-800/80 text-slate-400 hover:text-white'
            }`}
          >
            {t.allFolders}
          </button>

          <button
            onClick={() => setSelectedFolderId('none')}
            type="button"
            className={`px-3 py-1.5 rounded-lg text-xs font-medium whitespace-nowrap transition-all ${
              selectedFolderId === 'none'
                ? 'bg-violet-600 text-white shadow-md'
                : 'bg-silk-800/80 text-slate-400 hover:text-white'
            }`}
          >
            {t.noFolder}
          </button>

          {folders.map((f) => (
            <div
              key={f.id}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium whitespace-nowrap transition-all ${
                selectedFolderId === f.id
                  ? 'bg-violet-600 text-white shadow-md'
                  : 'bg-silk-800/80 text-slate-400 hover:text-white'
              }`}
            >
              <button
                type="button"
                onClick={() => setSelectedFolderId(f.id)}
                className="flex items-center gap-1.5"
              >
                <FolderIcon className="w-3.5 h-3.5" />
                <span>{f.name}</span>
              </button>
              <button
                type="button"
                onClick={(e) => handleDeleteFolder(f.id, f.name, e)}
                title={t.deleteFolder}
                className="ml-0.5 p-0.5 rounded hover:bg-black/20 text-slate-400 hover:text-rose-400"
              >
                <X className="w-3 h-3" />
              </button>
            </div>
          ))}

          <button
            onClick={() => setShowFolderModal(true)}
            type="button"
            className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs font-medium bg-silk-800/40 border border-dashed border-silk-700 text-slate-400 hover:text-violet-400 hover:border-violet-500 whitespace-nowrap"
          >
            <FolderPlus className="w-3.5 h-3.5" />
            <span>{t.newFolder}</span>
          </button>
        </div>
      </div>

      {/* Character Cards List */}
      <div className="flex-1 overflow-y-auto p-4 space-y-3 pb-28">
        {filteredCharacters.length === 0 ? (
          <div className="h-64 flex flex-col items-center justify-center text-center p-6 border border-dashed border-silk-800 rounded-2xl">
            <Sparkles className="w-8 h-8 text-violet-400/60 mb-2" />
            <h3 className="font-semibold text-slate-300 text-sm">{t.emptyCharactersTitle}</h3>
            <p className="text-xs text-slate-500 mt-1 max-w-xs">{t.emptyCharactersSubtitle}</p>
          </div>
        ) : (
          filteredCharacters.map((char) => {
            const folder = folders.find((f) => f.id === char.folderId);
            return (
              <div
                key={char.id}
                onClick={() => onOpenChat(char.id)}
                className="group relative flex items-center gap-3.5 p-3 rounded-2xl bg-silk-900/80 border border-silk-800/80 hover:border-violet-500/50 shadow-md hover:shadow-violet-500/10 transition-all cursor-pointer select-none active:scale-[0.99]"
              >
                {/* Avatar with offset */}
                <div className="relative w-14 h-14 rounded-2xl overflow-hidden shrink-0 border border-silk-700/60 bg-silk-800">
                  <AvatarImage
                    src={char.avatar}
                    alt={char.name}
                    className="w-full h-full object-cover"
                  />
                </div>

                {/* Details */}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <h3 className="font-semibold text-sm text-white truncate">{char.name}</h3>
                    {folder && (
                      <span className="px-2 py-0.5 rounded-md bg-silk-800 text-[10px] text-violet-400 font-medium shrink-0">
                        {folder.name}
                      </span>
                    )}
                  </div>
                  <p className="text-xs text-slate-400 line-clamp-2 mt-0.5 leading-relaxed">
                    {char.description}
                  </p>
                </div>

                {/* Actions */}
                <div className="flex items-center gap-1 shrink-0">
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      handleOpenEdit(char);
                    }}
                    type="button"
                    className="p-2 text-slate-400 hover:text-white rounded-xl hover:bg-silk-800"
                    title={t.editCharacter}
                  >
                    <Edit2 className="w-4 h-4" />
                  </button>
                  <button
                    onClick={(e) => handleDeleteCharacter(char.id, e)}
                    type="button"
                    className="p-2 text-slate-400 hover:text-rose-400 rounded-xl hover:bg-silk-800"
                    title={t.deleteCharacter}
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                  <div className="p-2 text-violet-400 group-hover:translate-x-0.5 transition-transform">
                    <MessageSquare className="w-4 h-4" />
                  </div>
                </div>
              </div>
            );
          })
        )}
      </div>

      {/* Folder Creation Modal */}
      {showFolderModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-md">
          <div className="w-full max-w-xs bg-silk-900 border border-silk-700 rounded-2xl p-4 shadow-2xl space-y-4">
            <h3 className="text-sm font-semibold text-white">{t.newFolder}</h3>
            <input
              type="text"
              value={newFolderName}
              onChange={(e) => setNewFolderName(e.target.value)}
              placeholder={t.folderNamePlaceholder}
              className="w-full px-3 py-2 bg-silk-800 border border-silk-700 rounded-xl text-xs text-white placeholder-slate-500 focus:outline-none focus:border-violet-500"
              autoFocus
            />
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setShowFolderModal(false)}
                type="button"
                className="px-3 py-1.5 text-xs text-slate-400 hover:text-white rounded-lg"
              >
                {t.cancel}
              </button>
              <button
                onClick={handleCreateFolder}
                type="button"
                className="px-4 py-1.5 text-xs font-medium text-white bg-violet-600 hover:bg-violet-500 rounded-lg"
              >
                {t.save}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Character Create/Edit Full Modal */}
      {showEditModal && (
        <div className="fixed inset-0 z-40 bg-silk-950 flex flex-col overflow-hidden animate-fade-in">
          {/* Header */}
          <div className="flex items-center justify-between px-4 py-3.5 border-b border-silk-800 bg-silk-900/90 backdrop-blur-md shrink-0">
            <h2 className="text-base font-bold text-white">
              {editingCharacterId ? t.editCharacter : t.createCharacter}
            </h2>
            <div className="flex items-center gap-2">
              <button
                onClick={handleSaveCharacter}
                type="button"
                className="flex items-center gap-1.5 px-3.5 py-1.5 bg-violet-600 hover:bg-violet-500 text-white rounded-xl text-xs font-semibold shadow-md active:scale-95 transition-all"
              >
                <Check className="w-4 h-4" />
                <span>{t.save}</span>
              </button>
              <button
                onClick={handleCloseModal}
                className="p-1.5 text-slate-400 hover:text-white rounded-lg hover:bg-silk-800"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
          </div>

          {/* Form Body */}
          <div className="flex-1 overflow-y-auto p-4 space-y-5 pb-32">
            {/* Visual Media Section (Avatar & Chat Background) */}
            <div className="grid grid-cols-2 gap-3">
              {/* Avatar Box */}
              <div className="flex flex-col items-center p-3 rounded-2xl bg-silk-900 border border-silk-800/80">
                <span className="text-[11px] font-medium text-slate-400 mb-2">{t.avatarImage}</span>
                <div className="relative w-20 h-20 rounded-2xl overflow-hidden border border-silk-700 bg-silk-800 mb-2">
                  {avatar ? (
                    <img
                      src={avatar}
                      alt="Avatar"
                      className="w-full h-full object-cover"
                    />
                  ) : (
                    <div className="w-full h-full flex items-center justify-center text-slate-500">
                      <Camera className="w-6 h-6" />
                    </div>
                  )}
                </div>
                <div className="flex items-center gap-1.5">
                  <label className="flex items-center gap-1 px-2.5 py-1 rounded-lg bg-silk-800 hover:bg-silk-700 text-[11px] text-violet-400 font-medium cursor-pointer">
                    <span>{avatar ? (language === 'ru' ? 'Сменить' : 'Change') : t.uploadAndPosition}</span>
                    <input
                      type="file"
                      accept="image/*"
                      onChange={(e) => handleFileSelect(e, true)}
                      className="hidden"
                    />
                  </label>
                  {avatar && (
                    <button
                      type="button"
                      onClick={() => handleRepositionExisting(true)}
                      className="px-2 py-1 rounded-lg bg-silk-800 hover:bg-silk-700 text-[11px] text-slate-300 font-medium"
                    >
                      {t.reposition}
                    </button>
                  )}
                </div>
              </div>

              {/* Chat Background Box */}
              <div className="flex flex-col items-center p-3 rounded-2xl bg-silk-900 border border-silk-800/80">
                <span className="text-[11px] font-medium text-slate-400 mb-2">{t.chatBackgroundImage}</span>
                <div className="relative w-20 h-20 rounded-2xl overflow-hidden border border-silk-700 bg-silk-800 mb-2">
                  {chatBackground ? (
                    <img
                      src={chatBackground}
                      alt="Background"
                      className="w-full h-full object-cover"
                    />
                  ) : (
                    <div className="w-full h-full flex items-center justify-center text-slate-500">
                      <ImageIcon className="w-6 h-6" />
                    </div>
                  )}
                </div>
                <div className="flex items-center gap-1.5">
                  <label className="flex items-center gap-1 px-2.5 py-1 rounded-lg bg-silk-800 hover:bg-silk-700 text-[11px] text-violet-400 font-medium cursor-pointer">
                    <span>{chatBackground ? (language === 'ru' ? 'Сменить' : 'Change') : t.uploadAndPosition}</span>
                    <input
                      type="file"
                      accept="image/*"
                      onChange={(e) => handleFileSelect(e, false)}
                      className="hidden"
                    />
                  </label>
                  {chatBackground && (
                    <button
                      type="button"
                      onClick={() => handleRepositionExisting(false)}
                      className="px-2 py-1 rounded-lg bg-silk-800 hover:bg-silk-700 text-[11px] text-slate-300 font-medium"
                    >
                      {t.reposition}
                    </button>
                  )}
                </div>
              </div>
            </div>

            {/* AI Generator trigger banner */}
            <button
              onClick={() => setShowGeneratorModal(true)}
              type="button"
              className="w-full flex items-center justify-between p-3.5 rounded-2xl bg-gradient-to-r from-violet-950/60 via-indigo-950/40 to-silk-900 border border-violet-800/40 shadow-lg text-left group"
            >
              <div className="flex items-center gap-3">
                <div className="p-2 rounded-xl bg-violet-600/20 text-violet-400">
                  <Sparkles className="w-5 h-5" />
                </div>
                <div>
                  <h4 className="text-xs font-semibold text-violet-200">{t.generateWithAI}</h4>
                  <p className="text-[11px] text-slate-400">
                    {language === 'ru'
                      ? 'Автоматическое создание характера, лора и первой реплики с поддержкой @ упоминаний'
                      : 'Auto-create detailed personality, lore, and greeting with @ mentions'}
                  </p>
                </div>
              </div>
              <ChevronRight className="w-4 h-4 text-violet-400 group-hover:translate-x-1 transition-transform" />
            </button>

            {/* Manual Fields */}
            <div className="space-y-4">
              <div>
                <label className="block text-xs font-semibold text-slate-300 mb-1.5">{t.charName}</label>
                <input
                  type="text"
                  value={name}
                  onChange={(e) => {
                    setName(e.target.value);
                    syncFormRef({ name: e.target.value });
                  }}
                  placeholder={t.charNamePlaceholder}
                  className="w-full px-3.5 py-2.5 bg-silk-900 border border-silk-800 rounded-xl text-sm text-white placeholder-slate-500 focus:outline-none focus:border-violet-500"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-300 mb-1.5">{t.charDescription}</label>
                <textarea
                  rows={5}
                  value={description}
                  onChange={(e) => {
                    setDescription(e.target.value);
                    syncFormRef({ description: e.target.value });
                  }}
                  placeholder={t.charDescriptionPlaceholder}
                  className="w-full px-3.5 py-2.5 bg-silk-900 border border-silk-800 rounded-xl text-xs text-white placeholder-slate-500 focus:outline-none focus:border-violet-500 leading-relaxed resize-none"
                />
              </div>

              {/* First greeting message & toggle */}
              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <label className="text-xs font-semibold text-slate-300">{t.charGreeting}</label>
                  <label className="flex items-center gap-1.5 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={greetingEnabled}
                      onChange={(e) => {
                        setGreetingEnabled(e.target.checked);
                        syncFormRef({ greetingEnabled: e.target.checked });
                      }}
                      className="accent-violet-600 rounded"
                    />
                    <span className="text-[11px] text-slate-400">{t.greetingEnabled}</span>
                  </label>
                </div>
                <textarea
                  rows={3}
                  disabled={!greetingEnabled}
                  value={greeting}
                  onChange={(e) => {
                    setGreeting(e.target.value);
                    syncFormRef({ greeting: e.target.value });
                  }}
                  placeholder={t.charGreetingPlaceholder}
                  className={`w-full px-3.5 py-2.5 bg-silk-900 border border-silk-800 rounded-xl text-xs text-white placeholder-slate-500 focus:outline-none focus:border-violet-500 leading-relaxed resize-none ${
                    !greetingEnabled ? 'opacity-40 cursor-not-allowed' : ''
                  }`}
                />
              </div>

              {/* Folder Selector */}
              <div>
                <label className="block text-xs font-semibold text-slate-300 mb-1.5">{t.charFolder}</label>
                <select
                  value={folderId || ''}
                  onChange={(e) => {
                    const fVal = e.target.value || null;
                    setFolderId(fVal);
                    syncFormRef({ folderId: fVal });
                  }}
                  className="w-full px-3.5 py-2.5 bg-silk-900 border border-silk-800 rounded-xl text-xs text-white focus:outline-none focus:border-violet-500"
                >
                  <option value="">{t.noFolder}</option>
                  {folders.map((f) => (
                    <option key={f.id} value={f.id}>
                      {f.name}
                    </option>
                  ))}
                </select>
              </div>

              {/* Character Emotions Section */}
              <div className="p-4 rounded-2xl bg-silk-900/90 border border-silk-800 space-y-3 mt-4">
                <div className="flex items-center justify-between">
                  <div>
                    <h3 className="text-xs font-bold text-slate-200 flex items-center gap-1.5">
                      <Smile className="w-4 h-4 text-violet-400" />
                      <span>{t.emotionsSection}</span>
                    </h3>
                    <p className="text-[11px] text-slate-400 mt-0.5">{t.emotionsSectionDesc}</p>
                  </div>
                </div>

                {/* Preset Buttons */}
                <div className="flex flex-wrap gap-1.5 pt-1">
                  {[
                    { name: 'neutral', label: t.emotionNeutral },
                    { name: 'happy', label: t.emotionHappy },
                    { name: 'angry', label: t.emotionAngry },
                    { name: 'sad', label: t.emotionSad },
                    { name: 'blushing', label: t.emotionBlushing },
                    { name: 'smirk', label: t.emotionSmirk },
                    { name: 'surprised', label: t.emotionSurprised },
                    { name: 'thoughtful', label: t.emotionThoughtful },
                  ].map((preset) => {
                    const alreadyAdded = emotions.some((e) => e.name === preset.name);
                    return (
                      <button
                        key={preset.name}
                        type="button"
                        disabled={alreadyAdded}
                        onClick={() => handleAddEmotionPreset(preset.name, preset.label)}
                        className={`px-2.5 py-1 rounded-lg text-[11px] font-medium border transition-all ${
                          alreadyAdded
                            ? 'opacity-40 border-silk-800 text-slate-500 cursor-default'
                            : 'bg-silk-800 hover:bg-silk-700 border-silk-700 text-slate-300 hover:text-white active:scale-95'
                        }`}
                      >
                        + {preset.label}
                      </button>
                    );
                  })}
                </div>

                {/* Emotion Sprites List */}
                {emotions.length > 0 && (
                  <div className="space-y-2.5 pt-2">
                    {emotions.map((em) => (
                      <div
                        key={em.id}
                        className="p-3 rounded-xl bg-silk-850 border border-silk-800 space-y-2.5 shadow-sm"
                      >
                        {/* Top row: Avatar + Details + Delete */}
                        <div className="flex items-center gap-3">
                          <div className="relative w-12 h-12 rounded-xl overflow-hidden bg-silk-800 border border-silk-700 shrink-0">
                            {em.avatar ? (
                              <img src={em.avatar} alt={em.label || em.name} className="w-full h-full object-cover" />
                            ) : (
                              <div className="w-full h-full flex items-center justify-center text-slate-500">
                                <Smile className="w-5 h-5 text-slate-600" />
                              </div>
                            )}
                          </div>

                          <div className="flex-1 min-w-0">
                            <span className="text-xs font-bold text-white truncate block">
                              {em.label || em.name}
                            </span>
                            <span className="text-[10px] text-violet-400 font-mono truncate block mt-0.5">
                              &lt;emotion&gt;{em.name}&lt;/emotion&gt;
                            </span>
                          </div>

                          <button
                            onClick={() => handleRemoveEmotion(em.id)}
                            type="button"
                            className="p-2 text-slate-400 hover:text-rose-400 rounded-lg hover:bg-silk-800 shrink-0 transition-colors"
                            title={t.removeEmotion}
                          >
                            <Trash2 className="w-4 h-4" />
                          </button>
                        </div>

                        {/* Bottom action row: Upload / Change & Reposition buttons */}
                        <div className="flex items-center gap-2 pt-1 border-t border-silk-800/80">
                          <label className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2 rounded-xl bg-silk-800 hover:bg-silk-700 border border-silk-700/80 text-xs text-violet-300 font-medium cursor-pointer transition-all active:scale-95">
                            <Camera className="w-3.5 h-3.5" />
                            <span>{em.avatar ? (language === 'ru' ? 'Сменить фото' : 'Change Image') : t.uploadEmotionAvatar}</span>
                            <input
                              type="file"
                              accept="image/*"
                              onChange={(e) => handleEmotionFileSelect(e, em.id)}
                              className="hidden"
                            />
                          </label>
                          {em.avatar && (
                            <button
                              type="button"
                              onClick={() => handleRepositionEmotion(em)}
                              className="px-3 py-2 rounded-xl bg-silk-800 hover:bg-silk-700 border border-silk-700/80 text-xs text-slate-300 font-medium transition-all active:scale-95 shrink-0"
                            >
                              {t.reposition}
                            </button>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* AI Generator Modal */}
      {showGeneratorModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/85 backdrop-blur-md animate-fade-in">
          <div className="w-full max-w-sm max-h-[90vh] bg-silk-900 border border-silk-700 rounded-2xl flex flex-col overflow-hidden shadow-2xl">
            {/* Header */}
            <div className="flex items-center justify-between px-4 py-3 border-b border-silk-800">
              <div className="flex items-center gap-2">
                <Sparkles className="w-4 h-4 text-violet-400" />
                <h3 className="font-semibold text-sm text-white">{t.generatorTitle}</h3>
              </div>
              <button
                onClick={() => setShowGeneratorModal(false)}
                className="p-1 text-slate-400 hover:text-white rounded-lg"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {/* Content */}
            <div className="flex-1 overflow-y-auto p-4 space-y-4">
              {/* Concept textarea with @ mention helper */}
              <div className="relative">
                <label className="block text-xs font-medium text-slate-300 mb-1">
                  {t.generatorConcept}
                </label>
                <textarea
                  rows={3}
                  value={genConcept}
                  onChange={handleConceptChange}
                  placeholder={t.generatorConceptPlaceholder}
                  className="w-full px-3 py-2 bg-silk-800 border border-silk-700 rounded-xl text-xs text-white placeholder-slate-500 focus:outline-none focus:border-violet-500 resize-none"
                />

                {/* @ Mention Autocomplete dropdown */}
                {showMentionDropdown && (
                  <div className="absolute left-0 right-0 top-full mt-1 z-20 bg-silk-850 border border-silk-700 rounded-xl shadow-2xl overflow-hidden max-h-36 overflow-y-auto text-xs">
                    <div className="p-2 text-[10px] uppercase font-semibold text-slate-400 border-b border-silk-800">
                      Link Companion or Group Lore
                    </div>
                    {characters.map((c) => (
                      <button
                        key={c.id}
                        onClick={() => handleSelectMention(c.name)}
                        type="button"
                        className="w-full flex items-center gap-2 px-3 py-1.5 hover:bg-silk-700 text-left text-slate-200"
                      >
                        <AtSign className="w-3 h-3 text-violet-400" />
                        <span className="font-medium">{c.name}</span>
                        <span className="text-[10px] text-slate-500">Character</span>
                      </button>
                    ))}
                    {groups.map((g) => (
                      <button
                        key={g.id}
                        onClick={() => handleSelectMention(g.name)}
                        type="button"
                        className="w-full flex items-center gap-2 px-3 py-1.5 hover:bg-silk-700 text-left text-slate-200"
                      >
                        <AtSign className="w-3 h-3 text-emerald-400" />
                        <span className="font-medium">{g.name}</span>
                        <span className="text-[10px] text-slate-500">Group</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-300 mb-1">{t.generatorDo}</label>
                <input
                  type="text"
                  value={genDo}
                  onChange={(e) => setGenDo(e.target.value)}
                  placeholder={t.generatorDoPlaceholder}
                  className="w-full px-3 py-2 bg-silk-800 border border-silk-700 rounded-xl text-xs text-white placeholder-slate-500 focus:outline-none focus:border-violet-500"
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-300 mb-1">{t.generatorDont}</label>
                <input
                  type="text"
                  value={genDont}
                  onChange={(e) => setGenDont(e.target.value)}
                  placeholder={t.generatorDontPlaceholder}
                  className="w-full px-3 py-2 bg-silk-800 border border-silk-700 rounded-xl text-xs text-white placeholder-slate-500 focus:outline-none focus:border-violet-500"
                />
              </div>

              {/* Photo reference upload */}
              <div>
                <label className="block text-xs font-medium text-slate-300 mb-1">{t.referencePhoto}</label>
                <div className="flex items-center gap-3">
                  {genPhotoRef ? (
                    <div className="relative w-12 h-12 rounded-xl overflow-hidden border border-silk-700 shrink-0">
                      <img src={genPhotoRef} alt="Ref" className="w-full h-full object-cover" />
                      <button
                        onClick={() => setGenPhotoRef('')}
                        className="absolute top-0 right-0 p-0.5 bg-black/70 text-white"
                      >
                        <X className="w-3 h-3" />
                      </button>
                    </div>
                  ) : (
                    <label className="flex items-center gap-1.5 px-3 py-2 rounded-xl bg-silk-800 border border-dashed border-silk-700 text-xs text-slate-300 hover:text-white cursor-pointer">
                      <Camera className="w-4 h-4 text-violet-400" />
                      <span>{t.attachPhotoRef}</span>
                      <input
                        type="file"
                        accept="image/*"
                        onChange={(e) => {
                          const file = e.target.files?.[0];
                          if (!file) return;
                          const r = new FileReader();
                          r.onload = (ev) => setGenPhotoRef(ev.target?.result as string);
                          r.readAsDataURL(file);
                        }}
                        className="hidden"
                      />
                    </label>
                  )}
                </div>
              </div>
            </div>

            {/* Footer */}
            <div className="p-3 border-t border-silk-800 flex justify-end gap-2 bg-silk-900">
              <button
                onClick={() => setShowGeneratorModal(false)}
                type="button"
                className="px-3 py-1.5 text-xs text-slate-400 hover:text-white rounded-lg"
              >
                {t.cancel}
              </button>
              <button
                onClick={handleRunAiGenerator}
                disabled={isGenerating || !genConcept.trim()}
                type="button"
                className="flex items-center gap-1.5 px-4 py-2 bg-violet-600 hover:bg-violet-500 disabled:opacity-50 text-white rounded-xl text-xs font-semibold shadow-md"
              >
                <Sparkles className="w-3.5 h-3.5" />
                <span>{isGenerating ? t.generating : t.generateButton}</span>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Image Cropper Modal */}
      <ImageCropperModal
        isOpen={cropperOpen}
        imageSrc={cropperRawSrc}
        isAvatar={cropperIsAvatar}
        initialOffset={cropperIsAvatar ? avatarOffset : chatBackgroundOffset}
        language={language}
        onConfirm={(croppedUrl, offset) => {
          if (activeEmotionCropperId) {
            const next = emotions.map((em) =>
              em.id === activeEmotionCropperId ? { ...em, avatar: croppedUrl } : em
            );
            setEmotions(next);
            syncFormRef({ emotions: next });
            setActiveEmotionCropperId(null);
          } else if (cropperIsAvatar) {
            setAvatar(croppedUrl);
            setAvatarOffset(offset);
            syncFormRef({ avatar: croppedUrl, avatarOffset: offset });
          } else {
            setChatBackground(croppedUrl);
            setChatBackgroundOffset(offset);
            syncFormRef({ chatBackground: croppedUrl, chatBackgroundOffset: offset });
          }
        }}
        onClose={() => setCropperOpen(false)}
      />
    </div>
  );
};
