import type {
  ApiKeyConfig,
  AppSettings,
  Character,
  ChatMessage,
  ChatSession,
  SceneAsset,
  SceneState,
} from '../types/index.ts';
import { compressDataUrlToJpeg, isRasterImageDataUrl } from '../utils/imageUtils.ts';
import { generateSceneImage, getComponentBackend, type SceneImageGenerationResult } from './ai.ts';
import {
  actorNamesMatch,
  analyzeAndUpdateSceneState,
  isGenericUserActorLabel,
  latestDialogueMessageId,
  translateCameraAngleToEnglish,
  transliterateCyrillicToLatin,
  type SceneAnalysisResult,
} from './sceneState.ts';

export interface BuiltScenePromptPlan {
  prompt: string;
  negativePrompt: string;
  references: string[];
  loras: Array<{ filename: string; weight: number; trigger_word?: string }>;
  perspective: string;
}

const BASE_NEGATIVE_PROMPT =
  'text, speech bubble, watermark, signature, split screen, collage, lowres, blurry, bad anatomy, deformed hands, mutated fingers, extra digits, duplicate face, fused bodies, merged characters, out of frame';

/**
 * Combines the analyzed SceneState with each character's configured reference photos / appearance
 * or trained LoRA adapter into a cohesive generation plan, strictly excluding SVG placeholder avatars.
 */
