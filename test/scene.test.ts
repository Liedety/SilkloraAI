import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  actorNamesMatch,
  parseSceneCommand,
  extractJsonObjectSafe,
  mergeSceneState,
  translateCameraAngleToEnglish,
  transliterateCyrillicToLatin,
  latestDialogueMessageId,
} from '../src/services/sceneState.ts';
import {
  buildScenePromptPlan,
  executeSceneGenerationPipeline,
  selectSceneCharacters,
} from '../src/services/sceneDirector.ts';
import { extractVisionAppearanceOutput } from '../src/services/ai/vision.ts';
import { buildSceneNote } from '../src/services/promptBuilder.ts';
import { parseCharacterCardJson, exportCharacterCardV2Json } from '../src/services/characterCard.ts';
import {
  bridgeAndRemoveNodes,
  cloneMemoryGraphRecords,
  isTrivialActionNode,
  selectRelevantMemories,
} from '../src/services/memory/scoring.ts';
import { isRasterImageDataUrl, normalizeSceneOutputImage } from '../src/utils/imageUtils.ts';
import { fontStack } from '../src/utils/fonts.ts';
import { translations } from '../src/i18n/index.ts';
import type { Character, ChatMessage, ChatSession, MemoryEdge, MemoryNode, SceneState } from '../src/types/index.ts';

function makeChar(id: string, name: string, imageGen?: Character['imageGen'], avatar?: string): Character {
  return {
    id,
    name,
    description: `${name} character description`,
    scenario: '',
    exampleDialogue: '',
    greeting: '',
    greetingEnabled: false,
    emotions: [],
    avatar,
    imageGen,
    createdAt: 1000,
    updatedAt: 1000,
  };
}

test('parseSceneCommand handles EN/RU slash commands and ignores non-scene commands', () => {
  assert.deepEqual(parseSceneCommand('/scene'), {
    isSceneCommand: true,
    command: '/scene',
    perspective: '',
  });
  assert.deepEqual(parseSceneCommand('  /scene low angle over shoulder  '), {
    isSceneCommand: true,
    command: '/scene',
    perspective: 'low angle over shoulder',
  });
  assert.deepEqual(parseSceneCommand('/сцена крупный план у камина'), {
    isSceneCommand: true,
    command: '/сцена',
    perspective: 'крупный план у камина',
  });
  assert.deepEqual(parseSceneCommand('/фото wide shot'), {
    isSceneCommand: true,
    command: '/фото',
    perspective: 'wide shot',
  });
  assert.deepEqual(parseSceneCommand('/кадр со спины'), {
    isSceneCommand: true,
    command: '/кадр',
    perspective: 'со спины',
  });
  assert.equal(parseSceneCommand('/continue').isSceneCommand, false);
  assert.equal(parseSceneCommand('just normal text /scene inside').isSceneCommand, false);
});

test('extractJsonObjectSafe unwraps thought blocks and fenced JSON cleanly', () => {
  const raw = `<thought>analyzing lighting and outfit</thought>\n\`\`\`json\n{"locationChanged": false, "locationName": "Rainy Alley", "lighting": "neon magenta"}\n\`\`\``;
  const parsed = extractJsonObjectSafe(raw);
  assert.ok(parsed);
  assert.equal(parsed?.locationName, 'Rainy Alley');
  assert.equal(parsed?.lighting, 'neon magenta');
  assert.equal(extractJsonObjectSafe('no json here'), null);
});

test('mergeSceneState locks visualAnchor across perspective changes until location changes or unlocks', () => {
  const anna = makeChar('char-1', 'Anna');
  const first = mergeSceneState(
    undefined,
    {
      locationChanged: true,
      locationName: 'Old Observatory',
      visualAnchor: 'domed brass observatory, tall arched glass windows overlooking snowy mountains, oak desk',
      lighting: 'soft amber lantern light',
      weatherOrAtmosphere: 'snowfall outside',
      actors: [
        {
          name: 'Anna',
          clothing: 'burgundy wool coat over dark sweater',
          poseOrAction: 'leaning over telescope',
          expression: 'focused',
          positionInScene: 'left of brass telescope',
        },
      ],
      props: ['brass telescope', 'parchment map'],
      cameraFraming: 'medium wide shot',
    },
    [anna],
    'medium wide shot',
    1000
  );

  assert.equal(first.location.locked, true);
  assert.equal(first.location.locationId, 'loc_1000');
  assert.match(first.location.visualAnchor, /domed brass observatory/);

  // Re-framing / new angle with slightly altered LLM visualAnchor wording must preserve locked background anchor
  const second = mergeSceneState(
    first,
    {
      locationChanged: false,
      locationName: 'Observatory Room',
      visualAnchor: 'totally drifted wooden hut in summer forest',
      lighting: 'warm golden rim light',
      actors: [
        {
          name: 'Anna',
          clothing: 'burgundy wool coat over dark sweater',
          poseOrAction: 'looking back over shoulder at viewer',
          expression: 'soft smile',
          positionInScene: 'center frame',
        },
      ],
      cameraFraming: 'close-up over shoulder',
    },
    [anna],
    'close-up over shoulder',
    2000
  );

  assert.equal(second.location.locationId, 'loc_1000');
  assert.equal(second.location.locationName, 'Old Observatory');
  assert.equal(second.location.visualAnchor, first.location.visualAnchor);
  assert.equal(second.location.lighting, 'warm golden rim light');
  assert.equal(second.actors[0]?.poseOrAction, 'looking back over shoulder at viewer');
  assert.equal(second.lastCameraAngle, 'close-up over shoulder');

  // Explicit move to a new place rotates the anchor cleanly
  const moved = mergeSceneState(
    second,
    {
      locationChanged: true,
      locationName: 'Harbor Pier',
      visualAnchor: 'wet cobblestone harbor pier at dusk with anchored wooden boats',
      lighting: 'cold harbor fog lamps',
    },
    [anna],
    'wide shot',
    3000
  );

  assert.equal(moved.location.locationId, 'loc_3000');
  assert.equal(moved.location.locationName, 'Harbor Pier');
  assert.match(moved.location.visualAnchor, /cobblestone harbor pier/);
});

test('buildScenePromptPlan merges Option A refs and Option B LoRAs uniformly', () => {
  const refChar = makeChar('c-ref', 'Elena', {
    enabled: true,
    mode: 'reference',
    referenceImages: ['data:image/jpeg;base64,AAA', 'data:image/jpeg;base64,BBB'],
    appearancePrompt: 'raven wavy hair, green eyes, silver earrings',
    styleHint: 'cinematic 35mm photography',
  });
  const loraChar = makeChar('c-lora', 'Viktor', {
    enabled: true,
    mode: 'lora',
    referenceImages: [],
    appearancePrompt: 'tall, sharp jawline, scar near brow',
    loraName: 'viktor_v1.safetensors',
    loraTrigger: 'vk_man',
    loraWeight: 0.78,
  });

  const sceneState: SceneState = {
    location: {
      locationId: 'loc_1',
      locationName: 'Jazz Lounge',
      visualAnchor: 'dimly lit jazz lounge, red velvet booths, brass lamps',
      lighting: 'warm tungsten spotlight',
      locked: true,
    },
    actors: [
      {
        characterId: 'c-ref',
        name: 'Elena',
        clothing: 'emerald silk dress',
        poseOrAction: 'holding crystal glass at table',
        expression: 'mysterious half-smile',
      },
      {
        characterId: 'c-lora',
        name: 'Viktor',
        clothing: 'charcoal overcoat',
        poseOrAction: 'leaning against booth divider',
        expression: 'watchful gaze',
      },
    ],
    props: ['crystal glass', 'vintage microphone in background'],
    lastCameraAngle: 'low angle two-shot',
    updatedAt: 5000,
  };

  const plan = buildScenePromptPlan({
    analysis: {
      sceneState,
      cameraFraming: 'low angle two-shot',
      compositionPrompt: 'Elena seated left, Viktor standing right',
    },
    characters: [refChar, loraChar],
    perspective: 'low angle two-shot',
  });

  assert.deepEqual(plan.references, ['data:image/jpeg;base64,AAA', 'data:image/jpeg;base64,BBB']);
  assert.deepEqual(plan.loras, [{ filename: 'viktor_v1.safetensors', weight: 0.78, trigger_word: 'vk_man' }]);
  assert.match(plan.prompt, /vk_man/);
  assert.match(plan.prompt, /raven wavy hair/);
  assert.match(plan.prompt, /emerald silk dress/);
  assert.match(plan.prompt, /consistent setting: dimly lit jazz lounge/);
  assert.match(plan.prompt, /cinematic 35mm photography/);
});

