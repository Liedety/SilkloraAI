import type { Character, Language, RelationshipDetail } from '../types/index.ts';

export interface RelationshipStageInfo {
  id: 'nemesis' | 'hostile' | 'cold' | 'neutral' | 'warm' | 'close' | 'devoted';
  label: string;
  behaviorHint: string;
  promptTone: string;
  textColor: string;
  barColor: string;
  badgeClass: string;
}

export interface RelationshipPresetPoint {
  score: number;
  label: string;
}

export interface BondRolePreset {
  id: string;
  label: string;
}

export function clampRelationshipScore(value: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0;
  return Math.max(-100, Math.min(100, Math.round(value)));
}

export function getRelationshipStage(rawScore: number, language: Language = 'en'): RelationshipStageInfo {
  const score = clampRelationshipScore(rawScore);
  const ru = language === 'ru';

  if (score <= -70) {
    return {
      id: 'nemesis',
      label: ru ? 'Ненависть и вражда' : 'Bitter Enmity',
      behaviorHint: ru
        ? 'Открытая враждебность, недоверие к каждому слову, ожидание подвоха.'
        : 'Open hostility, deep resentment, expects treachery at every step.',
      promptTone: ru
        ? 'открытая вражда, жесткое недоверие и неприязнь'
        : 'bitter enmity, deep distrust, and open hostility',
      textColor: 'text-rose-400',
      barColor: '#e11d48',
      badgeClass: 'bg-rose-950/60 border-rose-700/50 text-rose-300',
    };
  }

  if (score <= -35) {
    return {
      id: 'hostile',
      label: ru ? 'Неприязнь и конфликт' : 'Hostile & Resentful',
      behaviorHint: ru
        ? 'Резкий тон, колкости, защитная дистанция и раздражение.'
        : 'Sharp remarks, defensive posture, irritation, and lingering friction.',
      promptTone: ru
        ? 'явная неприязнь, колкость и напряженный конфликт'
        : 'sharp resentment, friction, and defensive hostility',
      textColor: 'text-orange-400',
      barColor: '#ea580c',
      badgeClass: 'bg-orange-950/50 border-orange-700/50 text-orange-300',
    };
  }

  if (score <= -10) {
    return {
      id: 'cold',
      label: ru ? 'Холод и настороженность' : 'Cold & Guarded',
      behaviorHint: ru
        ? 'Скепсис, сухие ответы, проверка границ и осторожность.'
        : 'Skeptical, guarded, keeps emotional distance and tests motives.',
      promptTone: ru
        ? 'холодность, настороженность и сдержанная дистанция'
        : 'guarded, skeptical, and emotionally distant',
      textColor: 'text-amber-300',
      barColor: '#d97706',
      badgeClass: 'bg-amber-950/40 border-amber-700/40 text-amber-200',
    };
  }

  if (score < 15) {
    return {
      id: 'neutral',
      label: ru ? 'Нейтралитет' : 'Neutral',
      behaviorHint: ru
        ? 'Ровное общение без лишней фамильярности; присматривается к поступкам.'
        : 'Balanced, observant demeanor without unearned familiarity.',
      promptTone: ru
        ? 'ровно, нейтрально, без преждевременной близости'
        : 'even-toned, observant, neutral acquaintance',
      textColor: 'text-slate-300',
      barColor: '#71717a',
      badgeClass: 'bg-silk-800 border-silk-700 text-slate-300',
    };
  }

  if (score < 45) {
    return {
      id: 'warm',
      label: ru ? 'Симпатия и интерес' : 'Warm & Interested',
      behaviorHint: ru
        ? 'Охотно идет на контакт, поддерживает разговор, проявляет живой интерес.'
        : 'Attentive, cooperative, open to banter and growing rapport.',
      promptTone: ru
        ? 'теплая симпатия, живой интерес и растущее расположение'
        : 'warm rapport, genuine curiosity, and growing fondness',
      textColor: 'text-emerald-400',
      barColor: '#10b981',
      badgeClass: 'bg-emerald-950/40 border-emerald-700/40 text-emerald-300',
    };
  }

  if (score < 75) {
    return {
      id: 'close',
      label: ru ? 'Доверие и близость' : 'Close & Trusted',
      behaviorHint: ru
        ? 'Искренняя теплота, готовность делиться личным и поддерживать в трудную минуту.'
        : 'Confides personal thoughts, protective, affectionate, and reliable.',
      promptTone: ru
        ? 'крепкое доверие, душевная близость и искренняя привязанность'
        : 'strong trust, emotional closeness, and genuine affection',
      textColor: 'text-sky-300',
      barColor: '#0ea5e9',
      badgeClass: 'bg-sky-950/40 border-sky-700/40 text-sky-300',
    };
  }

  return {
    id: 'devoted',
    label: ru ? 'Глубокая привязанность' : 'Deep Devotion',
    behaviorHint: ru
      ? 'Особая связь, максимальная открытость, преданность или сильное чувство.'
      : 'Profound bond, deep vulnerability, unwavering loyalty or passion.',
    promptTone: ru
      ? 'глубокая привязанность, полное доверие и особая личная связь'
      : 'profound intimacy, unconditional trust, and deep devotion',
    textColor: 'text-violet-300',
    barColor: '#8b5cf6',
    badgeClass: 'bg-violet-950/40 border-violet-600/40 text-violet-200',
  };
}

