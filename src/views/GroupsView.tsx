import React, { useState, useRef, useEffect } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import {
  Plus,
  Folder as FolderIcon,
  MessageSquare,
  Edit2,
  Trash2,
  Users,
  X,
  Check,
  Sparkles,
  Camera,
  Image as ImageIcon,
  ChevronRight,
  Shield,
} from 'lucide-react';
import { db } from '../db';
import type { Group, ImageCropOffset, Language } from '../types';
import { translations } from '../i18n';
import { ImageCropperModal } from '../components/ImageCropperModal';
import { generateGroupWithAI, generateGroupRolesWithAI } from '../services/ai';

interface GroupsViewProps {
  language: Language;
  onOpenGroupChat: (groupId: string) => void;
  onDirtyChange: (dirty: boolean, saveAction?: () => Promise<void>) => void;
}

export const GroupsView: React.FC<GroupsViewProps> = ({
  language,
  onOpenGroupChat,
  onDirtyChange,
}) => {
  const t = translations[language];

  const groups = useLiveQuery(() => db.groups.orderBy('createdAt').reverse().toArray()) || [];
  const characters = useLiveQuery(() => db.characters.toArray()) || [];
  const folders = useLiveQuery(() => db.folders.toArray()) || [];
  const activeApiKey = useLiveQuery(() => db.apiKeys.filter((k) => k.isActive).first());
  const settings = useLiveQuery(() => db.settings.get('default'));

  const [showEditModal, setShowEditModal] = useState(false);
  const [editingGroupId, setEditingGroupId] = useState<string | null>(null);

  // Form fields
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [backstory, setBackstory] = useState('');
  const [backstoryEnabled, setBackstoryEnabled] = useState(true);
  const [avatar, setAvatar] = useState('');
  const [avatarOffset, setAvatarOffset] = useState<ImageCropOffset>({ x: 0, y: 0, scale: 1 });
  const [chatBackground, setChatBackground] = useState('');
  const [chatBackgroundOffset, setChatBackgroundOffset] = useState<ImageCropOffset>({ x: 0, y: 0, scale: 1 });
  const [selectedCharIds, setSelectedCharIds] = useState<string[]>([]);
  const [characterRoles, setCharacterRoles] = useState<Record<string, string>>({});
  const [selectedFolderIds, setSelectedFolderIds] = useState<string[]>([]);

  // Synchronous form ref to prevent stale closures
  const currentFormRef = useRef({
    name: '',
    description: '',
    backstory: '',
    backstoryEnabled: true,
    avatar: '',
    avatarOffset: { x: 0, y: 0, scale: 1 } as ImageCropOffset,
    chatBackground: '',
    chatBackgroundOffset: { x: 0, y: 0, scale: 1 } as ImageCropOffset,
    characterIds: [] as string[],
    characterRoles: {} as Record<string, string>,
    folderIds: [] as string[],
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

  // AI Group Generator modal state
  const [showGenModal, setShowGenModal] = useState(false);
  const [genConcept, setGenConcept] = useState('');
  const [isGeneratingGroup, setIsGeneratingGroup] = useState(false);
  const [isGeneratingRoles, setIsGeneratingRoles] = useState(false);

  const handleOpenCreate = () => {
    setEditingGroupId(null);
    setName('');
    setDescription('');
    setBackstory('');
    setBackstoryEnabled(true);
    setAvatar('');
    setAvatarOffset({ x: 0, y: 0, scale: 1 });
    setChatBackground('');
    setChatBackgroundOffset({ x: 0, y: 0, scale: 1 });
    setSelectedCharIds([]);
    setCharacterRoles({});
    setSelectedFolderIds([]);
    syncFormRef({
      name: '',
      description: '',
      backstory: '',
      backstoryEnabled: true,
      avatar: '',
      avatarOffset: { x: 0, y: 0, scale: 1 },
      chatBackground: '',
      chatBackgroundOffset: { x: 0, y: 0, scale: 1 },
      characterIds: [],
      characterRoles: {},
      folderIds: [],
    });
    setShowEditModal(true);
  };

  const handleOpenEdit = (grp: Group) => {
    setEditingGroupId(grp.id);
    setName(grp.name);
    setDescription(grp.description);
    setBackstory(grp.backstory || '');
    setBackstoryEnabled(grp.backstoryEnabled);
    setAvatar(grp.avatar || '');
    setAvatarOffset(grp.avatarOffset || { x: 0, y: 0, scale: 1 });
    setChatBackground(grp.chatBackground || '');
    setChatBackgroundOffset(grp.chatBackgroundOffset || { x: 0, y: 0, scale: 1 });
    setSelectedCharIds(grp.characterIds || []);
    setCharacterRoles(grp.characterRoles || {});
    setSelectedFolderIds(grp.folderIds || []);
    syncFormRef({
      name: grp.name,
      description: grp.description,
      backstory: grp.backstory || '',
      backstoryEnabled: grp.backstoryEnabled,
      avatar: grp.avatar || '',
      avatarOffset: grp.avatarOffset || { x: 0, y: 0, scale: 1 },
      chatBackground: grp.chatBackground || '',
      chatBackgroundOffset: grp.chatBackgroundOffset || { x: 0, y: 0, scale: 1 },
      characterIds: grp.characterIds || [],
      characterRoles: grp.characterRoles || {},
      folderIds: grp.folderIds || [],
    });
    setShowEditModal(true);
  };

  const handleCloseModal = () => {
    setShowEditModal(false);
    onDirtyChange(false);
  };

  const handleToggleChar = (charId: string) => {
    setSelectedCharIds((prev) => {
      const next = prev.includes(charId) ? prev.filter((id) => id !== charId) : [...prev, charId];
      syncFormRef({ characterIds: next });
      return next;
    });
    onDirtyChange(true, handleSaveGroup);
  };

  const handleToggleFolder = (fldId: string) => {
    setSelectedFolderIds((prevFolders) => {
      const isSelected = prevFolders.includes(fldId);
      const nextFolders = isSelected ? prevFolders.filter((id) => id !== fldId) : [...prevFolders, fldId];
      const charsInFolder = characters.filter((c) => c.folderId === fldId).map((c) => c.id);

      setSelectedCharIds((prevChars) => {
        const nextChars = isSelected
          ? prevChars
          : Array.from(new Set([...prevChars, ...charsInFolder]));
        syncFormRef({ folderIds: nextFolders, characterIds: nextChars });
        return nextChars;
      });

      return nextFolders;
    });
    onDirtyChange(true, handleSaveGroup);
  };

  const handleRoleChange = (charId: string, role: string) => {
    setCharacterRoles((prev) => {
      const next = { ...prev, [charId]: role };
      syncFormRef({ characterRoles: next });
      return next;
    });
    onDirtyChange(true, handleSaveGroup);
  };

  const handleGenerateRolesWithAI = async () => {
    if (!activeApiKey || !activeApiKey.key.trim()) {
      alert(language === 'ru' ? 'Настройте API ключ в Настройках.' : 'Configure API key in Settings.');
      return;
    }
    const selectedChars = characters.filter((c) => currentFormRef.current.characterIds.includes(c.id));
    if (selectedChars.length === 0) {
      alert(language === 'ru' ? 'Сначала выберите участников группы.' : 'Select group members first.');
      return;
    }
    setIsGeneratingRoles(true);
    try {
      const generated = await generateGroupRolesWithAI(
        activeApiKey,
        settings?.textModel || 'deepseek/deepseek-chat',
        currentFormRef.current.name || 'Group',
        currentFormRef.current.description || '',
        selectedChars,
        language
      );
      setCharacterRoles(generated);
      syncFormRef({ characterRoles: generated });
      onDirtyChange(true, handleSaveGroup);
    } catch (err: any) {
      alert(language === 'ru' ? `Ошибка генерации ролей: ${err.message}` : `AI Roles error: ${err.message}`);
    } finally {
      setIsGeneratingRoles(false);
    }
  };

  const handleRunAiGroupGen = async () => {
    if (!activeApiKey || !activeApiKey.key.trim()) {
      alert(language === 'ru' ? 'Настройте API ключ в Настройках.' : 'Configure API key in Settings.');
      return;
    }
    if (!genConcept.trim()) return;
    setIsGeneratingGroup(true);
    try {
      const res = await generateGroupWithAI(
        activeApiKey,
        settings?.textModel || 'deepseek/deepseek-chat',
        genConcept,
        language
      );
      setName(res.name);
      setDescription(res.description);
      setBackstory(res.backstory);
      setBackstoryEnabled(true);
      syncFormRef({
        name: res.name,
        description: res.description,
        backstory: res.backstory,
        backstoryEnabled: true,
      });
      setShowGenModal(false);
      onDirtyChange(true, handleSaveGroup);
    } catch (err: any) {
      alert(language === 'ru' ? `Ошибка генерации группы: ${err.message}` : `Group generation error: ${err.message}`);
    } finally {
      setIsGeneratingGroup(false);
    }
  };

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
    setCropperOpen(true);
  };

  const handleSaveGroup = async () => {
    const data = currentFormRef.current;
    if (!data.name.trim()) return;

    const groupData: Group = {
      id: editingGroupId || 'group-' + Math.random().toString(36).substring(2, 10),
      name: data.name.trim(),
      description: data.description.trim(),
      backstory: data.backstory.trim(),
      backstoryEnabled: data.backstoryEnabled,
      avatar: data.avatar,
      avatarOffset: data.avatarOffset,
      chatBackground: data.chatBackground,
      chatBackgroundOffset: data.chatBackgroundOffset,
      characterIds: data.characterIds,
      characterRoles: data.characterRoles,
      folderIds: data.folderIds,
      createdAt: editingGroupId ? (await db.groups.get(editingGroupId))?.createdAt || Date.now() : Date.now(),
      updatedAt: Date.now(),
    };

    await db.groups.put(groupData);
    setShowEditModal(false);
    onDirtyChange(false);
  };

  const handleDeleteGroup = async (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (window.confirm(t.confirmDeleteGroup)) {
      await db.groups.delete(id);
      await db.chats.where('targetId').equals(id).delete();
    }
  };

  return (
    <div className="flex flex-col h-full overflow-hidden bg-silk-950 text-slate-100">
      {/* Top Header */}
      <div className="p-4 border-b border-silk-800/80 bg-silk-900/60 backdrop-blur-md flex items-center justify-between">
        <h1 className="text-xl font-bold tracking-tight text-white flex items-center gap-2">
          <span>{t.navGroups}</span>
          <span className="text-xs px-2 py-0.5 rounded-full bg-silk-800 text-slate-400 font-normal">
            {groups.length}
          </span>
        </h1>

        <button
          onClick={handleOpenCreate}
          type="button"
          className="flex items-center gap-2 px-4 py-2 bg-gradient-to-r from-violet-600 to-indigo-600 hover:from-violet-500 hover:to-indigo-500 text-white rounded-xl text-xs font-semibold shadow-lg shadow-indigo-600/30 active:scale-95 transition-all"
        >
          <Plus className="w-4 h-4" />
          <span>{t.createGroup}</span>
        </button>
      </div>

      {/* Group Cards List */}
      <div className="flex-1 overflow-y-auto p-4 space-y-3 pb-28">
        {groups.length === 0 ? (
          <div className="h-64 flex flex-col items-center justify-center text-center p-6 border border-dashed border-silk-800 rounded-2xl">
            <Users className="w-8 h-8 text-violet-400/60 mb-2" />
            <h3 className="font-semibold text-slate-300 text-sm">{t.emptyGroupsTitle}</h3>
            <p className="text-xs text-slate-500 mt-1 max-w-xs">{t.emptyGroupsSubtitle}</p>
          </div>
        ) : (
          groups.map((grp) => {
            const memberChars = characters.filter((c) => grp.characterIds.includes(c.id));
            return (
              <div
                key={grp.id}
                onClick={() => onOpenGroupChat(grp.id)}
                className="group relative flex flex-col p-4 rounded-2xl bg-silk-900/80 border border-silk-800/80 hover:border-violet-500/50 shadow-md hover:shadow-violet-500/10 transition-all cursor-pointer select-none active:scale-[0.99] space-y-3"
              >
                {/* Header row */}
                <div className="flex items-start gap-3">
                  {/* Group Avatar */}
                  <div className="relative w-12 h-12 rounded-xl overflow-hidden bg-silk-800 border border-silk-700 shrink-0">
                    {grp.avatar ? (
                      <img
                        src={grp.avatar}
                        alt={grp.name}
                        className="w-full h-full object-cover"
                      />
                    ) : (
                      <div className="w-full h-full flex items-center justify-center bg-violet-600/20 text-violet-400">
                        <Users className="w-6 h-6" />
                      </div>
                    )}
                  </div>

                  <div className="flex-1 min-w-0">
                    <h3 className="font-semibold text-sm text-white truncate">{grp.name}</h3>
                    <p className="text-xs text-slate-400 line-clamp-2 mt-0.5 leading-relaxed">
                      {grp.description}
                    </p>
                  </div>

                  <div className="flex items-center gap-1 shrink-0">
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        handleOpenEdit(grp);
                      }}
                      type="button"
                      className="p-1.5 text-slate-400 hover:text-white rounded-lg hover:bg-silk-800"
                    >
                      <Edit2 className="w-3.5 h-3.5" />
                    </button>
                    <button
                      onClick={(e) => handleDeleteGroup(grp.id, e)}
                      type="button"
                      className="p-1.5 text-slate-400 hover:text-rose-400 rounded-lg hover:bg-silk-800"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>

                {/* Member avatars row */}
                <div className="flex items-center justify-between pt-2 border-t border-silk-800/60">
                  <div className="flex items-center -space-x-2 overflow-hidden">
                    {memberChars.slice(0, 5).map((m) => (
                      <div
                        key={m.id}
                        className="w-7 h-7 rounded-full overflow-hidden border-2 border-silk-900 bg-silk-800 shrink-0"
                      >
                        <img src={m.avatar} alt={m.name} className="w-full h-full object-cover" />
                      </div>
                    ))}
                    {memberChars.length > 5 && (
                      <div className="w-7 h-7 rounded-full bg-silk-800 border-2 border-silk-900 flex items-center justify-center text-[10px] text-slate-300 font-medium">
                        +{memberChars.length - 5}
                      </div>
                    )}
                    {memberChars.length === 0 && (
                      <span className="text-[11px] text-slate-500">{t.noMembersSelected}</span>
                    )}
                  </div>

                  <div className="flex items-center gap-1 text-xs text-violet-400 font-medium">
                    <MessageSquare className="w-3.5 h-3.5" />
                    <span>{t.openGroupChat}</span>
                  </div>
                </div>
              </div>
            );
          })
        )}
      </div>

      {/* Group Create/Edit Modal */}
      {showEditModal && (
        <div className="fixed inset-0 z-40 bg-silk-950 flex flex-col overflow-hidden animate-fade-in">
          {/* Header */}
          <div className="flex items-center justify-between px-4 py-3.5 border-b border-silk-800 bg-silk-900/90 backdrop-blur-md shrink-0">
            <h2 className="text-base font-bold text-white">
              {editingGroupId ? t.editGroup : t.createGroup}
            </h2>
            <div className="flex items-center gap-2">
              <button
                onClick={handleSaveGroup}
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

          {/* Form */}
          <div className="flex-1 overflow-y-auto p-4 space-y-4 pb-32">
            {/* Visual Media Section (Avatar & Group Background) */}
            <div className="grid grid-cols-2 gap-3">
              {/* Group Avatar */}
              <div className="flex flex-col items-center p-3 rounded-2xl bg-silk-900 border border-silk-800/80">
                <span className="text-[11px] font-medium text-slate-400 mb-2">{t.groupAvatar}</span>
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

              {/* Group Chat Background */}
              <div className="flex flex-col items-center p-3 rounded-2xl bg-silk-900 border border-silk-800/80">
                <span className="text-[11px] font-medium text-slate-400 mb-2">{t.groupBackground}</span>
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
              onClick={() => setShowGenModal(true)}
              type="button"
              className="w-full flex items-center justify-between p-3.5 rounded-2xl bg-gradient-to-r from-violet-950/60 via-indigo-950/40 to-silk-900 border border-violet-800/40 shadow-lg text-left group"
            >
              <div className="flex items-center gap-3">
                <div className="p-2 rounded-xl bg-violet-600/20 text-violet-400">
                  <Sparkles className="w-5 h-5" />
                </div>
                <div>
                  <h4 className="text-xs font-semibold text-violet-200">{t.generateGroupAI}</h4>
                  <p className="text-[11px] text-slate-400">
                    {t.groupConceptPlaceholder}
                  </p>
                </div>
              </div>
              <ChevronRight className="w-4 h-4 text-violet-400 group-hover:translate-x-1 transition-transform" />
            </button>

            <div>
              <label className="block text-xs font-semibold text-slate-300 mb-1.5">{t.groupName}</label>
              <input
                type="text"
                value={name}
                onChange={(e) => {
                  setName(e.target.value);
                  syncFormRef({ name: e.target.value });
                  onDirtyChange(true, handleSaveGroup);
                }}
                placeholder={t.groupNamePlaceholder}
                className="w-full px-3.5 py-2.5 bg-silk-900 border border-silk-800 rounded-xl text-sm text-white placeholder-slate-500 focus:outline-none focus:border-violet-500"
              />
            </div>

            <div>
              <label className="block text-xs font-semibold text-slate-300 mb-1.5">{t.groupDescription}</label>
              <textarea
                rows={4}
                value={description}
                onChange={(e) => {
                  setDescription(e.target.value);
                  syncFormRef({ description: e.target.value });
                  onDirtyChange(true, handleSaveGroup);
                }}
                placeholder={t.groupDescriptionPlaceholder}
                className="w-full px-3.5 py-2.5 bg-silk-900 border border-silk-800 rounded-xl text-xs text-white placeholder-slate-500 focus:outline-none focus:border-violet-500 leading-relaxed resize-none"
              />
            </div>

            <div>
              <div className="flex items-center justify-between mb-1.5">
                <label className="text-xs font-semibold text-slate-300">{t.groupBackstory}</label>
                <label className="flex items-center gap-1.5 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={backstoryEnabled}
                    onChange={(e) => {
                      setBackstoryEnabled(e.target.checked);
                      syncFormRef({ backstoryEnabled: e.target.checked });
                      onDirtyChange(true, handleSaveGroup);
                    }}
                    className="accent-violet-600 rounded"
                  />
                  <span className="text-[11px] text-slate-400">{t.backstoryEnabled}</span>
                </label>
              </div>
              <textarea
                rows={3}
                disabled={!backstoryEnabled}
                value={backstory}
                onChange={(e) => {
                  setBackstory(e.target.value);
                  syncFormRef({ backstory: e.target.value });
                  onDirtyChange(true, handleSaveGroup);
                }}
                placeholder={t.groupBackstoryPlaceholder}
                className={`w-full px-3.5 py-2.5 bg-silk-900 border border-silk-800 rounded-xl text-xs text-white placeholder-slate-500 focus:outline-none focus:border-violet-500 leading-relaxed resize-none ${
                  !backstoryEnabled ? 'opacity-40 cursor-not-allowed' : ''
                }`}
              />
            </div>

            {/* Folder selection */}
            {folders.length > 0 && (
              <div>
                <label className="block text-xs font-semibold text-slate-300 mb-1.5">
                  {t.selectFolderForGroup}
                </label>
                <div className="flex flex-wrap gap-2">
                  {folders.map((f) => {
                    const isSelected = selectedFolderIds.includes(f.id);
                    return (
                      <button
                        key={f.id}
                        type="button"
                        onClick={() => handleToggleFolder(f.id)}
                        className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium border transition-all ${
                          isSelected
                            ? 'bg-violet-600/30 border-violet-500 text-violet-200'
                            : 'bg-silk-900 border-silk-800 text-slate-400 hover:text-white'
                        }`}
                      >
                        <FolderIcon className="w-3.5 h-3.5" />
                        <span>{f.name}</span>
                        {isSelected && <Check className="w-3 h-3 text-violet-400" />}
                      </button>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Character selection */}
            <div>
              <label className="block text-xs font-semibold text-slate-300 mb-1.5">
                {t.selectGroupMembers} ({selectedCharIds.length})
              </label>
              <div className="grid grid-cols-2 gap-2 max-h-56 overflow-y-auto p-1">
                {characters.map((c) => {
                  const isSelected = selectedCharIds.includes(c.id);
                  return (
                    <button
                      key={c.id}
                      type="button"
                      onClick={() => handleToggleChar(c.id)}
                      className={`flex items-center gap-2 p-2 rounded-xl border text-left transition-all ${
                        isSelected
                          ? 'bg-violet-600/20 border-violet-500/80 text-white'
                          : 'bg-silk-900 border-silk-800 text-slate-400 hover:text-white'
                      }`}
                    >
                      <div className="w-8 h-8 rounded-lg overflow-hidden bg-silk-800 shrink-0">
                        <img src={c.avatar} alt={c.name} className="w-full h-full object-cover" />
                      </div>
                      <span className="text-xs font-medium truncate flex-1">{c.name}</span>
                      {isSelected && <Check className="w-3.5 h-3.5 text-violet-400 shrink-0" />}
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Character Roles in Group */}
            {selectedCharIds.length > 0 && (
              <div className="p-4 rounded-2xl bg-silk-900/90 border border-silk-800 space-y-3 mt-4">
                <div className="flex items-center justify-between">
                  <div>
                    <h3 className="text-xs font-bold text-slate-200 flex items-center gap-1.5">
                      <Shield className="w-4 h-4 text-violet-400" />
                      <span>{t.groupRoles}</span>
                    </h3>
                    <p className="text-[11px] text-slate-400 mt-0.5">{t.groupRolesDesc}</p>
                  </div>

                  <button
                    onClick={handleGenerateRolesWithAI}
                    disabled={isGeneratingRoles}
                    type="button"
                    className="flex items-center gap-1.5 px-3 py-1.5 bg-violet-600/30 hover:bg-violet-600 border border-violet-500/50 text-violet-200 hover:text-white rounded-xl text-xs font-semibold shadow-sm active:scale-95 transition-all"
                  >
                    <Sparkles className="w-3.5 h-3.5 text-violet-400" />
                    <span>{isGeneratingRoles ? t.generatingRoles : t.generateRolesAI}</span>
                  </button>
                </div>

                <div className="space-y-2.5 pt-1">
                  {selectedCharIds.map((charId) => {
                    const char = characters.find((c) => c.id === charId);
                    if (!char) return null;
                    return (
                      <div
                        key={charId}
                        className="flex items-center gap-3 p-2 rounded-xl bg-silk-850 border border-silk-800"
                      >
                        <div className="w-8 h-8 rounded-lg overflow-hidden bg-silk-800 shrink-0 border border-silk-700">
                          <img src={char.avatar} alt={char.name} className="w-full h-full object-cover" />
                        </div>
                        <span className="text-xs font-semibold text-white w-24 truncate shrink-0">
                          {char.name}
                        </span>
                        <input
                          type="text"
                          value={characterRoles[charId] || ''}
                          onChange={(e) => handleRoleChange(charId, e.target.value)}
                          placeholder={t.charRolePlaceholder}
                          className="flex-1 px-3 py-1.5 bg-silk-900 border border-silk-700 rounded-lg text-xs text-white placeholder-slate-500 focus:outline-none focus:border-violet-500"
                        />
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </div>

          {/* Sticky Modal Footer */}
          <div className="p-3 border-t border-silk-800 bg-silk-900/95 backdrop-blur-md flex items-center justify-end gap-3 shrink-0">
            <button
              onClick={handleCloseModal}
              type="button"
              className="px-4 py-2 text-xs font-medium text-slate-300 hover:text-white rounded-xl hover:bg-silk-800"
            >
              {t.cancel}
            </button>
            <button
              onClick={handleSaveGroup}
              type="button"
              className="flex items-center gap-1.5 px-5 py-2 bg-gradient-to-r from-violet-600 to-indigo-600 hover:from-violet-500 hover:to-indigo-500 text-white text-xs font-semibold rounded-xl shadow-lg active:scale-95"
            >
              <Check className="w-4 h-4" />
              <span>{t.saveGroup}</span>
            </button>
          </div>
        </div>
      )}

      {/* AI Group Generator Modal */}
      {showGenModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/85 backdrop-blur-md animate-fade-in">
          <div className="w-full max-w-sm bg-silk-900 border border-silk-700 rounded-2xl flex flex-col overflow-hidden shadow-2xl">
            {/* Header */}
            <div className="flex items-center justify-between px-4 py-3 border-b border-silk-800">
              <div className="flex items-center gap-2">
                <Sparkles className="w-4 h-4 text-violet-400" />
                <h3 className="font-semibold text-sm text-white">{t.generateGroupAI}</h3>
              </div>
              <button
                onClick={() => setShowGenModal(false)}
                className="p-1 text-slate-400 hover:text-white rounded-lg"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {/* Body */}
            <div className="p-4 space-y-3">
              <label className="block text-xs font-semibold text-slate-300">
                {t.groupConcept}
              </label>
              <textarea
                rows={4}
                value={genConcept}
                onChange={(e) => setGenConcept(e.target.value)}
                placeholder={t.groupConceptPlaceholder}
                className="w-full px-3 py-2 bg-silk-800 border border-silk-700 rounded-xl text-xs text-white placeholder-slate-500 focus:outline-none focus:border-violet-500 resize-none"
                autoFocus
              />
            </div>

            {/* Footer */}
            <div className="p-3 border-t border-silk-800 flex justify-end gap-2 bg-silk-900">
              <button
                onClick={() => setShowGenModal(false)}
                type="button"
                className="px-3 py-1.5 text-xs text-slate-400 hover:text-white rounded-lg"
              >
                {t.cancel}
              </button>
              <button
                onClick={handleRunAiGroupGen}
                disabled={isGeneratingGroup || !genConcept.trim()}
                type="button"
                className="flex items-center gap-1.5 px-4 py-2 bg-violet-600 hover:bg-violet-500 disabled:opacity-50 text-white rounded-xl text-xs font-semibold shadow-md active:scale-95"
              >
                <Sparkles className="w-3.5 h-3.5" />
                <span>{isGeneratingGroup ? t.generatingGroup : t.generateButton}</span>
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
          if (cropperIsAvatar) {
            setAvatar(croppedUrl);
            setAvatarOffset(offset);
            syncFormRef({ avatar: croppedUrl, avatarOffset: offset });
          } else {
            setChatBackground(croppedUrl);
            setChatBackgroundOffset(offset);
            syncFormRef({ chatBackground: croppedUrl, chatBackgroundOffset: offset });
          }
          onDirtyChange(true, handleSaveGroup);
        }}
        onClose={() => setCropperOpen(false)}
      />
    </div>
  );
};