test('buildScenePromptPlan falls back to character data-URL avatar in reference mode when refs list is empty', () => {
  const ch = makeChar(
    'c-av',
    'Mira',
    {
      enabled: true,
      mode: 'reference',
      referenceImages: [],
      appearancePrompt: 'copper braid',
    },
    'data:image/jpeg;base64,AVATAR123'
  );
  const sceneState: SceneState = {
    location: {
      locationId: 'loc_x',
      locationName: 'Garden',
      visualAnchor: 'stone greenhouse filled with ferns',
      lighting: 'soft morning mist',
      locked: true,
    },
    actors: [],
    props: [],
    updatedAt: 1,
  };
  const plan = buildScenePromptPlan({
    analysis: { sceneState, cameraFraming: 'portrait', compositionPrompt: 'Mira tending ferns' },
    characters: [ch],
  });
  assert.deepEqual(plan.references, ['data:image/jpeg;base64,AVATAR123']);
});

test('buildSceneNote injects active sceneState cleanly in Russian and English', () => {
  const sceneState: SceneState = {
    location: {
      locationId: 'loc_9',
      locationName: 'Library',
      visualAnchor: 'tall mahogany bookshelves',
      lighting: 'candlelight',
      locked: true,
    },
    actors: [{ characterId: 'c1', name: 'Nora', clothing: 'blue cloak', poseOrAction: 'reading ledger' }],
    props: ['ledger'],
    updatedAt: 9,
  };
  const ruNote = buildSceneNote({
    speakerName: 'Nora',
    userName: 'Alex',
    language: 'ru',
    sceneState,
  });
  const enNote = buildSceneNote({
    speakerName: 'Nora',
    userName: 'Alex',
    language: 'en',
    sceneState,
  });
  assert.match(ruNote, /Library/);
  assert.match(ruNote, /blue cloak/);
  assert.match(enNote, /Current physical setting: Library/);
  assert.match(enNote, /candlelight/);
});

test('characterCard preserves imageGen Option A/B config across V2 JSON round-trip', () => {
  const ch = makeChar('c-rt', 'Kira', {
    enabled: true,
    mode: 'lora',
    referenceImages: ['data:image/jpeg;base64,SMALL'],
    appearancePrompt: 'short white hair, scarred cheek',
    styleHint: 'painterly dark fantasy',
    loraName: 'kira_sdxl.safetensors',
    loraTrigger: 'kira_char',
    loraWeight: 0.9,
  });
  const json = exportCharacterCardV2Json(ch);
  const parsed = parseCharacterCardJson(json);
  assert.equal(parsed.name, 'Kira');
  assert.deepEqual(parsed.imageGen, ch.imageGen);
});

test('translations en and ru contain zero emojis and share identical keys', () => {
  const enKeys = Object.keys(translations.en).sort();
  const ruKeys = Object.keys(translations.ru).sort();
  assert.deepEqual(enKeys, ruKeys);

  const emojiRegex = /\p{Extended_Pictographic}/u;
  for (const [key, val] of Object.entries(translations.en)) {
    assert.equal(emojiRegex.test(val), false, `EN i18n key ${key} contains emoji`);
  }
  for (const [key, val] of Object.entries(translations.ru)) {
    assert.equal(emojiRegex.test(val), false, `RU i18n key ${key} contains emoji`);
  }
});

test('extractVisionAppearanceOutput strips reasoning blocks and rejects empty output cleanly', () => {
  const withThought =
    '<|channel>thought Analyzing face and hair color.<channel|>\n"silver wavy hair, amber eyes, black coat"';
  assert.equal(extractVisionAppearanceOutput(withThought), 'silver wavy hair, amber eyes, black coat');

  const withThink = '<think>Checking lighting...</think>\n```text\nshort black bob, green eyes, freckles\n```';
  assert.equal(extractVisionAppearanceOutput(withThink), 'short black bob, green eyes, freckles');

  assert.throws(() => extractVisionAppearanceOutput('   '), /empty text/i);
  assert.throws(() => extractVisionAppearanceOutput('<thought>still thinking forever'), /internal reasoning/i);
});

test('selectSceneCharacters filters group chat members strictly by imageGen.enabled and excludes user persona', () => {
  const c1 = makeChar('c1', 'Aria', { enabled: true, mode: 'reference' });
  const c2 = makeChar('c2', 'Bram', { enabled: false, mode: 'reference' });
  const c3 = makeChar('c3', 'Nyx', { enabled: true, mode: 'lora', loraName: 'nyx.safetensors' });
  const userPersona = makeChar('p1', 'Hero', { enabled: true, mode: 'reference' });

  const picked = selectSceneCharacters({
    chatType: 'group',
    group: { characterIds: ['c1', 'c2', 'c3', 'p1'] },
    allCharacters: [c1, c2, c3, userPersona],
    personaId: 'p1',
  });
  assert.deepEqual(
    picked.map((c) => c.id),
    ['c1', 'c3']
  );

  const noneEnabled = selectSceneCharacters({
    chatType: 'group',
    group: { characterIds: ['c2'] },
    allCharacters: [c1, c2],
  });
  assert.equal(noneEnabled.length, 0);
});

test('isRasterImageDataUrl and buildScenePromptPlan strictly reject SVG placeholder avatars in reference mode', () => {
  const defaultSvgAvatar = "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg'><rect width='64' height='64'/></svg>";
  const encodedSvg = 'data:image/png;base64,' + Buffer.from('<svg width="10"></svg>').toString('base64');
  assert.equal(isRasterImageDataUrl(defaultSvgAvatar), false);
  assert.equal(isRasterImageDataUrl(encodedSvg), false);
  assert.equal(isRasterImageDataUrl('data:image/jpeg;base64,/9j/4AAQSkZJRg=='), true);
  assert.equal(isRasterImageDataUrl('data:image/webp;base64,UklGRh4AAABXRUJQ'), true);

  const chSvg = makeChar(
    'c-svg',
    'Evelyn',
    { enabled: true, mode: 'reference', referenceImages: [defaultSvgAvatar], appearancePrompt: 'silver hair' },
    defaultSvgAvatar
  );
  const sceneState: SceneState = {
    location: { locationId: 'l1', locationName: 'Study', visualAnchor: 'oak desk and rainy window', lighting: 'warm lamp', locked: true },
    actors: [],
    props: [],
    updatedAt: 1,
  };
  const plan = buildScenePromptPlan({
    analysis: { sceneState, cameraFraming: 'close-up portrait', compositionPrompt: 'Evelyn looking out window' },
    characters: [chSvg],
  });
  assert.deepEqual(plan.references, [], 'SVG avatars must never be passed as raster reference images');
  assert.match(plan.prompt, /silver hair/);
});