export function buildScenePromptPlan(params: {
  analysis: SceneAnalysisResult;
  characters: Character[];
  userPersona?: Character | null;
  perspective?: string;
  customPromptOverride?: string;
}): BuiltScenePromptPlan {
  const { analysis, characters, userPersona, perspective = '', customPromptOverride } = params;
  const { sceneState, cameraFraming, compositionPrompt } = analysis;

  const references: string[] = [];
  const loras: Array<{ filename: string; weight: number; trigger_word?: string }> = [];
  const actorDescriptions: string[] = [];
  const styleHints: string[] = [];

  for (const ch of characters) {
    const imgCfg = ch.imageGen;
    const actor = sceneState.actors.find(
      (a) => a.characterId === ch.id || actorNamesMatch(a.name, ch.name)
    );

    if (imgCfg?.enabled) {
      if (imgCfg.styleHint?.trim()) {
        styleHints.push(imgCfg.styleHint.trim());
      }
      if (imgCfg.mode === 'reference') {
        const photos = (imgCfg.referenceImages || []).filter((p) => isRasterImageDataUrl(p));
        if (photos.length > 0) {
          for (const p of photos.slice(0, 2)) {
            if (references.length < 4) references.push(p);
          }
        } else if (isRasterImageDataUrl(ch.avatar) && references.length < 4) {
          references.push(ch.avatar!);
        }
      } else if (imgCfg.mode === 'lora' && imgCfg.loraName) {
        loras.push({
          filename: imgCfg.loraName,
          weight: typeof imgCfg.loraWeight === 'number' ? imgCfg.loraWeight : 0.85,
          trigger_word: imgCfg.loraTrigger?.trim() || undefined,
        });
      }
    }

    const parts: string[] = [];
    if (imgCfg?.enabled && imgCfg.mode === 'lora' && imgCfg.loraTrigger?.trim()) {
      parts.push(imgCfg.loraTrigger.trim());
    }
    parts.push(transliterateCyrillicToLatin(ch.name) || ch.name);
    const charAppearance = imgCfg?.appearancePrompt?.trim() || actor?.appearance?.trim() || '';
    if (charAppearance) {
      parts.push(charAppearance);
    }
    if (actor?.clothing) parts.push(`wearing ${actor.clothing}`);
    if (actor?.poseOrAction) parts.push(actor.poseOrAction);
    if (actor?.expression) parts.push(`${actor.expression} expression`);
    if (actor?.positionInScene) parts.push(actor.positionInScene);
    actorDescriptions.push(parts.join(', '));
  }

  // Include extra non-card actors if analyzer noted e.g. user persona visible in frame
  for (const actor of sceneState.actors) {
    if (characters.some((c) => c.id === actor.characterId || actorNamesMatch(c.name, actor.name))) {
      continue;
    }
    const isPersonaActor = Boolean(
      userPersona &&
        (actor.characterId === userPersona.id ||
          actorNamesMatch(actor.name, userPersona.name) ||
          isGenericUserActorLabel(actor.name))
    );
    const pImg = isPersonaActor ? userPersona?.imageGen : undefined;

    if (isPersonaActor && pImg?.enabled) {
      if (pImg.styleHint?.trim() && styleHints.length === 0) {
        styleHints.push(pImg.styleHint.trim());
      }
      if (pImg.mode === 'reference') {
        const pPhotos = (pImg.referenceImages || []).filter((p) => isRasterImageDataUrl(p));
        if (pPhotos.length > 0) {
          for (const p of pPhotos.slice(0, 2)) {
            if (references.length < 4) references.push(p);
          }
        } else if (isRasterImageDataUrl(userPersona?.avatar) && references.length < 4) {
          references.push(userPersona!.avatar!);
        }
      } else if (pImg.mode === 'lora' && pImg.loraName) {
        loras.push({
          filename: pImg.loraName,
          weight: typeof pImg.loraWeight === 'number' ? pImg.loraWeight : 0.85,
          trigger_word: pImg.loraTrigger?.trim() || undefined,
        });
      }
    }

    const displayName = isPersonaActor && userPersona
      ? transliterateCyrillicToLatin(userPersona.name) || userPersona.name
      : transliterateCyrillicToLatin(actor.name) || actor.name;
    const resolvedAppearance =
      (isPersonaActor ? pImg?.appearancePrompt?.trim() : '') ||
      actor.appearance?.trim() ||
      '';

    const extraParts = [
      isPersonaActor && pImg?.enabled && pImg.mode === 'lora' && pImg.loraTrigger?.trim()
        ? pImg.loraTrigger.trim()
        : '',
      displayName,
      resolvedAppearance,
      actor.clothing ? `wearing ${actor.clothing}` : '',
      actor.poseOrAction,
      actor.expression ? `${actor.expression} expression` : '',
      actor.positionInScene || '',
    ].filter(Boolean);
    if (extraParts.length > 1 || (isPersonaActor && Boolean(pImg?.enabled))) {
      actorDescriptions.push(extraParts.join(', '));
    }
  }

  const uniqueStyles = Array.from(new Set(styleHints.filter(Boolean))).slice(0, 2);
  const resolvedStyle =
    uniqueStyles.join(', ') ||
    'cinematic high-detail storytelling illustration, cohesive lighting, sharp focus';
  const wantsComicStyle = /\b(?:comic|manga|graphic\s+novel|webtoon)\b/i.test(resolvedStyle);
  const negativePrompt = wantsComicStyle
    ? BASE_NEGATIVE_PROMPT
    : `comic panel, ${BASE_NEGATIVE_PROMPT}`;

  if (customPromptOverride?.trim()) {
    return {
      prompt: customPromptOverride.trim(),
      negativePrompt,
      references,
      loras,
      perspective: perspective || cameraFraming,
    };
  }

  const multiSubjectSeparation =
    actorDescriptions.length >= 2
      ? `${actorDescriptions.length} distinct separate individuals in frame with separate bodies and distinct features`
      : '';

  const promptSegments = [
    resolvedStyle,
    cameraFraming,
    multiSubjectSeparation,
    actorDescriptions.join('; '),
    compositionPrompt,
    sceneState.props.length ? `props: ${sceneState.props.join(', ')}` : '',
    `consistent setting: ${sceneState.location.visualAnchor}`,
    `lighting: ${sceneState.location.lighting}`,
    sceneState.location.weatherOrAtmosphere || '',
  ].filter((s) => Boolean(s && s.trim()));

  return {
    prompt: promptSegments.join(', '),
    negativePrompt,
    references,
    loras,
    perspective: perspective || cameraFraming,
  };
}

export interface GenerateSceneWorkflowResult {
  assetDraft: Omit<SceneAsset, 'id' | 'createdAt'>;
  sceneState: SceneState;
  generation: SceneImageGenerationResult;
}

/**
 * Selects which characters participate in scene generation.
 * In group chats, includes only group characters with `imageGen.enabled === true` (never the user's persona).
 */
export function selectSceneCharacters(params: {
  chatType: 'character' | 'group';
  character?: Character | null;
  group?: { characterIds: string[] } | null;
  allCharacters: Character[];
  personaId?: string | null;
}): Character[] {
  if (params.chatType === 'character') {
    return params.character ? [params.character] : [];
  }
  const ids = params.group?.characterIds || [];
  return params.allCharacters.filter(
    (c) => ids.includes(c.id) && c.id !== params.personaId && c.imageGen?.enabled === true
  );
}

/**
 * Orchestrates Scene Director:
 *   1. Runs LLM Context Analysis strictly BEFORE loading the image model when new chat turns exist.
 *      When regenerating or changing camera angle on the SAME chat state while Local Hub is active,
 *      reuses the locked SceneState + translated camera angle so the warm image model stays in VRAM!
 *   2. Normalizes character reference photos to clean compact RGB JPEGs (rejecting SVGs).
 *   3. Dispatches image synthesis with live stage/step progress.
 */
