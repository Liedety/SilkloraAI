import { db } from '../db';
import type { ApiKeyConfig, MemoryNode, MemoryEdge, ChatMessage } from '../types';
import { streamChatCompletion } from './ai';

export async function extractMemoryAndAffinity(
  chatId: string,
  characterId: string,
  currentAffinity: number,
  recentMessages: ChatMessage[],
  apiKeyConfig?: ApiKeyConfig,
  model?: string
): Promise<{ newAffinity: number; newNodes: MemoryNode[] }> {
  // If no API key configured yet, compute a lightweight heuristic update
  const lastUserMsg = [...recentMessages].reverse().find((m) => m.senderId === 'user');
  const lastBotMsg = [...recentMessages].reverse().find((m) => m.senderId !== 'user');

  if (!lastUserMsg || !lastBotMsg) {
    return { newAffinity: currentAffinity, newNodes: [] };
  }

  const userText = lastUserMsg.variants[lastUserMsg.activeVariantIndex]?.text || '';
  const botText = lastBotMsg.variants[lastBotMsg.activeVariantIndex]?.text || '';

  // If API key is available, use LLM to extract accurate memory node & affinity delta
  if (apiKeyConfig && apiKeyConfig.key.trim()) {
    let rawResponse = '';
    try {
      const extractionPrompt = `Analyze this roleplay dialogue turn between USER and CHARACTER.
1. Determine how user's actions affect character's affinity (-10 to +10 change).
2. Extract 1 or 2 new significant facts, events, bond shifts, or secrets to store in long-term memory graph.

USER: ${userText}
CHARACTER: ${botText}

Respond STRICTLY with valid JSON:
{
  "affinityDelta": 3,
  "nodes": [
    {
      "label": "Short Title (3-5 words)",
      "type": "event" | "fact" | "relationship" | "location" | "secret",
      "detail": "One concise sentence describing the memory."
    }
  ]
}
No markdown wrappers, raw JSON only.`;

      await streamChatCompletion({
        apiKeyConfig,
        model: model || 'deepseek/deepseek-chat',
        messages: [
          { role: 'system', content: 'You are an analytical memory module for an RPG engine.' },
          { role: 'user', content: extractionPrompt },
        ],
        temperature: 0.3,
        onToken: (tok) => { rawResponse += tok; },
        onError: () => {},
      });

      let cleaned = rawResponse.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
      const firstBrace = cleaned.indexOf('{');
      const lastBrace = cleaned.lastIndexOf('}');
      if (firstBrace !== -1 && lastBrace !== -1) {
        cleaned = cleaned.substring(firstBrace, lastBrace + 1);
      }
      const parsed = JSON.parse(cleaned);

      const delta = typeof parsed.affinityDelta === 'number' ? parsed.affinityDelta : 0;
      const newAffinity = Math.max(-100, Math.min(100, currentAffinity + delta));

      const createdNodes: MemoryNode[] = [];
      if (Array.isArray(parsed.nodes)) {
        for (const item of parsed.nodes) {
          if (item.label && item.detail) {
            const node: MemoryNode = {
              id: 'node-' + Math.random().toString(36).substring(2, 10),
              chatId,
              label: item.label,
              type: item.type || 'fact',
              detail: item.detail,
              createdAt: Date.now(),
            };
            await db.memoryNodes.put(node);
            createdNodes.push(node);

            // Connect to existing nodes if any
            const existingNodes = await db.memoryNodes.where('chatId').equals(chatId).toArray();
            if (existingNodes.length > 1) {
              const prev = existingNodes[existingNodes.length - 2];
              const edge: MemoryEdge = {
                id: 'edge-' + Math.random().toString(36).substring(2, 10),
                chatId,
                source: prev.id,
                target: node.id,
                label: 'leads to',
              };
              await db.memoryEdges.put(edge);
            }
          }
        }
      }

      return { newAffinity, newNodes: createdNodes };
    } catch {
      // fallback to regex extraction or heuristic
      const deltaM = rawResponse.match(/"affinityDelta"\s*:\s*(-?\d+)/);
      if (deltaM) {
        const delta = parseInt(deltaM[1], 10);
        if (!isNaN(delta)) {
          const newAffinity = Math.max(-100, Math.min(100, currentAffinity + delta));
          return { newAffinity, newNodes: [] };
        }
      }
    }
  }

  // Enhanced conversational sentiment & bond progression check
  let delta = 0;
  const lower = (userText + ' ' + botText).toLowerCase();
  
  // Positive cues
  const positiveWords = [
    'спасибо', 'благодар', 'нравиш', 'любл', 'обня', 'поцелу', 'друг', 'помогу', 'помощь',
    'вместе', 'милая', 'красив', 'умн', 'верен', 'доверя', 'береги', 'рад', 'улыб', 'смея',
    'защищ', 'рядом', 'thank', 'love', 'care', 'friend', 'help', 'trust', 'kiss', 'smile',
    'together', 'protect', 'sweet', 'cute', 'glad', 'warm'
  ];
  // Negative cues
  const negativeWords = [
    'ненавижу', 'убить', 'предател', 'мразь', 'урод', 'дурак', 'исчезни', 'пошел вон',
    'лжец', 'враг', 'удар', 'выстрел', 'угрож', 'hate', 'kill', 'traitor', 'fool', 'disappear',
    'enemy', 'liar', 'strike', 'threat', 'stupid', 'leave'
  ];

  let posCount = 0;
  for (const w of positiveWords) {
    if (lower.includes(w)) posCount++;
  }
  let negCount = 0;
  for (const w of negativeWords) {
    if (lower.includes(w)) negCount++;
  }

  if (posCount > negCount) {
    delta = Math.min(6, 1 + posCount);
  } else if (negCount > posCount) {
    delta = -Math.min(8, 2 + negCount * 2);
  } else if (userText.trim().length > 15) {
    // Regular conversational bonding: small positive progress from active engagement
    delta = 1;
  }

  const newAffinity = Math.max(-100, Math.min(100, currentAffinity + delta));

  // Create an automatic node for dialogue progression
  const node: MemoryNode = {
    id: 'node-' + Math.random().toString(36).substring(2, 10),
    chatId,
    label: userText.slice(0, 24) + '...',
    type: delta !== 0 ? 'relationship' : 'event',
    detail: `User said: "${userText.slice(0, 80)}" | Character responded: "${botText.slice(0, 80)}"`,
    createdAt: Date.now(),
  };
  await db.memoryNodes.put(node);

  const existingNodes = await db.memoryNodes.where('chatId').equals(chatId).toArray();
  if (existingNodes.length > 1) {
    const prev = existingNodes[existingNodes.length - 2];
    const edge: MemoryEdge = {
      id: 'edge-' + Math.random().toString(36).substring(2, 10),
      chatId,
      source: prev.id,
      target: node.id,
      label: 'relates to',
    };
    await db.memoryEdges.put(edge);
  }

  return { newAffinity, newNodes: [node] };
}
