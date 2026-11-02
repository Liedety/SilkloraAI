import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanArtifacts } from '../src/services/ai.ts';
import { buildSystemPrompt, DEFAULT_CORE_SYSTEM_PROMPT } from '../src/services/promptBuilder.ts';
import { translations } from '../src/i18n/index.ts';
import { normalizeLabel, calculateNodeScore, findDuplicateNodes, selectNodesToPrune, isSignificantTurn } from '../src/services/memoryGraph.ts';
import { getLocalizedTextStyle, DEFAULT_STYLES, DEFAULT_THEME, APP_THEMES } from '../src/db/index.ts';
import type { Character, Group, MemoryNode, MemoryEdge, TextStylePreset } from '../src/types/index.ts';

test('cleanArtifacts: strips empty {} brackets and Tavern tokens', () => {
  const dirty = 'Привет! {} Как твои дела? { ... } {{user}} смотрит на {{char}}. }';
  const cleaned = cleanArtifacts(dirty);
  assert.strictEqual(cleaned.includes('{}'), false, 'Should strip empty brackets');
  assert.strictEqual(cleaned.includes('{ ... }'), false, 'Should strip ellipsis brackets');
  assert.strictEqual(cleaned.includes('{{user}}'), false, 'Should replace {{user}} token');
  assert.strictEqual(cleaned.includes('{{char}}'), false, 'Should strip {{char}} token');
  assert.strictEqual(cleaned.includes('ты'), true, 'Should convert {{user}} to ты');
  assert.strictEqual(cleaned.endsWith('}'), false, 'Should strip trailing unmatched brace');
});

test('cleanArtifacts: strips tokenizer artifacts and role leak tags', () => {
  const sample1 = '<|begin_of_sentence|>package.json *smiles warmly*';
  assert.strictEqual(cleanArtifacts(sample1), 'package.json *smiles warmly*');

  const sample2 = '< | begin__of__sentence | >package.json';
  assert.strictEqual(cleanArtifacts(sample2), 'package.json');

  const sample3 = '<user> привет, как дела?';
  assert.strictEqual(cleanArtifacts(sample3), 'привет, как дела?');

  const sample4 = '*входит в комнату*\n<user> Что ты здесь делаешь?';
  assert.strictEqual(cleanArtifacts(sample4), '*входит в комнату*');

  const sample5 = '<bot>: *смотрит в глаза* Привет!';
  assert.strictEqual(cleanArtifacts(sample5), '*смотрит в глаза* Привет!');
});

test('buildSystemPrompt: generates complete prompt with group roles and emotions', () => {
  const speaker: Character = {
    id: 'char-1',
    name: 'Алиса',
    description: 'Мастер иллюзий и скрытных операций.',
    greeting: 'Приветствую в тенях.',
    greetingEnabled: true,
    emotions: [
      { id: 'em-1', name: 'радость', label: 'Радость' },
      { id: 'em-2', name: 'гнев', label: 'Гнев' },
    ],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };

  const member2: Character = {
    id: 'char-2',
    name: 'Борис',
    description: 'Тяжелый штурмовик.',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };

  const group: Group = {
    id: 'grp-1',
    name: 'Ночные Призраки',
    description: 'Скрытный отряд наемников в киберпанк-мегаполисе.',
    characterIds: ['char-1', 'char-2'],
    characterRoles: {
      'char-1': 'Координатор разведки',
      'char-2': 'Тяжелая огневая поддержка',
    },
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };

  const memoryNodes: MemoryNode[] = [
    {
      id: 'node-1',
      chatId: 'chat-1',
      label: 'Взлом терминала',
      type: 'event',
      detail: 'Игрок помог Алисе взломать охранный терминал корпорации.',
      createdAt: Date.now(),
    },
  ];

  const prompt = buildSystemPrompt({
    character: speaker,
    group,
    groupCharacters: [speaker, member2],
    thoughtsEnabled: true,
    memoryNodes,
    relationshipScore: 45,
    speakerCharacter: speaker,
  });

  assert.match(prompt, /АЛИСА/, 'Prompt should contain uppercase speaker name');
  assert.match(prompt, /НОЧНЫЕ ПРИЗРАКИ/, 'Prompt should contain group name');
  assert.match(prompt, /Координатор разведки/, 'Prompt should contain character role');
  assert.match(prompt, /Тяжелая огневая поддержка/, 'Prompt should contain member role');
  assert.match(prompt, /<emotion>emotion_name<\/emotion>/, 'Prompt should contain emotion tagging instruction');
  assert.match(prompt, /радость, гнев/, 'Prompt should list available character emotion names');
  assert.match(prompt, /<thought>\.\.\.<\/thought>/, 'Prompt should include thought block instructions');
  assert.match(prompt, /Взлом терминала/, 'Prompt should include memory nodes');
  assert.match(prompt, /45/, 'Prompt should include relationship affinity score');
});

