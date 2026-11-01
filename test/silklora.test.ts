import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanArtifacts } from '../src/services/ai.ts';
import { buildSystemPrompt } from '../src/services/promptBuilder.ts';
import { translations } from '../src/i18n/index.ts';
import type { Character, Group, MemoryNode } from '../src/types/index.ts';

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
