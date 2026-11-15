import type { AiBackend, AiComponent, ApiKeyConfig, AppSettings, Character, CharacterEmotion, Group, Language } from '../types';
import { findRepetitionBoundary, findForeignActorBoundary, findMetaLeakBoundary } from './replyGuard.ts';

export const INFER_EMOTION_FROM_TEXT = false;

export const AI_COMPONENTS: AiComponent[] = ['chat', 'ghostwriter', 'memory', 'summary', 'characterGen', 'groupGen', 'vision'];

export interface ChatCompletionMessage {
  role: 'system' | 'user' | 'assistant';
  content: string | Array<{ type: 'text' | 'image_url'; text?: string; image_url?: { url: string } }>;
}

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
  const cloudModel = component === 'vision'
    ? (settings?.visionModel || settings?.textModel || 'google/gemini-flash-1.5')
    : (settings?.textModel || 'deepseek/deepseek-chat');
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

export interface StreamOptions {
  apiKeyConfig: ApiKeyConfig;
  model: string;
  messages: ChatCompletionMessage[];
  temperature?: number;
  topP?: number;
  minP?: number;
  topK?: number;
  repeatPenalty?: number;
  repeatLastN?: number;
  frequencyPenalty?: number;
  presencePenalty?: number;
  maxTokens?: number;
  /** When true, forward reasoning_content deltas wrapped in <thought>...</thought>; otherwise drop them. */
  includeReasoning?: boolean;
  signal?: AbortSignal;
  /** Extra stop strings, e.g. "\nPersonaName:" so the model cannot start writing for the user. */
  extraStops?: string[];
  /** Names of the user and other characters: the stream is cut when the reply starts writing for them. */
  foreignNames?: string[];
  onToken: (token: string) => void;
  onComplete?: (fullText: string) => void;
  onError: (err: Error) => void;
}

function getProviderBaseUrl(config: ApiKeyConfig): string {
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
    case 'demonroute':
      return 'https://api.demonroute.com/v1';
    default:
      return 'https://openrouter.ai/api/v1';
  }
}

/**
 * Detects when a local model forgets its EOS token and starts simulating a follow-up turn
 * (>user, >fuser, >assistant, [Собеседник: ...], echoed context dividers, or repeated emotion loops).
 */
export function findSimulatedTurnBoundary(text: string, opts: { foreignNames?: string[] } = {}): number {
  if (!text) return -1;
  const thoughtStrip = text.replace(/<thought>[\s\S]*?<\/thought>/gi, '');
  if (thoughtStrip.trim().length < 45) return -1;

  const patterns = [
    /(?:^|\s)>+\s*(?:f?user|assistant|model|human|bot)\b/i,
    /\n\s*(?:f?user|assistant)\s*(?=\r?\n)/i,
    /\n\s*---\s*\n\s*(?:f?user|assistant|user|model|\*\*)/i,
    /\n\s*\[\s*(?:Собеседник|Реплика\s+собеседника|Пользователь|User|Assistant)\s*[:\]]/i,
    /\n\s*---\s*\n\s*(?:Контекст\s+сцены|Текущий\s+контекст|Контекст\s+текущей\s+сцены|Scene\s+context|Current\s+scene|УКАЗАНИЕ\s+ПОЛЬЗОВАТЕЛЯ|USER\s+TURN\s+DIRECTIVE)/i,
    /\n\s*>+\s*\*\*(?:Имя|Пол|Год рождения|Возраст|Класс|Характеристики|Умения|Способности|Аппаратура|Name|Gender|Age|Class)\s*[:*]/i,
    /\n\s*(?:Пользователь|Игрок|Вы|User|Assistant|Player|You)\s*:\s*\S/,
    /(?:^|\s)>+\s*[\p{Lu}][\p{Ll}\p{L}-]{1,24}(?:\s*\([^)]+\))?\s*:/u,
  ];

  let earliest = -1;
  for (const re of patterns) {
    const m = text.match(re);
    if (m && m.index !== undefined && m.index >= 40) {
      if (earliest === -1 || m.index < earliest) {
        earliest = m.index;
      }
    }
  }

  // Also abort multi-turn loops that emit 3+ separate <emotion> tags across paragraphs
  const emoMatches = Array.from(text.matchAll(/\n\s*<\s*(?:emotion|эмоция)\b/gi));
  if (emoMatches.length >= 2 && emoMatches[1].index !== undefined && emoMatches[1].index >= 80) {
    if (earliest === -1 || emoMatches[1].index < earliest) {
      earliest = emoMatches[1].index;
    }
  }

  const extra = [
    findRepetitionBoundary(text),
    findForeignActorBoundary(text, opts.foreignNames || [], 40),
    findMetaLeakBoundary(text, 40),
  ];
  for (const idx of extra) {
    if (idx >= 40 && (earliest === -1 || idx < earliest)) earliest = idx;
  }

  return earliest;
}

export async function streamChatCompletion(options: StreamOptions): Promise<void> {
  const { apiKeyConfig, model, messages, temperature = 0.85, maxTokens = 2048, signal, onToken, onComplete, onError } = options;

  const internalController = new AbortController();
  let stoppedForRunaway = false;
  let fullText = '';
  const forwardAbort = () => internalController.abort();
  signal?.addEventListener('abort', forwardAbort);

  try {
    if (apiKeyConfig.provider === 'gemini') {
      await streamGemini(options);
      return;
    }
    if (apiKeyConfig.provider === 'anthropic') {
      await streamAnthropic(options);
      return;
    }

    // Standard OpenAI-compatible format (OpenRouter, OpenAI, Groq, DeepSeek, Demon Route, Custom)
    const baseUrl = getProviderBaseUrl(apiKeyConfig);
    const url = `${baseUrl}/chat/completions`;

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    if (apiKeyConfig.key && apiKeyConfig.key.trim()) {
      headers['Authorization'] = `Bearer ${apiKeyConfig.key.trim()}`;
    }

    if (apiKeyConfig.provider === 'openrouter') {
      headers['HTTP-Referer'] = 'https://silklora.ai';
      headers['X-Title'] = 'SilkloraAI';
    }

    const res = await fetch(url, {
      method: 'POST',
      headers,
      signal: internalController.signal,
      body: JSON.stringify((() => {
        const allStops = [
          ...(options.extraStops || []),
          'USER:',
          'User:',
          '\nUSER:',
          '\nUser:',
          '\n>user',
          '\n>fuser',
          '\n>assistant',
          '\n>model',
          '\nuser\n',
          '\nfuser\n',
          '\nassistant\n',
          'ASSISTANT:',
          'Assistant:',
          '\nASSISTANT:',
          '\nAssistant:',
          '\n<user>',
          '\n<human>',
          '\n[Собеседник:',
          '\n[Реплика',
          '\n[Пользователь:',
          '\nПользователь:',
          '\nВы:',
          '\nИгрок:',
          '\nYou:',
          '\nPlayer:',
          '<|turn>user',
          '<|turn>system',
          '<turn|>',
          '<start_of_turn>',
          '<end_of_turn>',
          '<|im_end|>',
          '<|im_start|>',
          '<|eot_id|>',
        ];
        const normalizedUrl = (apiKeyConfig.baseUrl || '').toLowerCase();
        const isOfficialOpenAI =
          apiKeyConfig.provider === 'openai' && (!normalizedUrl || normalizedUrl.includes('api.openai.com'));
        const isCustomOrLocal =
          apiKeyConfig.provider === 'custom' ||
          apiKeyConfig.provider === 'openrouter' ||
          normalizedUrl.includes('localhost') ||
          normalizedUrl.includes('127.0.0.1') ||
          normalizedUrl.includes('192.168.') ||
          normalizedUrl.includes('10.') ||
          normalizedUrl.includes('openrouter.ai');

        const payload: Record<string, unknown> = {
          model: model || 'deepseek/deepseek-chat',
          messages,
          temperature,
          max_tokens: maxTokens,
          stream: true,
          stop: isOfficialOpenAI ? allStops.slice(0, 4) : allStops,
        };
        if (options.topP !== undefined) payload.top_p = options.topP;
        if (options.frequencyPenalty !== undefined) payload.frequency_penalty = options.frequencyPenalty;
        if (options.presencePenalty !== undefined) payload.presence_penalty = options.presencePenalty;
        if (isCustomOrLocal) {
          if (options.minP !== undefined) payload.min_p = options.minP;
          if (options.topK !== undefined) payload.top_k = options.topK;
          if (options.repeatPenalty !== undefined) payload.repeat_penalty = options.repeatPenalty;
          if (options.repeatLastN !== undefined) payload.repeat_last_n = options.repeatLastN;
        }
        return payload;
      })()),
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`API Error (${res.status}): ${errText}`);
    }

    if (!res.body) {
      throw new Error('ReadableStream not supported by the network response.');
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buffer = '';
    let reasoningOpen = false;
    const includeReasoning = Boolean(options.includeReasoning);

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith(':')) continue;
        if (trimmed === 'data: [DONE]') {
          continue;
        }
        if (trimmed.startsWith('data: ')) {
          try {
            const data = JSON.parse(trimmed.slice(6));
            const choiceDelta = data.choices?.[0]?.delta;
            const reasoningChunk = choiceDelta?.reasoning_content ?? choiceDelta?.reasoning;
            if (typeof reasoningChunk === 'string' && reasoningChunk && includeReasoning) {
              const out = reasoningOpen ? reasoningChunk : `<thought>${reasoningChunk}`;
              reasoningOpen = true;
              fullText += out;
              onToken(out);
            }
            const delta = choiceDelta?.content;
            if (delta) {
              const out = reasoningOpen ? `</thought>\n${delta}` : delta;
              reasoningOpen = false;
              fullText += out;
              const boundary = findSimulatedTurnBoundary(fullText, { foreignNames: options.foreignNames });
              if (boundary !== -1) {
                fullText = fullText.slice(0, boundary).trimEnd();
                stoppedForRunaway = true;
                internalController.abort();
                break;
              }
              onToken(out);
            }
          } catch {
            // ignore partial JSON parse error
          }
        }
      }
      if (stoppedForRunaway) break;
    }

    if (reasoningOpen) {
      const closeTag = '</thought>';
      fullText += closeTag;
      onToken(closeTag);
    }

    onComplete?.(fullText);
  } catch (err: unknown) {
    if (signal?.aborted) return;
    if (stoppedForRunaway) {
      onComplete?.(fullText);
      return;
    }
    onError(err instanceof Error ? err : new Error(String(err)));
  } finally {
    signal?.removeEventListener('abort', forwardAbort);
  }
}

