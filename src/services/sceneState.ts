import type {
  ApiKeyConfig,
  AppSettings,
  Character,
  ChatMessage,
  ChatSession,
  SceneActorState,
  SceneLocationAnchor,
  SceneState,
} from '../types/index.ts';
import { getComponentAiConfig, streamChatCompletion } from './ai.ts';

export interface SceneCommandParse {
  isSceneCommand: boolean;
  command: string;
  perspective: string;
}

/**
 * Parses `/scene [perspective / custom shot notes]` (and localized `/сцена`, `/фото`, `/кадр`).
 */
export function parseSceneCommand(rawInput: string): SceneCommandParse {
  const trimmed = (rawInput || '').trim();
  const m = trimmed.match(/^(\/(?:scene|сцена|фото|кадр))(?=\s|$)([\s\S]*)$/i);
  if (!m) {
    return { isSceneCommand: false, command: '', perspective: '' };
  }
  return {
    isSceneCommand: true,
    command: m[1].toLowerCase(),
    perspective: (m[2] || '').trim(),
  };
}

const ANGLE_TRANSLATIONS: Array<[RegExp, string]> = [
  [/(?:сверх\s*крупн\p{L}*\s+план|экстремальн\p{L}*\s+крупн\p{L}*|глаза\s+крупн\p{L}*|extreme\s+close[- ]?up)/iu, 'extreme close-up shot focusing on eyes and facial expression'],
  [/(?:крупн\p{L}*\s+план|портрет|лицо\s+крупн\p{L}*|close[- ]?up)/iu, 'intimate close-up portrait framing head and shoulders, shallow depth of field'],
  [/(?:со\s+спин\p{L}*|вид\s+сзади|через\s+плечо|из-за\s+плеча|from\s+behind|over[- ]the[- ]shoulder)/iu, 'cinematic over-the-shoulder view from behind looking into the scene'],
  [/(?:в\s+полн\p{L}*\s+рост|во\s+весь\s+рост|общ\p{L}*\s+план|широк\p{L}*\s+план|широк\p{L}*\s+угол|full[- ]?body|wide\s+shot)/iu, 'wide full-body establishing shot showing characters head-to-toe in the environment'],
  [/(?:сбоку|вид\s+сбоку|в\s+профиль|профиль|side\s+view|profile\s+shot)/iu, 'cinematic side-profile medium shot'],
  [/(?:вполоборота|три\s+четверти|3\/4|three[- ]?quarter)/iu, 'three-quarter angle view'],
  [/(?:анфас|вид\s+спереди|прямо|front[- ]?facing)/iu, 'front-facing eye-level view'],
  [/(?:сверху|вид\s+сверху|с\s+высот\p{L}*|high[- ]?angle|top[- ]?down|bird'?s[- ]?eye)/iu, 'dramatic high-angle shot looking slightly downward'],
  [/(?:снизу|вид\s+снизу|нижн\p{L}*\s+ракурс|low[- ]?angle)/iu, 'dramatic low-angle cinematic shot looking slightly upward'],
  [/(?:от\s+первого\s+лица|глазами\s+игрока|глазами\s+собеседника|\bpov\b|first[- ]?person)/iu, 'immersive first-person POV shot looking directly at the character'],
  [/(?:по\s+грудь|chest[- ]?up)/iu, 'chest-up medium close-up framing'],
  [/(?:по\s+колен\p{L}*|cowboy\s+shot|knee[- ]?up)/iu, 'knee-up cinematic cowboy shot'],
  [/(?:средн\p{L}*\s+план|по\s+пояс|medium\s+shot|waist[- ]?up)/iu, 'balanced waist-up cinematic medium shot'],
  [/(?:голландск\p{L}*\s+угол|наклон\p{L}*\s+камер\p{L}*|dutch\s+angle)/iu, 'dynamic tilted dutch-angle framing'],
  [/(?:макро|детал\p{L}*\s+крупн\p{L}*|macro\s+shot)/iu, 'detailed cinematic macro shot'],
  [/(?:силуэт|против\s+света|контровой\s+свет|backlit|silhouette)/iu, 'dramatic backlit rim-lit silhouette'],
  [/(?:боке|размыт\p{L}*\s+фон|bokeh|shallow\s+dof)/iu, 'creamy bokeh shallow depth of field'],
  [/(?:у\s+окн\p{L}*|возле\s+окн\p{L}*|by\s+the\s+window)/iu, 'framed beside the window'],
  [/(?:у\s+камин\p{L}*|возле\s+камин\p{L}*|by\s+the\s+fireplace)/iu, 'framed beside the warm fireplace'],
  [/(?:под\s+дожд[её]м|в\s+дождь|in\s+the\s+rain)/iu, 'atmospheric rain droplets in frame'],
  [/(?:смотр\p{L}*\s+в\s+камер\p{L}*|смотр\p{L}*\s+на\s+зрител\p{L}*|looking\s+at\s+(?:viewer|camera))/iu, 'looking directly into the camera'],
  [/(?:смотр\p{L}*\s+в\s+сторон\p{L}*|отвернувш\p{L}*|looking\s+away)/iu, 'looking away thoughtfully'],
];

/**
 * Translates common Russian/English camera angle & framing notes into clean English camera directions
 * so warm perspective changes can reuse the locked SceneState without reloading the local Text LLM.
 */
export function translateCameraAngleToEnglish(rawPerspective?: string): string {
  const raw = (rawPerspective || '').trim();
  if (!raw) {
    return 'cinematic medium shot, natural eye-level framing';
  }

  const matched: string[] = [];
  let remainder = raw;
  for (const [pattern, english] of ANGLE_TRANSLATIONS) {
    if (pattern.test(raw)) {
      matched.push(english);
      remainder = remainder.replace(pattern, ' ').trim();
    }
  }

  // Strip leftover punctuation/connectors if fully covered by preset rules
  const cleanedRemainder = remainder.replace(/^[,.;:\-–—\s]+|[,.;:\-–—\s]+$/g, '').replace(/\s{2,}/g, ' ').trim();
  if (matched.length > 0) {
    if (!cleanedRemainder) return matched.join(', ');
    // Keep any extra non-Cyrillic or specific English/character name tokens alongside translated angle
    if (!/[а-яА-ЯёЁ]/.test(cleanedRemainder)) {
      return `${matched.join(', ')}, ${cleanedRemainder}`;
    }
    return matched.join(', ');
  }

  // Avoid passing raw untranslated Cyrillic words into CLIP/T5 English-only diffusion tokenizers during warm angle swaps
  if (/[а-яА-ЯёЁ]/.test(raw)) {
    const latinTokens = raw.replace(/[а-яА-ЯёЁ]+/g, ' ').replace(/^[,.;:\-–—\s]+|[,.;:\-–—\s]+$/g, '').replace(/\s{2,}/g, ' ').trim();
    return latinTokens
      ? `cinematic medium shot, natural eye-level framing, ${latinTokens}`
      : 'cinematic medium shot, natural eye-level framing';
  }

  return raw;
}

/**
 * Returns the ID of the most recent message that contains actual dialogue/narrative text
 * (ignoring scene-director image cards and empty messages), used to detect whether new story context appeared since the last analysis.
 */
export function latestDialogueMessageId(messages: ChatMessage[]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.senderId === 'scene-director') continue;
    const txt = m.variants?.[m.activeVariantIndex]?.text || '';
    if (txt.trim().length > 0) {
      return m.id;
    }
  }
  return undefined;
}