test('Emotion regex: recognizes both Latin and Cyrillic emotion tags', () => {
  const regex = /<emotion>([^<]+)<\/emotion>/i;

  const latinSample = '<emotion>happy</emotion> *smiles warmly* Good morning!';
  const latinMatch = latinSample.match(regex);
  assert.ok(latinMatch, 'Should match Latin emotion');
  assert.strictEqual(latinMatch[1].trim(), 'happy');

  const cyrillicSample = '<emotion>радость</emotion> *весело улыбается* Привет!';
  const cyrillicMatch = cyrillicSample.match(regex);
  assert.ok(cyrillicMatch, 'Should match Cyrillic emotion');
  assert.strictEqual(cyrillicMatch[1].trim(), 'радость');

  const multiWordSample = '<emotion>легкое смущение</emotion> Ой, не стоило...';
  const multiMatch = multiWordSample.match(regex);
  assert.ok(multiMatch, 'Should match multi-word Cyrillic emotion');
  assert.strictEqual(multiMatch[1].trim(), 'легкое смущение');

  const stripped = cyrillicSample.replace(/<emotion>[\s\S]*?<\/emotion>/gi, '').trim();
  assert.strictEqual(stripped, '*весело улыбается* Привет!');
});

test('i18n: full parity between Russian and English translation dictionaries', () => {
  const enKeys = Object.keys(translations.en).sort();
  const ruKeys = Object.keys(translations.ru).sort();

  const missingInRu = enKeys.filter((k) => !(k in translations.ru));
  const missingInEn = ruKeys.filter((k) => !(k in translations.en));

  assert.deepStrictEqual(missingInRu, [], `Missing keys in Russian translations: ${missingInRu.join(', ')}`);
  assert.deepStrictEqual(missingInEn, [], `Missing keys in English translations: ${missingInEn.join(', ')}`);
  assert.strictEqual(enKeys.length, ruKeys.length, 'English and Russian key counts must match exactly');
});

test('cleanArtifacts: strips leaked emotion tags and bilingual translation parentheticals', () => {
  const sample1 = '<emotion>happy</emotion> *смеется* Привет!';
  assert.strictEqual(cleanArtifacts(sample1), '*смеется* Привет!');

  const sample2 = '[эмоция: радость] *улыбнулась* Рада встрече!';
  assert.strictEqual(cleanArtifacts(sample2), '*улыбнулась* Рада встрече!');

  const sample3 = 'Она почувствовала облегчение (relief) и вздохнула.';
  assert.strictEqual(cleanArtifacts(sample3), 'Она почувствовала облегчение и вздохнула.');
});

test('buildSystemPrompt: enforces language purity & defaults thoughtsEnabled to false', () => {
  const speaker: Character = {
    id: 'char-1',
    name: 'Эльвира',
    description: 'Маг огня.',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };

  const defaultPrompt = buildSystemPrompt({
    character: speaker,
  });

  assert.match(defaultPrompt, /STRICT LANGUAGE PURITY/, 'Should instruct on language consistency');
  assert.strictEqual(defaultPrompt.includes('### INNER THOUGHTS MONOLOGUE'), false, 'Thoughts must be disabled by default');
});