export async function executeSceneGenerationPipeline(params: {
  session: ChatSession;
  messages: ChatMessage[];
  characters: Character[];
  userPersona?: Character | null;
  perspective: string;
  settings?: AppSettings;
  activeApiKey?: ApiKeyConfig;
  customPromptOverride?: string;
  skipAnalysis?: boolean;
  forceReanalyze?: boolean;
  initImage?: string;
  strength?: number;
  seed?: number;
  signal?: AbortSignal;
  onStage?: (info: { stage: string; progress?: number; step?: number; totalSteps?: number }) => void;
  onSceneStateUpdated?: (nextState: SceneState) => Promise<void> | void;
}): Promise<GenerateSceneWorkflowResult> {
  const {
    session,
    messages,
    characters,
    userPersona,
    perspective,
    settings,
    activeApiKey,
    customPromptOverride,
    skipAnalysis = false,
    forceReanalyze = false,
    initImage,
    strength,
    seed,
    signal,
    onStage,
    onSceneStateUpdated,
  } = params;

  const lastMsgId = latestDialogueMessageId(messages);
  const analysisBackend = getComponentBackend(settings, 'sceneAnalysis');
  const imageBackend = getComponentBackend(settings, 'sceneImage');
  const sameDialogueState =
    Boolean(session.sceneState) &&
    Boolean(session.sceneState?.location?.visualAnchor) &&
    session.sceneState?.lastAnalyzedMsgId === lastMsgId;

  // Avoid unloading warm local image model just to re-read identical chat messages during angle changes
  const reuseWarmState =
    !forceReanalyze &&
    Boolean(session.sceneState) &&
    (skipAnalysis || (sameDialogueState && analysisBackend === 'local' && imageBackend === 'local'));

  let analysis: SceneAnalysisResult;

  if (reuseWarmState && session.sceneState) {
    const framing = perspective.trim()
      ? translateCameraAngleToEnglish(perspective)
      : session.sceneState.lastCameraAngle || 'cinematic medium shot';
    const nextState: SceneState = {
      ...session.sceneState,
      lastCameraAngle: framing,
      updatedAt: Date.now(),
    };
    analysis = {
      sceneState: nextState,
      cameraFraming: framing,
      compositionPrompt: session.sceneState.lastCompositionPrompt || '',
    };
    if (perspective.trim() && onSceneStateUpdated) {
      await onSceneStateUpdated(nextState);
    }
  } else {
    onStage?.({ stage: 'analyzing', progress: 8 });
    analysis = await analyzeAndUpdateSceneState({
      session,
      messages,
      characters,
      perspective,
      userPersona,
      settings,
      activeApiKey,
      signal,
    });
    if (onSceneStateUpdated) {
      await onSceneStateUpdated(analysis.sceneState);
    }
  }

  const plan = buildScenePromptPlan({
    analysis,
    characters,
    userPersona,
    perspective,
    customPromptOverride,
  });

  // Normalize reference photos to clean compact JPEGs (<=768px) so WebP/large PNGs never fail on 8 GB GPUs
  const normalizedRefs: string[] = [];
  for (const ref of plan.references) {
    const clean = await compressDataUrlToJpeg(ref, 768, 0.9);
    if (clean) normalizedRefs.push(clean);
  }

  const normalizedInit = initImage ? (await compressDataUrlToJpeg(initImage, 1024, 0.9)) || undefined : undefined;

  onStage?.({ stage: 'generating', progress: 18 });
  const generation = await generateSceneImage({
    settings,
    activeApiKey,
    prompt: plan.prompt,
    negativePrompt: plan.negativePrompt,
    aspectRatio: settings?.sceneAspectRatio || 'portrait',
    references: normalizedRefs,
    loras: plan.loras,
    initImage: normalizedInit,
    strength,
    seed,
    signal,
    onProgress: onStage,
  });

  return {
    sceneState: analysis.sceneState,
    generation,
    assetDraft: {
      chatId: session.id,
      imageData: generation.imageData,
      prompt: plan.prompt,
      negativePrompt: plan.negativePrompt,
      perspective: plan.perspective,
      seed: generation.seed,
      width: generation.width,
      height: generation.height,
      modelUsed: generation.modelUsed,
      backendUsed: generation.backendUsed,
      ...(generation.skippedLoras?.length ? { skippedLoras: generation.skippedLoras } : {}),
    },
  };
}
