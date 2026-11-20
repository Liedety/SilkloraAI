import type { AiBackend, AiComponent, ApiKeyConfig, AppSettings } from '../../types';

export const INFER_EMOTION_FROM_TEXT = false;

export const AI_COMPONENTS: AiComponent[] = [
  'chat',
  'ghostwriter',
  'memory',
  'summary',
  'sceneAnalysis',
  'sceneImage',
  'characterGen',
  'groupGen',
  'vision',
];


export function normalizeLocalServerUrl(rawUrl: string): string {
  let url = (rawUrl || '').trim();
  if (!url) return 'http://192.168.1.55:8080/v1';

  if (!/^https?:\/\//i.test(url)) {
    url = `http://${url}`;
  }

  url = url.replace(/\/+$/, '');

  if (!/\/v1$/i.test(url)) {
    url = `${url}/v1`;
  }

  return url;
}

export async function pingLocalServer(rawUrl: string): Promise<{
  ok: boolean;
  pingMs: number;
  activeModel?: string;
  error?: string;
}> {
  const normalized = normalizeLocalServerUrl(rawUrl);
  const start = performance.now();
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 6000);

  try {
    const modelsUrl = `${normalized}/models`;
    const res = await fetch(modelsUrl, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    });

    clearTimeout(timeoutId);
    const pingMs = Math.max(1, Math.round(performance.now() - start));

    if (res.ok) {
      let activeModel: string | undefined;
      try {
        const data = await res.json();
        if (data.data && Array.isArray(data.data) && data.data.length > 0) {
          activeModel = data.data[0].id || data.data[0].name;
        } else if (data.models && Array.isArray(data.models) && data.models.length > 0) {
          activeModel = data.models[0].id || data.models[0].name;
        }
      } catch {
        // ignore json parse error
      }

      return {
        ok: true,
        pingMs,
        activeModel: activeModel || 'GGUF Local Model',
      };
    }

    const rootUrl = normalized.replace(/\/v1\/?$/, '');
    const healthRes = await fetch(`${rootUrl}/health`, {
      method: 'GET',
      signal: controller.signal,
    }).catch(() => null);

    if (healthRes && healthRes.ok) {
      const data = await healthRes.json().catch(() => ({}));
      return {
        ok: true,
        pingMs,
        activeModel: data.active_model || 'GGUF Local Model',
      };
    }

    throw new Error(`HTTP ${res.status}: ${res.statusText}`);
  } catch (err: any) {
    clearTimeout(timeoutId);
    const isAbort = err.name === 'AbortError' || controller.signal.aborted;
    const msg = isAbort
      ? 'Таймаут подключения (сервер не ответил за 6 сек)'
      : (err.message || 'Ошибка подключения');
    return {
      ok: false,
      pingMs: 0,
      error: msg,
    };
  }
}

export interface LocalContextInfo {
  nCtx: number;
  recommendedPromptTokens: number;
  modelLoaded: boolean;
}

const localContextCache: { url: string; at: number; info: LocalContextInfo | null } = { url: '', at: 0, info: null };

/** Reads the loaded context size from the local hub so the chat can budget its prompt. */
export async function fetchLocalContextInfo(baseUrl: string, maxAgeMs = 15000): Promise<LocalContextInfo | null> {
  const url = normalizeLocalServerUrl(baseUrl);
  if (localContextCache.url === url && Date.now() - localContextCache.at < maxAgeMs) {
    return localContextCache.info;
  }
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 3000);
  let info: LocalContextInfo | null = null;
  try {
    const res = await fetch(`${url}/models`, { headers: { Accept: 'application/json' }, signal: controller.signal });
    if (res.ok) {
      const data = await res.json();
      const entry = Array.isArray(data?.data) ? data.data[0] : null;
      if (entry && Number(entry.context_length) > 0) {
        info = {
          nCtx: Number(entry.context_length),
          recommendedPromptTokens: Number(entry.recommended_prompt_tokens) || 0,
          modelLoaded: entry.loaded !== false,
        };
      }
    }
  } catch {
    info = null;
  } finally {
    clearTimeout(timeoutId);
  }
  localContextCache.url = url;
  localContextCache.at = Date.now();
  localContextCache.info = info;
  return info;
}

export function getEffectiveAiConfig(
  settings?: AppSettings,
  activeApiKey?: ApiKeyConfig
): {
  apiKeyConfig?: ApiKeyConfig;
  textModel: string;
  isLocal: boolean;
} {
  const { apiKeyConfig, textModel, isLocal } = getComponentAiConfig(settings, activeApiKey, 'chat');
  return { apiKeyConfig, textModel, isLocal };
}

/** Backend for one component: its own routing choice, otherwise the global engine mode. */
export function getComponentBackend(settings: AppSettings | undefined, component: AiComponent): AiBackend {
  const explicit = settings?.aiRouting?.[component];
  if (explicit) return explicit;
  return settings?.aiEngineMode === 'local' ? 'local' : 'cloud';
}