test('Group chat persona filtering: user persona is excluded from available bot speakers', () => {
  const allChars: Character[] = [
    { id: 'char-1', name: 'Персонаж 1', description: 'Бот 1', createdAt: 0, updatedAt: 0 },
    { id: 'char-2', name: 'Персона Пользователя', description: 'Игрок', createdAt: 0, updatedAt: 0 },
    { id: 'char-3', name: 'Персонаж 3', description: 'Бот 3', createdAt: 0, updatedAt: 0 },
  ];
  const group: Group = {
    id: 'grp-1',
    name: 'Группа',
    description: 'Тестовая группа',
    characterIds: ['char-1', 'char-2', 'char-3'],
    createdAt: 0,
    updatedAt: 0,
  };
  const sessionPersonaId = 'char-2'; // User chosen persona

  const availableBotSpeakers = allChars.filter(
    (c) => group.characterIds.includes(c.id) && c.id !== sessionPersonaId
  );

  assert.strictEqual(availableBotSpeakers.length, 2, 'Should only have 2 bot speakers');
  assert.strictEqual(availableBotSpeakers.some((c) => c.id === 'char-2'), false, 'Persona must not be among bot speakers');
  assert.deepStrictEqual(availableBotSpeakers.map((c) => c.id), ['char-1', 'char-3']);
});

test('buildSystemPrompt: enforces group speaker identity and style paragraph limits', () => {
  const alice: Character = {
    id: 'char-alice',
    name: 'Алиса',
    description: 'Снайпер',
    createdAt: 0,
    updatedAt: 0,
  };
  const bob: Character = {
    id: 'char-bob',
    name: 'Боб',
    description: 'Инженер',
    createdAt: 0,
    updatedAt: 0,
  };
  const group: Group = {
    id: 'grp-1',
    name: 'Отряд Омега',
    description: 'Специальный отряд',
    characterIds: ['char-alice', 'char-bob'],
    createdAt: 0,
    updatedAt: 0,
  };

  const prompt = buildSystemPrompt({
    character: bob,
    group,
    groupCharacters: [alice, bob],
    speakerCharacter: bob,
    textStyle: {
      id: 'custom-short',
      name: 'Короткий стиль',
      description: 'Максимум 3 абзаца',
      instruction: 'Пиши кратко. Максимум 3 абзаца.',
      isCustom: true,
    },
  });

  assert.match(prompt, /CRITICAL GROUP CHAT SPEAKER IDENTITY/, 'Should include group chat identity rule');
  assert.match(prompt, /solely, and uniquely \*\*Боб\*\*/, 'Should isolate current speaker identity');
  assert.match(prompt, /NEVER write dialogue, actions, thoughts, or replies on behalf of Алиса/, 'Should prevent speaking as other characters');
  assert.match(prompt, /MANDATORY WRITING STYLE & FORMATTING LIMITS/, 'Should enforce style limits at end of prompt');
  assert.match(prompt, /Максимум 3 абзаца/, 'Should include paragraph limit instruction');
});

test('buildSystemPrompt: supports custom system prompt template (augment and override modes)', () => {
  const speaker: Character = {
    id: 'char-elena',
    name: 'Елена',
    description: 'Опытная наемница.',
    createdAt: 0,
    updatedAt: 0,
  };
  const userPersona: Character = {
    id: 'char-user',
    name: 'Командир Марк',
    description: 'Лидер сопротивления.',
    createdAt: 0,
    updatedAt: 0,
  };

  // 1. Augment mode: retains default core principles and adds custom extension
  const augmentPrompt = buildSystemPrompt({
    character: speaker,
    userPersona,
    customSystemPrompt: 'ВНИМАНИЕ: Всегда обращайся к {{user}} уважительно, отвечая от лица {{char}}.',
    customSystemPromptMode: 'augment',
  });

  assert.match(augmentPrompt, /ABSOLUTE CORE PRINCIPLES/, 'Augment mode must keep base principles');
  assert.match(augmentPrompt, /CUSTOM SYSTEM PROMPT EXTENSION/, 'Augment mode must append extension section');
  assert.match(augmentPrompt, /Всегда обращайся к Командир Марк уважительно, отвечая от лица Елена/, 'Placeholders must be resolved');

  // 2. Override mode: replaces base principles with custom prompt
  const overridePrompt = buildSystemPrompt({
    character: speaker,
    userPersona,
    customSystemPrompt: 'CUSTOM CORE PROMPT: {{char}} is in an active tactical stealth simulation with {{user}}.',
    customSystemPromptMode: 'override',
  });

  assert.strictEqual(overridePrompt.includes('ABSOLUTE CORE PRINCIPLES'), false, 'Override mode must replace base principles');
  assert.match(overridePrompt, /CUSTOM CORE PROMPT: Елена is in an active tactical stealth simulation with Командир Марк/, 'Override prompt must resolve placeholders');
  assert.match(overridePrompt, /YOUR CURRENT ROLE: ЕЛЕНА/, 'Dynamic character role should still be appended');
});

