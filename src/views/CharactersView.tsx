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
  Upload,
  Download,
  SlidersHorizontal,
  ChevronDown,
  RefreshCw,
  Cpu,
  BookOpen,
} from 'lucide-react';
import { db } from '../db';
import type { Character, CharacterEmotion, CharacterImageGenConfig, Folder, Group, ImageCropOffset, Language } from '../types';
import { translations } from '../i18n';
import { ImageCropperModal } from '../components/ImageCropperModal';
import { AvatarImage } from '../components/AvatarImage';
import { ActivityProgressBar } from '../components/ActivityProgressBar';
import { SceneGuideModal, SceneHelpButton } from '../components/SceneHelp';
import {
  describeCharacterPhotoWithVision,
  fetchLocalLoras,
  fetchLoraTrainStatus,
  generatePersonaWithAI,
  getEffectiveAiConfig,
  getComponentAiConfig,
  isLoraCompatibleWithModelFamily,
  selectLocalImageModel,
  trainCharacterLoraOnHub,
  type LocalLoraItem,
  type ReadyImageModelItem,
  type TrainableCheckpointItem,
} from '../services/ai';
import { transliterateCyrillicToLatin } from '../services/sceneState';
import { parseCharacterCardFile, exportCharacterCardV2Json } from '../services/characterCard';
import { compressDataUrlToJpeg, fileToCompressedJpeg, isRasterImageDataUrl } from '../utils/imageUtils';