export function getComponentAiConfig(
  settings: AppSettings | undefined,
  activeApiKey: ApiKeyConfig | undefined,
  component: AiComponent
): {
  apiKeyConfig?: ApiKeyConfig;
  textModel: string;
  isLocal: boolean;
  backend: AiBackend;
} {
  const backend = getComponentBackend(settings, component);
  if (backend === 'local') {
    const baseUrl = normalizeLocalServerUrl(settings?.localHubUrl || 'http://192.168.1.55:8080/v1');
    return {
      apiKeyConfig: {
        id: 'local-hub',
        provider: 'custom',
        name: 'Local AI Hub (PC)',
        baseUrl,
        key: 'local-key',
        isActive: true,
      },
      textModel: 'local-model',
      isLocal: true,
      backend,
    };
  }
  const cloudModel =
    component === 'vision'
      ? settings?.visionModel || settings?.textModel || 'google/gemini-flash-1.5'
      : component === 'sceneImage'
        ? settings?.sceneImageModel || 'google/gemini-2.5-flash-image'
        : settings?.textModel || 'deepseek/deepseek-chat';
  return {
    apiKeyConfig: activeApiKey,
    textModel: cloudModel,
    isLocal: false,
    backend,
  };
}

export type RpSamplerPreset = 'roleplay' | 'balanced' | 'creative' | 'precise';

export interface SamplerConfig {
  temperature: number;
  topP: number;
  minP: number;
  topK: number;
  repeatPenalty: number;
  repeatLastN: number;
  frequencyPenalty: number;
  presencePenalty: number;
  maxTokens: number;
}

export const RP_SAMPLER_PRESETS: Record<RpSamplerPreset, SamplerConfig> = {
  roleplay: {
    temperature: 0.78,
    topP: 0.92,
    minP: 0.06,
    topK: 50,
    repeatPenalty: 1.12,
    repeatLastN: 512,
    frequencyPenalty: 0.25,
    presencePenalty: 0.22,
    maxTokens: 480,
  },
  balanced: {
    temperature: 0.72,
    topP: 0.90,
    minP: 0.06,
    topK: 45,
    repeatPenalty: 1.10,
    repeatLastN: 512,
    frequencyPenalty: 0.20,
    presencePenalty: 0.18,
    maxTokens: 480,
  },
  creative: {
    temperature: 0.90,
    topP: 0.95,
    minP: 0.05,
    topK: 64,
    repeatPenalty: 1.10,
    repeatLastN: 512,
    frequencyPenalty: 0.28,
    presencePenalty: 0.25,
    maxTokens: 680,
  },
  precise: {
    temperature: 0.58,
    topP: 0.88,
    minP: 0.08,
    topK: 40,
    repeatPenalty: 1.14,
    repeatLastN: 512,
    frequencyPenalty: 0.26,
    presencePenalty: 0.16,
    maxTokens: 400,
  },
};

export function resolveSamplerConfig(settings?: AppSettings, isLocal?: boolean): SamplerConfig {
  const presetKey = settings?.generationPreset;
  const baseKey: RpSamplerPreset =
    presetKey && presetKey !== 'custom' && presetKey in RP_SAMPLER_PRESETS
      ? presetKey
      : 'roleplay';
  const base = RP_SAMPLER_PRESETS[baseKey];
  const isCustom = presetKey === 'custom';
  return {
    temperature: isCustom
      ? (settings?.temperature ?? base.temperature)
      : presetKey
        ? base.temperature
        : isLocal
          ? base.temperature
          : 0.82,
    topP: isCustom ? (settings?.topP ?? base.topP) : base.topP,
    minP: isCustom ? (settings?.minP ?? base.minP) : base.minP,
    topK: base.topK,
    repeatPenalty: isCustom ? (settings?.repeatPenalty ?? base.repeatPenalty) : base.repeatPenalty,
    repeatLastN: base.repeatLastN,
    frequencyPenalty: isCustom ? (settings?.frequencyPenalty ?? base.frequencyPenalty) : base.frequencyPenalty,
    presencePenalty: isCustom ? (settings?.presencePenalty ?? base.presencePenalty) : base.presencePenalty,
    maxTokens: settings?.maxResponseTokens ?? base.maxTokens,
  };
}

export function getProviderBaseUrl(config: ApiKeyConfig): string {
  if (config.baseUrl && config.baseUrl.trim()) {
    return config.baseUrl.trim().replace(/\/+$/, '');
  }
  switch (config.provider) {
    case 'openrouter':
      return 'https://openrouter.ai/api/v1';
    case 'openai':
      return 'https://api.openai.com/v1';
    case 'groq':
      return 'https://api.groq.com/openai/v1';
    case 'deepseek':
      return 'https://api.deepseek.com/v1';
    default:
      return 'https://openrouter.ai/api/v1';
  }
}

export function localHubRootUrl(rawUrl?: string): string {
  return normalizeLocalServerUrl(rawUrl || 'http://192.168.1.55:8080/v1').replace(/\/v1\/?$/, '');
}