test('buildSystemPrompt: enforces strict text style adherence with prominent and recency directives', () => {
  const speaker: Character = {
    id: 'char-1',
    name: 'Роланд',
    description: 'Рыцарь ордена.',
    createdAt: 0,
    updatedAt: 0,
  };

  const prompt = buildSystemPrompt({
    character: speaker,
    textStyle: {
      id: 'style-gothic',
      name: 'Готический Нуар',
      description: 'Мрачная атмосфера',
      instruction: 'Используй архаичные обороты, мрачные описания и тяжелые тени.',
      isCustom: false,
    },
  });

  assert.match(prompt, /ABSOLUTE PRIORITY DIRECTIVE — MANDATORY WRITING STYLE/, 'Must have prominent directive at top');
  assert.match(prompt, /UNCOMPROMISING STYLE ENFORCEMENT RULES/, 'Must have uncompromising enforcement rules');
  assert.match(prompt, /Every physical action inside \*asterisks\* and every spoken line MUST faithfully embody this chosen style/, 'Must enforce style on actions and speech');
  assert.match(prompt, /FINAL STYLE CHECK: Ensure every sentence and paragraph strictly complies with "Готический Нуар"/, 'Must enforce final style check');
});

test('memoryGraph: normalizes labels and scores node priority (pinned nodes never pruned)', () => {
  assert.strictEqual(normalizeLabel('  Взлом Терминала! ... '), 'взлом терминала');

  const pinnedNode: MemoryNode = {
    id: 'n-pinned',
    chatId: 'c1',
    label: 'Главный заговор',
    type: 'secret',
    detail: 'Секретная операция синдиката',
    isPinned: true,
    createdAt: 1000,
  };
  assert.strictEqual(calculateNodeScore(pinnedNode), Infinity, 'Pinned node must have Infinite priority');

  const secretNode: MemoryNode = {
    id: 'n-secret',
    chatId: 'c1',
    label: 'Тайна базы',
    type: 'secret',
    detail: 'Координаты бункера',
    createdAt: 2000,
  };
  const fallbackEventNode: MemoryNode = {
    id: 'n-event',
    chatId: 'c1',
    label: 'Привет...',
    type: 'event',
    detail: 'User said: "Привет" | Character responded: "Здравствуй"',
    createdAt: 1000,
  };

  const secretScore = calculateNodeScore(secretNode, 3, 1000, 2000);
  const eventScore = calculateNodeScore(fallbackEventNode, 0, 1000, 2000);

  assert.ok(secretScore > eventScore, `Secret node score (${secretScore}) should be much higher than dialogue fallback event score (${eventScore})`);
});

