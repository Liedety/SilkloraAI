import React, { useState, useEffect, useRef } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import {
  Key,
  Plus,
  Trash2,
  Check,
  RefreshCw,
  Sparkles,
  Palette,
  Eye,
  Type,
  Sliders,
  Edit2,
  X,
  Search,
  FileText,
  Download,
  Upload,
  RotateCcw,
  Cloud,
  Monitor,
  Wifi,
  Activity,
  Info,
  Shield,
} from 'lucide-react';
import { db, DEFAULT_THEME, APP_THEMES, getLocalizedTextStyle } from '../db';
import type {
  ApiKeyConfig,
  ApiProvider,
  AppSettings,
  Language,
  TextStylePreset,
  ThemeConfig,
} from '../types';
import { translations } from '../i18n';
import { fetchAvailableModels, fetchVisionModels, pingLocalServer, normalizeLocalServerUrl } from '../services/ai';
import { DEFAULT_CORE_SYSTEM_PROMPT } from '../services/promptBuilder';
import { ChatPreviewCard } from '../components/ChatPreviewCard';

interface SettingsViewProps {
  language: Language;
  onLanguageChange: (lang: Language) => void;
  onDirtyChange: (dirty: boolean, saveAction?: () => Promise<void>) => void;
}

export const SettingsView: React.FC<SettingsViewProps> = ({
  language,
  onLanguageChange,
  onDirtyChange,
}) => {
  const t = translations[language];

  // Queries
  const settings = useLiveQuery(() => db.settings.get('default'));
  const apiKeys = useLiveQuery(() => db.apiKeys.toArray()) || [];
  const textStyles = useLiveQuery(() => db.textStyles.toArray()) || [];

  // Local AI Hub State
  const aiEngineMode = settings?.aiEngineMode || 'cloud';
  const [localServerUrl, setLocalServerUrl] = useState(
    settings?.localHubUrl || 'http://192.168.1.55:8080/v1'
  );
  const [isPinging, setIsPinging] = useState(false);
  const [pingResult, setPingResult] = useState<{
    ok: boolean;
    pingMs: number;
    activeModel?: string;
    error?: string;
  } | null>(null);

  useEffect(() => {
    if (settings?.localHubUrl) {
      setLocalServerUrl(settings.localHubUrl);
    }
  }, [settings?.localHubUrl]);

  const handleSetAiEngineMode = async (mode: 'cloud' | 'local') => {
    await db.settings.update('default', { aiEngineMode: mode });
  };

  const handleUpdateLocalServerUrl = async (val: string) => {
    setLocalServerUrl(val);
    await db.settings.update('default', { localHubUrl: val });
  };

  const handlePingServer = async () => {
    setIsPinging(true);
    setPingResult(null);
    try {
      const res = await pingLocalServer(localServerUrl);
      setPingResult(res);
      if (res.ok) {
        const normalized = normalizeLocalServerUrl(localServerUrl);
        if (normalized !== localServerUrl) {
          setLocalServerUrl(normalized);
          await db.settings.update('default', { localHubUrl: normalized });
        }
      }
    } catch (err: any) {
      setPingResult({
        ok: false,
        pingMs: 0,
        error: err.message || 'Error',
      });
    } finally {
      setIsPinging(false);
    }
  };

  // API Key Form State
  const [showAddKey, setShowAddKey] = useState(false);
  const [keyName, setKeyName] = useState('');
  const [keyProvider, setKeyProvider] = useState<ApiProvider>('openrouter');
  const [keyValue, setKeyValue] = useState('');
  const [keyBaseUrl, setKeyBaseUrl] = useState('');

  // Text Model Selector State
  const [modelFilter, setModelFilter] = useState<'all' | 'free' | 'paid'>('all');
  const [textModelSearch, setTextModelSearch] = useState('');
  const [customModelInput, setCustomModelInput] = useState('');
  const [availableModels, setAvailableModels] = useState<
    Array<{ id: string; name: string; pricing?: { prompt: number } }>
  >([]);
  const [isLoadingModels, setIsLoadingModels] = useState(false);

  // Vision Model Selector State
  const [visionModelSearch, setVisionModelSearch] = useState('');
  const [visionModelFilter, setVisionModelFilter] = useState<'all' | 'free' | 'paid'>('all');
  const [availableVisionModels, setAvailableVisionModels] = useState<
    Array<{ id: string; name: string; pricing?: { prompt: number } }>
  >([]);
  const [isLoadingVisionModels, setIsLoadingVisionModels] = useState(false);
  const [customVisionInput, setCustomVisionInput] = useState('');

  // Text Style Modal State
  const [showStyleModal, setShowStyleModal] = useState(false);
  const [editingStyleId, setEditingStyleId] = useState<string | null>(null);
  const [styleName, setStyleName] = useState('');
  const [styleDesc, setStyleDesc] = useState('');
  const [styleInstruction, setStyleInstruction] = useState('');

  // System Prompt Customization State
  const [customPrompt, setCustomPrompt] = useState(settings?.customSystemPrompt ?? '');
  const [promptFeedback, setPromptFeedback] = useState<string | null>(null);
  const promptFileInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (settings) {
      setCustomPrompt(settings.customSystemPrompt || '');
    }
  }, [settings?.customSystemPrompt]);

  const handleDownloadPrompt = () => {
    const content = customPrompt || DEFAULT_CORE_SYSTEM_PROMPT;
    const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'silklora-system-prompt.txt';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    setPromptFeedback(language === 'ru' ? 'Файл silklora-system-prompt.txt скачан' : 'silklora-system-prompt.txt downloaded');
    setTimeout(() => setPromptFeedback(null), 2500);
  };

  const handleUploadPromptFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    if (file.size > 1024 * 1024) {
      alert(language === 'ru' ? 'Файл слишком большой (максимум 1 МБ)' : 'File is too large (maximum 1 MB)');
      e.target.value = '';
      return;
    }

    const reader = new FileReader();
    reader.onerror = () => {
      setPromptFeedback(language === 'ru' ? 'Ошибка чтения файла' : 'Failed to read file');
      setTimeout(() => setPromptFeedback(null), 2500);
    };
    reader.onload = async (ev) => {
      const text = ev.target?.result;
      if (typeof text === 'string' && text.trim()) {
        let contentToUse = text;
        try {
          const parsed = JSON.parse(text);
          if (parsed && typeof parsed === 'object') {
            if (typeof parsed.customSystemPrompt === 'string') {
              contentToUse = parsed.customSystemPrompt;
            } else if (typeof parsed.prompt === 'string') {
              contentToUse = parsed.prompt;
            }
          }
        } catch {
          // Plain text format
        }

        setCustomPrompt(contentToUse);
        await db.settings.update('default', {
          customSystemPrompt: contentToUse,
          customSystemPromptMode: 'override',
        });
        setPromptFeedback(language === 'ru' ? 'Шаблон .txt успешно загружен!' : 'Custom .txt prompt loaded successfully!');
        setTimeout(() => setPromptFeedback(null), 2500);
      }
    };
    reader.readAsText(file);
    e.target.value = '';
  };

  const handleResetPromptToDefault = async () => {
    setCustomPrompt('');
    await db.settings.update('default', {
      customSystemPrompt: '',
      customSystemPromptMode: 'augment',
    });
    setPromptFeedback(t.promptResetSuccess);
    setTimeout(() => setPromptFeedback(null), 2500);
  };

  // Theme settings local state
  const currentTheme = settings?.theme || DEFAULT_THEME;

  const handleUpdateTheme = async (updates: Partial<ThemeConfig>) => {
    if (!settings) return;
    const updatedTheme = { ...currentTheme, ...updates };
    await db.settings.update('default', { theme: updatedTheme });
  };

  // Select App Theme preset while strictly preserving user's typography settings (font family, size, line height)
  const handleSelectAppTheme = async (themePreset: ThemeConfig) => {
    if (!settings) return;
    const current = currentTheme;
    const updatedTheme: ThemeConfig = {
      ...themePreset,
      fontSize: current.fontSize,
      fontFamily: current.fontFamily,
      lineHeight: current.lineHeight,
    };
    await db.settings.update('default', { theme: updatedTheme });
  };

  // API Key actions
  const handleSaveApiKey = async () => {
    if (!keyValue.trim()) return;
    const isFirst = apiKeys.length === 0;
    const newConfig: ApiKeyConfig = {
      id: 'key-' + Math.random().toString(36).substring(2, 9),
      name: keyName.trim() || `${keyProvider.toUpperCase()} Key`,
      provider: keyProvider,
      key: keyValue.trim(),
      baseUrl: keyBaseUrl.trim() || undefined,
      isActive: isFirst,
    };
    await db.apiKeys.put(newConfig);
    setKeyName('');
    setKeyValue('');
    setKeyBaseUrl('');
    setShowAddKey(false);
  };

  const handleSetActiveKey = async (id: string) => {
    for (const k of apiKeys) {
      await db.apiKeys.update(k.id, { isActive: k.id === id });
    }
  };

  const handleDeleteKey = async (id: string) => {
    await db.apiKeys.delete(id);
  };

  // Fetch Models
  const handleRefreshModels = async () => {
    const activeKey = apiKeys.find((k) => k.isActive);
    if (!activeKey) {
      alert(t.activateKeyFirst);
      return;
    }
    setIsLoadingModels(true);
    try {
      const list = await fetchAvailableModels(activeKey);
      setAvailableModels(list);
    } catch (err: any) {
      alert(`${t.failedLoadModels}: ${err.message}`);
    } finally {
      setIsLoadingModels(false);
    }
  };

  const handleSelectTextModel = async (modelId: string) => {
    await db.settings.update('default', { textModel: modelId });
  };

  const handleSelectVisionModel = async (modelId: string) => {
    await db.settings.update('default', { visionModel: modelId });
  };

  const handleRefreshVisionModels = async () => {
    const activeKey = apiKeys.find((k) => k.isActive);
    if (!activeKey) {
      alert(t.activateKeyFirst);
      return;
    }
    setIsLoadingVisionModels(true);
    try {
      const list = await fetchVisionModels(activeKey);
      setAvailableVisionModels(list);
    } catch (err: any) {
      alert(`${t.failedLoadVisionModels}: ${err.message}`);
    } finally {
      setIsLoadingVisionModels(false);
    }
  };

  // Text Style Actions
  const handleOpenCreateStyle = () => {
    setEditingStyleId(null);
    setStyleName('');
    setStyleDesc('');
    setStyleInstruction('');
    setShowStyleModal(true);
  };

  const handleOpenEditStyle = (st: TextStylePreset) => {
    setEditingStyleId(st.id);
    setStyleName(st.name);
    setStyleDesc(st.description);
    setStyleInstruction(st.instruction);
    setShowStyleModal(true);
  };

  const handleSaveStyle = async () => {
    if (!styleName.trim() || !styleInstruction.trim()) return;
    const styleData: TextStylePreset = {
      id: editingStyleId || 'style-' + Math.random().toString(36).substring(2, 9),
      name: styleName.trim(),
      description: styleDesc.trim(),
      instruction: styleInstruction.trim(),
      isCustom: true,
    };
    await db.textStyles.put(styleData);
    setShowStyleModal(false);
  };

  const handleDeleteStyle = async (id: string) => {
    await db.textStyles.delete(id);
    if (settings?.textStyleId === id) {
      await db.settings.update('default', { textStyleId: 'immersive' });
    }
  };

  // Filter text models
  const rawTextModels = (availableModels.length > 0 ? availableModels : [
    { id: 'deepseek/deepseek-chat', name: 'DeepSeek V3 (Uncensored & Fast)', pricing: { prompt: 0.0001 } },
    { id: 'deepseek/deepseek-r1', name: 'DeepSeek R1 (Reasoning)', pricing: { prompt: 0.0005 } },
    { id: 'anthropic/claude-3.5-sonnet', name: 'Claude 3.5 Sonnet', pricing: { prompt: 0.003 } },
    { id: 'openai/gpt-4o', name: 'GPT-4o (Vision & Fast)', pricing: { prompt: 0.0025 } },
    { id: 'openai/gpt-4o-mini', name: 'GPT-4o Mini', pricing: { prompt: 0 } },
    { id: 'google/gemini-2.0-flash-exp:free', name: 'Gemini 2.0 Flash (Free)', pricing: { prompt: 0 } },
    { id: 'meta-llama/llama-3.3-70b-instruct', name: 'Llama 3.3 70B', pricing: { prompt: 0.0002 } },
    { id: 'nousresearch/hermes-3-llama-3.1-405b', name: 'Hermes 3 405B (Uncensored)', pricing: { prompt: 0.001 } },
  ]);

  const filteredTextModels = rawTextModels.filter((m) => {
    if (modelFilter === 'free' && (m.pricing?.prompt || 0) > 0) return false;
    if (modelFilter === 'paid' && (m.pricing?.prompt || 0) === 0) return false;
    if (textModelSearch.trim()) {
      const q = textModelSearch.toLowerCase();
      return m.name.toLowerCase().includes(q) || m.id.toLowerCase().includes(q);
    }
    return true;
  });

  // Filter vision models
  const rawVisionModels = (availableVisionModels.length > 0 ? availableVisionModels : [
    { id: 'google/gemini-2.0-flash-exp:free', name: 'Gemini 2.0 Flash Vision (Free)', pricing: { prompt: 0 } },
    { id: 'google/gemini-flash-1.5', name: 'Gemini 1.5 Flash (Fast Multimodal)', pricing: { prompt: 0.0001 } },
    { id: 'google/gemini-pro-1.5', name: 'Gemini 1.5 Pro (Deep Multimodal)', pricing: { prompt: 0.00125 } },
    { id: 'openai/gpt-4o-mini', name: 'GPT-4o Mini Vision (Budget)', pricing: { prompt: 0.00015 } },
    { id: 'openai/gpt-4o', name: 'GPT-4o (High Detail Vision)', pricing: { prompt: 0.0025 } },
    { id: 'anthropic/claude-3.5-sonnet', name: 'Claude 3.5 Sonnet (Vision)', pricing: { prompt: 0.003 } },
    { id: 'qwen/qwen-2-vl-72b-instruct', name: 'Qwen 2 VL 72B (Open Weights)', pricing: { prompt: 0.0004 } },
    { id: 'meta-llama/llama-3.2-11b-vision-instruct', name: 'Llama 3.2 11B Vision (Free/Budget)', pricing: { prompt: 0 } },
  ]);

  const filteredVisionModels = rawVisionModels.filter((m) => {
    if (visionModelFilter === 'free' && (m.pricing?.prompt || 0) > 0) return false;
    if (visionModelFilter === 'paid' && (m.pricing?.prompt || 0) === 0) return false;
    if (visionModelSearch.trim()) {
      const q = visionModelSearch.toLowerCase();
      return m.name.toLowerCase().includes(q) || m.id.toLowerCase().includes(q);
    }
    return true;
  });

  return (
    <div className="flex flex-col h-full overflow-hidden bg-silk-950 text-slate-100">
      {/* Top Header */}
      <div className="p-4 border-b border-silk-800/80 bg-silk-900/60 backdrop-blur-md">
        <h1 className="text-xl font-bold tracking-tight text-white">{t.settingsTitle}</h1>
      </div>

      {/* Main Settings Scroll */}
      <div className="flex-1 overflow-y-auto p-4 space-y-6 pb-28">
        {/* AI Engine Mode Switcher: Cloud vs Local PC */}
        <div className="p-4 rounded-2xl bg-silk-900/80 border border-silk-800 space-y-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-slate-400">
              <Monitor className="w-4 h-4 text-violet-400" />
              <span>{t.sectionAiEngineMode}</span>
            </div>
            <span
              className={`text-[10px] px-2 py-0.5 rounded-full font-semibold uppercase tracking-wider ${
                aiEngineMode === 'local'
                  ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/30'
                  : 'bg-violet-500/20 text-violet-300 border border-violet-500/30'
              }`}
            >
              {aiEngineMode === 'local' ? 'Local Hub' : 'Cloud'}
            </span>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <button
              type="button"
              onClick={() => handleSetAiEngineMode('cloud')}
              className={`py-2.5 px-3 rounded-xl text-xs font-semibold border flex items-center justify-center gap-2 transition-all ${
                aiEngineMode === 'cloud'
                  ? 'bg-violet-600 border-violet-500 text-white shadow-lg shadow-violet-600/30'
                  : 'bg-silk-800 border-silk-700 text-slate-400 hover:text-white'
              }`}
            >
              <Cloud className="w-4 h-4" />
              <span>{t.aiModeCloud}</span>
            </button>
            <button
              type="button"
              onClick={() => handleSetAiEngineMode('local')}
              className={`py-2.5 px-3 rounded-xl text-xs font-semibold border flex items-center justify-center gap-2 transition-all ${
                aiEngineMode === 'local'
                  ? 'bg-violet-600 border-violet-500 text-white shadow-lg shadow-violet-600/30'
                  : 'bg-silk-800 border-silk-700 text-slate-400 hover:text-white'
              }`}
            >
              <Monitor className="w-4 h-4" />
              <span>{t.aiModeLocal}</span>
            </button>
          </div>
        </div>

        {/* 1. Language Section */}
        <div className="p-4 rounded-2xl bg-silk-900/80 border border-silk-800 space-y-3">
          <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-slate-400">
            <Sliders className="w-4 h-4 text-violet-400" />
            <span>{t.sectionLanguage}</span>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <button
              type="button"
              onClick={() => onLanguageChange('en')}
              className={`py-2 px-3 rounded-xl text-xs font-semibold border transition-all ${
                language === 'en'
                  ? 'bg-violet-600 border-violet-500 text-white shadow-md'
                  : 'bg-silk-800 border-silk-700 text-slate-400 hover:text-white'
              }`}
            >
              English (Default)
            </button>
            <button
              type="button"
              onClick={() => onLanguageChange('ru')}
              className={`py-2 px-3 rounded-xl text-xs font-semibold border transition-all ${
                language === 'ru'
                  ? 'bg-violet-600 border-violet-500 text-white shadow-md'
                  : 'bg-silk-800 border-silk-700 text-slate-400 hover:text-white'
              }`}
            >
              Русский
            </button>
          </div>
        </div>

        {aiEngineMode === 'local' ? (
          /* LOCAL AI HUB SECTION (Replaces Cloud Keys & Models) */
          <div className="p-4 rounded-2xl bg-silk-900/80 border border-silk-800 space-y-4 shadow-xl">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-slate-400">
                <Wifi className="w-4 h-4 text-emerald-400" />
                <span>{t.localHubTitle}</span>
              </div>
              <span className="text-[10px] px-2 py-0.5 rounded-full bg-emerald-500/20 text-emerald-300 font-semibold border border-emerald-500/30">
                Wi-Fi Direct
              </span>
            </div>

            <p className="text-[11px] text-slate-400 leading-relaxed">
              {t.localHubDesc}
            </p>

            {/* Server Address Input */}
            <div className="space-y-1.5">
              <label className="block text-xs font-semibold text-slate-300">
                {t.localServerUrlLabel}
              </label>
              <div className="flex gap-2">
                <input
                  type="text"
                  value={localServerUrl}
                  onChange={(e) => handleUpdateLocalServerUrl(e.target.value)}
                  placeholder={t.localServerUrlPlaceholder}
                  className="flex-1 px-3 py-2 bg-silk-800 border border-silk-700 rounded-xl text-xs text-white font-mono placeholder-slate-500 focus:outline-none focus:border-violet-500"
                />
                <button
                  type="button"
                  onClick={handlePingServer}
                  disabled={isPinging}
                  className="px-3.5 py-2 bg-violet-600 hover:bg-violet-500 disabled:opacity-50 text-white rounded-xl text-xs font-semibold flex items-center gap-1.5 shrink-0 shadow-md transition-all active:scale-95"
                >
                  <Activity className={`w-3.5 h-3.5 ${isPinging ? 'animate-spin' : ''}`} />
                  <span>{isPinging ? t.checkingConnection : t.checkConnection}</span>
                </button>
              </div>
            </div>

            {/* Ping Result Status Banner */}
            {pingResult && (
              <div
                className={`p-3 rounded-xl border transition-all ${
                  pingResult.ok
                    ? 'bg-emerald-950/40 border-emerald-500/60 text-emerald-200'
                    : 'bg-rose-950/40 border-rose-500/60 text-rose-200'
                }`}
              >
                <div className="flex items-start gap-2.5">
                  {pingResult.ok ? (
                    <div className="w-2.5 h-2.5 rounded-full bg-emerald-400 mt-1 shrink-0 animate-pulse shadow-[0_0_8px_#34d399]" />
                  ) : (
                    <div className="w-2.5 h-2.5 rounded-full bg-rose-400 mt-1 shrink-0" />
                  )}
                  <div className="flex-1 text-xs space-y-1">
                    <div className="font-semibold flex items-center justify-between">
                      <span>
                        {pingResult.ok
                          ? t.connectionSuccess.replace('{ms}', String(pingResult.pingMs))
                          : t.connectionFailed}
                      </span>
                      {pingResult.ok && (
                        <span className="font-mono text-[10px] px-1.5 py-0.5 rounded bg-emerald-500/20 text-emerald-300">
                          {pingResult.pingMs} ms
                        </span>
                      )}
                    </div>
                    {pingResult.ok && pingResult.activeModel && (
                      <div className="text-[11px] text-emerald-300/90 font-mono">
                        {t.activeModelPc.replace('{model}', pingResult.activeModel)}
                      </div>
                    )}
                    {!pingResult.ok && (
                      <p className="text-[11px] text-rose-300/90 leading-snug">
                        {t.connectionFailedHint.replace('{url}', localServerUrl)}
                      </p>
                    )}
                  </div>
                </div>
              </div>
            )}

            {/* Model Management Notice */}
            <div className="p-3 rounded-xl bg-silk-850/70 border border-silk-800 text-[11px] text-slate-400 flex items-start gap-2">
              <Info className="w-4 h-4 text-violet-400 shrink-0 mt-0.5" />
              <p className="leading-relaxed">
                {t.localModelManagedOnPc}
              </p>
            </div>

            {/* Step-by-Step Wi-Fi Setup Guide */}
            <div className="p-3.5 rounded-xl bg-silk-850 border border-silk-800 space-y-2.5">
              <div className="flex items-center gap-2 text-xs font-semibold text-slate-200">
                <Wifi className="w-4 h-4 text-violet-400 shrink-0" />
                <span>{t.wifiGuideTitle}</span>
              </div>
              <ul className="text-[11px] text-slate-400 space-y-2 leading-relaxed">
                <li className="flex items-start gap-2">
                  <span className="text-violet-400 font-mono font-bold">1.</span>
                  <span>{t.wifiStep1}</span>
                </li>
                <li className="flex items-start gap-2">
                  <span className="text-violet-400 font-mono font-bold">2.</span>
                  <span>{t.wifiStep2}</span>
                </li>
                <li className="flex items-start gap-2">
                  <span className="text-violet-400 font-mono font-bold">3.</span>
                  <span>{t.wifiStep3}</span>
                </li>
                <li className="flex items-start gap-2">
                  <span className="text-violet-400 font-mono font-bold">4.</span>
                  <span>{t.wifiStep4}</span>
                </li>
              </ul>
              <div className="flex items-start gap-1.5 pt-2 border-t border-silk-800/80 text-[10px] text-slate-500">
                <Shield className="w-3.5 h-3.5 shrink-0 mt-0.5 text-slate-400" />
                <span>{t.wifiFirewallTip}</span>
              </div>
            </div>
          </div>
        ) : (
          <>
            {/* 2. API Keys Section */}
            <div className="p-4 rounded-2xl bg-silk-900/80 border border-silk-800 space-y-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-slate-400">
              <Key className="w-4 h-4 text-violet-400" />
              <span>{t.sectionApiKeys}</span>
            </div>
            <button
              onClick={() => setShowAddKey(true)}
              type="button"
              className="flex items-center gap-1 px-2.5 py-1 bg-silk-800 hover:bg-silk-700 rounded-lg text-xs text-violet-400 font-medium"
            >
              <Plus className="w-3.5 h-3.5" />
              <span>{t.addApiKey}</span>
            </button>
          </div>

          {/* Keys List */}
          <div className="space-y-2">
            {apiKeys.length === 0 ? (
              <p className="text-xs text-slate-500 italic py-2">
                {t.noApiKeysPrompt}
              </p>
            ) : (
              apiKeys.map((k) => (
                <div
                  key={k.id}
                  className={`flex items-center justify-between p-3 rounded-xl border transition-all ${
                    k.isActive
                      ? 'bg-violet-950/30 border-violet-500/60'
                      : 'bg-silk-850 border-silk-800'
                  }`}
                >
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="font-semibold text-xs text-white">{k.name}</span>
                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-silk-800 text-slate-400 uppercase font-mono">
                        {k.provider}
                      </span>
                      {k.isActive && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-500/20 text-emerald-400 font-semibold">
                          {t.activeKeyBadge}
                        </span>
                      )}
                    </div>
                    <p className="text-[11px] font-mono text-slate-500 mt-0.5">
                      {k.key ? `••••••••${k.key.slice(-4)}` : '(Empty)'}
                    </p>
                  </div>

                  <div className="flex items-center gap-1">
                    {!k.isActive && (
                      <button
                        onClick={() => handleSetActiveKey(k.id)}
                        type="button"
                        className="p-1.5 text-xs text-slate-400 hover:text-emerald-400 rounded-lg hover:bg-silk-800"
                        title={t.setAsActive}
                      >
                        <Check className="w-4 h-4" />
                      </button>
                    )}
                    <button
                      onClick={() => handleDeleteKey(k.id)}
                      type="button"
                      className="p-1.5 text-xs text-slate-400 hover:text-rose-400 rounded-lg hover:bg-silk-800"
                      title={t.deleteKey}
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                </div>
              ))
            )}
          </div>

          {/* Add Key Sub-form */}
          {showAddKey && (
            <div className="p-3.5 rounded-xl bg-silk-850 border border-silk-700 space-y-3 mt-2">
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold text-white">{t.addApiKey}</span>
                <button
                  onClick={() => setShowAddKey(false)}
                  className="text-slate-400 hover:text-white"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>

              <div>
                <label className="block text-[11px] text-slate-400 mb-1">{t.apiKeyName}</label>
                <input
                  type="text"
                  value={keyName}
                  onChange={(e) => setKeyName(e.target.value)}
                  placeholder="e.g. My OpenRouter Key"
                  className="w-full px-3 py-1.5 bg-silk-800 border border-silk-700 rounded-lg text-xs text-white"
                />
              </div>

              <div>
                <label className="block text-[11px] text-slate-400 mb-1">{t.apiProvider}</label>
                <select
                  value={keyProvider}
                  onChange={(e) => setKeyProvider(e.target.value as ApiProvider)}
                  className="w-full px-3 py-1.5 bg-silk-800 border border-silk-700 rounded-lg text-xs text-white"
                >
                  <option value="openrouter">OpenRouter (Recommended)</option>
                  <option value="openai">OpenAI</option>
                  <option value="anthropic">Anthropic (Claude)</option>
                  <option value="gemini">Google Gemini</option>
                  <option value="groq">Groq</option>
                  <option value="deepseek">DeepSeek</option>
                  <option value="custom">Custom (Local / vLLM / Ollama)</option>
                </select>
              </div>

              <div>
                <label className="block text-[11px] text-slate-400 mb-1">{t.apiKeyValue}</label>
                <input
                  type="password"
                  value={keyValue}
                  onChange={(e) => setKeyValue(e.target.value)}
                  placeholder="sk-..."
                  className="w-full px-3 py-1.5 bg-silk-800 border border-silk-700 rounded-lg text-xs text-white font-mono"
                />
              </div>

              <div>
                <label className="block text-[11px] text-slate-400 mb-1">{t.baseUrlOptional}</label>
                <input
                  type="text"
                  value={keyBaseUrl}
                  onChange={(e) => setKeyBaseUrl(e.target.value)}
                  placeholder="http://localhost:11434/v1"
                  className="w-full px-3 py-1.5 bg-silk-800 border border-silk-700 rounded-lg text-xs text-white"
                />
              </div>

              <div className="flex justify-end gap-2 pt-1">
                <button
                  onClick={() => setShowAddKey(false)}
                  type="button"
                  className="px-3 py-1.5 text-xs text-slate-400 hover:text-white"
                >
                  {t.cancel}
                </button>
                <button
                  onClick={handleSaveApiKey}
                  type="button"
                  className="px-4 py-1.5 text-xs font-medium text-white bg-violet-600 hover:bg-violet-500 rounded-lg"
                >
                  {t.saveKey}
                </button>
              </div>
            </div>
          )}
        </div>

        {/* 3. Text & RP Model Selector */}
        <div className="p-4 rounded-2xl bg-silk-900/80 border border-silk-800 space-y-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-slate-400">
              <Sparkles className="w-4 h-4 text-violet-400" />
              <span>{t.sectionTextModel}</span>
            </div>
            <button
              onClick={handleRefreshModels}
              disabled={isLoadingModels}
              type="button"
              className="flex items-center gap-1 text-xs text-violet-400 hover:text-violet-300"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${isLoadingModels ? 'animate-spin' : ''}`} />
              <span>{t.fetchModels}</span>
            </button>
          </div>

          <div className="text-xs text-slate-300">
            {t.selectedModel}: <span className="font-mono text-violet-400 font-semibold">{settings?.textModel}</span>
          </div>

          {/* Custom input */}
          <div className="flex gap-2">
            <input
              type="text"
              value={customModelInput}
              onChange={(e) => setCustomModelInput(e.target.value)}
              placeholder="e.g. deepseek/deepseek-chat"
              className="flex-1 px-3 py-1.5 bg-silk-800 border border-silk-700 rounded-lg text-xs text-white font-mono"
            />
            <button
              onClick={() => {
                if (customModelInput.trim()) {
                  handleSelectTextModel(customModelInput.trim());
                  setCustomModelInput('');
                }
              }}
              type="button"
              className="px-3 py-1.5 bg-violet-600 hover:bg-violet-500 text-white rounded-lg text-xs font-medium"
            >
              {t.applyModel}
            </button>
          </div>

          {/* Search Text Models Input */}
          <div className="relative">
            <Search className="w-3.5 h-3.5 absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
            <input
              type="text"
              value={textModelSearch}
              onChange={(e) => setTextModelSearch(e.target.value)}
              placeholder={t.searchModelsPlaceholder}
              className="w-full pl-8 pr-3 py-1.5 bg-silk-800 border border-silk-700 rounded-lg text-xs text-white placeholder-slate-500 focus:outline-none focus:border-violet-500"
            />
          </div>

          {/* Model Filter Pills */}
          <div className="flex items-center gap-1.5 pt-1">
            {(['all', 'free', 'paid'] as const).map((f) => (
              <button
                key={f}
                type="button"
                onClick={() => setModelFilter(f)}
                className={`px-2.5 py-1 rounded-md text-[11px] font-medium transition-all ${
                  modelFilter === f
                    ? 'bg-violet-600 text-white'
                    : 'bg-silk-800 text-slate-400 hover:text-white'
                }`}
              >
                {f === 'all' ? t.modelFilterAll : f === 'free' ? t.modelFilterFree : t.modelFilterPaid}
              </button>
            ))}
          </div>

          {/* Compact Selectable Models List */}
          <div className="max-h-48 overflow-y-auto space-y-1.5 pr-1">
            {filteredTextModels.length === 0 ? (
              <div className="text-xs text-slate-500 italic p-2 text-center">{t.noMatchingModels}</div>
            ) : (
              filteredTextModels.map((m) => {
                const isSelected = settings?.textModel === m.id;
                return (
                  <button
                    key={m.id}
                    onClick={() => handleSelectTextModel(m.id)}
                    type="button"
                    className={`w-full flex items-center justify-between p-2.5 rounded-xl border text-left transition-all ${
                      isSelected
                        ? 'bg-violet-600/20 border-violet-500 text-white'
                        : 'bg-silk-850 border-silk-800 text-slate-300 hover:text-white'
                    }`}
                  >
                    <div className="truncate pr-2">
                      <div className="text-xs font-medium truncate">{m.name}</div>
                      <div className="text-[10px] font-mono text-slate-500 truncate">{m.id}</div>
                    </div>
                    {isSelected && <Check className="w-4 h-4 text-violet-400 shrink-0" />}
                  </button>
                );
              })
            )}
          </div>
        </div>

        {/* 4. Vision Model Selector */}
        <div className="p-4 rounded-2xl bg-silk-900/80 border border-silk-800 space-y-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-slate-400">
              <Eye className="w-4 h-4 text-violet-400" />
              <span>{t.sectionVisionModel}</span>
            </div>
            <button
              onClick={handleRefreshVisionModels}
              disabled={isLoadingVisionModels}
              type="button"
              className="flex items-center gap-1 text-xs text-violet-400 hover:text-violet-300"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${isLoadingVisionModels ? 'animate-spin' : ''}`} />
              <span>{t.fetchVisionModels}</span>
            </button>
          </div>
          <p className="text-[11px] text-slate-400 leading-snug">{t.visionModelDesc}</p>

          <div className="text-xs text-slate-300">
            {t.selectedModel}: <span className="font-mono text-violet-400 font-semibold">{settings?.visionModel}</span>
          </div>

          <div className="flex gap-2">
            <input
              type="text"
              value={customVisionInput}
              onChange={(e) => setCustomVisionInput(e.target.value)}
              placeholder="e.g. google/gemini-flash-1.5"
              className="flex-1 px-3 py-1.5 bg-silk-800 border border-silk-700 rounded-lg text-xs text-white font-mono"
            />
            <button
              onClick={() => {
                if (customVisionInput.trim()) {
                  handleSelectVisionModel(customVisionInput.trim());
                  setCustomVisionInput('');
                }
              }}
              type="button"
              className="px-3 py-1.5 bg-violet-600 hover:bg-violet-500 text-white rounded-lg text-xs font-medium"
            >
              {t.applyModel}
            </button>
          </div>

          {/* Search Vision Models Input */}
          <div className="relative">
            <Search className="w-3.5 h-3.5 absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
            <input
              type="text"
              value={visionModelSearch}
              onChange={(e) => setVisionModelSearch(e.target.value)}
              placeholder={t.searchVisionPlaceholder}
              className="w-full pl-8 pr-3 py-1.5 bg-silk-800 border border-silk-700 rounded-lg text-xs text-white placeholder-slate-500 focus:outline-none focus:border-violet-500"
            />
          </div>

          {/* Vision Filter Pills */}
          <div className="flex items-center gap-1.5 pt-1">
            {(['all', 'free', 'paid'] as const).map((f) => (
              <button
                key={f}
                type="button"
                onClick={() => setVisionModelFilter(f)}
                className={`px-2.5 py-1 rounded-md text-[11px] font-medium transition-all ${
                  visionModelFilter === f
                    ? 'bg-violet-600 text-white'
                    : 'bg-silk-800 text-slate-400 hover:text-white'
                }`}
              >
                {f === 'all' ? t.modelFilterAll : f === 'free' ? t.modelFilterFree : t.modelFilterPaid}
              </button>
            ))}
          </div>

          <div className="space-y-1.5 max-h-40 overflow-y-auto pr-1">
            {filteredVisionModels.length === 0 ? (
              <div className="text-xs text-slate-500 italic p-2 text-center">{t.noMatchingModels}</div>
            ) : (
              filteredVisionModels.map((m) => {
                const isSelected = settings?.visionModel === m.id;
                return (
                  <button
                    key={m.id}
                    onClick={() => handleSelectVisionModel(m.id)}
                    type="button"
                    className={`w-full flex items-center justify-between p-2 rounded-xl border text-left transition-all ${
                      isSelected
                        ? 'bg-violet-600/20 border-violet-500 text-white'
                        : 'bg-silk-850 border-silk-800 text-slate-300 hover:text-white'
                    }`}
                  >
                    <div className="truncate pr-2">
                      <div className="text-xs font-medium truncate">{m.name}</div>
                      <div className="text-[10px] font-mono text-slate-500 truncate">{m.id}</div>
                    </div>
                    {isSelected && <Check className="w-4 h-4 text-violet-400 shrink-0" />}
                  </button>
                );
              })
            )}
          </div>
        </div>
      </>
    )}

        {/* 5. Text & RP Styles */}
        <div className="p-4 rounded-2xl bg-silk-900/80 border border-silk-800 space-y-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-slate-400">
              <Type className="w-4 h-4 text-violet-400" />
              <span>{t.sectionStyles}</span>
            </div>
            <button
              onClick={handleOpenCreateStyle}
              type="button"
              className="flex items-center gap-1 text-xs text-violet-400 hover:text-violet-300"
            >
              <Plus className="w-3.5 h-3.5" />
              <span>{t.createStyle}</span>
            </button>
          </div>

          <div className="space-y-2">
            {textStyles.map((rawSt) => {
              const st = getLocalizedTextStyle(rawSt, language);
              const isSelected = settings?.textStyleId === rawSt.id;
              return (
                <div
                  key={rawSt.id}
                  onClick={() => db.settings.update('default', { textStyleId: rawSt.id })}
                  className={`p-3 rounded-xl border transition-all cursor-pointer select-none ${
                    isSelected
                      ? 'bg-violet-950/30 border-violet-500'
                      : 'bg-silk-850 border-silk-800 hover:border-silk-700'
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-semibold text-white">{st.name}</span>
                      {st.isCustom && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-violet-600/30 text-violet-300 font-medium">
                          {t.customStyleBadge}
                        </span>
                      )}
                    </div>
                    <div className="flex items-center gap-1">
                      {st.isCustom && (
                        <>
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              handleOpenEditStyle(st);
                            }}
                            type="button"
                            className="p-1 text-slate-400 hover:text-white"
                          >
                            <Edit2 className="w-3 h-3" />
                          </button>
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              handleDeleteStyle(st.id);
                            }}
                            type="button"
                            className="p-1 text-slate-400 hover:text-rose-400"
                          >
                            <Trash2 className="w-3 h-3" />
                          </button>
                        </>
                      )}
                      {isSelected && <Check className="w-4 h-4 text-violet-400 shrink-0 ml-1" />}
                    </div>
                  </div>
                  <p className="text-[11px] text-slate-400 mt-1 line-clamp-2 leading-relaxed">
                    {st.description}
                  </p>
                </div>
              );
            })}
          </div>
        </div>

        {/* 6. System Prompt Settings */}
        <div className="p-4 rounded-2xl bg-silk-900/80 border border-silk-800 space-y-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-slate-400">
              <FileText className="w-4 h-4 text-violet-400" />
              <span>{t.sectionSystemPrompt}</span>
            </div>
            {promptFeedback && (
              <span className="text-[11px] font-medium text-emerald-400 animate-fade-in flex items-center gap-1">
                <Check className="w-3.5 h-3.5" />
                <span>{promptFeedback}</span>
              </span>
            )}
          </div>

          {/* Standard .txt File Viewer with Base Censorship Bypass Template */}
          <div className="rounded-xl border border-silk-750 bg-silk-950 overflow-hidden shadow-inner">
            <div className="px-3 py-2 bg-silk-900/90 border-b border-silk-800 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <FileText className="w-3.5 h-3.5 text-violet-400" />
                <span className="text-xs font-mono font-medium text-slate-200">silklora-system-prompt.txt</span>
                <span className="text-[10px] px-1.5 py-0.5 rounded bg-violet-500/20 text-violet-300 font-mono">
                  {customPrompt ? (language === 'ru' ? 'пользовательский' : 'custom') : (language === 'ru' ? 'базовый' : 'standard')}
                </span>
              </div>
              {customPrompt && (
                <button
                  type="button"
                  onClick={handleResetPromptToDefault}
                  className="px-2 py-0.5 text-[10px] text-slate-400 hover:text-white bg-silk-850 hover:bg-silk-800 rounded border border-silk-750 transition-all flex items-center gap-1"
                  title={t.resetToDefaultPrompt}
                >
                  <RotateCcw className="w-3 h-3" />
                  <span>{language === 'ru' ? 'Вернуть базовый' : 'Reset'}</span>
                </button>
              )}
            </div>
            <div className="p-3 max-h-40 overflow-y-auto text-[11px] font-mono text-slate-300 whitespace-pre-wrap leading-relaxed select-text select-all">
              {customPrompt || DEFAULT_CORE_SYSTEM_PROMPT}
            </div>
          </div>

          {/* Download & Upload Buttons */}
          <div className="grid grid-cols-2 gap-2 pt-1">
            <button
              type="button"
              onClick={handleDownloadPrompt}
              className="flex items-center justify-center gap-2 py-2.5 px-3 bg-silk-850 hover:bg-silk-800 text-slate-200 hover:text-white rounded-xl text-xs font-semibold border border-silk-750 shadow-sm active:scale-98 transition-all"
            >
              <Download className="w-4 h-4 text-violet-400" />
              <span>{t.downloadPrompt}</span>
            </button>

            <label className="flex items-center justify-center gap-2 py-2.5 px-3 bg-violet-600 hover:bg-violet-500 text-white rounded-xl text-xs font-semibold shadow-md active:scale-98 transition-all cursor-pointer">
              <Upload className="w-4 h-4 text-white" />
              <span>{t.uploadPrompt}</span>
              <input
                ref={promptFileInputRef}
                type="file"
                accept=".txt"
                onChange={handleUploadPromptFile}
                className="hidden"
              />
            </label>
          </div>
        </div>

        {/* 7. Application Themes (Design & Interface) */}
        <div className="p-4 rounded-2xl bg-silk-900/80 border border-silk-800 space-y-4">
          <div>
            <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-slate-400">
              <Palette className="w-4 h-4 text-violet-400" />
              <span>{t.sectionAppThemes}</span>
            </div>
            <p className="text-[11px] text-slate-400 mt-1 leading-snug">{t.sectionAppThemesDesc}</p>
          </div>

          {/* Theme Presets */}
          <div className="grid grid-cols-2 gap-2">
            {APP_THEMES.map((pt) => {
              const isSelected = currentTheme.id === pt.id;
              return (
                <button
                  key={pt.id}
                  onClick={() => handleSelectAppTheme(pt.theme)}
                  type="button"
                  className={`p-2.5 rounded-xl border text-left transition-all ${
                    isSelected
                      ? 'bg-violet-600/20 border-violet-500 text-white'
                      : 'bg-silk-850 border-silk-800 text-slate-400 hover:text-white'
                  }`}
                >
                  <div className="flex items-center gap-2">
                    <span
                      className="w-3.5 h-3.5 rounded-full shrink-0 shadow-sm"
                      style={{ backgroundColor: pt.theme.accentColor }}
                    />
                    <span className="text-xs font-medium truncate">{pt.name}</span>
                  </div>
                </button>
              );
            })}
          </div>

          {/* Custom App Colors: Accent, Action, Background, Surface */}
          <div className="space-y-3 pt-1 border-t border-silk-800/80">
            <h4 className="text-xs font-semibold text-slate-300">
              {language === 'ru' ? 'Палитра дизайна интерфейса:' : 'App Interface Palette:'}
            </h4>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-[11px] text-slate-400 mb-1">{t.accentColor}</label>
                <div className="flex items-center gap-2 bg-silk-800 p-1.5 rounded-xl border border-silk-700">
                  <input
                    type="color"
                    value={currentTheme.accentColor}
                    onChange={(e) => handleUpdateTheme({ accentColor: e.target.value })}
                    className="w-7 h-7 rounded border-0 cursor-pointer bg-transparent"
                  />
                  <span className="text-xs font-mono text-slate-300">{currentTheme.accentColor}</span>
                </div>
              </div>

              <div>
                <label className="block text-[11px] text-slate-400 mb-1">{t.actionColor}</label>
                <div className="flex items-center gap-2 bg-silk-800 p-1.5 rounded-xl border border-silk-700">
                  <input
                    type="color"
                    value={currentTheme.actionColor}
                    onChange={(e) => handleUpdateTheme({ actionColor: e.target.value })}
                    className="w-7 h-7 rounded border-0 cursor-pointer bg-transparent"
                  />
                  <span className="text-xs font-mono text-slate-300">{currentTheme.actionColor}</span>
                </div>
              </div>

              <div>
                <label className="block text-[11px] text-slate-400 mb-1">{t.appBgColor}</label>
                <div className="flex items-center gap-2 bg-silk-800 p-1.5 rounded-xl border border-silk-700">
                  <input
                    type="color"
                    value={currentTheme.appBgColor || '#0a0814'}
                    onChange={(e) => handleUpdateTheme({ appBgColor: e.target.value })}
                    className="w-7 h-7 rounded border-0 cursor-pointer bg-transparent"
                  />
                  <span className="text-xs font-mono text-slate-300">{currentTheme.appBgColor || '#0a0814'}</span>
                </div>
              </div>

              <div>
                <label className="block text-[11px] text-slate-400 mb-1">{t.appSurfaceColor}</label>
                <div className="flex items-center gap-2 bg-silk-800 p-1.5 rounded-xl border border-silk-700">
                  <input
                    type="color"
                    value={currentTheme.appSurfaceColor || '#141126'}
                    onChange={(e) => handleUpdateTheme({ appSurfaceColor: e.target.value })}
                    className="w-7 h-7 rounded border-0 cursor-pointer bg-transparent"
                  />
                  <span className="text-xs font-mono text-slate-300">{currentTheme.appSurfaceColor || '#141126'}</span>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* 8. Message Bubbles Style */}
        <div className="p-4 rounded-2xl bg-silk-900/80 border border-silk-800 space-y-4">
          <div>
            <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-slate-400">
              <Sliders className="w-4 h-4 text-violet-400" />
              <span>{t.sectionChatStyling}</span>
            </div>
            <p className="text-[11px] text-slate-400 mt-1 leading-snug">{t.sectionChatStylingDesc}</p>
          </div>

          {/* Bubble Colors: User and Bot */}
          <div className="grid grid-cols-2 gap-3 pt-1">
            <div>
              <label className="block text-[11px] text-slate-400 mb-1">{t.bubbleUserBg}</label>
              <div className="flex items-center gap-2 bg-silk-800 p-1.5 rounded-xl border border-silk-700">
                <input
                  type="color"
                  value={currentTheme.bubbleUserBg}
                  onChange={(e) => handleUpdateTheme({ bubbleUserBg: e.target.value })}
                  className="w-7 h-7 rounded border-0 cursor-pointer bg-transparent"
                />
                <span className="text-xs font-mono text-slate-300">{currentTheme.bubbleUserBg}</span>
              </div>
            </div>

            <div>
              <label className="block text-[11px] text-slate-400 mb-1">{t.bubbleBotBg}</label>
              <div className="flex items-center gap-2 bg-silk-800 p-1.5 rounded-xl border border-silk-700">
                <input
                  type="color"
                  value={currentTheme.bubbleBotBg}
                  onChange={(e) => handleUpdateTheme({ bubbleBotBg: e.target.value })}
                  className="w-7 h-7 rounded border-0 cursor-pointer bg-transparent"
                />
                <span className="text-xs font-mono text-slate-300">{currentTheme.bubbleBotBg}</span>
              </div>
            </div>
          </div>

          {/* Sliders: Radius, Opacity, Background tint */}
          <div className="space-y-3 pt-1">
            <div>
              <div className="flex justify-between text-xs text-slate-400 mb-1">
                <span>{t.bubbleRadius}</span>
                <span className="font-mono">{currentTheme.bubbleRadius}px</span>
              </div>
              <input
                type="range"
                min={6}
                max={26}
                value={currentTheme.bubbleRadius}
                onChange={(e) => handleUpdateTheme({ bubbleRadius: parseInt(e.target.value) })}
                className="w-full accent-violet-500 h-1.5 bg-silk-800 rounded-lg cursor-pointer"
              />
            </div>

            <div>
              <div className="flex justify-between text-xs text-slate-400 mb-1">
                <span>{t.bubbleOpacity}</span>
                <span className="font-mono">{Math.round(currentTheme.bubbleOpacity * 100)}%</span>
              </div>
              <input
                type="range"
                min={0.3}
                max={1.0}
                step={0.05}
                value={currentTheme.bubbleOpacity}
                onChange={(e) => handleUpdateTheme({ bubbleOpacity: parseFloat(e.target.value) })}
                className="w-full accent-violet-500 h-1.5 bg-silk-800 rounded-lg cursor-pointer"
              />
            </div>

            <div>
              <div className="flex justify-between text-xs text-slate-400 mb-1">
                <span>{t.backgroundTint}</span>
                <span className="font-mono">{Math.round(currentTheme.backgroundTint * 100)}%</span>
              </div>
              <input
                type="range"
                min={0.1}
                max={0.95}
                step={0.05}
                value={currentTheme.backgroundTint}
                onChange={(e) => handleUpdateTheme({ backgroundTint: parseFloat(e.target.value) })}
                className="w-full accent-violet-500 h-1.5 bg-silk-800 rounded-lg cursor-pointer"
              />
            </div>
          </div>
        </div>

        {/* 9. Typography & Text Settings */}
        <div className="p-4 rounded-2xl bg-silk-900/80 border border-silk-800 space-y-4">
          <div>
            <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-slate-400">
              <Type className="w-4 h-4 text-violet-400" />
              <span>{t.sectionTypography}</span>
            </div>
            <p className="text-[11px] text-slate-400 mt-1 leading-snug">{t.sectionTypographyDesc}</p>
          </div>

          <div className="space-y-4 pt-1">
            {/* Font Size */}
            <div>
              <div className="flex justify-between text-xs text-slate-400 mb-1">
                <span>{t.fontSize}</span>
                <span className="font-mono text-violet-400 font-semibold">{currentTheme.fontSize}px</span>
              </div>
              <input
                type="range"
                min={12}
                max={20}
                value={currentTheme.fontSize}
                onChange={(e) => handleUpdateTheme({ fontSize: parseInt(e.target.value) })}
                className="w-full accent-violet-500 h-1.5 bg-silk-800 rounded-lg cursor-pointer"
              />
            </div>

            {/* Font Family Selector */}
            <div>
              <label className="block text-xs text-slate-400 mb-1.5 font-medium">{t.fontFamily}</label>
              <div className="grid grid-cols-3 gap-2">
                {[
                  { id: 'sans', label: t.fontFamilySans, fontStyle: 'font-sans' },
                  { id: 'serif', label: t.fontFamilySerif, fontStyle: 'font-serif' },
                  { id: 'mono', label: t.fontFamilyMono, fontStyle: 'font-mono' },
                ].map((f) => {
                  const isSelected = (currentTheme.fontFamily || 'sans') === f.id;
                  return (
                    <button
                      key={f.id}
                      type="button"
                      onClick={() => handleUpdateTheme({ fontFamily: f.id as any })}
                      className={`p-2 rounded-xl border text-center transition-all ${
                        isSelected
                          ? 'bg-violet-600/25 border-violet-500 text-white font-semibold'
                          : 'bg-silk-850 border-silk-800 text-slate-400 hover:text-white'
                      }`}
                    >
                      <span className={`text-xs block ${f.fontStyle}`}>{f.label}</span>
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Line Spacing Selector */}
            <div>
              <label className="block text-xs text-slate-400 mb-1.5 font-medium">{t.lineHeight}</label>
              <div className="grid grid-cols-3 gap-2">
                {[
                  { id: 'normal', label: t.lineHeightNormal },
                  { id: 'relaxed', label: t.lineHeightRelaxed },
                  { id: 'loose', label: t.lineHeightLoose },
                ].map((lh) => {
                  const isSelected = (currentTheme.lineHeight || 'relaxed') === lh.id;
                  return (
                    <button
                      key={lh.id}
                      type="button"
                      onClick={() => handleUpdateTheme({ lineHeight: lh.id as any })}
                      className={`p-2 rounded-xl border text-center transition-all ${
                        isSelected
                          ? 'bg-violet-600/25 border-violet-500 text-white font-semibold'
                          : 'bg-silk-850 border-silk-800 text-slate-400 hover:text-white'
                      }`}
                    >
                      <span className="text-xs block">{lh.label}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          </div>

          {/* Live Preview Card */}
          <div className="pt-2">
            <ChatPreviewCard theme={currentTheme} />
          </div>
        </div>
      </div>

      {/* Style Modal */}
      {showStyleModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-md">
          <div className="w-full max-w-sm bg-silk-900 border border-silk-700 rounded-2xl p-4 shadow-2xl space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="font-semibold text-sm text-white">
                {editingStyleId ? t.editStyle : t.createStyle}
              </h3>
              <button
                onClick={() => setShowStyleModal(false)}
                className="text-slate-400 hover:text-white"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div>
              <label className="block text-xs text-slate-400 mb-1">{t.styleName}</label>
              <input
                type="text"
                value={styleName}
                onChange={(e) => setStyleName(e.target.value)}
                placeholder={t.styleNamePlaceholder}
                className="w-full px-3 py-2 bg-silk-800 border border-silk-700 rounded-xl text-xs text-white"
              />
            </div>

            <div>
              <label className="block text-xs text-slate-400 mb-1">{t.styleDesc}</label>
              <input
                type="text"
                value={styleDesc}
                onChange={(e) => setStyleDesc(e.target.value)}
                placeholder={t.styleDescPlaceholder}
                className="w-full px-3 py-2 bg-silk-800 border border-silk-700 rounded-xl text-xs text-white"
              />
            </div>

            <div>
              <label className="block text-xs text-slate-400 mb-1">{t.styleInstruction}</label>
              <textarea
                rows={4}
                value={styleInstruction}
                onChange={(e) => setStyleInstruction(e.target.value)}
                placeholder={t.styleInstructionPlaceholder}
                className="w-full px-3 py-2 bg-silk-800 border border-silk-700 rounded-xl text-xs text-white resize-none"
              />
            </div>

            <div className="flex justify-end gap-2 pt-1">
              <button
                onClick={() => setShowStyleModal(false)}
                type="button"
                className="px-3 py-1.5 text-xs text-slate-400 hover:text-white rounded-lg"
              >
                {t.cancel}
              </button>
              <button
                onClick={handleSaveStyle}
                type="button"
                className="px-4 py-1.5 text-xs font-medium text-white bg-violet-600 hover:bg-violet-500 rounded-lg shadow-md"
              >
                {t.save}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
