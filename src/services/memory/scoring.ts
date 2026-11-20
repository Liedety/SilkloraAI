import type { MemoryEdge, MemoryNode } from '../../types/index.ts';

/**
 * Normalizes a string for deduplication (trims, lowercases, removes trailing punctuation).
 */
export function normalizeLabel(s: string): string {
  return s
    .trim()
    .toLowerCase()
    .replace(/[\s.,!?:;…]+$/, '')
    .trim();
}

/** Identify legacy heuristic fallback nodes that store raw verbatim dialogue quotes. */
export function isRawDialogueFallbackNode(node: Pick<MemoryNode, 'label' | 'detail'>): boolean {
  const detail = node.detail || '';
  return (
    detail.startsWith('User said:') ||
    detail.startsWith('Пользователь:') ||
    detail.includes(' | Персонаж: ') ||
    detail.includes(' | Character responded: ') ||
    (node.label || '').endsWith('...')
  );
}

const HIGH_VALUE_MARKERS_RE =
  /(?:тайн|секрет|клятв|обеща|признан|признал|правд|ложь|обман|предател|союз|договор|сделк|смерт|убий|погиб|гибел|спас|кров|шрам|ранен|оружи|артефакт|ключ|медальон|письм|дневник|прошл|биограф|семь|брат|сестр|отец|мать|родител|детств|долг|проклят|враг|любл|влюбл|поцелу|ненави|боитс|страх|цель|мисси|задани|план|улик|координат|парол|адрес|перееха|прибыл|покинул|сбежа|secret|promise|swear|oath|confess|truth|betray|alliance|pact|deal|death|murder|killed|saved|scar|wound|weapon|artifact|key|locket|letter|diary|past|backstory|family|brother|sister|father|mother|debt|curse|enemy|love|kiss|hate|fear|phobia|mission|quest|password|clue|arrived|escaped)/iu;

const TRIVIAL_LABEL_EXACT_RE =
  /^(?:рост доверия|обострение конфликта|обычный разговор|т[её]плый разговор|спокойный разговор|приятная беседа|дружеская беседа|разговор у окна|разговор у камина|приветствие|начало разговора|повседневное действие|короткий обмен|обмен репликами|growing trust|rising tension|casual chat|casual conversation|warm conversation|small talk|greeting|routine action|brief exchange)$/iu;

const ROUTINE_PHYSICAL_ACTION_RE =
  /(?:^|\s)(?:сел[аио]?|садится|сидел[аио]?|сидит|присел\p{L}*|встал[аио]?|вста[её]т|стоял[аио]?|стоит|поднял(?:ся|ась|ись)|подош[её]?л\p{L}*|отош[её]?л\p{L}*|вош[её]?л\p{L}*|выш[её]?л\p{L}*|приш[её]?л\p{L}*|уш[её]?л\p{L}*|заш[её]?л\p{L}*|лег[лаи]?|легл[аи]|ложится|лежал\p{L}*|налил\p{L}*|отпил\p{L}*|выпил\p{L}*|пил[аио]?|пь[её]т|взял\p{L}*|бер[её]т|положил\p{L}*|поставил\p{L}*|над[еи]л\p{L}*|накинул\p{L}*|снял\p{L}*|поправил\p{L}*|кивнул\p{L}*|кивал\p{L}*|вздохнул\p{L}*|вздыхал\p{L}*|улыбнул\p{L}*|улыбал\p{L}*|усмехнул\p{L}*|рассмеял\p{L}*|засмеял\p{L}*|смеял\p{L}*|нахмурил\p{L}*|посмотрел\p{L}*|смотрел\p{L}*|взглянул\p{L}*|глядел\p{L}*|отвернул\p{L}*|обернул\p{L}*|шагнул\p{L}*|протянул\p{L}*|облокотил\p{L}*|прислонил\p{L}*|скрестил\p{L}*|коснул\p{L}*|прикоснул\p{L}*|пров[её]?л\p{L}*\s+рукой|поговорил\p{L}*|поболтал\p{L}*|беседовал\p{L}*|разговаривал\p{L}*|sits?\s+down|sat\s+down|sitting|stands?\s+up|stood\s+(?:up|by|near)|walked\s+(?:over|in|out|up)|stepped\s+closer|picked\s+up|put\s+(?:on|down)|took\s+a\s+sip|poured\s+(?:tea|coffee|water|wine)|nodded|sighed|smiled|laughed|chuckled|frowned|glanced|looked\s+at|leaned\s+against|crossed\s+arms|chatted|made\s+small\s+talk)(?=$|[^\p{L}])/iu;