test('translateCameraAngleToEnglish translates Russian angle presets and executeSceneGenerationPipeline avoids LLM swap on warm angle change', async () => {
  assert.match(translateCameraAngleToEnglish('крупный план'), /close-up portrait/i);
  assert.match(translateCameraAngleToEnglish('со спины'), /from behind/i);
  assert.match(translateCameraAngleToEnglish('в полный рост'), /full-body/i);
  assert.match(translateCameraAngleToEnglish('от первого лица'), /first-person POV/i);

  const msgs: ChatMessage[] = [
    {
      id: 'm1',
      chatId: 's1',
      senderId: 'user',
      senderName: 'Alex',
      variants: [{ text: 'Подойди к окну.', timestamp: 100 }],
      activeVariantIndex: 0,
      createdAt: 100,
    },
    {
      id: 'm2',
      chatId: 's1',
      senderId: 'c1',
      senderName: 'Lyra',
      variants: [{ text: '*Она останавливается у высокого окна.*', timestamp: 200 }],
      activeVariantIndex: 0,
      createdAt: 200,
    },
  ];
  assert.equal(latestDialogueMessageId(msgs), 'm2');

  const session: ChatSession = {
    id: 's1',
    title: 'Test',
    type: 'character',
    targetId: 'c1',
    thoughtsEnabled: false,
    relationships: {},
    sceneState: {
      location: {
        locationId: 'loc_1',
        locationName: 'Attic Studio',
        visualAnchor: 'wooden attic studio with skylights and easel',
        lighting: 'golden sunset rays',
        locked: true,
      },
      actors: [{ characterId: 'c1', name: 'Lyra', clothing: 'linen shirt', poseOrAction: 'standing by window', expression: 'calm' }],
      props: ['paintbrush'],
      lastCameraAngle: 'medium shot',
      lastCompositionPrompt: 'Lyra standing near the skylight holding a paintbrush',
      lastAnalyzedMsgId: 'm2',
      updatedAt: 250,
    },
    createdAt: 1,
    updatedAt: 250,
  };

  const calledUrls: string[] = [];
  const origFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    calledUrls.push(url);
    if (url.endsWith('/v1/images/scene')) {
      return new Response(JSON.stringify({ ok: true, job_id: 'job_warm_1' }), { status: 200 });
    }
    if (url.includes('/v1/images/jobs/job_warm_1')) {
      return new Response(
        JSON.stringify({
          status: 'done',
          stage: 'done',
          progress: 100,
          result: { image_base64: 'data:image/png;base64,iVBORw0KGgo=', width: 768, height: 1024, seed: 77, model_used: 'warm-model.gguf' },
        }),
        { status: 200 }
      );
    }
    throw new Error(`Unexpected fetch URL: ${url}`);
  }) as typeof fetch;

  try {
    const res = await executeSceneGenerationPipeline({
      session,
      messages: msgs,
      characters: [makeChar('c1', 'Lyra', { enabled: true, mode: 'reference', appearancePrompt: 'emerald eyes' })],
      perspective: 'крупный план',
      settings: {
        id: 'default',
        language: 'ru',
        aiEngineMode: 'local',
        localHubUrl: 'http://127.0.0.1:8080/v1',
        aiRouting: { sceneAnalysis: 'local', sceneImage: 'local' },
      } as any,
      skipAnalysis: false,
    });

    // Must NOT hit /v1/chat/completions when changing angle on the already-analyzed dialogue turn!
    assert.equal(calledUrls.some((u) => u.includes('/chat/completions')), false);
    assert.match(res.assetDraft.prompt, /close-up portrait/i);
    assert.match(res.assetDraft.prompt, /wooden attic studio with skylights and easel/);
    assert.match(res.assetDraft.prompt, /wearing linen shirt/);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('memory overhaul: filters routine gestures, bridges multi-node pruning chains, clones on rollback, and recalls older relevant facts', () => {
  // 1. Trivial routine actions rejected, real plot milestones kept
  assert.equal(isTrivialActionNode({ label: 'Она медленно села на', detail: 'Она медленно села на диван и поправила волосы.' }), true);
  assert.equal(isTrivialActionNode({ label: 'Чаепитие', detail: 'Персонаж подошёл к столу, взял кружку и отпил чай.' }), true);
  assert.equal(isTrivialActionNode({ label: 'Рост доверия', detail: 'Персонажи стали ближе в ходе сцены.' }), true);
  assert.equal(
    isTrivialActionNode({
      label: 'Тайна серебряного медальона',
      detail: 'Лира призналась, что внутри медальона спрятан шифр от Северной башни.',
      type: 'secret',
    }),
    false
  );

  // 2. Sequential transitive bridging: A -> B -> C -> D -> E removing [B, C, D] preserves A -> E!
  const chainNodes: MemoryNode[] = ['A', 'B', 'C', 'D', 'E'].map((id, i) => ({
    id,
    chatId: 'c1',
    label: `Milestone ${id}`,
    type: 'secret',
    detail: `Important secret ${id}`,
    createdAt: 100 + i * 10,
  }));
  const chainEdges: MemoryEdge[] = [
    { id: 'e1', chatId: 'c1', source: 'A', target: 'B', label: 'leads to' },
    { id: 'e2', chatId: 'c1', source: 'B', target: 'C', label: 'leads to' },
    { id: 'e3', chatId: 'c1', source: 'C', target: 'D', label: 'leads to' },
    { id: 'e4', chatId: 'c1', source: 'D', target: 'E', label: 'leads to' },
  ];
  const bridged = bridgeAndRemoveNodes(chainNodes, chainEdges, ['B', 'C', 'D'], 'c1');
  assert.deepEqual(bridged.nodes.map((n) => n.id), ['A', 'E']);
  assert.equal(bridged.edges.length, 1);
  assert.equal(bridged.edges[0].source, 'A');
  assert.equal(bridged.edges[0].target, 'E');

  // 3. Rollback graph cloning preserves kept memories and remaps message IDs cleanly
  const rbNodes: MemoryNode[] = [
    { id: 'n1', chatId: 'orig', messageId: 'm1', label: 'Клятва у ворот', type: 'relationship', detail: 'Поклялись защищать друг друга.', createdAt: 10 },
    { id: 'n2', chatId: 'orig', messageId: 'm2', label: 'Секрет брата', type: 'secret', detail: 'Брат скрывается в порту.', createdAt: 20 },
    { id: 'n3', chatId: 'orig', messageId: 'm3', label: 'Предательство стражи', type: 'event', detail: 'Стража открыла огонь.', createdAt: 30 },
  ];
  const rbEdges: MemoryEdge[] = [
    { id: 're1', chatId: 'orig', source: 'n1', target: 'n2' },
    { id: 're2', chatId: 'orig', source: 'n2', target: 'n3' },
  ];
  const msgMap = new Map([
    ['m1', 'fork_m1'],
    ['m2', 'fork_m2'],
  ]);
  const cloned = cloneMemoryGraphRecords(rbNodes, rbEdges, 'fork_chat', msgMap);
  assert.equal(cloned.nodes.length, 2);
  assert.equal(cloned.edges.length, 1);
  assert.equal(cloned.nodes[0].chatId, 'fork_chat');
  assert.equal(cloned.nodes[0].messageId, 'fork_m1');
  assert.equal(cloned.nodes[1].messageId, 'fork_m2');
  assert.notEqual(cloned.nodes[0].id, 'n1');

  // 4. Invisible relevant memory recall surfaces turn-2 memory among 20 newer memories when mentioned!
  const manyNodes: MemoryNode[] = [
    {
      id: 'old-locket',
      chatId: 'c1',
      label: 'Серебряный медальон матери',
      type: 'secret',
      detail: 'Внутри серебряного медальона хранится код от Северной башни.',
      createdAt: 5,
    },
    {
      id: 'old-neighbor',
      chatId: 'c1',
      label: 'Страж Северной башни',
      type: 'fact',
      detail: 'Башню охраняет старый капитан Ворон.',
      createdAt: 6,
    },
    ...Array.from({ length: 16 }, (_, idx) => ({
      id: `later-${idx}`,
      chatId: 'c1',
      label: `Договор гильдии ${idx}`,
      type: 'fact' as const,
      detail: `Подписан торговый контракт с южным караваном номер ${idx}.`,
      createdAt: 100 + idx * 10,
    })),
  ];
  const manyEdges: MemoryEdge[] = [{ id: 'link1', chatId: 'c1', source: 'old-locket', target: 'old-neighbor' }];
  const recalled = selectRelevantMemories(manyNodes, {
    queryText: 'Ты помнишь, что спрятано внутри медальона?',
    edges: manyEdges,
    limit: 6,
  });
  assert.ok(recalled.some((n) => n.id === 'old-locket'), 'Turn-2 locket memory must be recalled when user asks about медальона');
  assert.ok(recalled.some((n) => n.id === 'old-neighbor'), '1-hop linked neighbor memory should also gain recall priority');

  const note = buildSceneNote({
    speakerName: 'Лира',
    userName: 'Алекс',
    language: 'ru',
    memoryNodes: manyNodes,
    memoryEdges: manyEdges,
    queryContext: 'Откроем медальон прямо сейчас?',
  });
  assert.match(note, /Серебряный медальон матери/);
});

test('proportional Cyrillic pixel font stack uses Tiny5 with unicode-range and zero-beta / zero-emoji UI invariants', () => {
  const px = fontStack('pixel');
  assert.match(px, /Tiny5/);
  assert.equal(px.includes('Pixelify Sans'), false, 'Pixelify Sans lacks Russian capital О/П and must not be used');
  assert.equal(px.includes('DotGothic16'), false, 'Fullwidth CJK DotGothic16 must not be used for Cyrillic pixel text');

  const mainSrc = fs.readFileSync(path.resolve('src/main.tsx'), 'utf-8');
  assert.match(mainSrc, /@fontsource\/tiny5\/index\.css/, 'main.tsx must import index.css with unicode-range');
  assert.equal(/pixelify-sans|dotgothic16/i.test(mainSrc), false);

  const tiny5Css = fs.readFileSync(path.resolve('node_modules/@fontsource/tiny5/index.css'), 'utf-8');
  assert.match(tiny5Css, /unicode-range:.*U\+0400-045F/i, 'Tiny5 CSS must include Cyrillic unicode-range');
  assert.equal(
    fs.existsSync(path.resolve('node_modules/@fontsource/tiny5/files/tiny5-cyrillic-400-normal.woff2')),
    true,
    'Tiny5 Cyrillic woff2 font file must exist'
  );

  const sceneHelpSrc = fs.readFileSync(path.resolve('src/components/SceneHelp.tsx'), 'utf-8');
  const emojiRegex = /\p{Extended_Pictographic}/u;
  assert.equal(emojiRegex.test(sceneHelpSrc), false, 'SceneHelp.tsx must contain zero emojis');
  assert.equal(/\bbeta\b/i.test(sceneHelpSrc), false, 'SceneHelp.tsx must not contain the word beta');
  assert.match(sceneHelpSrc, /createPortal/, 'SceneHelp modals must render via createPortal to avoid CSS transform clipping');
  assert.match(sceneHelpSrc, /loraTrigger/, 'SceneHelp must cover loraTrigger');
  assert.match(sceneHelpSrc, /loraStrength/, 'SceneHelp must cover loraStrength');

  const chatSettingsSrc = fs.readFileSync(path.resolve('src/views/ChatSettingsModal.tsx'), 'utf-8');
  assert.equal(/handlePruneMemories|Очистить лишнее/.test(chatSettingsSrc), false, 'Memory pruning must run automatically without manual UI buttons');

  for (const [k, v] of Object.entries(translations.ru)) {
    assert.equal(/\bbeta\b/i.test(v), false, `RU translation ${k} must not contain beta`);
  }
  for (const [k, v] of Object.entries(translations.en)) {
    assert.equal(/\bbeta\b/i.test(v), false, `EN translation ${k} must not contain beta`);
  }
});

test('regression: feminine Russian routine actions and banter are rejected while real plot turns survive', () => {
  assert.equal(
    isTrivialActionNode({ label: 'У окна', detail: 'Она подошла к окну и мягко улыбнулась.' }),
    true
  );
  assert.equal(
    isTrivialActionNode({ label: 'Чай в гостиной', detail: 'Ева налила горячий чай и села в кресло.' }),
    true
  );
  assert.equal(
    isTrivialActionNode({ label: 'Разговор у камина', detail: 'Тёплая беседа в уютной атмосфере комнаты.' }),
    true
  );
  assert.equal(
    isTrivialActionNode({ label: 'Лёгкий смех', detail: 'Девушка тихо рассмеялась и отвела взгляд.' }),
    true
  );
  assert.equal(
    isTrivialActionNode({
      label: 'Признание у окна',
      detail: 'Ева подошла к окну и раскрыла правду о гибели своего брата в Северной крепости.',
      type: 'secret',
    }),
    false
  );
});

test('regression: latestDialogueMessageId skips scene-director cards and translateCameraAngleToEnglish handles multi-part Russian framing cleanly', async () => {
  const msgs: ChatMessage[] = [
    {
      id: 'm1',
      chatId: 's1',
      senderId: 'c1',
      senderName: 'Lyra',
      variants: [{ text: 'Мы на крыше маяка.', timestamp: 10 }],
      activeVariantIndex: 0,
      createdAt: 10,
    },
    {
      id: 'm_scene_1',
      chatId: 's1',
      senderId: 'scene-director',
      senderName: 'Scene',
      variants: [{ text: 'Scene generation failed earlier', timestamp: 20 }],
      activeVariantIndex: 0,
      createdAt: 20,
    },
  ];
  assert.equal(latestDialogueMessageId(msgs), 'm1');

  const multiRu = translateCameraAngleToEnglish('крупный план, вполоборота у окна, боке');
  assert.match(multiRu, /close-up portrait/i);
  assert.match(multiRu, /three-quarter/i);
  assert.match(multiRu, /window/i);
  assert.match(multiRu, /bokeh/i);
  assert.equal(/[а-яА-ЯёЁ]/.test(multiRu), false, 'Translated angle must not leak raw Cyrillic tokens');

  const unknownRu = translateCameraAngleToEnglish('необычное русское примечание');
  assert.equal(/[а-яА-ЯёЁ]/.test(unknownRu), false, 'Pure Cyrillic fallback must not pass gibberish tokens to CLIP');
  assert.match(unknownRu, /cinematic medium shot/i);

  const { withChatMemoryLock } = await import('../src/services/memory/store.ts');
  const order: string[] = [];
  await Promise.all([
    withChatMemoryLock('chat-lock-1', async () => {
      order.push('a-start');
      await new Promise((r) => setTimeout(r, 25));
      order.push('a-end');
    }),
    withChatMemoryLock('chat-lock-1', async () => {
      order.push('b-start');
      order.push('b-end');
    }),
  ]);
  assert.deepEqual(order, ['a-start', 'a-end', 'b-start', 'b-end']);
});

test('userPersona appearancePrompt and optional visual refs apply when persona is in sceneState.actors and stay out of solo NPC shots', async () => {
  const npc = makeChar('npc-1', 'Лира', {
    enabled: true,
    mode: 'reference',
    referenceImages: ['data:image/jpeg;base64,/9j/NPC_REF'],
    appearancePrompt: 'silver hair, violet eyes',
  });
  const persona = makeChar('persona-1', 'Максим', {
    enabled: false,
    mode: 'reference',
    referenceImages: ['data:image/jpeg;base64,/9j/PERSONA_REF'],
    appearancePrompt: 'tall young man, short dark hair, rectangular glasses, grey scarf',
  });

  // 1) mergeSceneState preserves userPersona.id even for Cyrillic persona names
  const mergedWithPersona = mergeSceneState(
    undefined,
    {
      locationChanged: true,
      locationName: 'Winter Station',
      visualAnchor: 'snowy train platform under cast-iron canopy, warm station lamps',
      lighting: 'warm tungsten lamp glow in snowfall',
      actors: [
        { name: 'Лира', clothing: 'dark wool coat', poseOrAction: 'holding suitcase' },
        { name: 'Максим', clothing: 'black trenchcoat', poseOrAction: 'standing opposite Lyra' },
      ],
    },
    [npc],
    'two-shot',
    1000,
    'm1',
    persona
  );
  const personaActor = mergedWithPersona.actors.find((a) => a.characterId === 'persona-1');
  assert.ok(personaActor, 'mergeSceneState must map visible userPersona to persona.id');
  assert.equal(personaActor?.name, 'Максим');

  // 2) Even when persona.imageGen.enabled is false, persona.imageGen.appearancePrompt is injected when persona is in sceneState.actors
  const twoShotPlan = buildScenePromptPlan({
    analysis: {
      sceneState: mergedWithPersona,
      cameraFraming: 'medium two-shot',
      compositionPrompt: 'Lyra and Maxim facing each other on the snowy platform',
    },
    characters: [npc],
    userPersona: persona,
  });
  assert.match(twoShotPlan.prompt, /silver hair, violet eyes/);
  assert.match(twoShotPlan.prompt, /tall young man, short dark hair, rectangular glasses, grey scarf/);
  assert.match(twoShotPlan.prompt, /wearing black trenchcoat/);
  assert.deepEqual(twoShotPlan.references, ['data:image/jpeg;base64,/9j/NPC_REF']);

  // 3) If persona.imageGen.enabled is true in reference mode, persona raster ref is also appended after NPC ref
  const enabledPersona = makeChar('persona-1', 'Максим', {
    enabled: true,
    mode: 'reference',
    referenceImages: ['data:image/jpeg;base64,/9j/PERSONA_REF'],
    appearancePrompt: 'tall young man, short dark hair, rectangular glasses',
  });
  const twoShotWithPersonaRef = buildScenePromptPlan({
    analysis: {
      sceneState: mergedWithPersona,
      cameraFraming: 'medium two-shot',
      compositionPrompt: 'Lyra and Maxim on platform',
    },
    characters: [npc],
    userPersona: enabledPersona,
  });
  assert.deepEqual(twoShotWithPersonaRef.references, [
    'data:image/jpeg;base64,/9j/NPC_REF',
    'data:image/jpeg;base64,/9j/PERSONA_REF',
  ]);

  // 4) Solo NPC portrait (persona NOT in sceneState.actors): persona appearance & refs must NOT leak into solo NPC prompt
  const soloState = mergeSceneState(
    undefined,
    {
      locationChanged: true,
      locationName: 'Winter Station',
      visualAnchor: 'snowy train platform under cast-iron canopy',
      lighting: 'warm tungsten lamp glow',
      actors: [{ name: 'Лира', clothing: 'dark wool coat', poseOrAction: 'smiling at viewer' }],
    },
    [npc],
    'first-person POV',
    2000,
    'm2',
    enabledPersona
  );
  const soloPlan = buildScenePromptPlan({
    analysis: {
      sceneState: soloState,
      cameraFraming: 'first-person POV close-up',
      compositionPrompt: 'Lyra smiling under station lamp',
    },
    characters: [npc],
    userPersona: enabledPersona,
  });
  assert.equal(/rectangular glasses/.test(soloPlan.prompt), false, 'Persona appearance must not leak into solo NPC shot');
  assert.deepEqual(soloPlan.references, ['data:image/jpeg;base64,/9j/NPC_REF']);
});

test('regression: transliterated English LLM actor names match Cyrillic cards, preserve persona clothing across turns, and inject description appearance fallback without leaking Cyrillic', () => {
  assert.equal(actorNamesMatch('Максим', 'Maxim'), true);
  assert.equal(actorNamesMatch('Максим', 'Maksim'), true);
  assert.equal(actorNamesMatch('Лира', 'Lyra'), true);
  assert.equal(actorNamesMatch('Алекс', 'Alex'), true);
  assert.equal(actorNamesMatch('Виктор', 'Victor'), true);
  assert.equal(actorNamesMatch('Лира', 'Максим'), false);
  assert.equal(transliterateCyrillicToLatin('Максим'), 'Maksim');

  // Both NPC and Persona only have main card descriptions (appearancePrompt left empty)
  const npc: Character = {
    ...makeChar('npc-ru', 'Лира'),
    description: 'Девушка с пепельными волосами и янтарными глазами.',
    imageGen: { enabled: true, mode: 'reference', referenceImages: ['data:image/jpeg;base64,/9j/LIRA_REF'], appearancePrompt: '' },
  };
  const persona: Character = {
    ...makeChar('persona-ru', 'Максим'),
    description: 'Высокий брюнет со шрамом на левой брови.',
    imageGen: { enabled: true, mode: 'reference', referenceImages: ['data:image/jpeg;base64,/9j/MAX_REF'], appearancePrompt: '' },
  };

  // Turn 1: Scene Director outputs English transliterated names ("Lyra" & "Maxim") + synthesized English appearance
  const turn1 = mergeSceneState(
    undefined,
    {
      locationChanged: true,
      locationName: 'Rooftop Terrace',
      visualAnchor: 'stone rooftop terrace overlooking neon skyline at night',
      lighting: 'cool moonlight and warm string lights',
      actors: [
        {
          name: 'Lyra',
          appearance: 'young woman, ash-silver hair, amber eyes',
          clothing: 'burgundy leather jacket',
          poseOrAction: 'leaning on iron railing',
        },
        {
          name: 'Maxim',
          appearance: 'tall young man, dark hair, small scar on left eyebrow',
          clothing: 'charcoal wool coat',
          poseOrAction: 'standing beside Lyra',
        },
      ],
    },
    [npc],
    'medium two-shot',
    1000,
    'm1',
    persona
  );

  // Must NOT create duplicate extra_lyra actor; must have exactly 2 actors (npc-ru + persona-ru)
  assert.equal(turn1.actors.length, 2);
  assert.equal(turn1.actors[0]?.characterId, 'npc-ru');
  assert.equal(turn1.actors[1]?.characterId, 'persona-ru');

  // Turn 2: LLM updates poses and refers to persona as "Maxim" without repeating clothing/appearance
  const turn2 = mergeSceneState(
    turn1,
    {
      locationChanged: false,
      actors: [
        { name: 'Lyra', poseOrAction: 'turning toward Maxim' },
        { name: 'Maxim', poseOrAction: 'offering a warm cup of coffee' },
      ],
    },
    [npc],
    'over-the-shoulder two-shot',
    2000,
    'm2',
    persona
  );

  const pTurn2 = turn2.actors.find((a) => a.characterId === 'persona-ru');
  assert.equal(pTurn2?.clothing, 'charcoal wool coat', 'Persona clothing must persist across turns');
  assert.equal(pTurn2?.appearance, 'tall young man, dark hair, small scar on left eyebrow', 'Persona appearance must persist across turns');

  const plan = buildScenePromptPlan({
    analysis: {
      sceneState: turn2,
      cameraFraming: 'over-the-shoulder two-shot',
      compositionPrompt: 'Lyra and Maxim talking on the rooftop terrace',
    },
    characters: [npc],
    userPersona: persona,
  });

  assert.match(plan.prompt, /ash-silver hair, amber eyes/);
  assert.match(plan.prompt, /tall young man, dark hair, small scar on left eyebrow/);
  assert.match(plan.prompt, /wearing charcoal wool coat/);
  assert.equal(/[а-яА-ЯёЁ]/.test(plan.prompt), false, 'English CLIP/T5 prompt must not contain raw Cyrillic actor names');
  assert.deepEqual(plan.references, ['data:image/jpeg;base64,/9j/LIRA_REF', 'data:image/jpeg;base64,/9j/MAX_REF']);
});

test('regression: normalizeSceneOutputImage converts reachable LAN /v1/images/files URLs to data URLs and preserves HTTP URLs when fetch fails', async () => {
  const lanUrl = 'http://192.168.0.103:8080/v1/images/files/img_abc123.png';
  const origFetch = globalThis.fetch;

  try {
    // 1) Reachable LAN image URL converts cleanly into base64 raster data URL instead of empty string ""
    const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01, 0x02]);
    globalThis.fetch = (async () =>
      new Response(pngBytes, { status: 200, headers: { 'Content-Type': 'image/png' } })) as typeof fetch;
    const converted = await normalizeSceneOutputImage(lanUrl);
    assert.match(converted, /^data:image\/png;base64,/);

    // 2) CORS/offline failure preserves original HTTP URL instead of wiping to ""
    globalThis.fetch = (async () => {
      throw new Error('CORS blocked');
    }) as typeof fetch;
    const preserved = await normalizeSceneOutputImage('https://cdn.example.com/rendered_scene.png');
    assert.equal(preserved, 'https://cdn.example.com/rendered_scene.png');
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('unusual / non-human characters, diverse art styles, LoRA architecture compatibility, and SceneHelp LoRA education', async () => {
  const { isLoraCompatibleWithModelFamily } = await import('../src/services/ai/imageClient.ts');

  // 1) LoRA architecture compatibility matrix
  assert.equal(isLoraCompatibleWithModelFamily('sdxl', 'sdxl'), true);
  assert.equal(isLoraCompatibleWithModelFamily('illustrious', 'sdxl'), true);
  assert.equal(isLoraCompatibleWithModelFamily('pony', 'sdxl'), true);
  assert.equal(isLoraCompatibleWithModelFamily('flux', 'flux'), true);
  assert.equal(isLoraCompatibleWithModelFamily('flux', 'flux_kontext'), true);
  assert.equal(isLoraCompatibleWithModelFamily('chroma', 'chroma'), true);
  assert.equal(isLoraCompatibleWithModelFamily('kroma', 'chroma'), true);
  assert.equal(isLoraCompatibleWithModelFamily('qwen', 'qwen_image'), true);
  assert.equal(isLoraCompatibleWithModelFamily('qwen', 'qwen_edit'), true);
  assert.equal(isLoraCompatibleWithModelFamily('sd15', 'sd15'), true);
  assert.equal(isLoraCompatibleWithModelFamily('', 'sdxl'), true, 'Untagged LoRAs must never be blocked');
  assert.equal(isLoraCompatibleWithModelFamily('sdxl', 'flux_kontext'), false);
  assert.equal(isLoraCompatibleWithModelFamily('flux', 'sdxl'), false);
  assert.equal(isLoraCompatibleWithModelFamily('sd15', 'sdxl'), false);
  assert.equal(isLoraCompatibleWithModelFamily('chroma', 'sdxl'), false);

  // 2) Unusual characters (anthro wolf + winged tiefling) & graphic novel style in buildScenePromptPlan
  const fenrir = makeChar('c-wolf', 'Фенрир', {
    enabled: true,
    mode: 'lora',
    loraName: 'fenrir_illustrious.safetensors',
    loraTrigger: 'slx_fenrir',
    loraWeight: 0.85,
    appearancePrompt: 'anthropomorphic arctic wolf, silver-white fur, glowing amber eyes, fluffy tail, scar over muzzle',
    styleHint: 'stylized graphic novel illustration, bold ink linework',
  });
  const nyx = makeChar('c-tiefling', 'Никс', {
    enabled: true,
    mode: 'reference',
    referenceImages: ['data:image/jpeg;base64,/9j/NYX'],
    appearancePrompt: 'female tiefling, crimson skin, curved obsidian horns, leathery bat wings, spade tail',
    styleHint: 'dark fantasy color palette',
  });

  const merged = mergeSceneState(
    undefined,
    {
      locationChanged: true,
      locationName: 'Airship Deck',
      visualAnchor: 'brass steampunk airship deck above storm clouds',
      lighting: 'crackling violet lightning and warm lantern glow',
      actors: [
        { name: 'Fenrir', clothing: 'obsidian plate armor', poseOrAction: 'gripping greatsword' },
        { name: 'Nyx', clothing: 'indigo arcane cloak', poseOrAction: 'hovering with wings spread' },
      ],
    },
    [fenrir, nyx],
    'low-angle wide shot',
    1000,
    'm1'
  );

  const plan = buildScenePromptPlan({
    analysis: {
      sceneState: merged,
      cameraFraming: 'dramatic low-angle wide shot',
      compositionPrompt: 'Fenrir and Nyx standing back-to-back on the airship deck',
    },
    characters: [fenrir, nyx],
  });

  assert.match(plan.prompt, /slx_fenrir/);
  assert.match(plan.prompt, /anthropomorphic arctic wolf/);
  assert.match(plan.prompt, /curved obsidian horns, leathery bat wings/);
  assert.match(plan.prompt, /stylized graphic novel illustration, bold ink linework, dark fantasy color palette/);
  assert.equal(/extra limbs/i.test(plan.negativePrompt), false, 'Negative prompt must not suppress fantasy wings/tails via extra limbs');
  assert.equal(/comic panel/i.test(plan.negativePrompt), false, 'Negative prompt must omit comic panel when graphic novel/comic style is chosen');

  // 3) SceneHelp.tsx covers Base Model vs LoRA, SDXL/Illustrious/Pony, Flux, Chroma/Kroma, and local .safetensors training
  const helpSrc = fs.readFileSync(path.resolve('src/components/SceneHelp.tsx'), 'utf-8');
  assert.match(helpSrc, /loraTrain/);
  assert.match(helpSrc, /Illustrious/);
  assert.match(helpSrc, /Pony/);
  assert.match(helpSrc, /Chroma/);
  assert.match(helpSrc, /Kroma/);
  assert.match(helpSrc, /\.safetensors/);
  assert.match(helpSrc, /\.gguf/);
});

test('progress bar helpers, symmetric LoRA variant compatibility, skippedLoras propagation, and UI zero-emoji / zero-beta rules', async () => {
  const { formatActivityElapsed, clampActivityPercent } = await import('../src/utils/activityTimer.ts');
  const { isLoraCompatibleWithModelFamily } = await import('../src/services/ai/imageClient.ts');

  // 1) Elapsed timer & percent clamping boundaries
  assert.equal(formatActivityElapsed(0, 'en'), '0s');
  assert.equal(formatActivityElapsed(-10, 'en'), '0s');
  assert.equal(formatActivityElapsed(Number.NaN, 'ru'), '0 с');
  assert.equal(formatActivityElapsed(45.9, 'en'), '45s');
  assert.equal(formatActivityElapsed(65, 'en'), '1m 05s');
  assert.equal(formatActivityElapsed(129, 'ru'), '2 мин 09 с');

  assert.equal(clampActivityPercent(undefined), null);
  assert.equal(clampActivityPercent(null), null);
  assert.equal(clampActivityPercent(0), null);
  assert.equal(clampActivityPercent(-5), null);
  assert.equal(clampActivityPercent(1.2), 4);
  assert.equal(clampActivityPercent(54.6), 55);
  assert.equal(clampActivityPercent(140), 100);

  // 2) Symmetric variant compatibility (e.g. pony <-> illustrious, animagine <-> sdxl, kroma <-> chroma)
  assert.equal(isLoraCompatibleWithModelFamily('pony', 'illustrious'), true);
  assert.equal(isLoraCompatibleWithModelFamily('animagine', 'sdxl'), true);
  assert.equal(isLoraCompatibleWithModelFamily('chroma', 'kroma'), true);
  assert.equal(isLoraCompatibleWithModelFamily('chroma', 'flux_kontext'), false);

  // 3) skippedLoras propagation from Local Hub job result -> SceneAsset draft
  const session: ChatSession = {
    id: 's-skip',
    title: 'Skip LoRA Test',
    type: 'character',
    targetId: 'c1',
    thoughtsEnabled: false,
    relationships: {},
    sceneState: {
      location: {
        locationId: 'loc_1',
        locationName: 'Workshop',
        visualAnchor: 'stone alchemist workshop with copper alembics',
        lighting: 'warm hearth firelight',
        locked: true,
      },
      actors: [{ characterId: 'c1', name: 'Fenrir', clothing: 'leather apron', poseOrAction: 'mixing vial', expression: 'focused' }],
      props: ['glass vial'],
      lastCameraAngle: 'medium shot',
      lastCompositionPrompt: 'Fenrir mixing a glowing vial at the stone table',
      lastAnalyzedMsgId: 'm1',
      updatedAt: 500,
    },
    createdAt: 1,
    updatedAt: 500,
  };
  const msgs: ChatMessage[] = [
    {
      id: 'm1',
      chatId: 's-skip',
      senderId: 'c1',
      senderName: 'Fenrir',
      variants: [{ text: '*Mixes the glowing potion carefully.*', timestamp: 400 }],
      activeVariantIndex: 0,
      createdAt: 400,
    },
  ];
  const char = makeChar('c1', 'Fenrir', {
    enabled: true,
    mode: 'lora',
    loraName: 'anthro_chroma_lora.safetensors',
    loraWeight: 0.8,
    appearancePrompt: 'anthropomorphic silver wolf alchemist',
  });

  const stageEvents: Array<{ stage: string; progress?: number; step?: number; totalSteps?: number }> = [];
  const origFetch = globalThis.fetch;
  let pollCount = 0;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith('/v1/images/scene')) {
      return new Response(JSON.stringify({ ok: true, job_id: 'job_skip_1' }), { status: 200 });
    }
    if (url.includes('/v1/images/jobs/job_skip_1')) {
      pollCount += 1;
      if (pollCount === 1) {
        return new Response(
          JSON.stringify({ status: 'generating', stage: 'generating', progress: 60, step: 12, total_steps: 20 }),
          { status: 200 }
        );
      }
      return new Response(
        JSON.stringify({
          status: 'done',
          stage: 'done',
          progress: 100,
          result: {
            image_base64: 'data:image/png;base64,iVBORw0KGgo=',
            width: 768,
            height: 1024,
            seed: 42,
            model_used: 'flux-kontext-Q4_K_M.gguf',
            skipped_loras: [{ filename: 'anthro_chroma_lora.safetensors', lora_arch: 'chroma', model_family: 'flux_kontext' }],
          },
        }),
        { status: 200 }
      );
    }
    throw new Error(`Unexpected fetch URL: ${url}`);
  }) as typeof fetch;

  try {
    const out = await executeSceneGenerationPipeline({
      session,
      messages: msgs,
      characters: [char],
      perspective: 'close-up',
      skipAnalysis: true,
      settings: {
        id: 'default',
        aiEngineMode: 'local',
        localHubUrl: 'http://127.0.0.1:8080/v1',
        textModel: 'local',
        visionModel: 'local',
        textStyleId: 'literary',
        theme: {} as any,
      },
      onStage: (ev) => stageEvents.push(ev),
    });
    assert.equal(out.assetDraft.skippedLoras?.length, 1);
    assert.equal(out.assetDraft.skippedLoras?.[0]?.lora_arch, 'chroma');
    assert.equal(out.assetDraft.skippedLoras?.[0]?.model_family, 'flux_kontext');
    assert.ok(stageEvents.some((e) => e.step === 12 && e.totalSteps === 20), 'Step progress must propagate to onStage');
  } finally {
    globalThis.fetch = origFetch;
  }

  // 4) Zero emojis and zero word 'beta' in new/updated UI components
  const emojiRegex = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u;
  for (const rel of [
    'src/components/ActivityProgressBar.tsx',
    'src/components/SceneHelp.tsx',
    'src/utils/activityTimer.ts',
    'src/utils/themePersistence.ts',
    'src/utils/relationships.ts',
    'src/utils/slashCommands.ts',
    'src/views/ChatView.tsx',
    'src/views/ChatSettingsModal.tsx',
    'src/views/CharactersView.tsx',
    'src/views/GroupsView.tsx',
    'src/views/SettingsView.tsx',
    'src/App.tsx',
  ]) {
    const content = fs.readFileSync(path.resolve(rel), 'utf-8');
    assert.equal(emojiRegex.test(content), false, `Forbidden emoji found in ${rel}`);
    assert.equal(/\bbeta\b/i.test(content), false, `Forbidden word 'beta' found in ${rel}`);
  }
});