async function streamGemini(options: StreamOptions): Promise<void> {
  const { apiKeyConfig, model, messages, onToken, onComplete, onError, signal } = options;
  try {
    const modelName = model || 'gemini-1.5-flash';
    const cleanModel = modelName.startsWith('google/') ? modelName.replace('google/', '') : modelName;
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${cleanModel}:streamGenerateContent?alt=sse&key=${apiKeyConfig.key.trim()}`;

    // Convert OpenAI messages to Gemini contents
    let systemInstruction = '';
    const contents: Array<{ role: string; parts: Array<{ text?: string; inline_data?: { mime_type: string; data: string } }> }> = [];

    for (const msg of messages) {
      if (msg.role === 'system') {
        systemInstruction += (typeof msg.content === 'string' ? msg.content : '') + '\n';
      } else {
        const geminiRole = msg.role === 'assistant' ? 'model' : 'user';
        if (typeof msg.content === 'string') {
          contents.push({ role: geminiRole, parts: [{ text: msg.content }] });
        } else if (Array.isArray(msg.content)) {
          const parts: any[] = [];
          for (const p of msg.content) {
            if (p.type === 'text' && p.text) {
              parts.push({ text: p.text });
            } else if (p.type === 'image_url' && p.image_url?.url) {
              const base64Match = p.image_url.url.match(/^data:([^;]+);base64,(.+)$/);
              if (base64Match) {
                parts.push({
                  inline_data: {
                    mime_type: base64Match[1],
                    data: base64Match[2],
                  },
                });
              }
            }
          }
          contents.push({ role: geminiRole, parts });
        }
      }
    }

    const payload: any = { contents };
    if (systemInstruction.trim()) {
      payload.systemInstruction = { parts: [{ text: systemInstruction.trim() }] };
    }

    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal,
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Gemini Error (${res.status}): ${errText}`);
    }

    if (!res.body) {
      throw new Error('ReadableStream not supported by Gemini network response.');
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let fullText = '';
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.startsWith('data: ')) {
          try {
            const data = JSON.parse(trimmed.slice(6));
            const textChunk = data.candidates?.[0]?.content?.parts?.[0]?.text;
            if (textChunk) {
              fullText += textChunk;
              onToken(textChunk);
            }
          } catch {}
        }
      }
    }
    onComplete?.(fullText);
  } catch (err: unknown) {
    if (signal?.aborted) return;
    onError(err instanceof Error ? err : new Error(String(err)));
  }
}