const CYRILLIC_TO_LATIN_MAP: Record<string, string> = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'yo', ж: 'zh', з: 'z',
  и: 'i', й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r',
  с: 's', т: 't', у: 'u', ф: 'f', х: 'kh', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'shch',
  ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya',
};

/**
 * Transliterates Cyrillic text into clean ASCII Latin characters while preserving existing Latin text,
 * ensuring English-only CLIP/T5 diffusion tokenizers never receive raw Cyrillic character names.
 */
export function transliterateCyrillicToLatin(text?: string): string {
  const raw = (text || '').trim();
  if (!raw || !/[а-яА-ЯёЁ]/.test(raw)) return raw;
  let out = '';
  for (const ch of raw) {
    const low = ch.toLowerCase();
    const mapped = CYRILLIC_TO_LATIN_MAP[low];
    if (mapped !== undefined) {
      if (!mapped) continue;
      const isUpper = ch !== low;
      out += isUpper ? mapped[0].toUpperCase() + mapped.slice(1) : mapped;
    } else {
      out += ch;
    }
  }
  return out.replace(/\s{2,}/g, ' ').trim();
}

function phoneticNameKey(name?: string): string {
  const latin = transliterateCyrillicToLatin(name).toLowerCase();
  return latin
    .replace(/[^\p{L}\p{N}]+/gu, '')
    .replace(/ph/g, 'f')
    .replace(/ks/g, 'x')
    .replace(/ck/g, 'k')
    .replace(/c(?![ehi])/g, 'k')
    .replace(/w/g, 'v')
    .replace(/[yij]+/g, 'i');
}

