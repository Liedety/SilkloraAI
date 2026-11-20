import type { ApiKeyConfig, AppSettings } from '../../types';
import { getComponentBackend, getProviderBaseUrl, localHubRootUrl } from './config.ts';

export interface ImageModelChoice {
  id: string;
  name: string;
  family?: string;
  supportsRefs?: boolean;
  isActive?: boolean;
}

export async function fetchImageModels(options: {
  apiKeyConfig?: ApiKeyConfig;
  isLocal?: boolean;
  localHubUrl?: string;
}): Promise<ImageModelChoice[]> {
  const { apiKeyConfig, isLocal, localHubUrl } = options;

  if (isLocal) {
    try {
      const root = localHubRootUrl(localHubUrl);
      const res = await fetch(`${root}/v1/images/models`, { headers: { Accept: 'application/json' } });
      if (res.ok) {
        const data = await res.json();
        const models = Array.isArray(data.models) ? data.models : [];
        return models.map((m: any) => ({
          id: String(m.filename),
          name: String(m.filename),
          family: String(m.family || ''),
          supportsRefs: Boolean(m.supports_refs),
          isActive: Boolean(m.is_active),
        }));
      }
    } catch {
      // fall through
    }
    return [];
  }

  const defaults: ImageModelChoice[] = [
    { id: 'google/gemini-2.5-flash-image', name: 'Gemini 2.5 Flash Image (Fast + Multi-Ref)', supportsRefs: true },
    { id: 'black-forest-labs/flux.2-pro', name: 'FLUX.2 Pro (High Detail)', supportsRefs: true },
    { id: 'black-forest-labs/flux.2-flex', name: 'FLUX.2 Flex (Balanced)', supportsRefs: true },
    { id: 'openai/gpt-5-image-mini', name: 'GPT-5 Image Mini', supportsRefs: true },
  ];

  if (apiKeyConfig && apiKeyConfig.provider === 'gemini') {
    return [
      { id: 'gemini-2.5-flash-image', name: 'Gemini 2.5 Flash Image (Native Multi-Ref)', supportsRefs: true },
      { id: 'imagen-3.0-generate-002', name: 'Imagen 3.0 Generate', supportsRefs: false },
    ];
  }

  if (apiKeyConfig && apiKeyConfig.provider === 'openai') {
    return [
      { id: 'gpt-image-1', name: 'GPT Image 1', supportsRefs: true },
      { id: 'dall-e-3', name: 'DALL-E 3', supportsRefs: false },
    ];
  }

  if (apiKeyConfig && apiKeyConfig.provider === 'openrouter' && apiKeyConfig.key.trim()) {
    try {
      const res = await fetch('https://openrouter.ai/api/v1/images/models', {
        headers: { Authorization: `Bearer ${apiKeyConfig.key.trim()}` },
      });
      if (res.ok) {
        const data = await res.json();
        const rows = Array.isArray(data?.data) ? data.data : [];
        if (rows.length > 0) {
          return rows.slice(0, 40).map((m: any) => ({
            id: String(m.id),
            name: String(m.name || m.id),
            supportsRefs: true,
          }));
        }
      }
    } catch {
      // ignore and return curated defaults
    }
  }

  return defaults;
}

export interface LocalLoraItem {
  filename: string;
  stem: string;
  size_bytes: number;
  trigger_word: string;
  base_arch: string;
  compatible_with_active?: boolean | null;
  is_full_model?: boolean;
}

export interface TrainableCheckpointItem {
  filename: string;
  family: string;
  variant?: string;
  is_active?: boolean;
}

/**
 * Checks whether a LoRA's detected base architecture matches the active local base model family.
 * Unknown/untagged LoRAs or unknown base models return true so custom setups are never blocked.
 */
export function isLoraCompatibleWithModelFamily(loraArch?: string, modelFamily?: string): boolean {
  const la = (loraArch || '').trim().toLowerCase();
  const mf = (modelFamily || '').trim().toLowerCase();
  if (!la || !mf || mf === 'other') return true;
  if (la === mf) return true;
  const groups = [
    ['flux', 'flux_kontext'],
    ['qwen', 'qwen_image', 'qwen_edit'],
    ['sdxl', 'illustrious', 'pony', 'animagine', 'noob'],
    ['chroma', 'kroma'],
    ['sd3', 'sd35'],
    ['sd15', 'sd1.5'],
  ];
  return groups.some((g) => g.includes(la) && g.includes(mf));
}