async function streamAnthropic(options: StreamOptions): Promise<void> {
  const { apiKeyConfig, model, messages, onToken, onComplete, onError, signal } = options;
  try {
    const url = 'https://api.anthropic.com/v1/messages';
    let systemPrompt = '';
    const anthropicMessages: Array<{ role: 'user' | 'assistant'; content: any }> = [];

    for (const msg of messages) {
      if (msg.role === 'system') {
        systemPrompt += (typeof msg.content === 'string' ? msg.content : '') + '\n';
      } else {
        anthropicMessages.push({
          role: msg.role === 'assistant' ? 'assistant' : 'user',
          content: msg.content,
        });
      }
    }

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKeyConfig.key.trim(),
        'anthropic-version': '2023-06-01',
      },
      signal,
      body: JSON.stringify({
        model: model || 'claude-3-5-sonnet-20241022',
        system: systemPrompt,
        messages: anthropicMessages,
        max_tokens: 2048,
        stream: true,
      }),
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Anthropic Error (${res.status}): ${errText}`);
    }

    if (!res.body) {
      throw new Error('ReadableStream not supported by Anthropic network response.');
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let fullText = '';
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.startsWith('data: ')) {
          try {
            const data = JSON.parse(trimmed.slice(6));
            if (data.type === 'content_block_delta' && data.delta?.text) {
              fullText += data.delta.text;
              onToken(data.delta.text);
            }
          } catch {}
        }
      }
    }
    onComplete?.(fullText);
  } catch (err: unknown) {
    if (signal?.aborted) return;
    onError(err instanceof Error ? err : new Error(String(err)));
  }
}

export async function fetchAvailableModels(apiKeyConfig: ApiKeyConfig): Promise<Array<{ id: string; name: string; pricing?: { prompt: number } }>> {
  if (apiKeyConfig.provider === 'openrouter') {
    try {
      const res = await fetch('https://openrouter.ai/api/v1/models');
      if (res.ok) {
        const data = await res.json();
        return (data.data || []).map((m: any) => ({
          id: m.id,
          name: m.name || m.id,
          pricing: {
            prompt: parseFloat(m.pricing?.prompt || '0'),
          },
        }));
      }
    } catch {
      // fallback
    }
  }

  if (apiKeyConfig.provider === 'demonroute' && apiKeyConfig.key.trim()) {
    try {
      const res = await fetch(`${getProviderBaseUrl(apiKeyConfig)}/models`, {
        headers: {
          Authorization: `Bearer ${apiKeyConfig.key.trim()}`,
        },
      });
      if (res.ok) {
        const data = await res.json();
        return (data.data || []).map((m: any) => ({
          id: m.id,
          name: m.name || m.id,
        }));
      }
    } catch {
      // fallback
    }
  }

  // Fallback defaults for popular providers
  return [
    { id: 'deepseek/deepseek-chat', name: 'DeepSeek V3 (Fast & Uncensored RP)', pricing: { prompt: 0.0001 } },
    { id: 'deepseek/deepseek-r1', name: 'DeepSeek R1 (Deep Reasoning)', pricing: { prompt: 0.0005 } },
    { id: 'anthropic/claude-3.5-sonnet', name: 'Claude 3.5 Sonnet (Elite Quality)', pricing: { prompt: 0.003 } },
    { id: 'openai/gpt-4o', name: 'GPT-4o (Multimodal & Fast)', pricing: { prompt: 0.0025 } },
    { id: 'openai/gpt-4o-mini', name: 'GPT-4o Mini (Free/Cheap)', pricing: { prompt: 0 } },
    { id: 'google/gemini-2.0-flash-exp:free', name: 'Gemini 2.0 Flash (Free)', pricing: { prompt: 0 } },
    { id: 'meta-llama/llama-3.3-70b-instruct', name: 'Llama 3.3 70B Instruct', pricing: { prompt: 0.0002 } },
    { id: 'nousresearch/hermes-3-llama-3.1-405b', name: 'Hermes 3 405B (Uncensored)', pricing: { prompt: 0.001 } },
  ];
}

export async function fetchVisionModels(
  apiKeyConfig?: ApiKeyConfig
): Promise<Array<{ id: string; name: string; pricing?: { prompt: number } }>> {
  if (apiKeyConfig && apiKeyConfig.provider === 'openrouter' && apiKeyConfig.key.trim()) {
    try {
      const res = await fetch('https://openrouter.ai/api/v1/models', {
        headers: {
          Authorization: `Bearer ${apiKeyConfig.key.trim()}`,
        },
      });
      if (res.ok) {
        const data = await res.json();
        const list = (data.data || []).filter((m: any) => {
          const id = (m.id || '').toLowerCase();
          const desc = (m.description || '').toLowerCase();
          const modalities = m.architecture?.modality || '';
          return (
            modalities.includes('image') ||
            id.includes('vision') ||
            id.includes('vl') ||
            id.includes('gemini') ||
            id.includes('gpt-4o') ||
            id.includes('claude-3') ||
            desc.includes('multimodal') ||
            desc.includes('vision')
          );
        });

        if (list.length > 0) {
          return list.map((m: any) => ({
            id: m.id,
            name: m.name || m.id,
            pricing: {
              prompt: parseFloat(m.pricing?.prompt || '0'),
            },
          }));
        }
      }
    } catch {
      // fallback
    }
  }

  return [
    { id: 'google/gemini-2.0-flash-exp:free', name: 'Gemini 2.0 Flash Vision (Free)', pricing: { prompt: 0 } },
    { id: 'google/gemini-flash-1.5', name: 'Gemini 1.5 Flash (Fast Multimodal)', pricing: { prompt: 0.0001 } },
    { id: 'google/gemini-pro-1.5', name: 'Gemini 1.5 Pro (Deep Multimodal)', pricing: { prompt: 0.00125 } },
    { id: 'openai/gpt-4o-mini', name: 'GPT-4o Mini Vision (Budget Fast)', pricing: { prompt: 0.00015 } },
    { id: 'openai/gpt-4o', name: 'GPT-4o (High Detail Vision)', pricing: { prompt: 0.0025 } },
    { id: 'anthropic/claude-3.5-sonnet', name: 'Claude 3.5 Sonnet (Vision Elite)', pricing: { prompt: 0.003 } },
    { id: 'qwen/qwen-2-vl-72b-instruct', name: 'Qwen 2 VL 72B (Open Weights)', pricing: { prompt: 0.0004 } },
    { id: 'meta-llama/llama-3.2-11b-vision-instruct', name: 'Llama 3.2 11B Vision (Free/Cheap)', pricing: { prompt: 0 } },
  ];
}

/** Convert Gemma 4 / Qwen 3 / DeepSeek native reasoning markers into uniform <thought> blocks. */
export function normalizeNativeThoughtTags(str: string): string {
  if (!str) return '';
  return str
    // Strip leading turn tags so <emotion> or <thought> sits cleanly at start.
    .replace(/^\s*(?:<\|\s*turn\s*>(?:model|assistant|user|system)?|<\s*start_of_turn\s*>(?:model|assistant|user|system)?|<\|\s*im_start\s*\|>(?:model|assistant|user|system)?)\s*/gi, '')
    // Complete Gemma 4 channel thought: <|channel>thought ... <channel|>
    .replace(/<\|\s*channel\s*>\s*thought\b\s*([\s\S]*?)<\s*channel\s*\|>/gi, '<thought>$1</thought>\n')
    // Unclosed Gemma 4 channel thought (streaming or truncated)
    .replace(/<\|\s*channel\s*>\s*thought\b\s*([\s\S]*)$/gi, '<thought>$1')
    // <|thought> ... <thought|> and [|thought|] ... [/|thought|]
    .replace(/<\|\s*thought\s*>\s*([\s\S]*?)<\s*thought\s*\|>/gi, '<thought>$1</thought>\n')
    .replace(/<\|\s*thought\s*>\s*([\s\S]*)$/gi, '<thought>$1')
    .replace(/\[\|\s*thought\s*\|\]\s*([\s\S]*?)\[\/\|\s*thought\s*\|\]/gi, '<thought>$1</thought>\n')
    // DeepSeek / Qwen <think> ... </think>
    .replace(/<think>([\s\S]*?)<\/think>/gi, '<thought>$1</thought>\n')
    .replace(/<think>([\s\S]*)$/gi, '<thought>$1');
}

export function cleanArtifacts(str: string, characterEmotions?: CharacterEmotion[]): string {
  if (!str) return '';
  let out = str
    // Strip tokenizer tokens like <|begin_of_sentence|>, < | begin__of__sentence | >, <|im_end|>, etc.
    .replace(/<\s*\|\s*[^>]+\s*\|\s*>/gi, '')
    // Strip Gemma 4, ChatML, Llama 3, and Mistral half-piped or named turn/control markers.
    .replace(/<\|\s*(?:turn|channel|thought|im_start|im_end|eot_id|endoftext|start_header_id|end_header_id|bos|eos)\s*>?(?:model|assistant|user|system|thought)?/gi, '')
    .replace(/<\s*(?:turn|channel|thought|im_end|eot_id|endoftext)\s*\|>/gi, '')
    .replace(/\[\|\s*thought\s*\|\]|\[\s*\/\|\s*thought\s*\|\]/gi, '')
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/<\/?think>/gi, '')
    .replace(/<\s*(?:start_of_turn|end_of_turn)\s*>(?:user|model|system)?/gi, '')
    .replace(/<\/?s>/gi, '')
    .replace(/\uFFFD|[\u200B-\u200D\uFEFF]/g, '')
    // Strip echoed internal scene notes, prompt headers, or simulated follow-up turns
    .replace(/\n*\[\s*(?:Заметка сцены|Scene note|Контекст хода|Контекст сцены|Указание к ответу|УКАЗАНИЕ ПОЛЬЗОВАТЕЛЯ|USER TURN DIRECTIVE)[\s\S]*$/gi, '')
    .replace(/\n*---\s*\n\s*(?:Контекст сцены|Текущий контекст сцены|Scene context|Current scene context|УКАЗАНИЕ ПОЛЬЗОВАТЕЛЯ|USER TURN DIRECTIVE)[\s\S]*$/gi, '')
    .replace(/\n*###\s*(?:ТВОЯ РОЛЬ|ФУНДАМЕНТАЛЬНЫЕ|СТИЛЬ|КОНТРОЛЬ|ОБЯЗАТЕЛЬНЫЙ|CRITICAL|YOUR CURRENT ROLE|CORE PRINCIPLES)[\s\S]*$/gi, '')
    // Strip simulated turns starting with >user, >fuser, >assistant, bare user/assistant line, [Собеседник:], or dumped character sheets
    .replace(/(?:\n|(?<=\S)\s+)>+\s*(?:f?user|assistant|model|human|bot)\b[\s\S]*$/gi, '')
    .replace(/\n\s*>+\s*\*\*(?:Имя|Пол|Год рождения|Возраст|Класс|Характеристики|Умения|Способности|Аппаратура|Name|Gender|Age|Class)\s*[:*][\s\S]*$/gi, '')
    .replace(/\n\s*(?:f?user|assistant)\s*(?:\r?\n|$)[\s\S]*$/gi, '')
    .replace(/\n\s*\[\s*(?:Собеседник|Реплика\s+собеседника|Пользователь|User|Assistant)\s*[:\]][\s\S]*$/gi, '')
    .replace(/\n\s*<user>[\s\S]*$/gi, '')
    .replace(/\n\s*User:[\s\S]*$/gi, '')
    .replace(/\n\s*(?:Пользователь|Вы|Игрок):[\s\S]*$/g, '')
    .replace(/(?:\n|(?<=\S)\s+)>+\s*[\p{Lu}][\p{Ll}\p{L}-]{1,24}(?:\s*\([^)]+\))?\s*:[\s\S]*$/u, '')
    // Strip leading turn/technical bracket prefixes like >**Name:**, >user, <user>, [Ответ], []
    .replace(/^\s*(?:>+\s*)?(?:\*\*)?\[\s*(?:Собеседник|Реплика|Ответ|Сцена|Диалог|Action|Dialogue|OOC|System|Assistant|User|Bot)\s*(?::[^\]]*)?\]\s*(?:\*\*)?\s*/gi, '')
    .replace(/^\s*<user>[:\s]*/i, '')
    .replace(/^\s*<bot>[:\s]*/i, '')
    .replace(/^\s*<assistant>[:\s]*/i, '')
    .replace(/^\s*>+\s*(?:f?user|assistant|model|bot)[:\s]*/i, '')
    .replace(/^\s*User:[:\s]*/i, '')
    .replace(/^\s*Bot:[:\s]*/i, '')
    .replace(/^\s*Assistant:[:\s]*/i, '')
    .replace(/^\s*(?:>+\s*)?(?:\*\*)?(?:Пользователь|Вы|Игрок|You|Player)(?:\*\*)?\s*:\s*/i, '');

  out = stripEmotionTags(out, characterEmotions, { stripLeadingUnknownAngleTag: true });

  return out
    // Strip empty/malformed brackets, decorative markdown rules, stray invented XML tags (<joke>, </joke>), and leading '>' quotes
    .replace(/\[\s*\]/g, '')
    .replace(/<\s*\/?\s*>/g, '')
    .replace(/(?:^|\n)\s*---+\s*(?:\n|$)/g, '\n')
    .replace(/<\/?([a-zA-Z][a-zA-Z0-9_-]{1,24})\s*>/g, (full, tag) =>
      HTML_OR_SYSTEM_TAGS.has(tag.toLowerCase()) || HTML_OR_SYSTEM_TAGS.has('/' + tag.toLowerCase()) ? full : ''
    )
    .replace(/^\s*>+\s*/g, '')
    .replace(/[ \t]{2,}/g, ' ')
    // Clean accidental bilingual translation parentheticals (e.g. "слово (word)")
    .replace(/([а-яА-ЯёЁ]{2,30})\s*\([a-zA-Z\s]{2,30}\)/g, '$1')
    .replace(/([a-zA-Z]{2,30})\s*\(([а-яА-ЯёЁ\s]{2,30})\)/g, '$2')
    .replace(/\\"/g, '"')
    .replace(/\\n/g, '\n')
    .replace(/\\r/g, '')
    .replace(/\{\s*\}/g, '')
    .replace(/\{\s*\.\.\.\s*\}/g, '')
    .replace(/\{\{\s*user\s*\}\}/gi, 'ты')
    .replace(/\{\{\s*char\s*\}\}/gi, '')
    .replace(/\{\s*user\s*\}/gi, 'ты')
    .replace(/\{\s*char\s*\}/gi, '')
    .replace(/\s*[\{\}]\s*$/g, '')
    .replace(/^\s*[\{\}]\s*/g, '')
    .trim();
}

export interface ParsedBotResponse {
  text: string;
  thought?: string;
  emotion?: string;
}

/**
 * Robustly parses and extracts character emotion, inner monologue thoughts, and clean visible text
 * from a raw LLM response. Prevents default-to-neutral traps by extracting tags from anywhere
 * (including inside thoughts) and heuristically analyzing emotional context when tags are absent.
 */
const EMOTION_SYNONYMS: Record<string, string[]> = {
  happy: ['happy', 'joy', 'smile', 'smiling', 'laugh', 'радость', 'улыбка', 'веселье', 'счастье', 'смех'],
  sad: ['sad', 'sorrow', 'cry', 'crying', 'грусть', 'печаль', 'слезы', 'тоска'],
  angry: ['angry', 'furious', 'rage', 'гнев', 'злость', 'ярость', 'раздражение'],
  blushing: ['blushing', 'shy', 'embarrassed', 'смущение', 'стыд', 'румянец'],
  smirk: ['smirk', 'tease', 'playful', 'усмешка', 'сарказм', 'ухмылка'],
  surprised: ['surprised', 'shocked', 'удивление', 'шок', 'испуг'],
  thoughtful: ['thoughtful', 'pensive', 'задумчивость', 'размышление'],
  neutral: ['neutral', 'calm', 'нейтральный', 'спокойствие'],
};

/**
 * Maps a raw tag value to one of the speaker's configured emotions.
 * Returns undefined for unknown values and for tags that belong to another character
 * (e.g. "Mira: happy" written inside a group reply by someone else).
 */
export function resolveEmotion(
  raw: string,
  emotions?: CharacterEmotion[],
  speakerName?: string
): string | undefined {
  if (!raw) return undefined;
  let value = raw.trim().toLowerCase().replace(/^[*"'\[\/]+|[*"'\]\/]+$/g, '').trim();
  if (!value) return undefined;

  const named = value.match(/^([^:\-–—]{2,40})\s*[:–—-]\s*(.+)$/);
  if (named) {
    const who = named[1].trim();
    const speaker = (speakerName || '').trim().toLowerCase();
    if (speaker && who !== speaker && !speaker.includes(who) && !who.includes(speaker)) {
      return undefined; // tag belongs to another character
    }
    value = named[2].trim();
  }

  const list = emotions || [];
  const exact = list.find((e) => e.name.toLowerCase() === value || e.label?.toLowerCase() === value);
  if (exact) return exact.name.toLowerCase();

  const word = Object.entries(EMOTION_SYNONYMS).find(([, words]) => words.some((w) => value === w || value.includes(w)));
  if (word) {
    const target = list.find((e) => e.name.toLowerCase() === word[0] || word[1].some((w) => (e.name + ' ' + (e.label || '')).toLowerCase().includes(w)));
    if (target) return target.name.toLowerCase();
  }
  // No configured emotions at all: keep the raw value so nothing is lost
  return list.length === 0 ? value : undefined;
}

const HTML_OR_SYSTEM_TAGS = new Set([
  'thought', '/thought', 'p', '/p', 'br', 'b', '/b', 'i', '/i', 'em', '/em',
  'strong', '/strong', 'u', '/u', 's', '/s', 'a', '/a', 'div', '/div',
  'span', '/span', 'ul', '/ul', 'ol', '/ol', 'li', '/li', 'blockquote',
  '/blockquote', 'code', '/code', 'pre', '/pre', 'hr',
  'h1', '/h1', 'h2', '/h2', 'h3', '/h3', 'h4', '/h4', 'h5', '/h5', 'h6', '/h6',
  'user', 'bot', 'assistant', 'human', 'system',
]);

const KNOWN_EMOTION_WORDS = Array.from(
  new Set([
    ...Object.values(EMOTION_SYNONYMS).flat(),
    'shame', 'embarrassment', 'awkward', 'shock', 'pensive', 'tease',
    'неловкость', 'испуг', 'шок', 'стыд', 'румянец', 'сарказм', 'спокойствие',
  ])
);

function isStandardHtmlOrSystemTag(inner: string): boolean {
  const norm = inner.trim().toLowerCase().replace(/\s+/g, ' ');
  if (!norm) return false;
  if (norm.includes('://') || /^https?:/i.test(norm)) return true;
  const tagHead = norm.split(/[\s/>]/)[0];
  return HTML_OR_SYSTEM_TAGS.has(tagHead);
}

function buildEmotionWordSet(characterEmotions?: CharacterEmotion[]): Set<string> {
  const set = new Set<string>(KNOWN_EMOTION_WORDS);
  for (const em of characterEmotions || []) {
    if (em.name?.trim()) set.add(em.name.trim().toLowerCase());
    if (em.label?.trim()) set.add(em.label.trim().toLowerCase());
  }
  return set;
}

function isKnownOrConfiguredEmotionTag(inner: string, wordSet: Set<string>): boolean {
  let val = inner.trim().toLowerCase().replace(/^[*"'\[\/]+|[*"'\]\/]+$/g, '').trim();
  if (!val) return false;
  const named = val.match(/^[^:\-–—]{2,40}\s*[:–—-]\s*(.+)$/);
  if (named) {
    val = named[1].trim();
  }
  if (wordSet.has(val)) return true;
  // Also recognize multi-word / comma-separated variants like "wry smirk" or "happy, smirk"
  return val.split(/[\s,;]+/).some((tok) => tok.length >= 3 && wordSet.has(tok));
}

/**
 * Strips all raw emotion markers (<emotion>...</emotion>, [emotion: ...], <happy>,
 * <smirk/>, <радость>, [happy], empty <>, or leaked leading <custom> tags) without touching
 * <thought> blocks or HTML markup.
 */
export function stripEmotionTags(
  text: string,
  characterEmotions?: CharacterEmotion[],
  options: { stripLeadingUnknownAngleTag?: boolean } = {}
): string {
  if (!text) return '';
  const wordSet = buildEmotionWordSet(characterEmotions);
  let out = text
    .replace(/<\s*(?:emotion|эмоция)(?:\s*[:=][^>\n]*)?>[\s\S]*?<\/\s*(?:emotion|эмоция)\s*>/gi, '')
    // Handle malformed split closing tags such as "< emotion>angry</emotio\nn>"
    .replace(/<\s*(?:emotion|эмоция)(?:\s*[:=][^>\n]*)?>[^<>\n]{1,36}<\/\s*(?:emot|эмоц)[a-zа-яё\s]*>?/gi, '')
    .replace(/<\s*\/?\s*(?:emotion|эмоция)(?:\s*[:=][^>\n]*)?\s*>/gi, '')
    .replace(/(?:\[|<|\()\s*(?:эмоция|emotion)\s*[:=]\s*[^\]>\)\n]+(?:\]|>|\))/gi, '')
    .replace(/<\s*\/?\s*>|\[\s*\]/g, '')
    .replace(/\[([^\[\]\n]{1,48})\]/g, (full, inner) => (isKnownOrConfiguredEmotionTag(inner, wordSet) ? '' : full))
    .replace(/<(\/?[^<>\n]{1,48})>/g, (full, inner) =>
      !isStandardHtmlOrSystemTag(inner) && !inner.includes('|') && isKnownOrConfiguredEmotionTag(inner, wordSet) ? '' : full
    );

  if (options.stripLeadingUnknownAngleTag !== false) {
    for (let i = 0; i < 4; i++) {
      const m = out.match(/^\s*<(\/?[^<>\n]{1,50})>\s*/);
      if (!m) break;
      const inner = m[1];
      if (isStandardHtmlOrSystemTag(inner) || inner.includes('|')) break;
      out = out.slice(m[0].length);
    }
  }

  return out;
}

function extractEmotionFromText(
  completed: string,
  characterEmotions?: CharacterEmotion[],
  speakerName?: string
): string | undefined {
  // 1. Standard or space/newline-glitched < emotion>...</emotion> or <эмоция>...</эмоция>
  const emTagMatch = completed.match(/<\s*(?:emotion|эмоция)(?:\s*=\s*([^>\n]+))?\s*>([\s\S]*?)<\/\s*(?:emot|эмоц)[a-zа-яё\s]*>/i);
  if (emTagMatch) {
    const val = (emTagMatch[2] || '').trim() || (emTagMatch[1] || '').trim();
    const resolved = resolveEmotion(val, characterEmotions, speakerName);
    if (resolved) return resolved;
  }

  // 2. [emotion: ...], <emotion: ...>, (emotion: ...), <emotion=...>
  const emBracketMatch = completed.match(/(?:<\s*(?:emotion|эмоция)\s*[:=]\s*([^>\n]+)>|(?:\[|\()(?:эмоция|emotion)\s*[:=]\s*([^\]\)\n]+)(?:\]|\)))/i);
  if (emBracketMatch) {
    const val = (emBracketMatch[1] || emBracketMatch[2] || '').trim();
    const resolved = resolveEmotion(val, characterEmotions, speakerName);
    if (resolved) return resolved;
  }

  const wordSet = buildEmotionWordSet(characterEmotions);

  // 3. Standalone square bracket emotions like [happy] or [радость]
  const bracketMatches = completed.matchAll(/\[([^\[\]\n]{1,48})\]/g);
  for (const m of bracketMatches) {
    if (isKnownOrConfiguredEmotionTag(m[1], wordSet)) {
      const resolved = resolveEmotion(m[1], characterEmotions, speakerName);
      if (resolved) return resolved;
    }
  }

  // 4. Shorthand angle-bracket emotions like <happy>, <smirk/>, <радость>, <Мира: smirk>
  const angleMatches = completed.matchAll(/<(\/?[^<>\n]{1,48})>/g);
  for (const m of angleMatches) {
    const inner = m[1];
    if (isStandardHtmlOrSystemTag(inner) || inner.includes('|')) continue;
    if (isKnownOrConfiguredEmotionTag(inner, wordSet)) {
      const resolved = resolveEmotion(inner, characterEmotions, speakerName);
      if (resolved) return resolved;
    }
  }

  return undefined;
}

export function extractEmotionAndCleanResponse(
  completed: string,
  characterEmotions?: CharacterEmotion[],
  speakerName?: string
): ParsedBotResponse {
  if (!completed || !completed.trim()) {
    return { text: '' };
  }

  const normalized = normalizeNativeThoughtTags(completed);
  let finalEmotion = extractEmotionFromText(normalized, characterEmotions, speakerName);

  // Extract thoughts: <thought>...</thought>
  let finalThought = '';
  let visibleText = stripEmotionTags(normalized, characterEmotions, { stripLeadingUnknownAngleTag: true });

  const thoughtMatch = visibleText.match(/<thought>([\s\S]*?)<\/thought>/i);
  if (thoughtMatch) {
    finalThought = thoughtMatch[1].trim();
    visibleText = visibleText.replace(/<thought>[\s\S]*?<\/thought>/i, '').trim();
  } else if (/^\s*<thought>/i.test(visibleText)) {
    // Unclosed thought block
    finalThought = visibleText.replace(/^\s*<thought>/i, '').trim();
    visibleText = '';
  }

  if (finalThought) {
    finalThought = stripEmotionTags(finalThought, characterEmotions, { stripLeadingUnknownAngleTag: false }).trim();
  }

  // 4. Keyword inference from prose is off: the avatar changes only on an explicit <emotion> tag.
  // (It used to change the avatar whenever the narration mentioned a smile, tears, etc.)
  if (INFER_EMOTION_FROM_TEXT && !finalEmotion && characterEmotions && characterEmotions.length > 0) {
    const textToAnalyze = (visibleText + ' ' + finalThought).toLowerCase();
    const emotionPatterns: Array<{ name: string; regex: RegExp }> = [
      { name: 'happy', regex: /(?:улыб|сме|радост|счаст|весел|хохот|хихик|smile|laugh|happy|grin|giggle|cheerful|joy)/i },
      { name: 'sad', regex: /(?:плач|слез|груст|печал|вздох|тоск|рыдан|всхлип|sad|cry|tear|grief|sorrow|sigh|weep)/i },
      { name: 'angry', regex: /(?:гнев|злос|ярост|хмур|рыч|раздраж|стиснул|оскал|крик|angry|rage|furious|growl|frown|irritat|scowl|snarl)/i },
      { name: 'blushing', regex: /(?:смущ|красне|покрасн|румян|стыд|неловк|shy|blush|embarrass|fluster)/i },
      { name: 'smirk', regex: /(?:ухмыл|усмеш|сарказм|ехидн|прищур|подразн|smirk|tease|mock|sneer|playful|wry)/i },
      { name: 'surprised', regex: /(?:вздраг|удивл|шок|опешил|замер|surpris|shock|startle|gasp|stun)/i },
      { name: 'thoughtful', regex: /(?:задум|размышл|нахмурил лоб|взгляд в пустоту|pensive|thought|ponder|reflect|contemplat)/i },
    ];

    for (const ep of emotionPatterns) {
      const hasConfigured = characterEmotions.some(
        (e) => e.name.toLowerCase() === ep.name || e.label?.toLowerCase() === ep.name
      );
      if (hasConfigured && ep.regex.test(textToAnalyze)) {
        finalEmotion = ep.name;
        break;
      }
    }

    // Direct emotion name match in text
    if (!finalEmotion) {
      for (const em of characterEmotions) {
        const eName = em.name.toLowerCase();
        if (eName !== 'neutral' && new RegExp(`\\b${eName}\\b`, 'i').test(textToAnalyze)) {
          finalEmotion = eName;
          break;
        }
      }
    }

    // Default to neutral if neutral is explicitly in character emotions
    if (!finalEmotion && characterEmotions.some((e) => e.name.toLowerCase() === 'neutral')) {
      finalEmotion = 'neutral';
    }
  }

  visibleText = stripEmotionTags(visibleText, characterEmotions, { stripLeadingUnknownAngleTag: true });
  if (speakerName) {
    visibleText = stripLeadingSpeakerName(visibleText, [speakerName]);
  }

  const cleaned = cleanArtifacts(visibleText, characterEmotions);

  return {
    text: cleaned || cleanArtifacts(completed, characterEmotions),
    thought: finalThought || undefined,
    emotion: finalEmotion,
  };
}

/**
 * Shared streaming parser used by ChatView while tokens arrive: extracts emotions,
 * separates <thought>...</thought>, strips <emotion>/<word>/<> tags, and suppresses
 * incomplete leading <...> buffer fragments before they close.
 */
export function parseStreamingBotResponse(
  raw: string,
  characterEmotions?: CharacterEmotion[],
  speakerName?: string,
  extraStripNames: string[] = []
): ParsedBotResponse {
  if (!raw) return { text: '' };
  const normalized = normalizeNativeThoughtTags(raw);
  const emotion = extractEmotionFromText(normalized, characterEmotions, speakerName);
  const stripNames = [speakerName || '', ...extraStripNames].filter(Boolean);

  let work = stripLeadingSpeakerName(normalized, stripNames);
  work = stripEmotionTags(work, characterEmotions, { stripLeadingUnknownAngleTag: true });

  let thought = '';
  const thoughtMatch = work.match(/<thought>([\s\S]*?)<\/thought>/i);
  if (thoughtMatch) {
    thought = stripEmotionTags(thoughtMatch[1], characterEmotions, { stripLeadingUnknownAngleTag: false }).trim();
    work = work.replace(/<thought>[\s\S]*?<\/thought>/i, '').trimStart();
  } else if (/^\s*<thought>/i.test(work)) {
    thought = stripEmotionTags(work.replace(/^\s*<thought>/i, ''), characterEmotions, { stripLeadingUnknownAngleTag: false });
    return { text: '', thought, emotion };
  }

  work = stripEmotionTags(work, characterEmotions, { stripLeadingUnknownAngleTag: true });

  // Prevent flickering partial "<emotion", "<|channel", "<|turn", "<think", "<" before complete delimiter arrives
  if (/^\s*<[^>\n]{0,55}$/.test(work) || /^\s*<\|\s*(?:channel|turn|thought)[^>]*$/i.test(work)) {
    return { text: '', thought: thought || undefined, emotion };
  }

  work = stripLeadingSpeakerName(work, stripNames);

  return {
    text: cleanArtifacts(work, characterEmotions),
    thought: thought || undefined,
    emotion,
  };
}

export async function generatePersonaWithAI(
  apiKeyConfig: ApiKeyConfig,
  model: string,
  concept: string,
  dos: string,
  donts: string,
  photoRef?: string,
  contextLore?: string,
  language: Language = 'en'
): Promise<{ name: string; description: string; greeting: string; scenario?: string; exampleDialogue?: string }> {
  const isRu = language === 'ru';
  const languageInstruction = isRu
    ? `ВАЖНО: Язык генерации — РУССКИЙ. Все поля ("name", "description", "scenario", "exampleDialogue", "greeting") ОБЯЗАТЕЛЬНО должны быть написаны на чистом, выразительном русском языке. Никаких английских слов.`
    : `Language: English.`;

  const systemPrompt = `You are an elite creative director for deep, unrestricted roleplay characters.
Given a concept and preferences, generate an extraordinarily detailed, distinct, and compelling roleplay persona.
${languageInstruction}

Return STRICT JSON only matching this exact format:
{
  "name": "Character Name",
  "description": "Exhaustive description covering: personality traits, dark secrets, speech patterns, appearance, background lore, vulnerabilities, habits.",
  "scenario": "Starting situation, current location, atmosphere, and relationship premise between {{char}} and {{user}}.",
  "exampleDialogue": "<START>\\n{{user}}: Sample prompt\\n{{char}}: *Concise physical action.* Characteristic reply capturing tone and speech style.",
  "greeting": "An atmospheric opening message establishing the first scene, with actions enclosed in *asterisks* and spoken dialogue in plain text."
}
CRITICAL RULES:
1. Output complete, fully articulated text. Do NOT cut off sentences.
2. Never leave placeholders or empty brackets like {}.
3. Do NOT wrap the JSON in markdown code blocks. Output raw JSON only.`;

  let userContent: any = `Concept / Idea: ${concept}\n`;
  if (contextLore) {
    userContent += `Related Universe / Companions Lore:\n${contextLore}\n`;
  }
  if (dos) {
    userContent += `What to include (DO): ${dos}\n`;
  }
  if (donts) {
    userContent += `What to avoid (DON'T): ${donts}\n`;
  }

  const messages: ChatCompletionMessage[] = [{ role: 'system', content: systemPrompt }];

  if (photoRef) {
    messages.push({
      role: 'user',
      content: [
        { type: 'text', text: userContent + '\nAnalyze this reference photo and incorporate accurate physical appearance details into the character description.' },
        { type: 'image_url', image_url: { url: photoRef } },
      ],
    });
  } else {
    messages.push({ role: 'user', content: userContent });
  }

  let result = '';
  await streamChatCompletion({
    apiKeyConfig,
    model: model || 'deepseek/deepseek-chat',
    messages,
    temperature: 0.9,
    maxTokens: 4000,
    onToken: (tok) => { result += tok; },
    onError: (e) => { throw e; },
  });

  const cleaned = result.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try {
    const parsed = JSON.parse(cleaned);
    if (parsed.name && parsed.description) {
      return {
        name: String(parsed.name).trim(),
        description: cleanArtifacts(String(parsed.description)),
        greeting: cleanArtifacts(String(parsed.greeting || '')),
        scenario: parsed.scenario ? cleanArtifacts(String(parsed.scenario)) : undefined,
        exampleDialogue: parsed.exampleDialogue ? cleanArtifacts(String(parsed.exampleDialogue)) : undefined,
      };
    }
  } catch {
    // regex fallback below
  }

  const nameMatch = cleaned.match(/"name"\s*:\s*"([^"]+)"/);
  const greetingMatch = cleaned.match(/"greeting"\s*:\s*"([\s\S]*?)"(?:\s*,\s*"|\s*})/);
  const descMatch = cleaned.match(/"description"\s*:\s*"([\s\S]*?)"(?:\s*,\s*"greeting"|\s*})/);

  const fallbackName = nameMatch ? nameMatch[1] : (concept.slice(0, 30) || (isRu ? 'Безымянный персонаж' : 'Unknown Character'));
  const fallbackGreeting = greetingMatch
    ? cleanArtifacts(greetingMatch[1])
    : (isRu
        ? `*Смотрит на вас с внимательным интересом, слегка прищурившись.* Что привело тебя сюда?`
        : `*Stands before you, observing your presence with quiet curiosity.* What brings you here?`);
  let fallbackDesc = descMatch
    ? cleanArtifacts(descMatch[1])
    : cleanArtifacts(cleaned.replace(/^[{\s"name:]+/, '').replace(/[}\s]+$/, ''));

  if (!fallbackDesc || fallbackDesc.length < 5) {
    fallbackDesc = isRu ? `Загадочная личность, связанная с концептом: ${concept}` : `Mysterious entity tied to concept: ${concept}`;
  }

  return {
    name: fallbackName,
    description: fallbackDesc,
    greeting: fallbackGreeting,
  };
}

export async function generateGroupWithAI(
  apiKeyConfig: ApiKeyConfig,
  model: string,
  concept: string,
  language: Language = 'en'
): Promise<{ name: string; description: string; backstory: string }> {
  const isRu = language === 'ru';
  const languageInstruction = isRu
    ? `ВАЖНО: Язык ответа — РУССКИЙ. Все поля ("name", "description", "backstory") должны быть написаны на русском языке.`
    : `Language: English.`;

  const systemPrompt = `You are a worldbuilding designer for collaborative roleplay universes.
Given an idea/theme, generate a rich faction/group setting.
${languageInstruction}

Return STRICT JSON only matching this exact format:
{
  "name": "Group / Faction / Universe Name",
  "description": "Atmospheric lore describing the world setting, faction rules, internal power dynamics, conflicts and secrets.",
  "backstory": "An engaging starting scene describing where the group gathers and the initial crisis or dialogue hook."
}
CRITICAL: Output complete valid JSON only with no markdown code blocks, no unclosed brackets, no trailing empty brackets {}.`;

  let result = '';
  await streamChatCompletion({
    apiKeyConfig,
    model: model || 'deepseek/deepseek-chat',
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: `Group Theme / Idea: ${concept}` },
    ],
    temperature: 0.85,
    maxTokens: 3000,
    onToken: (tok) => { result += tok; },
    onError: (e) => { throw e; },
  });

  const cleaned = result.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try {
    const parsed = JSON.parse(cleaned);
    return {
      name: String(parsed.name || (isRu ? 'Новая группа' : 'New Group')).trim(),
      description: cleanArtifacts(String(parsed.description || '')),
      backstory: cleanArtifacts(String(parsed.backstory || '')),
    };
  } catch {
    const nameM = cleaned.match(/"name"\s*:\s*"([^"]+)"/);
    const descM = cleaned.match(/"description"\s*:\s*"([\s\S]*?)"(?:\s*,\s*"backstory"|\s*})/);
    const backM = cleaned.match(/"backstory"\s*:\s*"([\s\S]*?)"(?:\s*})/);

    return {
      name: nameM ? nameM[1] : (concept.slice(0, 30) || (isRu ? 'Группа' : 'Group')),
      description: descM ? cleanArtifacts(descM[1]) : cleanArtifacts(cleaned),
      backstory: backM ? cleanArtifacts(backM[1]) : (isRu ? 'Участники собираются в условленном месте...' : 'Members gather at the designated location...'),
    };
  }
}