/**
 * Matches actor names across Cyrillic and English transliterations (e.g. "Максим" <-> "Maxim"/"Maksim",
 * "Лира" <-> "Lyra"/"Lira", "Алекс" <-> "Alex", "Виктор" <-> "Victor").
 */
export function actorNamesMatch(a?: string, b?: string): boolean {
  const rawA = (a || '').trim().toLowerCase();
  const rawB = (b || '').trim().toLowerCase();
  if (!rawA || !rawB) return false;
  if (rawA === rawB) return true;
  if (rawA.length >= 2 && rawB.length >= 2 && (rawA.includes(rawB) || rawB.includes(rawA))) {
    return true;
  }
  const keyA = phoneticNameKey(rawA);
  const keyB = phoneticNameKey(rawB);
  if (!keyA || !keyB) return false;
  if (keyA === keyB) return true;
  if (keyA.length >= 3 && keyB.length >= 3 && (keyA.includes(keyB) || keyB.includes(keyA))) {
    return true;
  }
  return false;
}

export function isGenericUserActorLabel(name?: string): boolean {
  return /^(?:user|player|you|protagonist|main\s*character|игрок|пользователь|вы)$/i.test((name || '').trim());
}

function cleanAsciiAppearanceFallback(description?: string): string {
  const raw = (description || '').trim();
  if (!raw || /[а-яА-ЯёЁ]/.test(raw)) return '';
  return raw.replace(/[\r\n]+/g, ' ').replace(/\s{2,}/g, ' ').slice(0, 180).trim();
}

export interface RawSceneAnalysisPayload {
  locationChanged?: boolean;
  locationName?: string;
  visualAnchor?: string;
  lighting?: string;
  weatherOrAtmosphere?: string;
  actors?: Array<{
    name?: string;
    appearance?: string;
    clothing?: string;
    poseOrAction?: string;
    expression?: string;
    positionInScene?: string;
  }>;
  props?: string[];
  cameraFraming?: string;
  compositionPrompt?: string;
}

export function extractJsonObjectSafe(rawText: string): RawSceneAnalysisPayload | null {
  const cleaned = (rawText || '')
    .replace(/<thought>[\s\S]*?<\/thought>/gi, '')
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .trim();
  const m = cleaned.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const parsed = JSON.parse(m[0]);
    return parsed && typeof parsed === 'object' ? (parsed as RawSceneAnalysisPayload) : null;
  } catch {
    return null;
  }
}

/**
 * Merges a newly extracted scene snapshot into the session's previous SceneState while preserving
 * the static location visualAnchor across perspective changes / regenerations.
 */
