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
  Eye,
  Sliders,
} from 'lucide-react';
import { db } from '../db';
import type {
  Character,
  ChatSession,
  Group,
  Language,
  MemoryNode,
  MemoryEdge,
} from '../types';
import { translations } from '../i18n';
import { MemoryGraphView } from '../components/MemoryGraphView';

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

  // Queries
  const allCharacters = useLiveQuery(() => db.characters.toArray()) || [];
  const allSessions = useLiveQuery(
    () => db.chats.where('targetId').equals(session.targetId).toArray(),
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

  // Group members if this is a group chat
  const group = useLiveQuery(
    () => (session.type === 'group' ? db.groups.get(session.targetId) : undefined),
    [session]
  );
  const groupMembers = allCharacters.filter((c) => group?.characterIds.includes(c.id));

  // Roleplay settings form state
  const [personaId, setPersonaId] = useState<string | null>(session.personaId || null);
  const [thoughtsEnabled, setThoughtsEnabled] = useState(session.thoughtsEnabled);
  const [chatDirectives, setChatDirectives] = useState(session.chatDirectives || '');
  const [relationships, setRelationships] = useState<Record<string, number>>(session.relationships || {});

  useEffect(() => {
    setPersonaId(session.personaId || null);
    setThoughtsEnabled(session.thoughtsEnabled);
    setChatDirectives(session.chatDirectives || '');
    setRelationships(session.relationships || {});
  }, [session.id, session.personaId, session.thoughtsEnabled, session.chatDirectives, session.relationships]);

  // History rename state
  const [editingSessionId, setEditingSessionId] = useState<string | null>(null);
  const [renameText, setRenameText] = useState('');

  if (!isOpen) return null;

  // Potential personas (exclude current 1-on-1 character)
  const availablePersonas = allCharacters.filter(
    (c) => session.type === 'group' || c.id !== session.targetId
  );

  const handleSaveRoleplay = async () => {
    const fresh = await db.chats.get(session.id);
    await db.chats.update(session.id, {
      personaId,
      thoughtsEnabled,
      chatDirectives,
      relationships: { ...(fresh?.relationships || {}), ...relationships },
    });
  };

  const handleAffinityChange = async (charId: string, val: number) => {
    const fresh = await db.chats.get(session.id);
    const updated = { ...(fresh?.relationships || {}), ...relationships, [charId]: val };
    setRelationships(updated);
    await db.chats.update(session.id, { relationships: updated });
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
    await db.memoryNodes.where('chatId').equals(id).delete();
    await db.memoryEdges.where('chatId').equals(id).delete();
    if (session.id === id) {
      const remaining = allSessions.find((s) => s.id !== id);
      if (remaining) onSwitchSession(remaining.id);
    }
  };

  const getAffinityStatus = (score: number) => {
    const isRu = language === 'ru';
    if (score <= -50) return { label: isRu ? 'Враждебный' : 'Hostile', color: 'text-rose-500' };
    if (score < 0) return { label: isRu ? 'Настороженный' : 'Cold', color: 'text-orange-400' };
    if (score < 25) return { label: isRu ? 'Нейтральный' : 'Neutral', color: 'text-slate-400' };
    if (score < 60) return { label: isRu ? 'Теплый' : 'Friendly', color: 'text-emerald-400' };
    return { label: isRu ? 'Близкий' : 'Devoted', color: 'text-violet-400' };
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-3 bg-black/85 backdrop-blur-md animate-fade-in">
      <div className="w-full max-w-md h-[90vh] bg-silk-900 border border-silk-700/80 rounded-2xl flex flex-col overflow-hidden shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-silk-800 bg-silk-900/90 shrink-0">
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
        <div className="grid grid-cols-3 border-b border-silk-800 bg-silk-950/60 p-1.5 gap-1 shrink-0">
          <button
            type="button"
            onClick={() => setActiveTab('memory')}
            className={`flex items-center justify-center gap-1.5 py-1.5 rounded-xl text-xs font-semibold transition-all ${
              activeTab === 'memory'
                ? 'bg-violet-600 text-white shadow-md'
                : 'text-slate-400 hover:text-white'
            }`}
          >
            <Brain className="w-3.5 h-3.5" />
            <span>{t.tabMemory}</span>
          </button>

          <button
            type="button"
            onClick={() => setActiveTab('roleplay')}
            className={`flex items-center justify-center gap-1.5 py-1.5 rounded-xl text-xs font-semibold transition-all ${
              activeTab === 'roleplay'
                ? 'bg-violet-600 text-white shadow-md'
                : 'text-slate-400 hover:text-white'
            }`}
          >
            <Sparkles className="w-3.5 h-3.5" />
            <span>{t.tabRoleplay}</span>
          </button>

          <button
            type="button"
            onClick={() => setActiveTab('history')}
            className={`flex items-center justify-center gap-1.5 py-1.5 rounded-xl text-xs font-semibold transition-all ${
              activeTab === 'history'
                ? 'bg-violet-600 text-white shadow-md'
                : 'text-slate-400 hover:text-white'
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
                <div className="text-[11px] font-mono text-violet-400 bg-silk-800 px-2 py-0.5 rounded-lg shrink-0">
                  {memoryNodes.length} {t.nodesCount}
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

              {/* Relationship Affinity Meter(s) */}
              <div className="p-3.5 rounded-xl bg-silk-850 border border-silk-800 space-y-3">
                <div className="flex items-center gap-1.5 text-xs font-semibold text-white">
                  <Heart className="w-3.5 h-3.5 text-rose-500" />
                  <span>{t.relationshipMeterTitle}</span>
                </div>

                {session.type === 'character' ? (
                  // Single character relationship
                  (() => {
                    const charId = session.targetId;
                    const score = relationships[charId] || 0;
                    const status = getAffinityStatus(score);
                    return (
                      <div className="space-y-1.5">
                        <div className="flex justify-between items-center text-xs">
                          <span className={`font-medium ${status.color}`}>{status.label}</span>
                          <span className="font-mono text-slate-300">{score > 0 ? `+${score}` : score}%</span>
                        </div>
                        <input
                          type="range"
                          min={-100}
                          max={100}
                          value={score}
                          onChange={(e) => handleAffinityChange(charId, parseInt(e.target.value))}
                          className="w-full accent-rose-500 h-1.5 bg-silk-800 rounded-lg cursor-pointer"
                        />
                      </div>
                    );
                  })()
                ) : (
                  // Group: Separate meter for each member
                  <div className="space-y-3">
                    {groupMembers.map((member) => {
                      const score = relationships[member.id] || 0;
                      const status = getAffinityStatus(score);
                      return (
                        <div key={member.id} className="space-y-1 border-t border-silk-800/80 pt-2 first:border-0 first:pt-0">
                          <div className="flex justify-between items-center text-xs">
                            <span className="font-semibold text-slate-200">{member.name}</span>
                            <span className={`text-[11px] ${status.color}`}>
                              {score > 0 ? `+${score}` : score}%
                            </span>
                          </div>
                          <input
                            type="range"
                            min={-100}
                            max={100}
                            value={score}
                            onChange={(e) => handleAffinityChange(member.id, parseInt(e.target.value))}
                            className="w-full accent-rose-500 h-1.5 bg-silk-800 rounded-lg cursor-pointer"
                          />
                        </div>
                      );
                    })}
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
    </div>
  );
};