export function getRelationshipStagePresets(language: Language = 'en'): RelationshipPresetPoint[] {
  const ru = language === 'ru';
  return [
    { score: -80, label: ru ? 'Вражда' : 'Enmity' },
    { score: -35, label: ru ? 'Холод' : 'Cold' },
    { score: 0, label: ru ? 'Нейтр.' : 'Neutral' },
    { score: 30, label: ru ? 'Симпатия' : 'Warm' },
    { score: 60, label: ru ? 'Доверие' : 'Trusted' },
    { score: 90, label: ru ? 'Близость' : 'Devoted' },
  ];
}

export function getBondRolePresets(language: Language = 'en'): BondRolePreset[] {
  const ru = language === 'ru';
  return [
    { id: 'strangers', label: ru ? 'Незнакомцы' : 'Strangers' },
    { id: 'rivals', label: ru ? 'Соперники' : 'Rivals' },
    { id: 'partners', label: ru ? 'Напарники' : 'Partners' },
    { id: 'friends', label: ru ? 'Друзья' : 'Close Friends' },
    { id: 'exes', label: ru ? 'Бывшие' : 'Ex-Partners' },
    { id: 'tension', label: ru ? 'Скрытое влечение' : 'Unspoken Tension' },
    { id: 'lovers', label: ru ? 'Возлюбленные' : 'Lovers' },
    { id: 'mentor', label: ru ? 'Наставник и ученик' : 'Mentor & Protege' },
  ];
}

/**
 * Returns the characters whose relationship meters should appear in Chat Settings,
 * strictly excluding the player's currently selected persona (`personaId`).
 */
export function filterRelationshipTargets(params: {
  sessionType: 'character' | 'group';
  targetId: string;
  personaId?: string | null;
  allCharacters: Character[];
  groupCharacterIds?: string[];
}): Character[] {
  const activePersonaId = params.personaId || null;

  if (params.sessionType === 'character') {
    if (activePersonaId && params.targetId === activePersonaId) {
      return [];
    }
    const found = params.allCharacters.find((c) => c.id === params.targetId);
    if (found) return [found];
    return [];
  }

  const memberIds = new Set(params.groupCharacterIds || []);
  return params.allCharacters.filter(
    (c) => memberIds.has(c.id) && (!activePersonaId || c.id !== activePersonaId)
  );
}

/**
 * Formats a concise, natural-prose relationship summary line for system prompts and scene notes,
 * incorporating numeric affinity, behavioral stage, optional bond status, and custom dynamic notes.
 */
export function formatRelationshipPromptLine(params: {
  speakerName: string;
  userName: string;
  score?: number;
  detail?: RelationshipDetail | null;
  language?: Language;
  mode?: 'sceneNote' | 'system';
}): string {
  const language = params.language || 'en';
  const ru = language === 'ru';
  const score = clampRelationshipScore(params.score ?? 0);
  const signedScore = score > 0 ? `+${score}` : String(score);
  const stage = getRelationshipStage(score, language);

  const customTitle = params.detail?.customTitle?.trim() || '';
  const note = params.detail?.note?.trim() || '';

  const extras: string[] = [stage.promptTone];
  if (customTitle) {
    extras.push(ru ? `статус связи: ${customTitle}` : `bond role: ${customTitle}`);
  }
  if (note) {
    extras.push(ru ? `нюанс динамики: ${note}` : `dynamic nuance: ${note}`);
  }

  if (params.mode === 'system') {
    return ru
      ? `Отношения ${params.speakerName} к ${params.userName}: ${signedScore} из 100 (${extras.join('; ')}).`
      : `Your current affinity score with ${params.userName} is: ${signedScore} (from -100 Hostile to +100 Deep Devotion — ${extras.join('; ')}).`;
  }

  return ru
    ? `${params.speakerName} и ${params.userName}: отношения ${signedScore} из 100 (${extras.join('; ')})`
    : `${params.speakerName} and ${params.userName}: affinity ${signedScore} of 100 (${extras.join('; ')})`;
}
