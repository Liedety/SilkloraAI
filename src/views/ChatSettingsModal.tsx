import React, { useState, useEffect } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import {
  X,
  Brain,
  Sparkles,
  History as HistoryIcon,
  Plus,
  Trash2,
  Edit2,
  Check,
  Heart,
  Sliders,
  MapPin,
  Lock,
  Unlock,
  BookOpen,
} from 'lucide-react';
import { db, getLocalizedTextStyle } from '../db';
import type {
  ChatSession,
  Language,
  RelationshipDetail,
} from '../types';
import { translations } from '../i18n';
import { AvatarImage } from '../components/AvatarImage';
import { MemoryGraphView } from '../components/MemoryGraphView';
import { SceneGuideModal, SceneHelpButton } from '../components/SceneHelp';
import {
  clampRelationshipScore,
  filterRelationshipTargets,
  getBondRolePresets,
  getRelationshipStage,
  getRelationshipStagePresets,
} from '../utils/relationships';

interface ChatSettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  session: ChatSession;
  language: Language;
  onSwitchSession: (sessionId: string) => void;
  onCreateNewSession: () => void;
}

export const ChatSettingsModal: React.FC<ChatSettingsModalProps> = ({
  isOpen,
  onClose,
  session,
  language,
  onSwitchSession,
  onCreateNewSession,
}) => {
  const t = translations[language];
  const [activeTab, setActiveTab] = useState<'memory' | 'roleplay' | 'history'>('memory');
  const [showSceneGuide, setShowSceneGuide] = useState(false);

  // Queries
  const allCharacters = useLiveQuery(() => db.characters.toArray()) || [];
  const allSessions = useLiveQuery(
    async () => (await db.chats.where('targetId').equals(session.targetId).toArray()).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)),
    [session.targetId]
  ) || [];
  const memoryNodes = useLiveQuery(
    () => db.memoryNodes.where('chatId').equals(session.id).toArray(),
    [session.id]
  ) || [];
  const memoryEdges = useLiveQuery(
    () => db.memoryEdges.where('chatId').equals(session.id).toArray(),
    [session.id]
  ) || [];
  const textStyles = useLiveQuery(() => db.textStyles.toArray()) || [];
  const settings = useLiveQuery(() => db.settings.get('default'));
  const activeDefaultStyle = textStyles.find((st) => st.id === settings?.textStyleId);

  // Group members if this is a group chat
  const group = useLiveQuery(
    () => (session.type === 'group' ? db.groups.get(session.targetId) : undefined),
    [session]
  );

  // Roleplay settings form state
  const [personaId, setPersonaId] = useState<string | null>(session.personaId || null);
  const [thoughtsEnabled, setThoughtsEnabled] = useState(session.thoughtsEnabled === true);
  const [chatDirectives, setChatDirectives] = useState(session.chatDirectives || '');
  const [relationships, setRelationships] = useState<Record<string, number>>(session.relationships || {});
  const [relationshipDetails, setRelationshipDetails] = useState<Record<string, RelationshipDetail>>(
    session.relationshipDetails || {}
  );
  const [expandedBondIds, setExpandedBondIds] = useState<Record<string, boolean>>({});

  useEffect(() => {
    setPersonaId(session.personaId || null);
    setThoughtsEnabled(session.thoughtsEnabled === true);
    setChatDirectives(session.chatDirectives || '');
    setRelationships(session.relationships || {});
    setRelationshipDetails(session.relationshipDetails || {});
  }, [
    session.id,
    session.personaId,
    session.thoughtsEnabled,
    session.chatDirectives,
    session.relationships,
    session.relationshipDetails,
  ]);

  // History rename state
  const [editingSessionId, setEditingSessionId] = useState<string | null>(null);
  const [renameText, setRenameText] = useState('');

  if (!isOpen) return null;

  // Potential personas (exclude current 1-on-1 character)
  const availablePersonas = allCharacters.filter(
    (c) => session.type === 'group' || c.id !== session.targetId
  );

  // Characters shown in Relationship Dynamics (strictly excluding selected player persona)
  const relationshipTargets = filterRelationshipTargets({
    sessionType: session.type,
    targetId: session.targetId,
    personaId,
    allCharacters,
    groupCharacterIds: group?.characterIds,
  });
  const stagePresets = getRelationshipStagePresets(language);
  const bondRolePresets = getBondRolePresets(language);

  const handleSaveRoleplay = async () => {
    const fresh = await db.chats.get(session.id);
    await db.chats.update(session.id, {
      personaId,
      thoughtsEnabled,
      chatDirectives,
      relationships: { ...(fresh?.relationships || {}), ...relationships },
      relationshipDetails: { ...(fresh?.relationshipDetails || {}), ...relationshipDetails },
    });
  };

  const handleAffinityChange = async (charId: string, rawVal: number) => {
    const val = clampRelationshipScore(rawVal);
    const fresh = await db.chats.get(session.id);
    const updated = { ...(fresh?.relationships || {}), ...relationships, [charId]: val };
    setRelationships(updated);
    await db.chats.update(session.id, { relationships: updated });
  };

  const handleRelationshipDetailChange = async (charId: string, patch: Partial<RelationshipDetail>) => {
    const fresh = await db.chats.get(session.id);
    const prevMap = { ...(fresh?.relationshipDetails || {}), ...relationshipDetails };
    const nextDetail: RelationshipDetail = {
      ...(prevMap[charId] || {}),
      ...patch,
    };
    const updated = { ...prevMap, [charId]: nextDetail };
    setRelationshipDetails(updated);
    await db.chats.update(session.id, { relationshipDetails: updated });
  };

  const handleStartRename = (s: ChatSession) => {
    setEditingSessionId(s.id);
    setRenameText(s.title);
  };

  const handleSaveRename = async (id: string) => {
    if (renameText.trim()) {
      await db.chats.update(id, { title: renameText.trim() });
    }
    setEditingSessionId(null);
  };

  const handleDeleteSession = async (id: string) => {
    if (allSessions.length <= 1) {
      alert(language === 'ru' ? 'Нельзя удалить единственную сессию.' : 'Cannot delete the only remaining session.');
      return;
    }
    await db.chats.delete(id);
    await db.messages.where('chatId').equals(id).delete();
    await db.sceneAssets.where('chatId').equals(id).delete().catch(() => {});
    await db.memoryNodes.where('chatId').equals(id).delete();
    await db.memoryEdges.where('chatId').equals(id).delete();
    if (session.id === id) {
      const remaining = allSessions.find((s) => s.id !== id);
      if (remaining) onSwitchSession(remaining.id);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-3 bg-black/80 animate-fade-in">
      <div className="w-full max-w-md h-[90vh] bg-silk-900 border border-silk-700 rounded-2xl flex flex-col overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-silk-800 bg-silk-900 shrink-0">
          <h2 className="text-sm font-bold text-white tracking-tight">{t.chatSettings}</h2>
          <button
            onClick={() => {
              handleSaveRoleplay();
              onClose();
            }}
            className="p-1 text-slate-400 hover:text-white rounded-lg hover:bg-silk-800"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Tab Switcher */}
        <div className="grid grid-cols-3 border-b border-silk-800 bg-silk-950 p-1.5 gap-1 shrink-0">
          <button
            type="button"
            onClick={() => setActiveTab('memory')}
            className={`flex items-center justify-center gap-1.5 py-1.5 rounded-xl text-xs font-semibold transition-colors ${
              activeTab === 'memory'
                ? 'bg-silk-800 border border-silk-600 text-slate-100'
                : 'text-slate-400 hover:text-white border border-transparent'
            }`}
          >
            <Brain className="w-3.5 h-3.5" />
            <span>{t.tabMemory}</span>
          </button>

          <button
            type="button"
            onClick={() => setActiveTab('roleplay')}
            className={`flex items-center justify-center gap-1.5 py-1.5 rounded-xl text-xs font-semibold transition-colors ${
              activeTab === 'roleplay'
                ? 'bg-silk-800 border border-silk-600 text-slate-100'
                : 'text-slate-400 hover:text-white border border-transparent'
            }`}
          >
            <Sparkles className="w-3.5 h-3.5" />
            <span>{t.tabRoleplay}</span>
          </button>

          <button
            type="button"
            onClick={() => setActiveTab('history')}
            className={`flex items-center justify-center gap-1.5 py-1.5 rounded-xl text-xs font-semibold transition-colors ${
              activeTab === 'history'
                ? 'bg-silk-800 border border-silk-600 text-slate-100'
                : 'text-slate-400 hover:text-white border border-transparent'
            }`}
          >
            <HistoryIcon className="w-3.5 h-3.5" />
            <span>{t.tabHistory}</span>
          </button>
        </div>

        {/* Tab Body */}
        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          {/* 1. MEMORY TAB */}
          {activeTab === 'memory' && (
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <div>
                  <h3 className="text-xs font-semibold text-white">{t.memoryGraphTitle}</h3>
                  <p className="text-[11px] text-slate-400">{t.memoryGraphDesc}</p>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <div className="text-[11px] font-mono text-violet-400 bg-silk-800 px-2 py-0.5 rounded-lg">
                    {memoryNodes.length} {t.nodesCount}
                  </div>
                </div>
              </div>

              {/* Interactive Canvas Graph */}
              <MemoryGraphView nodes={memoryNodes} edges={memoryEdges} language={language} />
            </div>
          )}

          {/* 2. ROLEPLAY TAB */}
          {activeTab === 'roleplay' && (
            <div className="space-y-4">
              {/* User Persona Picker */}
              <div className="p-3.5 rounded-xl bg-silk-850 border border-silk-800 space-y-2">
                <label className="block text-xs font-semibold text-white">{t.userPersonaTitle}</label>
                <p className="text-[11px] text-slate-400">{t.userPersonaDesc}</p>
                <select
                  value={personaId || ''}
                  onChange={(e) => {
                    const val = e.target.value || null;
                    setPersonaId(val);
                    db.chats.update(session.id, { personaId: val });
                  }}
                  className="w-full px-3 py-2 bg-silk-800 border border-silk-700 rounded-xl text-xs text-white"
                >
                  <option value="">{t.noPersona}</option>
                  {availablePersonas.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </div>

              {/* Text Style for Session */}
              <div className="p-3.5 rounded-xl bg-silk-850 border border-silk-800 space-y-2">
                <label className="block text-xs font-semibold text-white">
                  {language === 'ru' ? 'Стиль текста для этой сессии' : 'Writing Style for this Session'}
                </label>
                <select
                  value={session.textStyleId || ''}
                  onChange={(e) => {
                    const val = e.target.value || null;
                    db.chats.update(session.id, { textStyleId: val });
                  }}
                  className="w-full px-3 py-2 bg-silk-800 border border-silk-700 rounded-xl text-xs text-white"
                >
                  <option value="">
                    {language === 'ru'
                      ? `Общий из настроек (${activeDefaultStyle ? getLocalizedTextStyle(activeDefaultStyle, language).name : 'Иммерсивный'})`
                      : `Global Setting (${activeDefaultStyle ? getLocalizedTextStyle(activeDefaultStyle, language).name : 'Immersive'})`}
                  </option>
                  {textStyles.map((st) => {
                    const loc = getLocalizedTextStyle(st, language);
                    return (
                      <option key={st.id} value={st.id}>
                        {loc.name}
                      </option>
                    );
                  })}
                </select>
              </div>

              {/* Thoughts Toggle */}
              <div className="flex items-start justify-between p-3.5 rounded-xl bg-silk-850 border border-silk-800">
                <div className="pr-3">
                  <span className="text-xs font-semibold text-white block">{t.thoughtsToggle}</span>
                  <p className="text-[11px] text-slate-400 mt-0.5">{t.thoughtsToggleDesc}</p>
                </div>
                <input
                  type="checkbox"
                  checked={thoughtsEnabled}
                  onChange={(e) => {
                    setThoughtsEnabled(e.target.checked);
                    db.chats.update(session.id, { thoughtsEnabled: e.target.checked });
                  }}
                  className="w-5 h-5 accent-violet-600 rounded cursor-pointer shrink-0 mt-0.5"
                />
              </div>

              {/* Chat Directives */}
              <div className="p-3.5 rounded-xl bg-silk-850 border border-silk-800 space-y-2">
                <label className="block text-xs font-semibold text-white">{t.chatDirectivesTitle}</label>
                <textarea
                  rows={3}
                  value={chatDirectives}
                  onChange={(e) => {
                    setChatDirectives(e.target.value);
                    db.chats.update(session.id, { chatDirectives: e.target.value });
                  }}
                  placeholder={t.chatDirectivesPlaceholder}
                  className="w-full px-3 py-2 bg-silk-800 border border-silk-700 rounded-xl text-xs text-white resize-none"
                />
              </div>

              {/* Relationship & Bond Dynamics (excludes selected player persona) */}
              <div className="p-3.5 rounded-xl bg-silk-850 border border-silk-800 space-y-3">
                <div>
                  <div className="flex items-center gap-1.5 text-xs font-semibold text-white">
                    <Heart className="w-3.5 h-3.5 text-rose-400" />
                    <span>{t.relationshipMeterTitle}</span>
                  </div>
                  <p className="text-[11px] text-slate-400 mt-0.5 leading-snug">{t.relationshipMeterDesc}</p>
                </div>

                {relationshipTargets.length === 0 ? (
                  <p className="text-[11px] text-slate-500 py-1">{t.relationshipNoTargets}</p>
                ) : (
                  <div className="space-y-3">
                    {relationshipTargets.map((targetChar) => {
                      const charId = targetChar.id;
                      const score = clampRelationshipScore(relationships[charId] ?? 0);
                      const stage = getRelationshipStage(score, language);
                      const detail = relationshipDetails[charId] || {};
                      const isLocked = Boolean(detail.locked);
                      const hasCustomBond = Boolean(detail.customTitle?.trim() || detail.note?.trim());
                      const isExpanded = Boolean(expandedBondIds[charId]);
                      const fillLeftPct = score < 0 ? 50 + score / 2 : 50;
                      const fillWidthPct = Math.abs(score) / 2;

                      return (
                        <div
                          key={charId}
                          className="p-3 rounded-xl bg-silk-900/90 border border-silk-800 space-y-2.5"
                        >
                          {/* Top Row: Avatar, Name, Stage, Numeric Score, Lock & Customize */}
                          <div className="flex items-center justify-between gap-2">
                            <div className="flex items-center gap-2 min-w-0">
                              <div className="w-7 h-7 rounded-lg overflow-hidden bg-silk-800 border border-silk-700 shrink-0">
                                <AvatarImage
                                  src={targetChar.avatar}
                                  alt={targetChar.name}
                                  className="w-full h-full object-cover"
                                />
                              </div>
                              <div className="min-w-0">
                                <div className="text-xs font-semibold text-white truncate">{targetChar.name}</div>
                                <div className="flex items-center gap-1.5 flex-wrap mt-0.5">
                                  <span className={`px-1.5 py-0.5 rounded border text-[10px] font-medium leading-none ${stage.badgeClass}`}>
                                    {stage.label}
                                  </span>
                                  {detail.customTitle?.trim() && (
                                    <span className="px-1.5 py-0.5 rounded bg-silk-800 border border-silk-700 text-[10px] text-slate-200 truncate max-w-[130px] leading-none">
                                      {detail.customTitle.trim()}
                                    </span>
                                  )}
                                </div>
                              </div>
                            </div>

                            <div className="flex items-center gap-1 shrink-0">
                              <span className={`font-mono text-xs font-bold px-1.5 ${stage.textColor}`}>
                                {score > 0 ? `+${score}` : score}
                              </span>
                              <button
                                type="button"
                                onClick={() => handleRelationshipDetailChange(charId, { locked: !isLocked })}
                                title={isLocked ? t.relationshipUnlockTitle : t.relationshipLockTitle}
                                className={`flex items-center gap-1 px-2 py-1 rounded-lg border text-[10px] font-medium transition-colors ${
                                  isLocked
                                    ? 'bg-amber-950/40 border-amber-600/50 text-amber-200'
                                    : 'bg-silk-800 border-silk-700 text-slate-400 hover:text-white'
                                }`}
                              >
                                {isLocked ? <Lock className="w-3 h-3" /> : <Unlock className="w-3 h-3" />}
                                <span>{isLocked ? t.relationshipLockedBadge : t.relationshipAutoBadge}</span>
                              </button>
                              <button
                                type="button"
                                onClick={() =>
                                  setExpandedBondIds((prev) => ({ ...prev, [charId]: !prev[charId] }))
                                }
                                title={t.relationshipCustomizeBtn}
                                className={`p-1.5 rounded-lg border transition-colors ${
                                  isExpanded || hasCustomBond
                                    ? 'bg-violet-600/20 border-violet-500/50 text-violet-200'
                                    : 'bg-silk-800 border-silk-700 text-slate-400 hover:text-white'
                                }`}
                              >
                                <Sliders className="w-3.5 h-3.5" />
                              </button>
                            </div>
                          </div>

                          {/* Behavioral Nuance Preview */}
                          <p className="text-[11px] text-slate-400 leading-snug">
                            {detail.note?.trim() && !isExpanded ? detail.note.trim() : stage.behaviorHint}
                          </p>

                          {/* Bipolar Visual Meter (-100 .. 0 .. +100) + Fine Slider */}
                          <div className="space-y-1.5">
                            <div className="relative h-2 w-full rounded-full bg-silk-950 border border-silk-800 overflow-hidden">
                              <div className="absolute left-1/2 top-0 bottom-0 w-px bg-slate-500/60 z-10" />
                              {fillWidthPct > 0 && (
                                <div
                                  className="absolute top-0 bottom-0 transition-all duration-150"
                                  style={{
                                    left: `${fillLeftPct}%`,
                                    width: `${fillWidthPct}%`,
                                    backgroundColor: stage.barColor,
                                  }}
                                />
                              )}
                            </div>

                            <div className="flex items-center gap-1.5">
                              <button
                                type="button"
                                onClick={() => handleAffinityChange(charId, score - 5)}
                                className="px-2 py-0.5 rounded-md bg-silk-800 hover:bg-silk-700 border border-silk-700 text-[10px] font-mono text-slate-300 shrink-0"
                              >
                                -5
                              </button>
                              <input
                                type="range"
                                min={-100}
                                max={100}
                                value={score}
                                onChange={(e) => handleAffinityChange(charId, parseInt(e.target.value, 10))}
                                className="flex-1 accent-slate-200 h-1.5 bg-silk-800 rounded-lg cursor-pointer"
                              />
                              <button
                                type="button"
                                onClick={() => handleAffinityChange(charId, score + 5)}
                                className="px-2 py-0.5 rounded-md bg-silk-800 hover:bg-silk-700 border border-silk-700 text-[10px] font-mono text-slate-300 shrink-0"
                              >
                                +5
                              </button>
                            </div>

                            {/* Quick Stage Jump Chips */}
                            <div className="grid grid-cols-6 gap-1 pt-0.5">
                              {stagePresets.map((preset) => {
                                const isNear = Math.abs(score - preset.score) <= 6;
                                return (
                                  <button
                                    key={preset.score}
                                    type="button"
                                    onClick={() => handleAffinityChange(charId, preset.score)}
                                    className={`py-1 px-1 rounded-lg border text-[9px] font-medium truncate transition-colors ${
                                      isNear
                                        ? 'bg-silk-800 border-slate-400/60 text-white'
                                        : 'bg-silk-950 border-silk-800 text-slate-400 hover:text-slate-200'
                                    }`}
                                  >
                                    {preset.label}
                                  </button>
                                );
                              })}
                            </div>
                          </div>

                          {/* Expandable Bond Status & Attitude Nuance Editor */}
                          {isExpanded && (
                            <div className="pt-2.5 border-t border-silk-800 space-y-2.5">
                              <div className="space-y-1.5">
                                <label className="block text-[11px] font-semibold text-slate-300">
                                  {t.relationshipBondLabel}
                                </label>
                                <div className="flex flex-wrap gap-1">
                                  {bondRolePresets.map((role) => {
                                    const activeRole =
                                      (detail.customTitle || '').trim().toLowerCase() === role.label.toLowerCase();
                                    return (
                                      <button
                                        key={role.id}
                                        type="button"
                                        onClick={() =>
                                          handleRelationshipDetailChange(charId, {
                                            customTitle: activeRole ? '' : role.label,
                                          })
                                        }
                                        className={`px-2 py-0.5 rounded-lg border text-[10px] font-medium transition-colors ${
                                          activeRole
                                            ? 'bg-violet-600/25 border-violet-500/60 text-violet-200'
                                            : 'bg-silk-850 border-silk-700 text-slate-300 hover:text-white'
                                        }`}
                                      >
                                        {role.label}
                                      </button>
                                    );
                                  })}
                                </div>
                                <input
                                  type="text"
                                  value={detail.customTitle || ''}
                                  onChange={(e) =>
                                    handleRelationshipDetailChange(charId, { customTitle: e.target.value })
                                  }
                                  placeholder={t.relationshipBondPlaceholder}
                                  className="w-full px-2.5 py-1.5 bg-silk-800 border border-silk-700 rounded-lg text-xs text-white placeholder-slate-500"
                                />
                              </div>

                              <div className="space-y-1">
                                <label className="block text-[11px] font-semibold text-slate-300">
                                  {t.relationshipNoteLabel}
                                </label>
                                <textarea
                                  rows={2}
                                  value={detail.note || ''}
                                  onChange={(e) =>
                                    handleRelationshipDetailChange(charId, { note: e.target.value })
                                  }
                                  placeholder={t.relationshipNotePlaceholder}
                                  className="w-full px-2.5 py-1.5 bg-silk-800 border border-silk-700 rounded-lg text-xs text-white placeholder-slate-500 resize-none"
                                />
                              </div>
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>

              {/* Active Scene State & Background Anchor */}
              <div className="p-3.5 rounded-xl bg-silk-850 border border-silk-800 space-y-2.5">
                <div className="flex items-center justify-between gap-2 flex-wrap">
                  <div className="flex items-center gap-1.5 text-xs font-semibold text-white">
                    <MapPin className="w-3.5 h-3.5 text-violet-400" />
                    <span>{t.sceneAnchorSectionTitle}</span>
                    <SceneHelpButton
                      topic="locationAnchor"
                      language={language}
                      onOpenGuide={() => setShowSceneGuide(true)}
                    />
                  </div>
                  <div className="flex items-center gap-1.5">
                    <button
                      type="button"
                      onClick={() => setShowSceneGuide(true)}
                      className="px-2 py-1 rounded-lg bg-silk-800 hover:bg-silk-700 border border-silk-700 text-[10px] font-medium text-slate-200 flex items-center gap-1"
                    >
                      <BookOpen className="w-3 h-3 text-slate-300" />
                      <span>{t.sceneOpenGuideBtn}</span>
                    </button>
                    {session.sceneState && (
                      <button
                        type="button"
                        onClick={() =>
                          db.chats.update(session.id, {
                            sceneState: {
                              ...session.sceneState!,
                              location: {
                                ...session.sceneState!.location,
                                locked: !session.sceneState!.location.locked,
                              },
                            },
                          })
                        }
                        className={`px-2 py-1 rounded-lg border text-[10px] font-medium flex items-center gap-1 ${
                          session.sceneState.location.locked
                            ? 'bg-violet-600/20 border-violet-500/40 text-violet-300'
                            : 'bg-silk-800 border-silk-700 text-slate-400'
                        }`}
                      >
                        {session.sceneState.location.locked ? <Lock className="w-3 h-3" /> : <Unlock className="w-3 h-3" />}
                        <span>{session.sceneState.location.locked ? t.sceneUnpinAnchorBtn : t.scenePinAnchorBtn}</span>
                      </button>
                    )}
                  </div>
                </div>

                {!session.sceneState ? (
                  <p className="text-[11px] text-slate-500">{t.sceneAnchorEmpty}</p>
                ) : (
                  <div className="space-y-1.5 text-[11px] text-slate-300">
                    <div>
                      <span className="text-slate-500">{t.sceneAnchorLocation}: </span>
                      <span className="font-medium text-white">{session.sceneState.location.locationName}</span>
                    </div>
                    <p className="text-slate-400 leading-relaxed">{session.sceneState.location.visualAnchor}</p>
                    <div>
                      <span className="text-slate-500">{t.sceneAnchorLighting}: </span>
                      <span>{session.sceneState.location.lighting}</span>
                    </div>
                    {session.sceneState.actors.length > 0 && (
                      <div>
                        <span className="text-slate-500">{t.sceneAnchorClothes}: </span>
                        <span>
                          {session.sceneState.actors
                            .map((a) => `${a.name}${a.clothing ? ` (${a.clothing})` : ''}`)
                            .join(', ')}
                        </span>
                      </div>
                    )}
                    <button
                      type="button"
                      onClick={() => db.chats.update(session.id, { sceneState: undefined })}
                      className="mt-1 px-2.5 py-1 rounded-lg bg-silk-800 hover:bg-rose-950/50 border border-silk-700 hover:border-rose-700/50 text-[10px] text-slate-300 hover:text-rose-300 transition-colors"
                    >
                      {t.sceneAnchorReset}
                    </button>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* 3. HISTORY TAB */}
          {activeTab === 'history' && (
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <h3 className="text-xs font-semibold text-white">{t.sessionsTitle}</h3>
                <button
                  onClick={onCreateNewSession}
                  type="button"
                  className="flex items-center gap-1 px-3 py-1.5 bg-violet-600 hover:bg-violet-500 text-white rounded-xl text-xs font-semibold shadow-md"
                >
                  <Plus className="w-3.5 h-3.5" />
                  <span>{t.newSession}</span>
                </button>
              </div>

              <div className="space-y-2">
                {allSessions.map((s) => {
                  const isActive = s.id === session.id;
                  const isEditing = editingSessionId === s.id;
                  return (
                    <div
                      key={s.id}
                      className={`p-3 rounded-xl border transition-all ${
                        isActive
                          ? 'bg-violet-950/30 border-violet-500'
                          : 'bg-silk-850 border-silk-800'
                      }`}
                    >
                      <div className="flex items-center justify-between gap-2">
                        {isEditing ? (
                          <div className="flex items-center gap-1 flex-1">
                            <input
                              type="text"
                              value={renameText}
                              onChange={(e) => setRenameText(e.target.value)}
                              className="w-full px-2 py-1 bg-silk-800 border border-silk-700 rounded text-xs text-white"
                              autoFocus
                            />
                            <button
                              onClick={() => handleSaveRename(s.id)}
                              className="p-1 text-emerald-400 hover:text-emerald-300"
                            >
                              <Check className="w-4 h-4" />
                            </button>
                          </div>
                        ) : (
                          <div
                            onClick={() => !isActive && onSwitchSession(s.id)}
                            className="flex-1 cursor-pointer truncate"
                          >
                            <div className="flex items-center gap-2">
                              <span className="text-xs font-semibold text-white truncate">
                                {s.title}
                              </span>
                              {isActive && (
                                <span className="text-[10px] px-1.5 py-0.5 rounded bg-violet-600/30 text-violet-300 font-semibold">
                                  {t.activeSession}
                                </span>
                              )}
                              {s.title.includes('Fork') && (
                                <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-300 font-semibold">
                                  {t.forkedBadge}
                                </span>
                              )}
                            </div>
                            <span className="text-[10px] text-slate-500">
                              {new Date(s.updatedAt).toLocaleString()}
                            </span>
                          </div>
                        )}

                        <div className="flex items-center gap-1 shrink-0">
                          <button
                            onClick={() => handleStartRename(s)}
                            type="button"
                            className="p-1 text-slate-400 hover:text-white"
                            title={t.renameSession}
                          >
                            <Edit2 className="w-3.5 h-3.5" />
                          </button>
                          <button
                            onClick={() => handleDeleteSession(s.id)}
                            type="button"
                            className="p-1 text-slate-400 hover:text-rose-400"
                            title={t.deleteSession}
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      </div>

      <SceneGuideModal
        isOpen={showSceneGuide}
        onClose={() => setShowSceneGuide(false)}
        language={language}
      />
    </div>
  );
};
