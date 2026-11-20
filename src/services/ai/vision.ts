import type { ApiKeyConfig, AppSettings } from '../../types';
import { getComponentAiConfig } from './config.ts';
import { streamChatCompletion } from './streaming.ts';
import { normalizeNativeThoughtTags } from './textProcessing.ts';

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

/** Normalize and validate raw Vision LLM output into a clean single-line appearance trait list. */
export function extractVisionAppearanceOutput(rawOutput: string): string {
  const normalized = normalizeNativeThoughtTags(rawOutput || '');
  const hadThought = /<thought>/i.test(normalized);
  const visible = normalized
    .replace(/<thought>[\s\S]*?<\/thought>/gi, '')
    .replace(/<thought>[\s\S]*$/gi, '')
    .replace(/```[\w]*\s*([\s\S]*?)```/g, '$1')
    .replace(/[\r\n]+/g, ' ')
    .replace(/^["'\s,;:.]+|["'\s]+$/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();

  if (visible) return visible;
  if (hadThought) {
    throw new Error(
      'Vision model only returned internal reasoning without a final trait list. Increase tokens or switch to a Vision model.'
    );
  }
  throw new Error(
    'Vision AI returned empty text. Make sure the active PC model supports Vision (with mmproj) or choose a Vision cloud model in Settings.'
  );
}

/** Extract clean, stable English physical appearance traits from a character reference photo via Vision AI. */
export async function describeCharacterPhotoWithVision(options: {
  settings?: AppSettings;
  activeApiKey?: ApiKeyConfig;
  photoDataUrl: string;
  characterName: string;
  onProgress?: (chars: number) => void;
}): Promise<string> {
  const { settings, activeApiKey, photoDataUrl, characterName, onProgress } = options;
  const { apiKeyConfig, textModel, isLocal } = getComponentAiConfig(settings, activeApiKey, 'vision');
  if (!apiKeyConfig || (!isLocal && !apiKeyConfig.key?.trim() && apiKeyConfig.provider !== 'custom')) {
    throw new Error('Configure Vision API key or Local Vision model in Settings first.');
  }

  let output = '';
  let capturedError: Error | null = null;
  await streamChatCompletion({
    apiKeyConfig,
    model: textModel,
    temperature: 0.2,
    maxTokens: 900,
    includeReasoning: true,
    messages: [
      {
        role: 'system',
        content:
          'You extract stable visual character traits for image generation prompts. Return ONLY a clean comma-separated English tag/phrase list (max 55 words) describing exact species/race (human, elf, anthropomorphic wolf/fox/feline/dragon, demon, cyborg, etc.), gender/presentation, build, hair or fur/scales/feathers/plating color and pattern, face or muzzle structure, eye color, distinctive anatomy (pointed ears, horns, wings, tail, cybernetics, markings, scars, glasses), and signature outfit. Do NOT describe background, lighting, or camera angle.',
      },
      {
        role: 'user',
        content: [
          { type: 'text', text: `Character name: ${characterName}. Describe their permanent physical appearance from this reference image:` },
          { type: 'image_url', image_url: { url: photoDataUrl } },
        ],
      },
    ],
    onToken: (tok) => {
      output += tok;
      onProgress?.(output.length);
    },
    onError: (err) => {
      capturedError = err;
    },
  });
  if (capturedError) {
    throw capturedError;
  }
  return extractVisionAppearanceOutput(output);
}