export async function generateGroupRolesWithAI(
  apiKeyConfig: ApiKeyConfig,
  model: string,
  groupName: string,
  groupDescription: string,
  characters: Character[],
  userConcept?: string,
  language: Language = 'en'
): Promise<Record<string, string>> {
  if (characters.length === 0) return {};
  const isRu = language === 'ru';

  const charProfiles = characters
    .map((c) => `- Character [${c.name}]: ${c.description.slice(0, 200)}`)
    .join('\n');

  const system = `You are a narrative director assigning distinctive roles and faction ranks to characters in a group.
${isRu ? 'Язык ответа: РУССКИЙ. Назначь каждому персонажу интересную и органичную роль в группе.' : 'Language: English. Assign fitting and distinct roles to each character in the group.'}

Respond STRICT JSON mapping character names to concise role titles with brief duties (1 short phrase or sentence):
{
  "Character Name": "Role / Rank (e.g. Master Hacker & Infiltrator)"
}
Raw JSON only.`;

  let user = `Group: ${groupName}\nLore: ${groupDescription}\n\nMembers:\n${charProfiles}`;
  if (userConcept && userConcept.trim()) {
    user += `\n\nUser instructions and desired assignments:\n${userConcept.trim()}`;
  }

  let result = '';
  await streamChatCompletion({
    apiKeyConfig,
    model: model || 'deepseek/deepseek-chat',
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    temperature: 0.8,
    maxTokens: 2000,
    onToken: (t) => { result += t; },
    onError: (e) => { throw e; },
  });

  const rolesMap: Record<string, string> = {};
  const cleaned = result.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try {
    const parsed = JSON.parse(cleaned);
    for (const c of characters) {
      if (parsed[c.name]) {
        rolesMap[c.id] = String(parsed[c.name]).trim();
      }
    }
  } catch {
    for (const c of characters) {
      const reg = new RegExp(`"${c.name}"\\s*:\\s*"([^"]+)"`, 'i');
      const m = cleaned.match(reg);
      if (m) {
        rolesMap[c.id] = m[1].trim();
      }
    }
  }

  for (const c of characters) {
    if (!rolesMap[c.id]) {
      rolesMap[c.id] = isRu ? 'Участник группы' : 'Group Member';
    }
  }

  return rolesMap;
}