const DEFAULT_IMAGE_GEN: CharacterImageGenConfig = {
  enabled: false,
  mode: 'reference',
  referenceImages: [],
  appearancePrompt: '',
  styleHint: '',
  loraName: '',
  loraTrigger: '',
  loraWeight: 0.85,
};

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
  const { apiKeyConfig: effectiveApiKey, isLocal } = getEffectiveAiConfig(settings, activeApiKey);

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
  const [scenario, setScenario] = useState('');
  const [exampleDialogue, setExampleDialogue] = useState('');
  const [greeting, setGreeting] = useState('');
  const [greetingEnabled, setGreetingEnabled] = useState(true);
  const [folderId, setFolderId] = useState<string | null>(null);
  const [avatar, setAvatar] = useState<string>('');
  const [avatarOffset, setAvatarOffset] = useState<ImageCropOffset>({ x: 0, y: 0, scale: 1 });
  const [chatBackground, setChatBackground] = useState<string>('');
  const [chatBackgroundOffset, setChatBackgroundOffset] = useState<ImageCropOffset>({ x: 0, y: 0, scale: 1 });
  const [emotions, setEmotions] = useState<CharacterEmotion[]>([]);
  const [imageGen, setImageGen] = useState<CharacterImageGenConfig>(DEFAULT_IMAGE_GEN);
  const [showAdvancedScene, setShowAdvancedScene] = useState(false);
  const [availableLoras, setAvailableLoras] = useState<LocalLoraItem[]>([]);
  const [activeHubImageModel, setActiveHubImageModel] = useState<{ filename: string; family: string; variant?: string; format?: string } | null>(null);
  const [trainableCheckpoints, setTrainableCheckpoints] = useState<TrainableCheckpointItem[]>([]);
  const [inferenceOnlyModels, setInferenceOnlyModels] = useState<Array<{ filename: string; family: string; format?: string }>>([]);
  const [readyHubModels, setReadyHubModels] = useState<ReadyImageModelItem[]>([]);
  const [switchingHubModel, setSwitchingHubModel] = useState(false);
  const [selectedTrainBaseModel, setSelectedTrainBaseModel] = useState<string>('');
  const [loraTrainerInfo, setLoraTrainerInfo] = useState<{ installed: boolean; gpu_ok: boolean; warning?: string } | null>(null);
  const [isUploadingRefs, setIsUploadingRefs] = useState(false);
  const [RefsStartedAt, setRefsStartedAt] = useState(0);
  const [describingPhoto, setDescribingPhoto] = useState(false);
  const [visionStartedAt, setVisionStartedAt] = useState(0);
  const [visionChars, setVisionChars] = useState(0);
  const [isLoadingLoras, setIsLoadingLoras] = useState(false);
  const [lorasStartedAt, setLorasStartedAt] = useState(0);
  const [loraTrainStartedAt, setLoraTrainStartedAt] = useState(0);
  const [loraTrainJob, setLoraTrainJob] = useState<{
    status: string;
    stage?: string;
    progress?: number;
    step?: number;
    total_steps?: number;
    started_at?: number;
    elapsed_sec?: number;
    logs?: string[];
    error?: string;
    output_file?: string;
  } | null>(null);
  const loraPollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const [activeEmotionCropperId, setActiveEmotionCropperId] = useState<string | null>(null);

  // Synchronous form ref to prevent stale closures during save
  const currentFormRef = useRef({
    name: '',
    description: '',
    scenario: '',
    exampleDialogue: '',
    greeting: '',
    greetingEnabled: true,
    folderId: null as string | null,
    avatar: '',
    avatarOffset: { x: 0, y: 0, scale: 1 } as ImageCropOffset,
    chatBackground: '',
    chatBackgroundOffset: { x: 0, y: 0, scale: 1 } as ImageCropOffset,
    emotions: [] as CharacterEmotion[],
    imageGen: DEFAULT_IMAGE_GEN as CharacterImageGenConfig,
  });

  const syncFormRef = (updates: Partial<typeof currentFormRef.current>) => {
    currentFormRef.current = { ...currentFormRef.current, ...updates };
  };

  const stopLoraPolling = () => {
    if (loraPollTimerRef.current) {
      clearInterval(loraPollTimerRef.current);
      loraPollTimerRef.current = null;
    }
  };

  useEffect(() => {
    return () => {
      stopLoraPolling();
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
  const [genStartedAt, setGenStartedAt] = useState(0);
  const [mentionQuery, setMentionQuery] = useState<string | null>(null);
  const [showMentionDropdown, setShowMentionDropdown] = useState(false);

  // Open Create Character
  const handleOpenCreate = () => {
    setEditingCharacterId(null);
    setName('');
    setDescription('');
    setScenario('');
    setExampleDialogue('');
    setGreeting('');
    setGreetingEnabled(true);
    const initialFolder = selectedFolderId && selectedFolderId !== 'none' ? selectedFolderId : null;
    setFolderId(initialFolder);
    setAvatar('');
    setAvatarOffset({ x: 0, y: 0, scale: 1 });
    setChatBackground('');
    setChatBackgroundOffset({ x: 0, y: 0, scale: 1 });
    setEmotions([]);
    setImageGen(DEFAULT_IMAGE_GEN);
    setShowAdvancedScene(false);
    setLoraTrainJob(null);
    syncFormRef({
      name: '',
      description: '',
      scenario: '',
      exampleDialogue: '',
      greeting: '',
      greetingEnabled: true,
      folderId: initialFolder,
      avatar: '',
      avatarOffset: { x: 0, y: 0, scale: 1 },
      chatBackground: '',
      chatBackgroundOffset: { x: 0, y: 0, scale: 1 },
      emotions: [],
      imageGen: DEFAULT_IMAGE_GEN,
    });
    setShowEditModal(true);
  };

  // Open Edit Character
  const handleOpenEdit = (char: Character) => {
    setEditingCharacterId(char.id);
    setName(char.name);
    setDescription(char.description);
    setScenario(char.scenario || '');
    setExampleDialogue(char.exampleDialogue || '');
    setGreeting(char.greeting || '');
    setGreetingEnabled(char.greetingEnabled);
    setFolderId(char.folderId || null);
    setAvatar(char.avatar);
    setAvatarOffset(char.avatarOffset || { x: 0, y: 0, scale: 1 });
    setChatBackground(char.chatBackground || '');
    setChatBackgroundOffset(char.chatBackgroundOffset || { x: 0, y: 0, scale: 1 });
    const loadedEmotions = char.emotions || [];
    const loadedImgGen: CharacterImageGenConfig = { ...DEFAULT_IMAGE_GEN, ...(char.imageGen || {}) };
    setEmotions(loadedEmotions);
    setImageGen(loadedImgGen);
    setShowAdvancedScene(false);
    setLoraTrainJob(null);
    syncFormRef({
      name: char.name,
      description: char.description,
      scenario: char.scenario || '',
      exampleDialogue: char.exampleDialogue || '',
      greeting: char.greeting || '',
      greetingEnabled: char.greetingEnabled,
      folderId: char.folderId || null,
      avatar: char.avatar,
      avatarOffset: char.avatarOffset || { x: 0, y: 0, scale: 1 },
      chatBackground: char.chatBackground || '',
      chatBackgroundOffset: char.chatBackgroundOffset || { x: 0, y: 0, scale: 1 },
      emotions: loadedEmotions,
      imageGen: loadedImgGen,
    });
    setShowEditModal(true);
  };

  // Close Character Modal
  const handleCloseModal = () => {
    stopLoraPolling();
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
      scenario: data.scenario.trim(),
      exampleDialogue: data.exampleDialogue.trim(),
      greeting: data.greeting.trim(),
      greetingEnabled: data.greetingEnabled,
      folderId: data.folderId,
      avatar: data.avatar || 'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100" viewBox="0 0 24 24" fill="%238b5cf6"><circle cx="12" cy="8" r="4"/><path d="M4 20c0-4 4-6 8-6s8 2 8 6"/></svg>',
      avatarOffset: data.avatarOffset,
      chatBackground: data.chatBackground,
      chatBackgroundOffset: data.chatBackgroundOffset,
      emotions: data.emotions,
      imageGen: data.imageGen,
      createdAt: editingCharacterId ? (await db.characters.get(editingCharacterId))?.createdAt || Date.now() : Date.now(),
      updatedAt: Date.now(),
    };

    await db.characters.put(charData);
    stopLoraPolling();
    setShowEditModal(false);
    onDirtyChange(false);
  };

  const updateImageGen = (patch: Partial<CharacterImageGenConfig>) => {
    setImageGen((prev) => {
      const next = { ...prev, ...patch };
      syncFormRef({ imageGen: next });
      return next;
    });
    onDirtyChange(true, handleSaveCharacter);
  };

  const handleUploadRefPhotos = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const fileList = Array.from(e.target.files || []);
    e.target.value = '';
    if (fileList.length === 0) return;
    setRefsStartedAt(Date.now());
    setIsUploadingRefs(true);
    try {
      const current = [...(imageGen.referenceImages || [])];
      for (const f of fileList) {
        if (current.length >= 4) break;
        try {
          const jpg = await fileToCompressedJpeg(f, 896, 0.88);
          current.push(jpg);
        } catch {
          // skip unreadable image
        }
      }
      updateImageGen({ referenceImages: current });
    } finally {
      setIsUploadingRefs(false);
    }
  };

  const [showSceneGuide, setShowSceneGuide] = useState(false);

  const handleUseAvatarAsRef = async () => {
    if (!isRasterImageDataUrl(avatar)) return;
    const current = [...(imageGen.referenceImages || [])];
    if (current.length >= 4) return;
    setRefsStartedAt(Date.now());
    setIsUploadingRefs(true);
    try {
      const normalized = (await compressDataUrlToJpeg(avatar, 896, 0.9)) || avatar;
      if (!current.includes(normalized)) {
        updateImageGen({ referenceImages: [normalized, ...current].slice(0, 4) });
      }
    } finally {
      setIsUploadingRefs(false);
    }
  };

  const handleAutoDescribeAppearance = async () => {
    const validRef = (imageGen.referenceImages || []).find((p) => isRasterImageDataUrl(p));
    const sample = validRef || (isRasterImageDataUrl(avatar) ? avatar : '');
    if (!sample) return;
    setVisionStartedAt(Date.now());
    setVisionChars(0);
    setDescribingPhoto(true);
    try {
      const desc = await describeCharacterPhotoWithVision({
        settings,
        activeApiKey,
        photoDataUrl: sample,
        characterName: name || 'Character',
        onProgress: (chars) => setVisionChars(chars),
      });
      if (desc && desc.trim()) {
        updateImageGen({ appearancePrompt: desc.trim() });
      } else {
        alert(
          language === 'ru'
            ? 'Vision-модель вернула пустой ответ. Убедитесь, что на ПК загружена Vision-модель с mmproj или выбрана облачная Vision-модель.'
            : 'Vision AI returned an empty description. Ensure a Vision model with mmproj is active on PC or configure a Cloud Vision model.'
        );
      }
    } catch (err: any) {
      alert(err?.message || 'Vision error');
    } finally {
      setDescribingPhoto(false);
      setVisionChars(0);
    }
  };

  const startLoraStatusPolling = (hubUrl: string, trigOnComplete?: string) => {
    stopLoraPolling();
    loraPollTimerRef.current = setInterval(async () => {
      try {
        const st = await fetchLoraTrainStatus(hubUrl);
        if (st?.job) {
          setLoraTrainJob(st.job);
          if (st.job.status === 'done') {
            stopLoraPolling();
            if (trigOnComplete) {
              updateImageGen({
                loraName: st.job.output_file,
                loraTrigger: trigOnComplete,
                enabled: true,
                mode: 'lora',
              });
            }
            loadLocalLoras(false);
          } else if (st.job.status === 'error') {
            stopLoraPolling();
          }
        }
      } catch {
        stopLoraPolling();
      }
    }, 1500);
  };

  const loadLocalLoras = async (checkActiveJob = true) => {
    const hubUrl = settings?.localHubUrl;
    setLorasStartedAt(Date.now());
    setIsLoadingLoras(true);
    try {
      const res = await fetchLocalLoras(hubUrl);
      setAvailableLoras((res.loras || []).filter((l) => !l.is_full_model));
      setLoraTrainerInfo(res.trainer || null);
      setActiveHubImageModel(res.active_image_model || null);
      setTrainableCheckpoints(res.trainable_checkpoints || []);
      setInferenceOnlyModels(res.inference_only_models || []);
      setReadyHubModels(res.ready_models || []);
      if (checkActiveJob && hubUrl) {
        const st = await fetchLoraTrainStatus(hubUrl).catch(() => null);
        if (st?.job && (st.job.status === 'preparing' || st.job.status === 'training')) {
          setLoraTrainStartedAt(st.job.started_at ? st.job.started_at * 1000 : Date.now());
          setLoraTrainJob(st.job);
          startLoraStatusPolling(hubUrl);
        }
      }
    } catch {
      setAvailableLoras([]);
      setLoraTrainerInfo(null);
      setActiveHubImageModel(null);
      setTrainableCheckpoints([]);
      setInferenceOnlyModels([]);
      setReadyHubModels([]);
    } finally {
      setIsLoadingLoras(false);
    }
  };

  const handleTrainLoraOnHub = async () => {
    const validRefs = (imageGen.referenceImages || []).filter((p) => isRasterImageDataUrl(p));
    const samples = validRefs.length > 0
      ? validRefs
      : isRasterImageDataUrl(avatar) ? [avatar] : [];
    if (samples.length === 0) return;
    const hubUrl = settings?.localHubUrl || 'http://192.168.1.55:8080/v1';
    const latinSlug = transliterateCyrillicToLatin(name || 'char').toLowerCase().replace(/[^a-z0-9]/g, '') || 'char';
    const trig = (imageGen.loraTrigger || `slx_${latinSlug}`).trim();
    setLoraTrainStartedAt(Date.now());
    setLoraTrainJob({ status: 'preparing', stage: 'preparing_dataset', progress: 4 });
    try {
      const job = await trainCharacterLoraOnHub(hubUrl, {
        character_name: name || 'character',
        trigger_word: trig,
        images: samples.map((dataUrl) => ({ dataUrl, caption: imageGen.appearancePrompt || '' })),
        base_model: selectedTrainBaseModel || undefined,
        caption: imageGen.appearancePrompt || '',
      });
      setLoraTrainJob(job);
      startLoraStatusPolling(hubUrl, trig);
    } catch (err: any) {
      setLoraTrainJob({ status: 'error', error: err?.message || 'Train failed' });
    }
  };

  const handleImportCardFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    try {
      const buf = await file.arrayBuffer();
      const card = parseCharacterCardFile(file.name, new Uint8Array(buf), file.type);
      const initialFolder = selectedFolderId && selectedFolderId !== 'none' ? selectedFolderId : null;
      const importedImgGen: CharacterImageGenConfig = { ...DEFAULT_IMAGE_GEN, ...(card.imageGen || {}) };
      setEditingCharacterId(null);
      setName(card.name);
      setDescription(card.description);
      setScenario(card.scenario);
      setExampleDialogue(card.exampleDialogue);
      setGreeting(card.greeting);
      setGreetingEnabled(card.greetingEnabled);
      setFolderId(initialFolder);
      setAvatar(card.avatar || '');
      setAvatarOffset({ x: 0, y: 0, scale: 1 });
      setChatBackground('');
      setChatBackgroundOffset({ x: 0, y: 0, scale: 1 });
      setEmotions([]);
      setImageGen(importedImgGen);
      syncFormRef({
        name: card.name,
        description: card.description,
        scenario: card.scenario,
        exampleDialogue: card.exampleDialogue,
        greeting: card.greeting,
        greetingEnabled: card.greetingEnabled,
        folderId: initialFolder,
        avatar: card.avatar || '',
        avatarOffset: { x: 0, y: 0, scale: 1 },
        chatBackground: '',
        chatBackgroundOffset: { x: 0, y: 0, scale: 1 },
        emotions: [],
        imageGen: importedImgGen,
      });
      onDirtyChange(true, handleSaveCharacter);
      setShowEditModal(true);
    } catch (err: any) {
      alert(t.importCardError + (err?.message || err));
    }
  };

  const handleExportCurrentCard = () => {
    const data = currentFormRef.current;
    if (!data.name.trim()) return;
    const tempChar: Character = {
      id: editingCharacterId || 'export',
      name: data.name.trim(),
      description: data.description.trim(),
      scenario: data.scenario.trim(),
      exampleDialogue: data.exampleDialogue.trim(),
      greeting: data.greeting.trim(),
      greetingEnabled: data.greetingEnabled,
      avatar: data.avatar,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    const json = exportCharacterCardV2Json(tempChar);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const safeName = tempChar.name.replace(/[^\p{L}\p{N}_-]+/gu, '_').slice(0, 40) || 'character';
    a.href = url;
    a.download = `${safeName}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
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
    setGenStartedAt(Date.now());
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

      // A reference photo goes to the vision backend, the rest to the character generator backend
      const genCfg = getComponentAiConfig(settings, activeApiKey, genPhotoRef ? 'vision' : 'characterGen');
      const generated = await generatePersonaWithAI(
        genCfg.apiKeyConfig as any,
        genCfg.textModel,
        genConcept,
        genDo,
        genDont,
        genPhotoRef,
        contextLore,
        language
      );

      setName(generated.name);
      setDescription(generated.description);
      if (generated.scenario) setScenario(generated.scenario);
      if (generated.exampleDialogue) setExampleDialogue(generated.exampleDialogue);
      setGreeting(generated.greeting);
      setGreetingEnabled(true);
      syncFormRef({
        name: generated.name,
        description: generated.description,
        ...(generated.scenario ? { scenario: generated.scenario } : {}),
        ...(generated.exampleDialogue ? { exampleDialogue: generated.exampleDialogue } : {}),
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

          <div className="flex items-center gap-2">
            <label
              title={t.importCharacterCard}
              className="flex items-center gap-1.5 px-3 py-2 bg-silk-800 hover:bg-silk-700 border border-silk-700 text-slate-200 rounded-xl text-xs font-medium cursor-pointer active:scale-95 transition-all"
            >
              <Upload className="w-3.5 h-3.5 text-violet-400" />
              <span className="hidden sm:inline">{t.importCharacterCard}</span>
              <input
                type="file"
                accept=".json,.png,application/json,image/png"
                onChange={handleImportCardFile}
                className="hidden"
              />
            </label>
            <button
              onClick={handleOpenCreate}
              type="button"
              className="flex items-center gap-2 px-4 py-2 bg-violet-600 hover:bg-violet-500 border border-white/10 text-white rounded-xl text-xs font-semibold active:scale-95 transition-colors"
            >
              <Plus className="w-4 h-4" />
              <span>{t.createCharacter}</span>
            </button>
          </div>
        </div>

        {/* Folder Navigation Pills */}
        <div className="flex items-center gap-2 overflow-x-auto no-scrollbar py-1">
          <button
            onClick={() => setSelectedFolderId(null)}
            type="button"
            className={`px-3 py-1.5 rounded-lg text-xs font-medium whitespace-nowrap border transition-colors ${
              selectedFolderId === null
                ? 'bg-silk-800 border-silk-600 text-slate-100'
                : 'bg-silk-900 border-silk-800 text-slate-400 hover:text-slate-200'
            }`}
          >
            {t.allFolders}
          </button>

          <button
            onClick={() => setSelectedFolderId('none')}
            type="button"
            className={`px-3 py-1.5 rounded-lg text-xs font-medium whitespace-nowrap border transition-colors ${
              selectedFolderId === 'none'
                ? 'bg-silk-800 border-silk-600 text-slate-100'
                : 'bg-silk-900 border-silk-800 text-slate-400 hover:text-slate-200'
            }`}
          >
            {t.noFolder}
          </button>

          {folders.map((f) => (
            <div
              key={f.id}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium whitespace-nowrap border transition-colors ${
                selectedFolderId === f.id
                  ? 'bg-silk-800 border-silk-600 text-slate-100'
                  : 'bg-silk-900 border-silk-800 text-slate-400 hover:text-slate-200'
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
          <div className="h-64 flex flex-col items-center justify-center text-center p-6 border border-dashed border-silk-800 rounded-2xl bg-silk-900/40">
            <Sparkles className="w-7 h-7 text-slate-500 mb-2" />
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
                className="group relative flex items-center gap-3.5 p-3 rounded-2xl bg-silk-900 border border-silk-800 hover:border-silk-600 transition-colors cursor-pointer select-none active:scale-[0.99]"
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
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80">
          <div className="w-full max-w-xs bg-silk-900 border border-silk-700 rounded-2xl p-4 space-y-4">
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
              {name.trim() && (
                <button
                  onClick={handleExportCurrentCard}
                  type="button"
                  title={t.exportCharacterCard}
                  className="flex items-center gap-1 px-2.5 py-1.5 bg-silk-800 hover:bg-silk-700 border border-silk-700 text-slate-200 rounded-xl text-xs font-medium active:scale-95 transition-all"
                >
                  <Download className="w-3.5 h-3.5 text-violet-400" />
                  <span className="hidden sm:inline">{t.exportCharacterCard}</span>
                </button>
              )}
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
              className="w-full flex items-center justify-between p-3.5 rounded-2xl bg-silk-900 hover:bg-silk-850 border border-silk-700 text-left group transition-colors"
            >
              <div className="flex items-center gap-3">
                <div className="p-2 rounded-xl bg-silk-800 text-slate-300 border border-silk-700">
                  <Sparkles className="w-5 h-5" />
                </div>
                <div>
                  <h4 className="text-xs font-semibold text-slate-100">{t.generateWithAI}</h4>
                  <p className="text-[11px] text-slate-400">
                    {language === 'ru'
                      ? 'Автоматическое создание характера, лора и первой реплики с поддержкой @ упоминаний'
                      : 'Auto-create detailed personality, lore, and greeting with @ mentions'}
                  </p>
                </div>
              </div>
              <ChevronRight className="w-4 h-4 text-slate-400 group-hover:translate-x-0.5 transition-transform" />
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

              <div>
                <label className="block text-xs font-semibold text-slate-300 mb-1.5">{t.charScenario}</label>
                <textarea
                  rows={3}
                  value={scenario}
                  onChange={(e) => {
                    setScenario(e.target.value);
                    syncFormRef({ scenario: e.target.value });
                  }}
                  placeholder={t.charScenarioPlaceholder}
                  className="w-full px-3.5 py-2.5 bg-silk-900 border border-silk-800 rounded-xl text-xs text-white placeholder-slate-500 focus:outline-none focus:border-violet-500 leading-relaxed resize-none"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-300 mb-1.5">{t.charExampleDialogue}</label>
                <textarea
                  rows={3}
                  value={exampleDialogue}
                  onChange={(e) => {
                    setExampleDialogue(e.target.value);
                    syncFormRef({ exampleDialogue: e.target.value });
                  }}
                  placeholder={t.charExampleDialoguePlaceholder}
                  className="w-full px-3.5 py-2.5 bg-silk-900 border border-silk-800 rounded-xl text-xs text-white placeholder-slate-500 focus:outline-none focus:border-violet-500 leading-relaxed resize-none font-mono"
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

              {/* Collapsible Advanced Scene Image Generation Section */}
              <div className="pt-2 border-t border-silk-800">
                <button
                  type="button"
                  onClick={() => {
                    const next = !showAdvancedScene;
                    setShowAdvancedScene(next);
                    if (next) loadLocalLoras();
                  }}
                  className="w-full flex items-center justify-between px-3 py-2.5 rounded-xl bg-silk-850/90 hover:bg-silk-800 border border-silk-700/80 transition-colors text-left"
                >
                  <div className="flex items-center gap-2 min-w-0">
                    <SlidersHorizontal className="w-4 h-4 text-violet-400 shrink-0" />
                    <div className="min-w-0">
                      <div className="text-xs font-semibold text-slate-200 flex items-center gap-2">
                        <span>{t.advancedSettingsTitle}</span>
                        {imageGen.enabled && (
                          <span className="px-1.5 py-0.5 rounded bg-violet-600/25 border border-violet-500/40 text-[10px] text-violet-300">
                            {imageGen.mode === 'lora' ? 'LoRA' : language === 'ru' ? 'Фото' : 'Refs'}
                          </span>
                        )}
                      </div>
                      <p className="text-[11px] text-slate-500 truncate">{t.advancedSettingsHint}</p>
                    </div>
                  </div>
                  <ChevronDown
                    className={`w-4 h-4 text-slate-400 shrink-0 transition-transform ${showAdvancedScene ? 'rotate-180' : ''}`}
                  />
                </button>

                {showAdvancedScene && (
                  <div className="mt-3 p-3.5 rounded-xl bg-silk-950/60 border border-silk-800 space-y-3.5 animate-fade-in">
                    {/* Enable Switch + Full Guide Button */}
                    <div className="flex items-center justify-between gap-2 flex-wrap">
                      <div className="flex items-center gap-1.5">
                        <span className="text-xs font-semibold text-slate-200">{t.enableSceneImageGen}</span>
                        <SceneHelpButton
                          topic="enableScene"
                          language={language}
                          onOpenGuide={() => setShowSceneGuide(true)}
                        />
                      </div>
                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          onClick={() => setShowSceneGuide(true)}
                          className="px-2.5 py-1 rounded-lg bg-silk-800 hover:bg-silk-700 border border-silk-700 text-[11px] text-slate-200 font-medium flex items-center gap-1 transition-colors"
                        >
                          <BookOpen className="w-3 h-3 text-slate-300" />
                          <span>{t.sceneOpenGuideBtn}</span>
                        </button>
                        <button
                          type="button"
                          onClick={() => updateImageGen({ enabled: !imageGen.enabled })}
                          className={`relative w-11 h-6 rounded-full transition-colors ${
                            imageGen.enabled ? 'bg-violet-600' : 'bg-silk-700'
                          }`}
                        >
                          <div
                            className={`absolute top-1 left-1 w-4 h-4 rounded-full bg-white transition-transform ${
                              imageGen.enabled ? 'translate-x-5' : 'translate-x-0'
                            }`}
                          />
                        </button>
                      </div>
                    </div>

                    {imageGen.enabled && (
                      <div className="space-y-3.5 pt-2.5 border-t border-silk-800/80">
                        {/* Likeness Mode Segmented Switcher */}
                        <div className="space-y-1.5">
                          <div className="flex items-center justify-between gap-2">
                            <span className="text-[11px] font-medium text-slate-300">
                              {language === 'ru' ? 'Способ сохранения внешности' : 'Character Likeness Mode'}
                            </span>
                            <SceneHelpButton
                              topic="modeSelect"
                              language={language}
                              onOpenGuide={() => setShowSceneGuide(true)}
                            />
                          </div>
                          <div className="grid grid-cols-2 gap-1.5 p-1 rounded-xl bg-silk-900 border border-silk-800">
                            <button
                              type="button"
                              onClick={() => updateImageGen({ mode: 'reference' })}
                              className={`px-2.5 py-2 rounded-lg text-[11px] font-medium transition-colors text-center ${
                                imageGen.mode !== 'lora'
                                  ? 'bg-violet-600 text-white shadow'
                                  : 'text-slate-400 hover:text-slate-200'
                              }`}
                            >
                              {t.sceneModeOptionA}
                            </button>
                            <button
                              type="button"
                              onClick={() => {
                                updateImageGen({ mode: 'lora' });
                                loadLocalLoras();
                              }}
                              className={`px-2.5 py-2 rounded-lg text-[11px] font-medium transition-colors text-center ${
                                imageGen.mode === 'lora'
                                  ? 'bg-violet-600 text-white shadow'
                                  : 'text-slate-400 hover:text-slate-200'
                              }`}
                            >
                              {t.sceneModeOptionB}
                            </button>
                          </div>
                          <p className="text-[11px] text-slate-400 leading-relaxed">
                            {imageGen.mode === 'lora' ? t.sceneModeOptionBDesc : t.sceneModeOptionADesc}
                          </p>
                        </div>

                        {/* Reference Photo Pack */}
                        <div className="space-y-2">
                          <div className="flex items-center justify-between gap-2 flex-wrap">
                            <div className="flex items-center gap-1.5">
                              <span className="text-[11px] font-medium text-slate-300">{t.refPhotosLabel}</span>
                              <SceneHelpButton
                                topic="refPhotos"
                                language={language}
                                onOpenGuide={() => setShowSceneGuide(true)}
                              />
                            </div>
                            <div className="flex items-center gap-1.5">
                              {isRasterImageDataUrl(avatar) && (imageGen.referenceImages || []).length < 4 && (
                                <button
                                  type="button"
                                  onClick={handleUseAvatarAsRef}
                                  className="px-2.5 py-1 rounded-lg bg-silk-800 hover:bg-silk-700 border border-silk-700 text-[11px] text-slate-200 font-medium flex items-center gap-1 transition-colors"
                                >
                                  <Camera className="w-3 h-3" />
                                  <span>{t.useAvatarAsRefBtn}</span>
                                </button>
                              )}
                              <label className="px-2.5 py-1 rounded-lg bg-silk-800 hover:bg-silk-700 border border-silk-700 text-[11px] text-violet-300 font-medium cursor-pointer flex items-center gap-1 transition-colors">
                                <Upload className="w-3 h-3" />
                                <span>{t.addRefPhotos}</span>
                                <input
                                  type="file"
                                  accept="image/*"
                                  multiple
                                  onChange={handleUploadRefPhotos}
                                  className="hidden"
                                />
                              </label>
                            </div>
                          </div>

                          {isUploadingRefs && (
                            <ActivityProgressBar
                              compact
                              accent="violet"
                              language={language}
                              label={t.uploadingRefPhotosProgress}
                              startedAt={RefsStartedAt}
                            />
                          )}

                          {(imageGen.referenceImages || []).length > 0 && (
                            <div className="grid grid-cols-4 gap-2">
                              {(imageGen.referenceImages || []).map((src, idx) => (
                                <div key={idx} className="relative aspect-square rounded-lg overflow-hidden border border-silk-700 bg-silk-900">
                                  <img src={src} alt="" className="w-full h-full object-cover" />
                                  <button
                                    type="button"
                                    onClick={() =>
                                      updateImageGen({
                                        referenceImages: (imageGen.referenceImages || []).filter((_, i) => i !== idx),
                                      })
                                    }
                                    className="absolute top-1 right-1 p-0.5 rounded-full bg-black/75 text-white hover:bg-rose-600"
                                  >
                                    <X className="w-3 h-3" />
                                  </button>
                                </div>
                              ))}
                            </div>
                          )}
                        </div>

                        {/* Visual Appearance & Style Hint */}
                        <div className="space-y-1.5">
                          <div className="flex items-center justify-between gap-2 flex-wrap">
                            <div className="flex items-center gap-1.5">
                              <label className="text-[11px] font-medium text-slate-300">{t.appearancePromptLabel}</label>
                              <SceneHelpButton
                                topic="appearancePrompt"
                                language={language}
                                onOpenGuide={() => setShowSceneGuide(true)}
                              />
                            </div>
                            <button
                              type="button"
                              disabled={
                                describingPhoto ||
                                (!(imageGen.referenceImages || []).some((p) => isRasterImageDataUrl(p)) &&
                                  !isRasterImageDataUrl(avatar))
                              }
                              onClick={handleAutoDescribeAppearance}
                              className="px-2 py-1 rounded-lg bg-violet-600/20 hover:bg-violet-600/35 disabled:opacity-40 border border-violet-500/35 text-[10px] text-violet-300 flex items-center gap-1"
                            >
                              <Sparkles className="w-3 h-3" />
                              <span>{describingPhoto ? t.describingAppearance : t.autoDescribeAppearance}</span>
                            </button>
                          </div>
                          {describingPhoto && (
                            <ActivityProgressBar
                              compact
                              accent="violet"
                              language={language}
                              label={t.visionExtractingProgress}
                              sublabel={visionChars > 0 ? t.visionStreamingSub.replace('{n}', String(visionChars)) : undefined}
                              startedAt={visionStartedAt}
                            />
                          )}
                          <textarea
                            rows={2}
                            value={imageGen.appearancePrompt || ''}
                            onChange={(e) => updateImageGen({ appearancePrompt: e.target.value })}
                            placeholder={t.appearancePromptPlaceholder}
                            className="w-full bg-silk-900 border border-silk-700 rounded-xl px-3 py-2 text-xs text-slate-200 placeholder-slate-500 focus:outline-none focus:border-violet-500 resize-none"
                          />
                        </div>

                        <div className="space-y-1.5">
                          <div className="flex items-center gap-1.5">
                            <label className="text-[11px] font-medium text-slate-300">{t.styleHintLabel}</label>
                            <SceneHelpButton
                              topic="styleHint"
                              language={language}
                              onOpenGuide={() => setShowSceneGuide(true)}
                            />
                          </div>
                          <input
                            type="text"
                            value={imageGen.styleHint || ''}
                            onChange={(e) => updateImageGen({ styleHint: e.target.value })}
                            placeholder={t.styleHintPlaceholder}
                            className="w-full bg-silk-900 border border-silk-700 rounded-xl px-3 py-1.5 text-xs text-slate-200 placeholder-slate-500 focus:outline-none focus:border-violet-500"
                          />
                          <div className="flex flex-wrap gap-1.5 pt-0.5">
                            {([
                              [t.stylePresetPhoto, 'cinematic realistic photography, natural film grain, dramatic lighting'],
                              [t.stylePresetAnime, 'high-detail anime key visual illustration, crisp cel shading, expressive lighting'],
                              [t.stylePresetFantasy, 'atmospheric dark fantasy digital painting, rich textures, moody chiaroscuro'],
                              [t.stylePresetPainterly, 'soft semi-realistic painterly illustration, warm atmospheric brushwork'],
                              [t.stylePresetScifi, 'futuristic sci-fi cyberpunk illustration, atmospheric neon rim light, intricate tech details'],
                              [t.stylePresetAnthro, 'detailed anthropomorphic character illustration, expressive fur and species anatomy, vibrant lighting'],
                              [t.stylePresetComic, 'stylized graphic novel illustration, bold ink linework, dramatic cel-shaded lighting'],
                            ] as const).map(([label, presetVal]) => {
                              const isCurrent = (imageGen.styleHint || '').trim() === presetVal;
                              return (
                                <button
                                  key={label}
                                  type="button"
                                  onClick={() => updateImageGen({ styleHint: isCurrent ? '' : presetVal })}
                                  className={`px-2 py-0.5 rounded-lg text-[10px] border transition-colors ${
                                    isCurrent
                                      ? 'bg-violet-600/25 border-violet-500 text-violet-200'
                                      : 'bg-silk-900 border-silk-800 text-slate-400 hover:text-slate-200'
                                  }`}
                                >
                                  {label}
                                </button>
                              );
                            })}
                          </div>
                        </div>

                        {/* LoRA Adapter Picker & Dataset Trainer */}
                        {imageGen.mode === 'lora' && (() => {
                          const selectedLoraItem = availableLoras.find((l) => l.filename === imageGen.loraName);
                          const hasArchMismatch = Boolean(
                            selectedLoraItem?.base_arch &&
                              activeHubImageModel?.family &&
                              !isLoraCompatibleWithModelFamily(selectedLoraItem.base_arch, activeHubImageModel.family)
                          );
                          const isTrainingActive =
                            loraTrainJob?.status === 'preparing' || loraTrainJob?.status === 'training';
                          const loraStageLabel = (() => {
                            const st = loraTrainJob?.stage || loraTrainJob?.status || '';
                            if (st === 'preparing_dataset' || st === 'preparing') return t.loraStageDataset;
                            if (st === 'loading_checkpoint') return t.loraStageLoad;
                            if (st === 'encoding_latents') return t.loraStageEncode;
                            if (st === 'saving_weights') return t.loraStageSave;
                            if (st === 'training_steps' || st === 'training') return t.loraStageSteps;
                            return t.loraTrainingProgress;
                          })();
                          const lastLoraLog =
                            loraTrainJob?.logs && loraTrainJob.logs.length > 0
                              ? loraTrainJob.logs[loraTrainJob.logs.length - 1]
                              : undefined;
                          const effLoraStartMs = loraTrainJob?.started_at
                            ? loraTrainJob.started_at * 1000
                            : loraTrainStartedAt;

                          return (
                            <div className="pt-2 border-t border-silk-800 space-y-2.5">
                              <div className="flex items-center justify-between gap-2">
                                <div className="flex items-center gap-1.5">
                                  <label className="text-[11px] font-medium text-slate-300">{t.loraFileLabel}</label>
                                  <SceneHelpButton
                                    topic="loraAdapter"
                                    language={language}
                                    onOpenGuide={() => setShowSceneGuide(true)}
                                  />
                                </div>
                                <button
                                  type="button"
                                  disabled={isLoadingLoras}
                                  onClick={() => loadLocalLoras()}
                                  className="text-[11px] text-slate-400 hover:text-violet-300 disabled:opacity-50 flex items-center gap-1"
                                >
                                  <RefreshCw className={`w-3 h-3 ${isLoadingLoras ? 'animate-spin' : ''}`} />
                                  <span>{t.loraRefreshList}</span>
                                </button>
                              </div>
                              {isLoadingLoras && (
                                <ActivityProgressBar
                                  compact
                                  accent="slate"
                                  language={language}
                                  label={t.loadingLoraListProgress}
                                  startedAt={lorasStartedAt}
                                />
                              )}
                              <select
                                value={imageGen.loraName || ''}
                                onChange={(e) => {
                                  const picked = availableLoras.find((l) => l.filename === e.target.value);
                                  updateImageGen({
                                    loraName: e.target.value,
                                    loraTrigger: picked?.trigger_word || imageGen.loraTrigger || '',
                                  });
                                }}
                                className="w-full bg-silk-900 border border-silk-700 rounded-xl px-3 py-2 text-xs text-slate-200 focus:outline-none focus:border-violet-500"
                              >
                                <option value="">{t.loraSelectPlaceholder}</option>
                                {availableLoras.map((l) => (
                                  <option key={l.filename} value={l.filename}>
                                    {l.filename}
                                    {l.base_arch ? ` [${l.base_arch.toUpperCase()}]` : ''}
                                    {l.trigger_word ? ` (${l.trigger_word})` : ''}
                                  </option>
                                ))}
                              </select>
                              {hasArchMismatch && selectedLoraItem && activeHubImageModel && (() => {
                                const compatReady = readyHubModels.find((m) =>
                                  isLoraCompatibleWithModelFamily(selectedLoraItem.base_arch, m.family)
                                );
                                return (
                                  <div className="space-y-1.5 bg-amber-950/30 border border-amber-800/40 rounded-lg px-2.5 py-2">
                                    <p className="text-[10px] text-amber-400/95 leading-relaxed">
                                      {t.loraArchMismatchHint
                                        .replace('{lora}', selectedLoraItem.base_arch.toUpperCase())
                                        .replace('{model}', activeHubImageModel.family.toUpperCase())}
                                    </p>
                                    {compatReady && (
                                      <button
                                        type="button"
                                        disabled={switchingHubModel}
                                        onClick={async () => {
                                          setSwitchingHubModel(true);
                                          try {
                                            await selectLocalImageModel(settings?.localHubUrl, compatReady.filename);
                                            await loadLocalLoras(false);
                                          } catch (err: any) {
                                            alert(err?.message || 'Switch failed');
                                          } finally {
                                            setSwitchingHubModel(false);
                                          }
                                        }}
                                        className="px-2.5 py-1 rounded-lg bg-amber-500/20 hover:bg-amber-500/30 disabled:opacity-50 border border-amber-500/40 text-[10px] font-medium text-amber-200"
                                      >
                                        {t.loraSwitchModelBtn.replace('{model}', compatReady.filename)}
                                      </button>
                                    )}
                                  </div>
                                );
                              })()}

                              <div className="grid grid-cols-2 gap-2">
                                <div>
                                  <div className="flex items-center justify-between gap-1 mb-1">
                                    <label className="text-[10px] text-slate-400">{t.loraTriggerLabel}</label>
                                    <SceneHelpButton
                                      topic="loraTrigger"
                                      language={language}
                                      onOpenGuide={() => setShowSceneGuide(true)}
                                    />
                                  </div>
                                  <input
                                    type="text"
                                    value={imageGen.loraTrigger || ''}
                                    onChange={(e) => updateImageGen({ loraTrigger: e.target.value })}
                                    placeholder="slx_char"
                                    className="w-full bg-silk-900 border border-silk-700 rounded-lg px-2.5 py-1.5 text-xs text-slate-200"
                                  />
                                </div>
                                <div>
                                  <div className="flex items-center justify-between gap-1 mb-1">
                                    <label className="text-[10px] text-slate-400">
                                      {t.loraWeightLabel}: {(imageGen.loraWeight ?? 0.85).toFixed(2)}
                                    </label>
                                    <SceneHelpButton
                                      topic="loraStrength"
                                      language={language}
                                      onOpenGuide={() => setShowSceneGuide(true)}
                                    />
                                  </div>
                                  <input
                                    type="range"
                                    min="0.2"
                                    max="1.2"
                                    step="0.05"
                                    value={imageGen.loraWeight ?? 0.85}
                                    onChange={(e) => updateImageGen({ loraWeight: parseFloat(e.target.value) })}
                                    className="w-full accent-violet-500 mt-1.5"
                                  />
                                </div>
                              </div>

                              {/* Train on Hub from uploaded refs */}
                              <div className="pt-1.5 border-t border-silk-800/70 space-y-2">
                                <div className="flex items-center justify-between gap-2">
                                  <span className="text-[10px] text-slate-400">{t.loraTrainBaseLabel}</span>
                                  <SceneHelpButton
                                    topic="loraTrain"
                                    language={language}
                                    onOpenGuide={() => setShowSceneGuide(true)}
                                  />
                                </div>
                                {trainableCheckpoints.length > 0 ? (
                                  <select
                                    value={selectedTrainBaseModel}
                                    onChange={(e) => setSelectedTrainBaseModel(e.target.value)}
                                    className="w-full bg-silk-900 border border-silk-700 rounded-lg px-2.5 py-1.5 text-xs text-slate-200"
                                  >
                                    <option value="">{t.loraTrainBaseAuto}</option>
                                    {trainableCheckpoints.map((ck) => (
                                      <option key={ck.filename} value={ck.filename}>
                                        {ck.filename} [{ck.family.toUpperCase()}
                                        {ck.variant ? `/${ck.variant}` : ''}]
                                        {ck.is_active ? ' *' : ''}
                                      </option>
                                    ))}
                                  </select>
                                ) : (
                                  <select
                                    disabled
                                    value=""
                                    className="w-full bg-silk-900/70 border border-silk-800 rounded-lg px-2.5 py-1.5 text-xs text-slate-500"
                                  >
                                    <option value="">{t.loraTrainNoSafetensorsOption}</option>
                                  </select>
                                )}
                                {(() => {
                                  if (trainableCheckpoints.length > 0) {
                                    const chosenCkpt =
                                      trainableCheckpoints.find((ck) => ck.filename === selectedTrainBaseModel) ||
                                      trainableCheckpoints.find((ck) => ck.is_active) ||
                                      trainableCheckpoints[0];
                                    if (
                                      chosenCkpt &&
                                      activeHubImageModel?.family &&
                                      !isLoraCompatibleWithModelFamily(chosenCkpt.family, activeHubImageModel.family)
                                    ) {
                                      return (
                                        <p className="text-[10px] leading-relaxed text-amber-300/90 bg-amber-500/10 border border-amber-500/20 rounded-lg px-2.5 py-1.5">
                                          {t.loraTrainArchDiffHint
                                            .replace('{trainArch}', chosenCkpt.family.toUpperCase())
                                            .replace('{activeModel}', activeHubImageModel.filename)
                                            .replace(/\{activeArch\}/g, activeHubImageModel.family.toUpperCase())}
                                        </p>
                                      );
                                    }
                                    return null;
                                  }
                                  if (loraTrainerInfo && !isLoadingLoras) {
                                    const ggufNames = inferenceOnlyModels.map((m) => m.filename);
                                    const fallbackActive =
                                      activeHubImageModel && activeHubImageModel.filename.toLowerCase().endsWith('.gguf')
                                        ? [activeHubImageModel.filename]
                                        : [];
                                    const modelNames = ggufNames.length > 0 ? ggufNames : fallbackActive;
                                    return (
                                      <p className="text-[10px] leading-relaxed text-slate-300 bg-silk-900/80 border border-silk-700/80 rounded-lg px-2.5 py-2">
                                        {modelNames.length > 0
                                          ? t.loraTrainGgufOnlyHint.replace('{models}', modelNames.slice(0, 3).join(', '))
                                          : t.loraTrainEmptyModelsHint}
                                      </p>
                                    );
                                  }
                                  return null;
                                })()}
                                {isTrainingActive && (
                                  <ActivityProgressBar
                                    accent="violet"
                                    language={language}
                                    label={loraStageLabel}
                                    sublabel={lastLoraLog}
                                    progress={loraTrainJob?.progress ?? null}
                                    stepInfo={
                                      loraTrainJob?.total_steps && loraTrainJob?.step
                                        ? { step: loraTrainJob.step, totalSteps: loraTrainJob.total_steps }
                                        : null
                                    }
                                    startedAt={effLoraStartMs}
                                  />
                                )}
                                <button
                                  type="button"
                                  disabled={
                                    isTrainingActive ||
                                    (Boolean(loraTrainerInfo) && trainableCheckpoints.length === 0) ||
                                    (!(imageGen.referenceImages || []).some((p) => isRasterImageDataUrl(p)) &&
                                      !isRasterImageDataUrl(avatar))
                                  }
                                  onClick={handleTrainLoraOnHub}
                                  className="w-full px-3 py-2 rounded-xl bg-silk-800 hover:bg-silk-700 disabled:opacity-45 border border-silk-700 text-xs font-medium text-violet-300 flex items-center justify-center gap-1.5"
                                >
                                  <Cpu className="w-3.5 h-3.5" />
                                  <span>
                                    {isTrainingActive
                                      ? `${t.loraTrainingProgress} ${Math.round(loraTrainJob?.progress || 0)}%`
                                      : t.loraTrainDatasetBtn}
                                  </span>
                                </button>
                                {loraTrainerInfo?.warning && (
                                  <p className="text-[10px] text-amber-400/90 mt-1">
                                    {loraTrainerInfo.warning.includes('>= 6 GB VRAM')
                                      ? t.loraTrainWarnLowVram
                                      : loraTrainerInfo.warning}
                                  </p>
                                )}
                                {loraTrainJob?.error && (
                                  <p className="text-[10px] text-rose-400 mt-1">
                                    {loraTrainJob.error.includes('Compressed .gguf files are inference-only') ||
                                    loraTrainJob.error.includes('requires a full .safetensors/.ckpt base checkpoint')
                                      ? t.loraTrainErrNoCheckpoint
                                      : loraTrainJob.error.includes('LoRA trainer environment is not installed')
                                        ? t.loraTrainErrEnvMissing
                                        : loraTrainJob.error.includes('CPU-only PyTorch') || loraTrainJob.error.includes('CUDA GPU')
                                          ? t.loraTrainErrCudaMissing
                                          : loraTrainJob.error}
                                  </p>
                                )}
                                {!loraTrainerInfo && !availableLoras.length && !isLoadingLoras && (
                                  <p className="text-[10px] text-slate-500 mt-1">{t.loraTrainNoHub}</p>
                                )}
                              </div>
                            </div>
                          );
                        })()}
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* AI Generator Modal */}
      {showGeneratorModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 animate-fade-in">
          <div className="w-full max-w-sm max-h-[90vh] bg-silk-900 border border-silk-700 rounded-2xl flex flex-col overflow-hidden">
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
                  <div className="absolute left-0 right-0 top-full mt-1 z-20 bg-silk-850 border border-silk-700 rounded-xl overflow-hidden max-h-36 overflow-y-auto text-xs">
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
              {isGenerating && (
                <ActivityProgressBar
                  accent="violet"
                  language={language}
                  label={t.generating}
                  startedAt={genStartedAt}
                />
              )}
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

      <SceneGuideModal
        isOpen={showSceneGuide}
        onClose={() => setShowSceneGuide(false)}
        language={language}
      />
    </div>
  );
};