test('slashCommands: /wand Ghostwriter command, RU/EN aliases, autocomplete filtering, and ChatView button removal', async () => {
  const {
    parseWandCommand,
    filterSlashCommands,
    resolveCanonicalSlashCommand,
  } = await import('../src/utils/slashCommands.ts');

  // 1) Bare & inline-hint /wand aliases
  assert.deepEqual(parseWandCommand('/wand'), { isWandCommand: true, command: '/wand', hint: '' });
  assert.deepEqual(parseWandCommand('/reply'), { isWandCommand: true, command: '/reply', hint: '' });
  assert.deepEqual(parseWandCommand('/ответ'), { isWandCommand: true, command: '/ответ', hint: '' });
  assert.deepEqual(parseWandCommand('/палочка'), { isWandCommand: true, command: '/палочка', hint: '' });
  assert.deepEqual(parseWandCommand('  /wand поддразни её и спроси про ключ  '), {
    isWandCommand: true,
    command: '/wand',
    hint: 'поддразни её и спроси про ключ',
  });
  assert.deepEqual(parseWandCommand('/РЕПЛИКА step closer\nand smile'), {
    isWandCommand: true,
    command: '/реплика',
    hint: 'step closer\nand smile',
  });

  // 2) Non-matching / prefix-collision edge cases
  assert.equal(parseWandCommand('').isWandCommand, false);
  assert.equal(parseWandCommand('/wanderlust').isWandCommand, false);
  assert.equal(parseWandCommand('/replying').isWandCommand, false);
  assert.equal(parseWandCommand('/scene').isWandCommand, false);
  assert.equal(parseWandCommand('hello /wand inside text').isWandCommand, false);

  // 3) Live autocomplete filtering & canonical command resolution
  const allCmds = filterSlashCommands('/');
  assert.ok(allCmds.includes('/scene') && allCmds.includes('/wand') && allCmds.includes('/continue'));
  assert.deepEqual(filterSlashCommands('/пал'), ['/wand']);
  assert.deepEqual(filterSlashCommands('/отв'), ['/wand']);
  assert.deepEqual(filterSlashCommands('/re'), ['/wand', '/reset']);
  assert.deepEqual(filterSlashCommands('/wand with space'), []);
  assert.deepEqual(filterSlashCommands('not a command'), []);

  assert.equal(resolveCanonicalSlashCommand('/продолжить'), '/continue');
  assert.equal(resolveCanonicalSlashCommand('/сводка'), '/summary');
  assert.equal(resolveCanonicalSlashCommand('/память'), '/memory');
  assert.equal(resolveCanonicalSlashCommand('/действие'), '/action');
  assert.equal(resolveCanonicalSlashCommand('/сброс'), '/reset');
  assert.equal(resolveCanonicalSlashCommand('/unknown'), null);

  // 4) ChatView structural invariants: top-right header has no /scene or scene-guide buttons, bottom bar has no Wand2 button
  const chatViewSrc = fs.readFileSync(path.resolve('src/views/ChatView.tsx'), 'utf-8');
  const headerSlice = chatViewSrc.slice(
    chatViewSrc.indexOf('{/* 1. Header */}'),
    chatViewSrc.indexOf('{/* Sticky Activity Strip')
  );
  assert.ok(headerSlice.length > 100, 'Header section must be located in ChatView.tsx');
  assert.equal(headerSlice.includes('runSceneGeneration'), false, 'Top-right chat header must not render quick /scene button');
  assert.equal(headerSlice.includes('setShowSceneGuide'), false, 'Top-right chat header must not render Scene Guide button');
  assert.equal(headerSlice.includes('setShowSettingsModal(true)'), true, 'Top-right chat header must keep RP Settings button');

  const inputBarSlice = chatViewSrc.slice(
    chatViewSrc.indexOf('{/* 3. Bottom Chat Input Bar */}'),
    chatViewSrc.indexOf('{/* User Ghostwriter Wand Modal */}')
  );
  assert.ok(inputBarSlice.length > 100, 'Bottom input bar section must be located in ChatView.tsx');
  assert.equal(inputBarSlice.includes('setShowUserWandModal'), false, 'Bottom input bar must not render standalone Magic Wand button');
  assert.equal(inputBarSlice.includes('t.magicWandUser'), false, 'Bottom input bar must not render Magic Wand button tooltip');
  assert.match(chatViewSrc, /handleSelectSlashCommand\('\/wand'\)/, 'Slash command menu must expose /wand');
});