export interface SuggestUserReplyOptions {
  onPartial?: (text: string) => void;
  signal?: AbortSignal;
  userName?: string;
  otherSpeakers?: string[];
  language?: 'en' | 'ru';
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function inferSpeakersFromHistory(recentHistory: string, excludeNames: string[]): string[] {
  const excluded = new Set(
    ['вы', 'you', 'игрок', 'player', 'user', 'assistant', 'bot', ...excludeNames]
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean)
  );
  const found: string[] = [];
  for (const line of recentHistory.split('\n')) {
    const m = line.match(/^\s*\[?([^:\[\]\n]{2,40})\]?\s*:\s*\S/);
    if (!m) continue;
    const candidate = m[1].trim();
    if (!excluded.has(candidate.toLowerCase()) && !found.includes(candidate)) {
      found.push(candidate);
    }
  }
  return found;
}

export function buildGhostwriterMessages(params: {
  userPersona: Character | null;
  prompt: string;
  recentHistory: string;
  userName?: string;
  otherSpeakers?: string[];
  language?: 'en' | 'ru';
}): {
  system: string;
  userMsg: string;
  speakerLabel: string;
  otherSpeakers: string[];
} {
  const { userPersona, prompt, recentHistory, userName, otherSpeakers = [], language } = params;
  const isRu = language === 'ru' || (!language && /[а-яА-ЯёЁ]/.test(recentHistory + (userPersona?.description || '') + (prompt || '')));
  const speakerLabel =
    (userPersona?.name || userName || '').trim() ||
    (isRu ? 'Игрок' : 'Player');

  const uniqueOthers = Array.from(
    new Set([
      ...otherSpeakers.map((s) => (s || '').trim()).filter((s) => s && s.toLowerCase() !== speakerLabel.toLowerCase()),
      ...inferSpeakersFromHistory(recentHistory, [speakerLabel]),
    ])
  );

  // Align generic "Вы:" / "You:" prefixes in history with the active persona/speaker label
  const normalizedHistory = recentHistory.replace(
    /^(\s*)(Вы|You|Игрок|Player)(\s*:)/gm,
    `$1${speakerLabel}$3`
  );

  const effectivePrompt = prompt && prompt.trim()
    ? prompt.trim()
    : (isRu
        ? `Придумай естественную, логичную и живую реакцию от лица ${speakerLabel} в текущей ситуации.`
        : `Write a natural, vivid, in-character reply strictly on behalf of ${speakerLabel} in this scene.`);

  const othersText = uniqueOthers.join(', ');

  if (isRu) {
    const personaLine = userPersona
      ? `\nОписание персоны ${speakerLabel}: ${userPersona.description.slice(0, 320)}`
      : '';
    const othersLine = uniqueOthers.length > 0
      ? `\nДругие персонажи сцены (они управляются отдельно): ${othersText}.`
      : '';
    const forbiddenNames = uniqueOthers.length > 0
      ? ` («${speakerLabel}:», «Вы:», ${uniqueOthers.slice(0, 4).map((n) => `«${n}:»`).join(', ')})`
      : ` («${speakerLabel}:», «Вы:», «Игрок:»)`;

    const system = `Ты — помощник ролевой игры, формулирующий ТОЛЬКО одну следующую реплику игрока (${speakerLabel}).${personaLine}${othersLine}

СТРОГИЕ ПРАВИЛА:
1. Пиши ИСКЛЮЧИТЕЛЬНО от лица персонажа игрока (${speakerLabel}): действия и мимику в *звездочках*, прямую речь обычным текстом без кавычек-ёлочек и лишних пояснений.
2. КАТЕГОРИЧЕСКИ ЗАПРЕЩЕНО писать реплики, действия, реакции, чувства или мысли за ${othersText || 'других персонажей сцены'}. Остановись сразу после хода ${speakerLabel}.
3. НИКОГДА не начинай ответ с имени или двоеточия${forbiddenNames} и не добавляй никаких служебных или XML-тегов.
4. Выведи ТОЛЬКО саму реакцию ${speakerLabel}, готовый текст для отправки в чат (1–2 абзаца), без повторения предыдущих фраз.`;

    const userMsg = `Недавний диалог в сцене:\n${normalizedHistory}\n\nЗадача: напиши ТОЛЬКО следующий ход от лица «${speakerLabel}».${uniqueOthers.length > 0 ? ` Не описывай ходы и слова ${othersText}.` : ''}\nПожелание: ${effectivePrompt}\nНачни сразу с *действия* или фразы без имени в начале.`;

    return { system, userMsg, speakerLabel, otherSpeakers: uniqueOthers };
  }

  const personaLineEn = userPersona
    ? `\nUser persona details for ${speakerLabel}: ${userPersona.description.slice(0, 320)}`
    : '';
  const othersLineEn = uniqueOthers.length > 0
    ? `\nOther characters in this scene (controlled separately): ${othersText}.`
    : '';

  const system = `You are a creative roleplay ghostwriter composing ONLY the next single turn on behalf of the player (${speakerLabel}).${personaLineEn}${othersLineEn}

STRICT RULES:
1. Write STRICTLY from ${speakerLabel}'s perspective: physical actions inside *asterisks*, spoken dialogue as plain text without outer quotation marks.
2. NEVER write dialogue, actions, thoughts, or reactions on behalf of ${othersText || 'other characters'}. Stop immediately after ${speakerLabel}'s turn.
3. NEVER start the response with a character name or colon ("${speakerLabel}:", "You:"${uniqueOthers.length > 0 ? `, "${uniqueOthers[0]}:"` : ''}) and NEVER output any XML, emotion, or thought tags.
4. Output ONLY ${speakerLabel}'s ready-to-send message (1–2 concise paragraphs) without repeating earlier turns or adding meta notes.`;

  const userMsg = `Recent Scene History:\n${normalizedHistory}\n\nTask: Write ONLY ${speakerLabel}'s next turn.${uniqueOthers.length > 0 ? ` Do NOT narrate or speak for ${othersText}.` : ''}\nUser's Intent: ${effectivePrompt}\nBegin directly with *action* or dialogue with no leading name prefix.`;

  return { system, userMsg, speakerLabel, otherSpeakers: uniqueOthers };
}