export function mergeSceneState(
  prev: SceneState | undefined,
  extracted: RawSceneAnalysisPayload,
  characters: Character[],
  perspective = '',
  now = Date.now(),
  analyzedMsgId?: string,
  userPersona?: Character | null
): SceneState {
  const prevLoc = prev?.location;
  const hasPrevAnchor = Boolean(prevLoc?.visualAnchor?.trim());
  const normalizedPrevName = (prevLoc?.locationName || '').trim().toLowerCase();
  const normalizedNewName = (extracted.locationName || '').trim().toLowerCase();
  const explicitNewPlace =
    Boolean(extracted.locationChanged) &&
    Boolean(normalizedNewName) &&
    normalizedNewName !== normalizedPrevName;

  // Keep locked static environment unless characters genuinely moved to a different location
  const keepLockedAnchor = hasPrevAnchor && prevLoc?.locked !== false && !explicitNewPlace;

  const location: SceneLocationAnchor = keepLockedAnchor && prevLoc
    ? {
        locationId: prevLoc.locationId,
        locationName: prevLoc.locationName,
        visualAnchor: prevLoc.visualAnchor,
        lighting: (extracted.lighting || '').trim() || prevLoc.lighting,
        weatherOrAtmosphere: (extracted.weatherOrAtmosphere || '').trim() || prevLoc.weatherOrAtmosphere || '',
        locked: true,
      }
    : {
        locationId: `loc_${now}`,
        locationName: (extracted.locationName || prevLoc?.locationName || 'Current setting').trim(),
        visualAnchor: (extracted.visualAnchor || prevLoc?.visualAnchor || 'indoor moody room with warm ambient details').trim(),
        lighting: (extracted.lighting || prevLoc?.lighting || 'natural cinematic lighting').trim(),
        weatherOrAtmosphere: (extracted.weatherOrAtmosphere || prevLoc?.weatherOrAtmosphere || '').trim(),
        locked: true,
      };

  const incomingActors = Array.isArray(extracted.actors) ? extracted.actors : [];
  const prevActors = prev?.actors || [];
  const actors: SceneActorState[] = [];

  for (const ch of characters) {
    const hit = incomingActors.find((a) => actorNamesMatch(a.name, ch.name));
    const old = prevActors.find((a) => a.characterId === ch.id || actorNamesMatch(a.name, ch.name));
    const appearance = (
      hit?.appearance ||
      old?.appearance ||
      (!ch.imageGen?.appearancePrompt?.trim() ? cleanAsciiAppearanceFallback(ch.description) : '') ||
      ''
    ).trim();
    actors.push({
      characterId: ch.id,
      name: ch.name,
      ...(appearance ? { appearance } : {}),
      clothing: (hit?.clothing || old?.clothing || '').trim(),
      poseOrAction: (hit?.poseOrAction || old?.poseOrAction || 'standing naturally in scene').trim(),
      expression: (hit?.expression || old?.expression || 'composed expression').trim(),
      positionInScene: (hit?.positionInScene || old?.positionInScene || '').trim(),
    });
  }

  // Keep any extra non-card background actors / user persona mentioned by analyzer
  for (const extra of incomingActors) {
    const eName = (extra.name || '').trim();
    if (!eName) continue;
    const already = actors.some((a) => actorNamesMatch(a.name, eName));
    if (!already && actors.length < 4) {
      const matchesPersona = Boolean(
        userPersona && (actorNamesMatch(eName, userPersona.name) || isGenericUserActorLabel(eName))
      );
      const oldExtra = prevActors.find(
        (a) => (matchesPersona && userPersona && a.characterId === userPersona.id) || actorNamesMatch(a.name, eName)
      );
      const appearance = (
        extra.appearance ||
        oldExtra?.appearance ||
        (matchesPersona && userPersona && !userPersona.imageGen?.appearancePrompt?.trim()
          ? cleanAsciiAppearanceFallback(userPersona.description)
          : '') ||
        ''
      ).trim();
      const eLow = transliterateCyrillicToLatin(eName).toLowerCase();
      const safeSlug = eLow.replace(/[^\p{L}\p{N}]+/gu, '_').replace(/^_+|_+$/g, '') || 'actor';
      actors.push({
        characterId: matchesPersona && userPersona ? userPersona.id : `extra_${safeSlug}`,
        name: matchesPersona && userPersona ? userPersona.name : eName,
        ...(appearance ? { appearance } : {}),
        clothing: (extra.clothing || oldExtra?.clothing || '').trim(),
        poseOrAction: (extra.poseOrAction || oldExtra?.poseOrAction || '').trim(),
        expression: (extra.expression || oldExtra?.expression || '').trim(),
        positionInScene: (extra.positionInScene || oldExtra?.positionInScene || '').trim(),
      });
    }
  }

  const props = Array.isArray(extracted.props)
    ? extracted.props.map((p) => String(p).trim()).filter(Boolean).slice(0, 8)
    : (prev?.props || []);

  const resolvedFraming = (
    extracted.cameraFraming ||
    (perspective ? translateCameraAngleToEnglish(perspective) : '') ||
    prev?.lastCameraAngle ||
    'medium shot, cinematic eye-level framing'
  ).trim();

  const resolvedComp = (extracted.compositionPrompt || prev?.lastCompositionPrompt || '').trim();

  return {
    location,
    actors,
    props,
    lastCameraAngle: resolvedFraming,
    lastCompositionPrompt: resolvedComp || undefined,
    lastAnalyzedMsgId: analyzedMsgId ?? prev?.lastAnalyzedMsgId,
    updatedAt: now,
  };
}