test('relationships: excludes selected player persona, classifies 7 stages, and injects custom bond status & nuance into prompts', async () => {
  const {
    clampRelationshipScore,
    filterRelationshipTargets,
    formatRelationshipPromptLine,
    getRelationshipStage,
  } = await import('../src/utils/relationships.ts');
  const { buildSystemPrompt } = await import('../src/services/promptBuilder.ts');

  const c1 = makeChar('c1', 'Лира');
  const c2 = makeChar('c2', 'Виктор');
  const pUser = makeChar('p-user', 'Максим');

  // 1) Group chat strictly excludes selected personaId
  const groupFiltered = filterRelationshipTargets({
    sessionType: 'group',
    targetId: 'grp-1',
    personaId: 'p-user',
    allCharacters: [c1, c2, pUser],
    groupCharacterIds: ['c1', 'c2', 'p-user'],
  });
  assert.deepEqual(groupFiltered.map((c) => c.id), ['c1', 'c2']);

  // Without persona selected, all group members appear
  const groupNoPersona = filterRelationshipTargets({
    sessionType: 'group',
    targetId: 'grp-1',
    personaId: null,
    allCharacters: [c1, c2, pUser],
    groupCharacterIds: ['c1', 'c2', 'p-user'],
  });
  assert.deepEqual(groupNoPersona.map((c) => c.id), ['c1', 'c2', 'p-user']);

  // Single-member group where that member is chosen as persona yields empty list cleanly
  const emptyGroupRel = filterRelationshipTargets({
    sessionType: 'group',
    targetId: 'grp-solo',
    personaId: 'p-user',
    allCharacters: [pUser],
    groupCharacterIds: ['p-user'],
  });
  assert.deepEqual(emptyGroupRel, []);

  // 1-on-1 chat returns companion and excludes if defensively equal to personaId
  assert.deepEqual(
    filterRelationshipTargets({
      sessionType: 'character',
      targetId: 'c1',
      personaId: 'p-user',
      allCharacters: [c1, pUser],
    }).map((c) => c.id),
    ['c1']
  );
  assert.deepEqual(
    filterRelationshipTargets({
      sessionType: 'character',
      targetId: 'c1',
      personaId: 'c1',
      allCharacters: [c1],
    }),
    []
  );

  // 2) Score clamping & 7-tier stage boundaries
  assert.equal(clampRelationshipScore(-500), -100);
  assert.equal(clampRelationshipScore(500), 100);
  assert.equal(clampRelationshipScore(Number.NaN), 0);
  assert.equal(getRelationshipStage(-85, 'ru').id, 'nemesis');
  assert.equal(getRelationshipStage(-50, 'ru').id, 'hostile');
  assert.equal(getRelationshipStage(-20, 'ru').id, 'cold');
  assert.equal(getRelationshipStage(0, 'ru').id, 'neutral');
  assert.equal(getRelationshipStage(30, 'ru').id, 'warm');
  assert.equal(getRelationshipStage(60, 'ru').id, 'close');
  assert.equal(getRelationshipStage(90, 'en').id, 'devoted');

  // 3) Custom bond status & dynamic note injection into buildSceneNote and buildSystemPrompt
  const ruLine = formatRelationshipPromptLine({
    speakerName: 'Лира',
    userName: 'Максим',
    score: -25,
    detail: { customTitle: 'Соперники', note: 'уважает его в бою, но язвит при разговоре' },
    language: 'ru',
  });
  assert.match(ruLine, /-25 из 100/);
  assert.match(ruLine, /статус связи: Соперники/);
  assert.match(ruLine, /нюанс динамики: уважает его в бою/);

  const noteWithBond = buildSceneNote({
    speakerName: 'Лира',
    userName: 'Максим',
    language: 'ru',
    relationshipScore: 55,
    relationshipDetail: { customTitle: 'Напарники', note: 'прикрывает спину без лишних слов' },
  });
  assert.match(noteWithBond, /\+55 из 100/);
  assert.match(noteWithBond, /статус связи: Напарники/);
  assert.match(noteWithBond, /прикрывает спину без лишних слов/);

  const sysPromptEn = buildSystemPrompt({
    character: c1,
    userName: 'Maxim',
    relationshipScore: 80,
    relationshipDetail: { customTitle: 'Sworn Partners', note: 'complete mutual trust after the siege' },
    language: 'en',
    dynamicTail: false,
  });
  assert.match(sysPromptEn, /\+80/);
  assert.match(sysPromptEn, /bond role: Sworn Partners/);
  assert.match(sysPromptEn, /dynamic nuance: complete mutual trust after the siege/);
});