export function cleanGhostwriterOutput(
  raw: string,
  speakerLabel: string,
  otherSpeakers: string[] = []
): string {
  if (!raw) return '';
  let out = normalizeNativeThoughtTags(raw)
    .replace(/<thought>[\s\S]*?<\/thought>/gi, '')
    .replace(/^\s*<thought>[\s\S]*$/i, '');

  out = stripEmotionTags(out, undefined, { stripLeadingUnknownAngleTag: true });

  const allNames = Array.from(
    new Set([speakerLabel, ...otherSpeakers, 'Вы', 'Игрок', 'You', 'Player'].filter(Boolean))
  );
  out = stripLeadingSpeakerName(out, allNames);

  // Truncate if the model continued into another speaker's turn on a subsequent line
  const stopTargets = Array.from(
    new Set([...otherSpeakers, speakerLabel, 'Вы', 'Игрок', 'You', 'Player'].filter((n) => n && n.trim().length >= 2))
  );
  if (stopTargets.length > 0) {
    const alt = stopTargets.map((n) => escapeRegex(n.trim())).join('|');
    out = out.replace(new RegExp(`\\n+\\s*\\[?(?:${alt})\\]?\\s*:.*$`, 'is'), '');
  }

  out = cleanArtifacts(out);
  out = stripLeadingSpeakerName(out, allNames);
  return out.trim();
}