test('memoryGraph: detects duplicate nodes and selects optimal survivor', () => {
  const nodes: MemoryNode[] = [
    {
      id: 'n-1',
      chatId: 'c1',
      label: 'Взлом сейфа',
      type: 'event',
      detail: 'Краткое описание',
      createdAt: 100,
    },
    {
      id: 'n-2',
      chatId: 'c1',
      label: '  взлом сейфа!  ',
      type: 'fact',
      detail: 'Подробное описание: взломали сейф с шифром 9481 и забрали данные',
      createdAt: 200,
    },
    {
      id: 'n-3',
      chatId: 'c1',
      label: 'Другая локация',
      type: 'location',
      detail: 'Заброшенный склад',
      createdAt: 150,
    },
  ];

  const duplicates = findDuplicateNodes(nodes);
  assert.strictEqual(duplicates.length, 1, 'Should find 1 duplicate group');
  assert.strictEqual(duplicates[0].survivor.id, 'n-2', 'Survivor should be n-2 due to richer detail');
  assert.strictEqual(duplicates[0].duplicates.length, 1);
  assert.strictEqual(duplicates[0].duplicates[0].id, 'n-1');
});

test('memoryGraph: selects lowest priority unpinned nodes to prune when cap is exceeded', () => {
  const nodes: MemoryNode[] = [
    {
      id: 'n-pinned',
      chatId: 'c1',
      label: 'Ключевой союз',
      type: 'relationship',
      detail: 'Вечная клятва верности',
      isPinned: true,
      createdAt: 100,
    },
    {
      id: 'n-high-secret',
      chatId: 'c1',
      label: 'Шпион в штабе',
      type: 'secret',
      detail: 'Секретная личность шпиона',
      createdAt: 200,
    },
    {
      id: 'n-low-old',
      chatId: 'c1',
      label: 'Приветствие...',
      type: 'event',
      detail: 'User said: "Привет" | Character responded: "Хай"',
      createdAt: 50,
    },
  ];

  const edges: MemoryEdge[] = [
    { id: 'e-1', chatId: 'c1', source: 'n-pinned', target: 'n-high-secret' },
  ];

  // If maxNodes is 2, one node must be pruned
  const toPrune = selectNodesToPrune(nodes, edges, 2);
  assert.strictEqual(toPrune.length, 1, 'Should prune exactly 1 node');
  assert.strictEqual(toPrune[0].id, 'n-low-old', 'Should prune the lowest priority dialogue quote');
  assert.strictEqual(toPrune.some((n) => n.isPinned), false, 'Must NEVER prune pinned node');

  // If maxNodes is 3 or more, nothing to prune
  assert.deepStrictEqual(selectNodesToPrune(nodes, edges, 3), []);
});

test('buildSystemPrompt: prioritizes pinned nodes and marks permanent memories in context', () => {
  const speaker: Character = {
    id: 'char-1',
    name: 'Элис',
    description: 'Кибер-детектив',
    createdAt: 0,
    updatedAt: 0,
  };

  const oldPinnedNode: MemoryNode = {
    id: 'n-old-pinned',
    chatId: 'c1',
    label: 'Секретный код доступа',
    type: 'secret',
    detail: 'Код доступа: 9942',
    isPinned: true,
    createdAt: 10,
  };

  const recentUnpinnedNodes: MemoryNode[] = Array.from({ length: 12 }, (_, i) => ({
    id: `n-recent-${i}`,
    chatId: 'c1',
    label: `Разговор ${i}`,
    type: 'event',
    detail: `Диалог номер ${i}`,
    createdAt: 100 + i,
  }));

  // Old pinned node is at index 0, followed by 12 newer nodes
  const prompt = buildSystemPrompt({
    character: speaker,
    memoryNodes: [oldPinnedNode, ...recentUnpinnedNodes],
  });

  // Despite having 12 newer nodes and a limit of 10 nodes, oldPinnedNode MUST be present
  assert.match(prompt, /RELEVANT LONG-TERM MEMORIES & ESTABLISHED FACTS/, 'Should include memory section');
  assert.match(prompt, /\[SECRET \[CORE\/PERMANENT\]\] Секретный код доступа: Код доступа: 9942/, 'Pinned node must be preserved and tagged');
});