const MUNDANE_BANTER_RE =
  /(?:разговор\p{L}*\s+(?:о\s+погоде|о\s+пустяк|ни\s+о\s+ч[её]м|за\s+чаем|за\s+кофе|у\s+окна|у\s+камина)|обсудил\p{L}*\s+(?:погод|чай|кофе|еду|настроени)|просто\s+(?:поговорил|поболтал|посидел|постоял)|talked\s+about\s+(?:the\s+weather|nothing|tea|coffee)|casual\s+banter|everyday\s+chat)/iu;

/**
 * Detects trivial everyday physical gestures, postures, or generic filler labels
 * that should NOT pollute long-term plot memory (`db.memoryNodes`).
 */
export function isTrivialActionNode(node: Pick<MemoryNode, 'label' | 'detail'> & { type?: MemoryNode['type']; isPinned?: boolean }): boolean {
  if (node.isPinned) return false;
  const label = (node.label || '').trim();
  const detail = (node.detail || '').trim();
  if (!label || !detail) return true;
  if (isRawDialogueFallbackNode(node)) return true;

  const normLabel = normalizeLabel(label);
  if (TRIVIAL_LABEL_EXACT_RE.test(normLabel)) return true;

  const combined = `${label} ${detail}`;
  if (HIGH_VALUE_MARKERS_RE.test(combined)) {
    return false;
  }

  if (MUNDANE_BANTER_RE.test(combined)) {
    return true;
  }

  // Labels starting directly with a routine verb or action sentence fragment (masculine/feminine/plural)
  if (/^(?:он|она|они|\p{Lu}\p{Ll}+)?\s*(?:медленно\s+|тихо\s+|молча\s+|слегка\s+|спокойно\s+)?(?:сел|садит|сидел|встал|стоял|подош|отош|вош|выш|приш|уш|взял|протянул|налил|отпил|выпил|надел|снял|накинул|поправил|кивнул|вздохнул|посмотрел|смотрел|взглянул|улыбнул|усмехнул|рассмеял|засмеял|нахмурил|облокотил|прислонил|коснул|прикоснул)/iu.test(label)) {
    return true;
  }

  // If the entire detail is just a routine physical gesture/movement/chat without plot stakes
  if (ROUTINE_PHYSICAL_ACTION_RE.test(combined) && detail.length < 160 && node.type !== 'secret') {
    return true;
  }

  return false;
}

/**
 * Calculates priority score for a memory node.
 * Higher score = more important, less likely to be pruned.
 * Pinned nodes return Infinity (never pruned).
 */
export function calculateNodeScore(
  node: MemoryNode,
  degree: number = 0,
  minTime: number = 0,
  maxTime: number = 0
): number {
  if (node.isPinned) return Infinity;

  let typeScore = 10;
  switch (node.type) {
    case 'secret':
      typeScore = 35;
      break;
    case 'relationship':
      typeScore = 30;
      break;
    case 'fact':
      typeScore = 25;
      break;
    case 'location':
      typeScore = 20;
      break;
    case 'event':
      typeScore = 10;
      break;
  }

  const degreeBonus = degree * 5;

  let recencyBonus = 10;
  if (maxTime > minTime) {
    recencyBonus = Math.round(((node.createdAt - minTime) / (maxTime - minTime)) * 20);
  }

  const detailPenalty = isRawDialogueFallbackNode(node) ? 20 : isTrivialActionNode(node) ? 25 : 0;

  return typeScore + degreeBonus + recencyBonus - detailPenalty;
}