export async function suggestUserReply(
  apiKeyConfig: ApiKeyConfig,
  model: string,
  userPersona: Character | null,
  prompt: string,
  recentHistory: string,
  options: SuggestUserReplyOptions = {}
): Promise<string> {
  const { system, userMsg, speakerLabel, otherSpeakers } = buildGhostwriterMessages({
    userPersona,
    prompt,
    recentHistory,
    userName: options.userName,
    otherSpeakers: options.otherSpeakers,
    language: options.language,
  });

  const extraStops = speakerStopStrings([speakerLabel, ...otherSpeakers, 'Вы', 'Игрок', 'You', 'Player']);
  const gwSamplers = RP_SAMPLER_PRESETS.roleplay;

  let out = '';
  try {
    await streamChatCompletion({
      apiKeyConfig,
      model: model || 'deepseek/deepseek-chat',
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: userMsg },
      ],
      extraStops,
      temperature: 0.82,
      topP: gwSamplers.topP,
      minP: gwSamplers.minP,
      topK: gwSamplers.topK,
      repeatPenalty: gwSamplers.repeatPenalty,
      repeatLastN: gwSamplers.repeatLastN,
      frequencyPenalty: gwSamplers.frequencyPenalty,
      presencePenalty: gwSamplers.presencePenalty,
      signal: options.signal,
      onToken: (t) => {
        out += t;
        options.onPartial?.(cleanGhostwriterOutput(out, speakerLabel, otherSpeakers));
      },
      onError: (e) => { throw e; },
    });
  } catch (err: any) {
    // A stopped generation keeps the text received so far
    if (!options.signal?.aborted) throw err;
  }

  return cleanGhostwriterOutput(out, speakerLabel, otherSpeakers);
}

export interface CompressOptions {
  maxChars?: number;
  maxTokens?: number;
  timeoutMs?: number;
}