test('memoryGraph: findDuplicateNodes chooses pinned node as survivor regardless of creation time', () => {
  const olderPinned: MemoryNode = {
    id: 'n-older-pinned',
    chatId: 'c1',
    messageId: 'msg-turn-1',
    label: 'Главный штаб',
    type: 'location',
    detail: 'Штаб в секторе 4',
    isPinned: true,
    createdAt: 100,
  };

  const newerUnpinned: MemoryNode = {
    id: 'n-newer-unpinned',
    chatId: 'c1',
    messageId: 'msg-turn-5',
    label: '  главный штаб! ',
    type: 'location',
    detail: 'Штаб в секторе 4 подробнее',
    isPinned: false,
    createdAt: 500,
  };

  const duplicates = findDuplicateNodes([olderPinned, newerUnpinned]);
  assert.strictEqual(duplicates.length, 1);
  assert.strictEqual(duplicates[0].survivor.id, 'n-older-pinned', 'Pinned node must ALWAYS win over unpinned even if older');
});

test('Chat context slicing: regeneration excludes target bot message from context prompt', () => {
  const messages = [
    { id: 'm1', senderId: 'user', variants: [{ text: 'Turn 1 User' }] },
    { id: 'm2', senderId: 'bot-1', variants: [{ text: 'Turn 1 Bot' }] },
    { id: 'm3', senderId: 'user', variants: [{ text: 'Turn 2 User' }] },
    { id: 'm4', senderId: 'bot-1', variants: [{ text: 'Turn 2 Bot (stale variant to regenerate)' }] },
  ];

  const targetRegenMsg = messages[3]; // regenerating m4
  const targetIdx = messages.findIndex((m) => m.id === targetRegenMsg.id);
  const msgsForContext = targetIdx !== -1 ? messages.slice(0, targetIdx) : messages;

  assert.strictEqual(msgsForContext.length, 3, 'Context should only contain messages before the regenerated message');
  assert.strictEqual(msgsForContext.some((m) => m.id === 'm4'), false, 'Regenerated message must not be in context turns');
  assert.strictEqual(msgsForContext[msgsForContext.length - 1].id, 'm3', 'Last context message must be the user prompt for this turn');
});

test('isSignificantTurn: filters out trivial greetings and captures narrative milestones', () => {
  // Empty input
  assert.strictEqual(isSignificantTurn('', 'Hello', 0), false, 'Empty user text is never significant');
  assert.strictEqual(isSignificantTurn('   ', 'Hello', 0), false, 'Whitespace-only user text is never significant');

  // Trivial greetings without strong affinity shifts
  assert.strictEqual(isSignificantTurn('привет', 'Привет!', 0), false, 'Trivial Russian greeting should be ignored');
  assert.strictEqual(isSignificantTurn('Hello!', 'Hi there!', 1), false, 'Trivial English greeting should be ignored');
  assert.strictEqual(isSignificantTurn('ок', 'Хорошо.', 0), false, 'Trivial Russian acknowledgment should be ignored');
  assert.strictEqual(isSignificantTurn('ok, thanks', 'You are welcome', 0), false, 'Trivial English acknowledgment should be ignored');

  // Significant affinity milestone shifts override trivial text
  assert.strictEqual(isSignificantTurn('привет', 'Привет!', 3), true, 'Milestone affinity shift (+3) should be significant');
  assert.strictEqual(isSignificantTurn('ок', 'Ладно...', -3), true, 'Milestone affinity penalty (-3) should be significant');

  // Narrative keywords with sufficient context length (>= 20 chars)
  assert.strictEqual(
    isSignificantTurn('Я обещаю, что мы найдем этот древний артефакт в руинах.', 'Я верю тебе всем сердцем.', 0),
    true,
    'Russian narrative promise and artifact should be significant'
  );
  assert.strictEqual(
    isSignificantTurn('I swear to protect this secret alliance until the very end.', 'We will stand together.', 0),
    true,
    'English narrative oath and secret alliance should be significant'
  );
});

