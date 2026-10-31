import React, { useState } from 'react';
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
} from 'lucide-react';
import { db, DEFAULT_THEME, APP_THEMES } from '../db';
import type {
  ApiKeyConfig,
  ApiProvider,
  AppSettings,
  Language,
  TextStylePreset,
  ThemeConfig,
} from '../types';
import { translations } from '../i18n';
import { fetchAvailableModels, fetchVisionModels } from '../services/ai';
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

  // Theme settings local state
  const currentTheme = settings?.theme || DEFAULT_THEME;

  const handleUpdateTheme = async (updates: Partial<ThemeConfig>) => {
    if (!settings) return;
    const updatedTheme = { ...currentTheme, ...updates };
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
            {textStyles.map((st) => {
              const isSelected = settings?.textStyleId === st.id;
              return (
                <div
                  key={st.id}
                  onClick={() => db.settings.update('default', { textStyleId: st.id })}
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

        {/* 6. Themes & Live Chat Preview */}
        <div className="p-4 rounded-2xl bg-silk-900/80 border border-silk-800 space-y-4">
          <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-slate-400">
            <Palette className="w-4 h-4 text-violet-400" />
            <span>{t.sectionThemes}</span>
          </div>

          {/* Theme Presets */}
          <div className="grid grid-cols-2 gap-2">
            {APP_THEMES.map((pt) => {
              const isSelected = currentTheme.id === pt.id;
              return (
                <button
                  key={pt.id}
                  onClick={() => handleUpdateTheme(pt.theme)}
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

          {/* Sliders: Radius, Opacity, Font size, Background tint */}
          <div className="space-y-3 pt-2">
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
                <span>{t.fontSize}</span>
                <span className="font-mono">{currentTheme.fontSize}px</span>
              </div>
              <input
                type="range"
                min={13}
                max={18}
                value={currentTheme.fontSize}
                onChange={(e) => handleUpdateTheme({ fontSize: parseInt(e.target.value) })}
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

            {/* Colors picker row */}
            <div className="grid grid-cols-2 gap-3 pt-1">
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