/**
 * Finds groups of duplicate memory nodes based on normalized label.
 */
export function findDuplicateNodes(nodes: MemoryNode[]): { survivor: MemoryNode; duplicates: MemoryNode[] }[] {
  const groups: Record<string, MemoryNode[]> = {};

  for (const node of nodes) {
    const key = normalizeLabel(node.label);
    if (!groups[key]) groups[key] = [];
    groups[key].push(node);
  }

  const results: { survivor: MemoryNode; duplicates: MemoryNode[] }[] = [];

  for (const group of Object.values(groups)) {
    if (group.length > 1) {
      const sorted = [...group].sort((a, b) => {
        if (a.isPinned && !b.isPinned) return -1;
        if (!a.isPinned && b.isPinned) return 1;
        if (b.detail.length !== a.detail.length) return b.detail.length - a.detail.length;
        return b.createdAt - a.createdAt;
      });

      results.push({ survivor: sorted[0], duplicates: sorted.slice(1) });
    }
  }

  return results;
}

/**
 * Pure function: Selects lowest priority unpinned nodes to prune when total nodes exceed maxNodes.
 */
export function selectNodesToPrune(
  nodes: MemoryNode[],
  edges: MemoryEdge[] = [],
  maxNodes: number = 16
): MemoryNode[] {
  if (nodes.length <= maxNodes) return [];

  const degrees: Record<string, number> = {};
  for (const edge of edges) {
    degrees[edge.source] = (degrees[edge.source] || 0) + 1;
    degrees[edge.target] = (degrees[edge.target] || 0) + 1;
  }

  let minTime = Infinity;
  let maxTime = -Infinity;
  for (const n of nodes) {
    if (n.createdAt < minTime) minTime = n.createdAt;
    if (n.createdAt > maxTime) maxTime = n.createdAt;
  }

  const unpinned = nodes.filter((n) => !n.isPinned);
  const excess = nodes.length - maxNodes;

  if (excess <= 0 || unpinned.length === 0) return [];

  const sorted = [...unpinned].sort((a, b) => {
    const scoreA = calculateNodeScore(a, degrees[a.id] || 0, minTime, maxTime);
    const scoreB = calculateNodeScore(b, degrees[b.id] || 0, minTime, maxTime);
    return scoreA - scoreB;
  });

  return sorted.slice(0, Math.min(excess, unpinned.length));
}

/**
 * Pure transitive edge-bridging removal: removes `removeIds` one node at a time
 * so multi-node pruning (`A -> B -> C -> D` removing `B, C`) ALWAYS preserves `A -> D`
 * instead of severing the graph into isolated islands.
 */
export function bridgeAndRemoveNodes(
  nodes: MemoryNode[],
  edges: MemoryEdge[],
  removeIds: Iterable<string>,
  chatId: string
): { nodes: MemoryNode[]; edges: MemoryEdge[] } {
  const toRemove = new Set(removeIds);
  if (toRemove.size === 0) {
    return { nodes: [...nodes], edges: [...edges] };
  }

  let workingEdges = edges.map((e) => ({ ...e }));

  for (const remId of toRemove) {
    const incoming = workingEdges.filter((e) => e.target === remId);
    const outgoing = workingEdges.filter((e) => e.source === remId);

    for (const inc of incoming) {
      for (const out of outgoing) {
        if (inc.source === out.target) continue;
        const alreadyExists = workingEdges.some(
          (e) => e.source === inc.source && e.target === out.target
        );
        if (!alreadyExists) {
          workingEdges.push({
            id: 'edge-' + Math.random().toString(36).substring(2, 10),
            chatId,
            source: inc.source,
            target: out.target,
            label: inc.label || out.label,
          });
        }
      }
    }

    workingEdges = workingEdges.filter((e) => e.source !== remId && e.target !== remId);
  }

  const survivingIds = new Set(nodes.filter((n) => !toRemove.has(n.id)).map((n) => n.id));
  const cleanEdges = workingEdges.filter(
    (e) => survivingIds.has(e.source) && survivingIds.has(e.target) && e.source !== e.target
  );

  return {
    nodes: nodes.filter((n) => !toRemove.has(n.id)),
    edges: cleanEdges,
  };
}