export interface SceneAnalysisResult {
  sceneState: SceneState;
  cameraFraming: string;
  compositionPrompt: string;
}

/**
 * Runs the dedicated textual `sceneAnalysis` AI strictly BEFORE any local image generation
 * (so if hardware shares VRAM, text reasoning finishes while the LLM is still loaded).
 */
export async function analyzeAndUpdateSceneState(params: {
  session: ChatSession;
  messages: ChatMessage[];
  characters: Character[];
  perspective: string;
  userPersona?: Character | null;
  settings?: AppSettings;
  activeApiKey?: ApiKeyConfig;
  signal?: AbortSignal;
}): Promise<SceneAnalysisResult> {
  const { session, messages, characters, perspective, userPersona, settings, activeApiKey, signal } = params;
  const { apiKeyConfig, textModel, isLocal } = getComponentAiConfig(settings, activeApiKey, 'sceneAnalysis');
  const lastMsgId = latestDialogueMessageId(messages);

  const recentTranscript = messages
    .filter((m) => m.senderId !== 'scene-director')
    .slice(-12)
    .map((m) => {
      const txt = m.variants?.[m.activeVariantIndex]?.text || '';
      if (!txt.trim()) return '';
      return `${m.senderName}: ${txt.slice(0, 600)}`;
    })
    .filter(Boolean)
    .join('\n');

  const charRoster = characters
    .map((c) => {
      const appearance = c.imageGen?.appearancePrompt ? ` | Appearance: ${c.imageGen.appearancePrompt}` : '';
      return `- ${c.name}: ${c.description.slice(0, 500)}${appearance}`;
    })
    .join('\n');

  const prevState = session.sceneState;
  const prevStateJson = prevState
    ? JSON.stringify({
        locationName: prevState.location.locationName,
        visualAnchor: prevState.location.visualAnchor,
        lighting: prevState.location.lighting,
        locked: prevState.location.locked,
        actors: prevState.actors.map((a) => ({
          name: a.name,
          ...(a.appearance ? { appearance: a.appearance } : {}),
          clothing: a.clothing,
          expression: a.expression,
        })),
        props: prevState.props,
      })
    : 'none';

  const translatedAngle = translateCameraAngleToEnglish(perspective);
  const perspectiveText = perspective.trim()
    ? `${perspective.trim()} (${translatedAngle})`
    : 'cinematic medium shot capturing the current interaction naturally';

  // If no AI key / local hub isn't usable, synthesize cleanly without crashing
  if (!apiKeyConfig || (!isLocal && !apiKeyConfig.key?.trim() && apiKeyConfig.provider !== 'custom')) {
    const fallbackState = mergeSceneState(
      prevState,
      {
        locationChanged: !prevState,
        locationName: prevState?.location.locationName || session.title || 'Scene setting',
        visualAnchor: prevState?.location.visualAnchor || 'detailed atmospheric interior matching story context',
        lighting: prevState?.location.lighting || 'soft cinematic lighting',
        cameraFraming: translatedAngle,
      },
      characters,
      translatedAngle,
      Date.now(),
      lastMsgId,
      userPersona
    );
    return {
      sceneState: fallbackState,
      cameraFraming: translatedAngle,
      compositionPrompt: fallbackState.lastCompositionPrompt || translatedAngle,
    };
  }

  const systemPrompt = [
    'You are the visual Scene Director AI for a roleplay story.',
    'Analyze the recent roleplay dialogue, rolling summary, character sheets, and existing locked location state.',
    'Output ONLY a valid JSON object (no markdown fences, no commentary) in English with these exact keys:',
    '{',
    '  "locationChanged": boolean, // TRUE only if characters explicitly walked/traveled to a completely new place. FALSE if only camera angle, pose, or time shifted!',
    '  "locationName": string, // Short location label',
    '  "visualAnchor": string, // Detailed static architecture, room layout, wall colors, furniture, background objects in English (25-45 words). Preserve previous visualAnchor unless locationChanged=true!',
    '  "lighting": string, // Color temperature, light sources, shadows',
    '  "weatherOrAtmosphere": string,',
    '  "actors": [ { "name": string, "appearance": string, "clothing": string, "poseOrAction": string, "expression": string, "positionInScene": string } ], // Keep "name" matching the exact character/user sheet name; set "appearance" to concise English physical traits (preserve exact non-human/furry/anthro/fantasy/cyborg species & anatomy first — e.g. anthropomorphic wolf, muzzle, fur/scales, horns, wings, tail, pointed ears, cybernetics — plus gender/build, hair, eyes, key markings from sheet, 10-24 words)',
    '  "props": [ string ], // Active items currently held or on nearby table/surfaces',
    '  "cameraFraming": string, // Honor the requested perspective/angle in English',
    '  "compositionPrompt": string // Cohesive English description (35-65 words) of character actions, interaction, clothes, props, and mood WITHOUT hardcoding a conflicting camera angle so cameraFraming can shift cleanly.',
    '}',
  ].join('\n');

  const personaAppearance = userPersona?.imageGen?.appearancePrompt?.trim()
    ? ` | Appearance: ${userPersona.imageGen.appearancePrompt.trim()}`
    : '';
  const userPrompt = [
    `Requested shot / perspective: ${perspectiveText}`,
    userPersona
      ? `User character in scene (only include in actors if actively visible in shot, not first-person POV): ${userPersona.name} (${userPersona.description.slice(0, 500)}${personaAppearance})`
      : '',
    `Characters:\n${charRoster}`,
    session.rollingSummary ? `Story summary so far:\n${session.rollingSummary.slice(0, 700)}` : '',
    `Previous locked scene state:\n${prevStateJson}`,
    `Recent messages (translate all visual details into clean English for image generation):\n${recentTranscript}`,
  ]
    .filter(Boolean)
    .join('\n\n');

  let rawOutput = '';
  await streamChatCompletion({
    apiKeyConfig,
    model: textModel,
    temperature: 0.25,
    maxTokens: 640,
    includeReasoning: false,
    signal,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
    onToken: (tok) => {
      rawOutput += tok;
    },
    onError: (err) => {
      throw err;
    },
  });

  const parsed = extractJsonObjectSafe(rawOutput) || {
    locationChanged: false,
    cameraFraming: translatedAngle,
    compositionPrompt: rawOutput.slice(0, 260).replace(/[\r\n]+/g, ' ').trim() || translatedAngle,
  };

  const merged = mergeSceneState(prevState, parsed, characters, translatedAngle, Date.now(), lastMsgId, userPersona);
  const framing = (parsed.cameraFraming || merged.lastCameraAngle || translatedAngle).trim();
  const comp = (parsed.compositionPrompt || merged.lastCompositionPrompt || '').trim() || framing;

  return {
    sceneState: merged,
    cameraFraming: framing,
    compositionPrompt: comp,
  };
}