export interface InferenceOnlyModelItem {
  filename: string;
  family: string;
  variant?: string;
  format?: string;
  is_active?: boolean;
}

export interface ReadyImageModelItem {
  filename: string;
  family: string;
  variant?: string;
  format?: string;
  is_active?: boolean;
}

export async function fetchLocalLoras(localHubUrl?: string): Promise<{
  loras: LocalLoraItem[];
  trainer?: { installed: boolean; gpu_ok: boolean; vram_gb: number; warning?: string };
  active_image_model?: {
    filename: string;
    family: string;
    variant?: string;
    format?: string;
    ready_to_run?: boolean;
    missing_companions?: string[];
  } | null;
  trainable_checkpoints?: TrainableCheckpointItem[];
  inference_only_models?: InferenceOnlyModelItem[];
  ready_models?: ReadyImageModelItem[];
}> {
  const root = localHubRootUrl(localHubUrl);
  const res = await fetch(`${root}/v1/images/loras`, { headers: { Accept: 'application/json' } });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}`);
  }
  return res.json();
}

export async function selectLocalImageModel(localHubUrl: string | undefined, model: string): Promise<void> {
  const root = localHubRootUrl(localHubUrl);
  const res = await fetch(`${root}/v1/images/select`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model }),
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(errText || `HTTP ${res.status}`);
  }
}

export async function trainCharacterLoraOnHub(
  localHubUrl: string,
  payload: {
    character_name: string;
    trigger_word: string;
    images: Array<{ dataUrl: string; caption?: string }>;
    base_model?: string;
    caption?: string;
    steps?: number;
  }
): Promise<any> {
  const root = localHubRootUrl(localHubUrl);
  const res = await fetch(`${root}/v1/images/lora/train`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data?.error?.message || `HTTP ${res.status}`);
  }
  return data.job || data;
}

export async function fetchLoraTrainStatus(localHubUrl: string): Promise<any> {
  const root = localHubRootUrl(localHubUrl);
  const res = await fetch(`${root}/v1/images/lora/status`, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export interface SceneImageGenerationParams {
  settings?: AppSettings;
  activeApiKey?: ApiKeyConfig;
  prompt: string;
  negativePrompt?: string;
  width?: number;
  height?: number;
  aspectRatio?: 'portrait' | 'landscape' | 'square';
  references?: string[];
  loras?: Array<{ filename: string; weight?: number; trigger_word?: string }>;
  initImage?: string;
  strength?: number;
  seed?: number;
  modelOverride?: string;
  signal?: AbortSignal;
  onProgress?: (info: { stage: string; progress?: number; step?: number; totalSteps?: number }) => void;
}

export interface SceneImageGenerationResult {
  imageData: string;
  seed?: number;
  width?: number;
  height?: number;
  modelUsed: string;
  backendUsed: 'local' | 'cloud';
  skippedLoras?: Array<{ filename: string; lora_arch: string; model_family: string }>;
}

function splitDataUrl(dataUrl: string): { mime: string; b64: string } | null {
  const m = (dataUrl || '').match(/^data:([^;]+);base64,(.+)$/);
  if (!m) return null;
  return { mime: m[1], b64: m[2] };
}

export async function generateSceneImage(params: SceneImageGenerationParams): Promise<SceneImageGenerationResult> {
  const { settings, activeApiKey, prompt, negativePrompt, references = [], loras = [], initImage, strength, seed, modelOverride, signal, onProgress } = params;
  const backend = getComponentBackend(settings, 'sceneImage');
  const aspect = params.aspectRatio || settings?.sceneAspectRatio || 'portrait';
  const width = params.width || (aspect === 'landscape' ? 1024 : aspect === 'square' ? 896 : 768);
  const height = params.height || (aspect === 'landscape' ? 768 : aspect === 'square' ? 896 : 1024);

  if (backend === 'local') {
    const root = localHubRootUrl(settings?.localHubUrl);
    onProgress?.({ stage: 'switching_memory', progress: 0 });
    const startRes = await fetch(`${root}/v1/images/scene`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal,
      body: JSON.stringify({
        async: true,
        prompt,
        negative_prompt: negativePrompt || '',
        width,
        height,
        references,
        loras,
        init_image: initImage || undefined,
        strength: strength ?? 0.55,
        seed: seed ?? -1,
        model: modelOverride || undefined,
      }),
    });
    const startData = await startRes.json().catch(() => ({}));
    if (!startRes.ok) {
      throw new Error(startData?.error?.message || `Local image server error (${startRes.status})`);
    }
    const jobId = startData.job_id;
    if (!jobId) throw new Error('Server did not return an image job_id.');

    const maxWallDeadline = Date.now() + 900_000; // 15 min max for heavy cold loads + multi-ref diffusion
    let lastContactAt = Date.now();

    const notifyServerCancel = () => {
      fetch(`${root}/v1/images/jobs/${encodeURIComponent(jobId)}/cancel`, { method: 'POST' }).catch(() => {});
    };

    while (Date.now() < maxWallDeadline) {
      if (signal?.aborted) {
        notifyServerCancel();
        throw new Error('Cancelled');
      }
      await new Promise((r) => setTimeout(r, 900));
      if (signal?.aborted) {
        notifyServerCancel();
        throw new Error('Cancelled');
      }

      let jobRes: Response | null = null;
      const pollCtrl = new AbortController();
      const pollTimer = setTimeout(() => pollCtrl.abort(), 12_000);
      try {
        jobRes = await fetch(`${root}/v1/images/jobs/${encodeURIComponent(jobId)}`, {
          signal: pollCtrl.signal,
        });
      } catch {
        if (signal?.aborted) {
          notifyServerCancel();
          throw new Error('Cancelled');
        }
        if (Date.now() - lastContactAt > 180_000) {
          throw new Error('Lost connection to Local AI Hub during scene generation.');
        }
        continue;
      } finally {
        clearTimeout(pollTimer);
      }

      if (!jobRes || !jobRes.ok) {
        if (jobRes?.status === 404) {
          throw new Error('Image job was reset on server (server may have restarted).');
        }
        if (Date.now() - lastContactAt > 180_000) {
          throw new Error(`Local image server stopped responding (${jobRes?.status || 'network'}).`);
        }
        continue;
      }

      lastContactAt = Date.now();
      const job = await jobRes.json();
      onProgress?.({
        stage: job.stage || job.status,
        progress: job.progress,
        step: job.step,
        totalSteps: job.total_steps,
      });
      if (job.status === 'done' && (job.result?.image_base64 || job.result?.image_url)) {
        const rawUrl = String(job.result.image_url || '');
        const resolvedUrl = rawUrl.startsWith('/') ? `${root}${rawUrl}` : rawUrl;
        const skippedLoras = Array.isArray(job.result.skipped_loras) && job.result.skipped_loras.length > 0
          ? job.result.skipped_loras.map((s: any) => ({
              filename: String(s?.filename || ''),
              lora_arch: String(s?.lora_arch || ''),
              model_family: String(s?.model_family || ''),
            }))
          : undefined;
        return {
          imageData: job.result.image_base64 || resolvedUrl,
          seed: job.result.seed,
          width: job.result.width || width,
          height: job.result.height || height,
          modelUsed: String(job.result.model_used || 'local-sdcpp'),
          backendUsed: 'local',
          ...(skippedLoras ? { skippedLoras } : {}),
        };
      }
      if (job.status === 'error' || job.status === 'cancelled') {
        throw new Error(job.error || `Image generation ${job.status}`);
      }
    }
    notifyServerCancel();
    throw new Error('Local image generation exceeded maximum 15-minute limit.');
  }

  // Cloud Image API generation
  if (!activeApiKey || (!activeApiKey.key?.trim() && activeApiKey.provider !== 'custom')) {
    throw new Error('Cloud Scene Image generation requires an active API key in Settings.');
  }

  const model = modelOverride || settings?.sceneImageModel || (activeApiKey.provider === 'gemini' ? 'gemini-2.5-flash-image' : activeApiKey.provider === 'openai' ? 'gpt-image-1' : 'google/gemini-2.5-flash-image');
  onProgress?.({ stage: 'generating', progress: 25 });

  // 1. Direct Google Gemini API
  if (activeApiKey.provider === 'gemini') {
    const cleanModel = model.replace(/^google\//i, '');
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(cleanModel)}:generateContent?key=${encodeURIComponent(activeApiKey.key.trim())}`;
    const parts: any[] = [];
    for (const ref of references.slice(0, 4)) {
      const sp = splitDataUrl(ref);
      if (sp) parts.push({ inlineData: { mimeType: sp.mime, data: sp.b64 } });
    }
    if (initImage) {
      const sp = splitDataUrl(initImage);
      if (sp) parts.push({ inlineData: { mimeType: sp.mime, data: sp.b64 } });
    }
    parts.push({ text: prompt });

    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal,
      body: JSON.stringify({
        contents: [{ parts }],
        generationConfig: { responseModalities: ['TEXT', 'IMAGE'] },
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(data?.error?.message || `Gemini image error (${res.status})`);
    }
    const candParts = data?.candidates?.[0]?.content?.parts || [];
    const imgPart = candParts.find((p: any) => p.inlineData?.data);
    if (!imgPart) {
      throw new Error('Gemini did not return an image.');
    }
    const mime = imgPart.inlineData.mimeType || 'image/png';
    return {
      imageData: `data:${mime};base64,${imgPart.inlineData.data}`,
      width,
      height,
      modelUsed: cleanModel,
      backendUsed: 'cloud',
    };
  }

  // 2. OpenRouter (/api/v1/images + fallback to multimodal /chat/completions with modalities:["image","text"])
  if (activeApiKey.provider === 'openrouter') {
    const headers = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${activeApiKey.key.trim()}`,
      'HTTP-Referer': 'https://silklora.ai',
      'X-Title': 'SilkloraAI',
    };
    const allRefs = [...references.slice(0, 4), ...(initImage ? [initImage] : [])];
    const sizeStr = aspect === 'landscape' ? '4:3' : aspect === 'square' ? '1:1' : '3:4';

    // Try OpenRouter dedicated images endpoint first when model isn't strictly chat-modality
    try {
      const imgRes = await fetch('https://openrouter.ai/api/v1/images', {
        method: 'POST',
        headers,
        signal,
        body: JSON.stringify({
          model,
          prompt,
          ...(allRefs.length ? { input_references: allRefs } : {}),
          aspect_ratio: sizeStr,
          output_format: 'jpeg',
        }),
      });
      if (imgRes.ok) {
        const imgJson = await imgRes.json();
        const first = imgJson?.data?.[0];
        if (first?.b64_json) {
          return { imageData: `data:image/jpeg;base64,${first.b64_json}`, width, height, modelUsed: model, backendUsed: 'cloud' };
        }
        if (first?.url) {
          return { imageData: first.url, width, height, modelUsed: model, backendUsed: 'cloud' };
        }
      }
    } catch {
      // fall through to /chat/completions multimodal image call
    }

    const content: any[] = [{ type: 'text', text: prompt }];
    for (const ref of allRefs) {
      content.push({ type: 'image_url', image_url: { url: ref } });
    }
    const chatRes = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers,
      signal,
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content }],
        modalities: ['image', 'text'],
      }),
    });
    const chatData = await chatRes.json().catch(() => ({}));
    if (!chatRes.ok) {
      throw new Error(chatData?.error?.message || `OpenRouter image error (${chatRes.status})`);
    }
    const msg = chatData?.choices?.[0]?.message;
    const imgOut = msg?.images?.[0]?.image_url?.url || msg?.images?.[0]?.url;
    if (imgOut) {
      return { imageData: imgOut, width, height, modelUsed: model, backendUsed: 'cloud' };
    }
    throw new Error('OpenRouter response did not include a generated image.');
  }

  // 3. OpenAI / Custom OpenAI-compatible `/images/generations`
  const baseUrl = getProviderBaseUrl(activeApiKey);
  const size = aspect === 'landscape' ? '1536x1024' : aspect === 'square' ? '1024x1024' : '1024x1536';
  const oaiRes = await fetch(`${baseUrl}/images/generations`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(activeApiKey.key?.trim() ? { Authorization: `Bearer ${activeApiKey.key.trim()}` } : {}),
    },
    signal,
    body: JSON.stringify({
      model,
      prompt,
      size,
      response_format: 'b64_json',
    }),
  });
  const oaiJson = await oaiRes.json().catch(() => ({}));
  if (!oaiRes.ok) {
    throw new Error(oaiJson?.error?.message || `Image API error (${oaiRes.status})`);
  }
  const entry = oaiJson?.data?.[0];
  const imgUrl = entry?.b64_json ? `data:image/png;base64,${entry.b64_json}` : entry?.url;
  if (!imgUrl) throw new Error('Image endpoint returned empty result.');
  return { imageData: imgUrl, width, height, modelUsed: model, backendUsed: 'cloud' };
}