/**
 * Clones memory nodes & edges when branching/rolling back a chat session up to a cutoff set of messages,
 * remapping node IDs and message IDs while bridging any cut tail nodes cleanly.
 */
export function cloneMemoryGraphRecords(
  nodes: MemoryNode[],
  edges: MemoryEdge[],
  targetChatId: string,
  msgIdMap: Map<string, string>
): { nodes: MemoryNode[]; edges: MemoryEdge[] } {
  // Keep pinned nodes, nodes without a messageId, and nodes whose messageId is within the kept history
  const droppedIds = nodes
    .filter((n) => !n.isPinned && Boolean(n.messageId) && !msgIdMap.has(n.messageId!))
    .map((n) => n.id);

  const bridged = bridgeAndRemoveNodes(nodes, edges, droppedIds, targetChatId);
  const nodeIdMap = new Map<string, string>();

  const clonedNodes: MemoryNode[] = bridged.nodes.map((n) => {
    const newId = 'node-' + Math.random().toString(36).substring(2, 10);
    nodeIdMap.set(n.id, newId);
    return {
      ...n,
      id: newId,
      chatId: targetChatId,
      messageId: n.messageId ? msgIdMap.get(n.messageId) : undefined,
    };
  });

  const clonedEdges: MemoryEdge[] = [];
  for (const e of bridged.edges) {
    const src = nodeIdMap.get(e.source);
    const tgt = nodeIdMap.get(e.target);
    if (src && tgt && src !== tgt) {
      clonedEdges.push({
        ...e,
        id: 'edge-' + Math.random().toString(36).substring(2, 10),
        chatId: targetChatId,
        source: src,
        target: tgt,
      });
    }
  }

  return { nodes: clonedNodes, edges: clonedEdges };
}

const STOP_STEMS = new Set([
  'этот', 'этого', 'этом', 'была', 'были', 'было', 'быть', 'очень', 'когда', 'после',
  'перед', 'между', 'через', 'снова', 'только', 'сейчас', 'здесь', 'потом', 'сказал',
  'сказала', 'говорит', 'спросил', 'ответил', 'просто', 'может', 'тебя', 'меня', 'него',
  'неё', 'свои', 'свой', 'своей', 'который', 'которая', 'которые', 'персонаж', 'пользователь',
  'this', 'that', 'with', 'from', 'have', 'were', 'been', 'they', 'them', 'their',
  'what', 'when', 'where', 'which', 'while', 'about', 'after', 'before', 'again', 'just',
  'said', 'asked', 'replied', 'user', 'character',
]);

function extractSearchStems(text?: string): string[] {
  if (!text) return [];
  const words = text
    .toLowerCase()
    .replace(/ё/g, 'е')
    .match(/[\p{L}\p{N}]{4,}/gu);
  if (!words) return [];

  const stems = new Set<string>();
  for (const w of words) {
    if (STOP_STEMS.has(w)) continue;
    let stem = w
      .replace(/(?:ами|ями|ого|его|ому|ему|ыми|ими|ость|ости|ение|ения|ание|ания|ться|лась|лись|лось|ует|ют|ит|ат|ят|ой|ей|ую|юю|ом|ем|ах|ях|ов|ев|ий|ый|ая|яя|ое|ее)$/u, '')
      .replace(/(?:ing|ed|es|ly|tion|ment|ness|s)$/u, '');
    if (stem.length < 4) {
      stem = w.slice(0, Math.min(w.length, 5));
    }
    if (stem.length >= 4 && !STOP_STEMS.has(stem)) {
      stems.add(stem);
    }
  }
  return [...stems];
}