export async function compressChatHistory(
  apiKeyConfig: ApiKeyConfig,
  model: string,
  messagesToCompress: Array<{ senderName: string; text: string }>,
  previousSummary?: string,
  options: CompressOptions = {}
): Promise<string> {
  const maxChars = options.maxChars ?? 1200;
  const maxTokens = options.maxTokens ?? 384;
  const timeoutMs = options.timeoutMs ?? 20000;
  const wordLimit = Math.round(maxChars / 7.5);
  const turns = messagesToCompress
    .filter((m) => m.text && m.text.trim().length > 0)
    .map((m) => `${m.senderName}: ${m.text.trim()}`)
    .join('\n');

  if (!turns) return previousSummary || '';

  const isRu = /[а-яА-ЯёЁ]/.test(turns + (previousSummary || ''));

  const system = isRu
    ? `Ты — литературный архивариус и летописец ролевой истории.
Твоя задача: составить предельно краткий, емкий и компактный пересказ (строго 1-3 коротких абзаца, не более ${wordLimit} слов) предшествующих событий сюжета.
Отрази ключевые решения, действия, смену отношений, тайны и факты, необходимые для сохранения контекста в долгих диалогах.
НЕ растягивай текст и не включай мелкую болтовню. Пиши на чистом русском языке без мета-вступлений. Выводи ТОЛЬКО сжатый пересказ.`
    : `You are an expert narrative chronicler for a roleplay story.
Your task: produce a strictly concise, compact summary (strictly 1-3 short paragraphs, max ${wordLimit} words) of earlier dialogue turns and story developments.
Highlight pivotal plot events, character decisions, secrets revealed, and relationship shifts needed to preserve long-term context.
Eliminate trivial chatter and keep it strictly bounded. Output ONLY the concise narrative recap with no meta introductions.`;

  const userContent = previousSummary
    ? (isRu
        ? `Предыдущий краткий пересказ:\n${previousSummary}\n\nНовые предшествующие реплики для включения в пересказ:\n${turns}`
        : `Previous context summary:\n${previousSummary}\n\nNew dialogue turns to incorporate into summary:\n${turns}`)
    : (isRu
        ? `Диалог для краткого пересказа:\n${turns}`
        : `Dialogue to summarize into concise context recap:\n${turns}`);

  let out = '';
  const timeoutController = new AbortController();
  const timeoutId = setTimeout(() => timeoutController.abort(), timeoutMs);
  try {
    await streamChatCompletion({
      apiKeyConfig,
      model: model || 'deepseek/deepseek-chat',
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: userContent },
      ],
      temperature: 0.35,
      maxTokens,
      signal: timeoutController.signal,
      onToken: (t) => { out += t; },
      onError: (e) => { throw e; },
    });
  } catch (err) {
    if (timeoutController.signal.aborted) {
      console.warn(`Chat history compression timed out after ${Math.round(timeoutMs / 1000)}s`);
    } else {
      throw err;
    }
  } finally {
    clearTimeout(timeoutId);
  }

  let summary = out.trim();
  if (summary.length > maxChars) {
    summary = summary.slice(0, maxChars).trim() + '...';
  }
  return summary;
}

export async function summarizeScene(
  apiKeyConfig: ApiKeyConfig,
  model: string,
  recentHistory: string,
  language: 'en' | 'ru' = 'ru'
): Promise<string> {
  const isRu = language === 'ru' || /[а-яА-ЯёЁ]/.test(recentHistory);
  const system = isRu
    ? `Ты — беспристрастный литературный рассказчик, подводящий итоги текущей ролевой сцены.
Напиши выразительную, атмосферную сводку из 2-3 абзацев на русском языке:
1. Текущее место действия и обстановка.
2. Что только что произошло и какое эмоциональное напряжение возникло между персонажами.
3. Активные конфликты, цели или невысказанные намерения.
Отвечай ТОЛЬКО на чистом литературном русском языке.`
    : `You are an impartial narrator summarizing the current roleplay scene.
Provide a clear, atmospheric 2-3 paragraph summary of:
1. Current location and situation.
2. What just happened and emotional tension between characters.
3. Active conflicts or unspoken intentions.
Respond in English.`;

  const userContent = isRu
    ? `Диалог и события сцены для составления сводки:\n\n${recentHistory}\n\nСоставь выразительную сводку на русском языке.`
    : `Scene dialogue and events to summarize:\n\n${recentHistory}\n\nProvide the scene summary in English.`;

  let out = '';
  await streamChatCompletion({
    apiKeyConfig,
    model: model || 'deepseek/deepseek-chat',
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: userContent },
    ],
    temperature: 0.7,
    onToken: (t) => { out += t; },
    onError: (e) => { throw e; },
  });

  return out.trim();
}

/**
 * Stop strings that end the reply when the model starts writing another speaker's line,
 * e.g. "Mira:" or "\nAlex:" for the user's persona. Names must be at least two characters.
 */
export function speakerStopStrings(names: string[]): string[] {
  const stops: string[] = [];
  for (const raw of names) {
    const name = (raw || '').trim();
    if (name.length < 3) continue;
    stops.push(
      `\n${name}:`,
      `\n${name} :`,
      `\n[${name}]:`,
      `\n>${name}:`,
      ` >${name}:`,
      `>${name}:`
    );
  }
  return Array.from(new Set(stops));
}

/** Removes a leading "Name:" or "[Name]:" (even wrapped in quotes/bold) that the model copied from history. */
/**
 * If a small local model literally begins its reply by parroting the previous user turn
 * (or first full line/sentence of it), strip that echoed duplicate while keeping the real reply.
 */
export function stripEchoedUserPrefix(reply: string, lastUserText?: string): string {
  const trimmedReply = (reply || '').trim();
  const trimmedUser = (lastUserText || '').trim();
  if (!trimmedReply || trimmedUser.length < 12) return trimmedReply;

  if (trimmedReply.toLowerCase().startsWith(trimmedUser.toLowerCase())) {
    const remainder = trimmedReply.slice(trimmedUser.length).replace(/^[\s\-–—:]+/, '').trim();
    if (remainder.length >= 6) return remainder;
  }

  const firstUserLine = trimmedUser.split(/\r?\n/)[0].trim();
  if (
    firstUserLine.length >= 16 &&
    trimmedReply.toLowerCase().startsWith(firstUserLine.toLowerCase())
  ) {
    const remainder = trimmedReply.slice(firstUserLine.length).replace(/^[\s\-–—:]+/, '').trim();
    if (remainder.length >= 6) return remainder;
  }

  return trimmedReply;
}

export function stripLeadingSpeakerName(text: string, names: string[]): string {
  let out = text;
  for (let pass = 0; pass < 2; pass++) {
    for (const raw of names) {
      const name = (raw || '').trim();
      if (name.length < 2) continue;
      const escaped = escapeRegex(name);
      // 1. Markdown bold/underline name header: >**Лира:** or >**Лира**:
      out = out.replace(
        new RegExp(`^\\s*(?:>+\\s*)?(?:\\*\\*|__)\\s*\\[?(?:(?:Ответ|Реплика|Собеседник)\\s+)?${escaped}(?:\\s*\\([^)]{1,24}\\))?\\]?(?:\\s*:)?\\s*(?:\\*\\*|__)(?:\\s*:)?\\s*`, 'i'),
        ''
      );
      // 2. Plain or quoted name prefix requiring a colon: >Лира: or Лира (она): or [Лира]:
      out = out.replace(
        new RegExp(`^\\s*(?:>+\\s*)?\\[?(?:(?:Ответ|Реплика|Собеседник)\\s+)?${escaped}(?:\\s*\\([^)]{1,24}\\))?\\]?\\s*:\\s*`, 'i'),
        ''
      );
    }
  }
  return out;
}

function isActionOnlyParagraph(paragraph: string): boolean {
  const trimmed = paragraph.trim();
  return /\*/.test(trimmed) && trimmed.replace(/\*[^*\n]+\*/g, '').trim() === '';
}

/**
 * Enforces an explicit user paragraph cap or compact-brevity wish without breaking sentences:
 * first merges isolated *action* paragraphs with their adjacent spoken dialogue line, and if
 * an explicit maxParagraphs limit is still exceeded, trims trailing excess paragraphs cleanly.
 */
export function enforceParagraphLimit(
  text: string,
  maxParagraphs?: number,
  compactBrevity = false
): string {
  const trimmed = (text || '').trim();
  if (!trimmed) return '';
  const targetMax = maxParagraphs && maxParagraphs > 0 ? maxParagraphs : (compactBrevity ? 2 : 0);
  if (!targetMax) return trimmed;

  let paras = trimmed.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  if (paras.length <= targetMax) return paras.join('\n\n');

  // Step 1: Losslessly merge standalone *action* lines into adjacent speech paragraphs
  while (paras.length > targetMax) {
    const idx = paras.findIndex((p) => isActionOnlyParagraph(p));
    if (idx === -1) break;
    if (idx + 1 < paras.length && !isActionOnlyParagraph(paras[idx + 1])) {
      paras.splice(idx, 2, `${paras[idx]} ${paras[idx + 1]}`);
    } else if (idx > 0) {
      paras.splice(idx - 1, 2, `${paras[idx - 1]} ${paras[idx]}`);
    } else if (idx + 1 < paras.length) {
      paras.splice(idx, 2, `${paras[idx]} ${paras[idx + 1]}`);
    } else {
      break;
    }
  }

  // Step 2: Only for an explicit user cap (e.g. "не пиши больше 2 абзацев"), keep complete leading paragraphs
  if (maxParagraphs && maxParagraphs > 0 && paras.length > maxParagraphs) {
    paras = paras.slice(0, maxParagraphs);
  }

  return paras.join('\n\n');
}