test('getLocalizedTextStyle: translates RP styles based on active language', () => {
  const literaryStyle = DEFAULT_STYLES.find((s) => s.id === 'literary')!;
  assert.ok(literaryStyle, 'Default literary style must exist');

  // Localized to Russian
  const ruStyle = getLocalizedTextStyle(literaryStyle, 'ru');
  assert.strictEqual(ruStyle.name, 'Литературный роман');
  assert.match(ruStyle.instruction, /литературном стиле высокого качества/);

  // Localized to English
  const enStyle = getLocalizedTextStyle(literaryStyle, 'en');
  assert.strictEqual(enStyle.name, 'Literary Prose');
  assert.match(enStyle.instruction, /high-literary prose style/);

  // Custom style presets remain unchanged regardless of language
  const customPreset: TextStylePreset = {
    id: 'user-custom-style-1',
    name: 'Мой уникальный стиль',
    description: 'Описание стиля',
    instruction: 'Инструкция для нейросети',
    isCustom: true,
  };
  const localizedCustom = getLocalizedTextStyle(customPreset, 'en');
  assert.strictEqual(localizedCustom.name, 'Мой уникальный стиль');
  assert.strictEqual(localizedCustom.instruction, 'Инструкция для нейросети');
});

test('buildSystemPrompt: context compression recap is injected when contextSummary is provided', () => {
  const speaker: Character = {
    id: 'char-1',
    name: 'Амалия',
    description: 'Верховный чародей.',
    createdAt: 0,
    updatedAt: 0,
  };

  const promptWithSummary = buildSystemPrompt({
    character: speaker,
    contextSummary: 'Герои сбежали из темницы цитадели и укрылись в старом квартале алхимиков.',
  });

  assert.match(promptWithSummary, /CONTEXT COMPRESSION — SUMMARY OF EARLIER EVENTS/, 'Prompt must include compression section header');
  assert.match(
    promptWithSummary,
    /Герои сбежали из темницы цитадели и укрылись в старом квартале алхимиков\./,
    'Prompt must contain the rolling summary text'
  );

  const promptWithoutSummary = buildSystemPrompt({
    character: speaker,
  });
  assert.strictEqual(
    promptWithoutSummary.includes('CONTEXT COMPRESSION'),
    false,
    'Prompt without contextSummary must not include compression section'
  );
});

test('DEFAULT_CORE_SYSTEM_PROMPT: mirrors user language dynamically without hardcoded Russian requirement', () => {
  assert.match(DEFAULT_CORE_SYSTEM_PROMPT, /DYNAMIC LANGUAGE MIRRORING/, 'Prompt must mandate dynamic language mirroring');
  assert.match(DEFAULT_CORE_SYSTEM_PROMPT, /STRICT LANGUAGE PURITY/, 'Prompt must retain strict language purity token');
  assert.strictEqual(
    DEFAULT_CORE_SYSTEM_PROMPT.includes('ТОЛЬКО на русском'),
    false,
    'Core system prompt must not force Russian on all conversations'
  );
  assert.strictEqual(
    DEFAULT_CORE_SYSTEM_PROMPT.includes('всегда отвечай на русском'),
    false,
    'Core system prompt must not mandate Russian replies unconditionally'
  );
});

test('Theme configuration: separates theme design from typography settings', () => {
  // DEFAULT_THEME
  assert.ok(DEFAULT_THEME.fontFamily, 'DEFAULT_THEME must specify fontFamily');
  assert.ok(DEFAULT_THEME.lineHeight, 'DEFAULT_THEME must specify lineHeight');
  assert.ok(['sans', 'serif', 'mono'].includes(DEFAULT_THEME.fontFamily));
  assert.ok(['normal', 'relaxed', 'loose'].includes(DEFAULT_THEME.lineHeight));

  // APP_THEMES
  assert.ok(APP_THEMES.length >= 3, 'Must have at least 3 pre-built app themes');
  for (const themeItem of APP_THEMES) {
    assert.ok(themeItem.theme.fontFamily, `Theme ${themeItem.id} must define fontFamily`);
    assert.ok(themeItem.theme.lineHeight, `Theme ${themeItem.id} must define lineHeight`);
    assert.ok(['sans', 'serif', 'mono'].includes(themeItem.theme.fontFamily));
    assert.ok(['normal', 'relaxed', 'loose'].includes(themeItem.theme.lineHeight));
  }
});