/**
 * Invisible backend retrieval: surfaces the most relevant long-term memories for the current turn
 * by combining pinned status, lexical stem overlap with `queryText`, 1-hop graph neighbors,
 * intrinsic narrative importance, and recent milestones — requiring zero manual UI interaction.
 */
export function selectRelevantMemories(
  nodes: MemoryNode[],
  options: {
    queryText?: string;
    edges?: MemoryEdge[];
    limit?: number;
  } = {}
): MemoryNode[] {
  const { queryText = '', edges = [], limit = 8 } = options;
  const clean = nodes.filter((n) => !isRawDialogueFallbackNode(n) && !isTrivialActionNode(n));
  if (clean.length <= limit) {
    return [...clean].sort((a, b) => {
      if (a.isPinned && !b.isPinned) return -1;
      if (!a.isPinned && b.isPinned) return 1;
      return a.createdAt - b.createdAt;
    });
  }

  const queryStems = extractSearchStems(queryText);
  const degrees: Record<string, number> = {};
  const neighbors: Record<string, Set<string>> = {};
  for (const e of edges) {
    degrees[e.source] = (degrees[e.source] || 0) + 1;
    degrees[e.target] = (degrees[e.target] || 0) + 1;
    if (!neighbors[e.source]) neighbors[e.source] = new Set();
    if (!neighbors[e.target]) neighbors[e.target] = new Set();
    neighbors[e.source].add(e.target);
    neighbors[e.target].add(e.source);
  }

  let minTime = Infinity;
  let maxTime = -Infinity;
  for (const n of clean) {
    if (n.createdAt < minTime) minTime = n.createdAt;
    if (n.createdAt > maxTime) maxTime = n.createdAt;
  }

  const directMatchHits: Record<string, number> = {};
  for (const n of clean) {
    if (queryStems.length === 0) {
      directMatchHits[n.id] = 0;
      continue;
    }
    const hay = `${n.label} ${n.detail}`.toLowerCase().replace(/ё/g, 'е');
    let hits = 0;
    for (const stem of queryStems) {
      if (hay.includes(stem)) hits++;
    }
    directMatchHits[n.id] = hits;
  }

  const scored = clean.map((n) => {
    if (n.isPinned) return { node: n, total: Infinity, hits: directMatchHits[n.id] || 0 };
    const base = calculateNodeScore(n, degrees[n.id] || 0, minTime, maxTime);
    const hits = directMatchHits[n.id] || 0;
    let neighborBonus = 0;
    for (const nbId of neighbors[n.id] || []) {
      if ((directMatchHits[nbId] || 0) > 0) {
        neighborBonus = 22;
        break;
      }
    }
    return {
      node: n,
      total: base + hits * 45 + neighborBonus,
      hits,
    };
  });

  const selectedIds = new Set<string>();
  const picked: MemoryNode[] = [];

  // 1. Always keep pinned core memories first
  for (const item of scored) {
    if (item.node.isPinned && picked.length < limit) {
      selectedIds.add(item.node.id);
      picked.push(item.node);
    }
  }

  // 2. Keep the single latest milestone so immediate continuity is never lost
  const newest = [...clean].sort((a, b) => b.createdAt - a.createdAt)[0];
  if (newest && !selectedIds.has(newest.id) && picked.length < limit) {
    selectedIds.add(newest.id);
    picked.push(newest);
  }

  // 3. Fill remaining slots by highest combined relevance + importance score
  const ranked = [...scored].sort((a, b) => b.total - a.total || b.node.createdAt - a.node.createdAt);
  for (const item of ranked) {
    if (picked.length >= limit) break;
    if (selectedIds.has(item.node.id)) continue;
    selectedIds.add(item.node.id);
    picked.push(item.node);
  }

  // Order pinned first, then chronological story order for natural LLM comprehension
  return picked.sort((a, b) => {
    if (a.isPinned && !b.isPinned) return -1;
    if (!a.isPinned && b.isPinned) return 1;
    return a.createdAt - b.createdAt;
  });
}