test('themePersistence: prevents message appearance reset on chat entry when useLiveQuery is pending or storage has partial data', async () => {
  const {
    applyThemeToDocument,
    hexToRgba,
    normalizeThemeConfig,
    readCachedTheme,
    resolveActiveTheme,
    saveCachedTheme,
    THEME_CACHE_STORAGE_KEY,
  } = await import('../src/utils/themePersistence.ts');
  const { DEFAULT_THEME } = await import('../src/db/index.ts');

  const store = new Map<string, string>();
  const mockStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => {
      store.set(k, v);
    },
  };

  const userCustomTheme = normalizeThemeConfig(
    {
      id: 'crimson-noir',
      name: 'Oxblood Ink',
      accentColor: '#7f2d3e',
      actionColor: '#c98895',
      appBgColor: '#0d090b',
      appSurfaceColor: '#161013',
      bubbleUserBg: '#3b1822',
      bubbleBotBg: '#1b1115',
      bubbleRadius: 6,
      bubbleOpacity: 0.75,
      fontSize: 19,
      backgroundTint: 0.85,
      fontFamily: 'pixel',
      lineHeight: 'loose',
    },
    DEFAULT_THEME
  );

  saveCachedTheme(userCustomTheme, mockStorage, DEFAULT_THEME);
  assert.ok(store.has(THEME_CACHE_STORAGE_KEY));

  const restored = readCachedTheme(mockStorage, DEFAULT_THEME);
  assert.ok(restored);
  assert.equal(restored?.bubbleUserBg, '#3b1822');
  assert.equal(restored?.bubbleBotBg, '#1b1115');
  assert.equal(restored?.bubbleRadius, 6);
  assert.equal(restored?.bubbleOpacity, 0.75);
  assert.equal(restored?.fontSize, 19);
  assert.equal(restored?.fontFamily, 'pixel');
  assert.equal(restored?.lineHeight, 'loose');

  // Simulate ChatView initial mount where dbTheme (useLiveQuery) is undefined:
  // must resolve to propTheme / cachedTheme and NEVER reset to DEFAULT_THEME (#222227 / 16px / 15px)!
  const onChatMountFromProp = resolveActiveTheme({
    dbTheme: undefined,
    propTheme: userCustomTheme,
    cachedTheme: restored,
    fallback: DEFAULT_THEME,
  });
  assert.equal(onChatMountFromProp.bubbleUserBg, '#3b1822');
  assert.equal(onChatMountFromProp.bubbleRadius, 6);
  assert.equal(onChatMountFromProp.fontSize, 19);

  const onColdBootFromCache = resolveActiveTheme({
    dbTheme: undefined,
    propTheme: undefined,
    cachedTheme: restored,
    fallback: DEFAULT_THEME,
  });
  assert.equal(onColdBootFromCache.bubbleBotBg, '#1b1115');
  assert.equal(onColdBootFromCache.fontFamily, 'pixel');

  // Corrupt JSON or out-of-range fields are sanitized safely without throwing
  store.set(THEME_CACHE_STORAGE_KEY, '{corrupt-json');
  assert.equal(readCachedTheme(mockStorage, DEFAULT_THEME), null);

  const sanitized = normalizeThemeConfig(
    {
      accentColor: 'not-a-hex',
      bubbleUserBg: '',
      bubbleRadius: 999,
      bubbleOpacity: -5,
      fontSize: Number.NaN,
      fontFamily: 'invalid-font' as any,
      lineHeight: 'invalid-lh' as any,
    },
    DEFAULT_THEME
  );
  assert.equal(sanitized.accentColor, DEFAULT_THEME.accentColor);
  assert.equal(sanitized.bubbleUserBg, DEFAULT_THEME.bubbleUserBg);
  assert.equal(sanitized.bubbleRadius, 28);
  assert.equal(sanitized.bubbleOpacity, 0.3);
  assert.equal(sanitized.fontSize, DEFAULT_THEME.fontSize);
  assert.equal(sanitized.fontFamily, 'sans');
  assert.equal(sanitized.lineHeight, 'relaxed');

  // hexToRgba keeps text opaque while applying bubble translucency to background only
  assert.equal(hexToRgba('#27151a', 0.8), 'rgba(39, 21, 26, 0.8)');

  // applyThemeToDocument populates all root & bubble CSS custom properties
  const cssVars = new Map<string, string>();
  const attrs = new Map<string, string>();
  const fakeDoc = {
    documentElement: {
      style: { setProperty: (k: string, v: string) => cssVars.set(k, v) },
      setAttribute: (k: string, v: string) => attrs.set(k, v),
    },
    querySelector: () => null,
  } as unknown as Document;
  applyThemeToDocument(userCustomTheme, fakeDoc);
  assert.equal(cssVars.get('--bubble-radius'), '6px');
  assert.equal(cssVars.get('--chat-font-size'), '19px');
  assert.equal(cssVars.get('--chat-line-height'), '1.8');
  assert.equal(cssVars.get('--theme-action'), '#c98895');
  assert.equal(attrs.get('data-font'), 'pixel');
});






