import React, { useState } from 'react';
import { createPortal } from 'react-dom';
import { BookOpen, Camera, CheckCircle2, Cpu, HelpCircle, Layers, Lock, Monitor, Sparkles, Users, X } from 'lucide-react';

export type SceneHelpTopic =
  | 'enableScene'
  | 'modeSelect'
  | 'refPhotos'
  | 'appearancePrompt'
  | 'styleHint'
  | 'loraAdapter'
  | 'loraTrigger'
  | 'loraStrength'
  | 'loraTrain'
  | 'slashScene'
  | 'sceneCard'
  | 'locationAnchor'
  | 'sceneRouting'
  | 'aspectRatio';

interface TopicEntry {
  title: string;
  body: string;
  example?: string;
}

const TOPICS_RU: Record<SceneHelpTopic, TopicEntry> = {
  enableScene: {
    title: 'Генерация сцен с этим персонажем',
    body: 'Включает передачу внешности персонажа при вызове команды /scene в чате. В личном чате используется карточка собеседника, а в групповом чате в кадр попадают только те участники группы, у которых включён этот тумблер (персона игрока не перекрывает персонажей).',
    example: 'Если в группе 4 персонажа, а тумблер включён у двоих — генератор возьмёт референсы именно этих двоих.',
  },
  modeSelect: {
    title: 'Способ сохранения внешности: Референс-фото или LoRA',
    body: 'Выберите, как графическая модель должна узнавать лицо, расу и образ персонажа:\n• Референс-фото (без обучения): вы прикрепляете 1–4 картинки и текстовое описание внешности. Напрямую читают фото модели с пометкой редактирования (FLUX Kontext, Qwen-Image-Edit) и облачные модели (Gemini, GPT Image, FLUX.2). На обычных моделях (SDXL, Illustrious, Pony, Chroma, Z-Image) фото помогают составить точное описание через кнопку Vision.\n• Персональная или стилевая LoRA: подключает отдельный файл-насадку (.safetensors) из server/models/loras. Лучший выбор для специализированных моделей (SDXL, Illustrious, Pony, Animagine, Chroma/Kroma, FLUX, SD 1.5), необычных персонажей (антро/фурри, эльфы, демоны, киборги) и авторской рисовки.',
  },
  refPhotos: {
    title: 'Фото-референсы внешности (1–4 шт.)',
    body: 'Прикрепите от 1 до 4 чётких изображений персонажа (портрет и вид по пояс без рамок и надписей) или нажмите «Взять из аватара». Эти же картинки используются и для мультимодальных моделей (FLUX Kontext, Qwen-Image-Edit), и для автоописания через Vision, и как датасет при локальном обучении вашей LoRA на ПК.',
    example: 'Для необычных рас и антро-персонажей выбирайте кадры, где хорошо видны уши, морда/лицо, рога, хвост, окрас и основная одежда.',
  },
  appearancePrompt: {
    title: 'Описание внешности для генератора (на английском)',
    body: 'Список ключевых примет на английском языке — работает абсолютно со всеми семействами моделей (FLUX, SDXL, Illustrious, Pony, Chroma/Kroma, Qwen-Image, Z-Image, SD 1.5). Для нестандартных героев обязательно указывайте расу/вид и анатомию в начале (например anthropomorphic wolf, elf, tiefling, cyborg, horns, wings, fluffy tail, fur pattern). Нажмите «Описать внешность (Vision)», чтобы ИИ сам считал все черты с картинки.',
    example: 'anthropomorphic arctic wolf, silver-white fur, amber eyes, pointed fluffy ears, scar on brow, dark techwear jacket',
  },
  styleHint: {
    title: 'Стиль отрисовки кадра',
    body: 'Задаёт художественную подачу сцен: кино-фотореализм, аниме, тёмное фэнтези, живопись, сай-фай/киберпанк, фурри/антро-иллюстрация или графический роман. Выберите готовую кнопку ниже или впишите собственные теги стиля.',
    example: 'detailed anime fantasy illustration, dramatic cel-shaded lighting, rich colors',
  },
  loraAdapter: {
    title: 'Что такое LoRA (.safetensors), модули и совместимость',
    body: 'В генераторе есть три типа файлов:\n• Базовая модель (models/image, 4–12 ГБ, .safetensors или .gguf) — основной «движок-художник».\n• Модули-компаньоны (models/image_aux: VAE, CLIP, T5, Qwen) — модули зрения и текста для .gguf-моделей (скачиваются сервером автоматически в составе сборок).\n• Адаптер LoRA (models/loras, от 20 МБ до 5 ГБ для высокого ранга, .safetensors) — съёмная «насадка-память» на конкретного персонажа, редкую расу или стиль. Без базовой модели LoRA сама не рисует.\n\nПравило совместимости архитектур:\n• SDXL / Illustrious / Pony / Animagine LoRA -> к семейству SDXL (и .safetensors, и .gguf).\n• Flux LoRA -> к FLUX.1 и FLUX Kontext.\n• Chroma / Kroma LoRA -> к Chroma и Kroma.\n• SD 1.5 LoRA -> к SD 1.5.\nЕсли переключить базовую модель на другое семейство, сервер безопасно пропустит несовместимую LoRA без сбоя.',
    example: 'Положите скачанный .safetensors файл LoRA в server/models/loras и нажмите «Обновить список» — сервер сам определит его архитектуру.',
  },
  loraTrigger: {
    title: 'Триггер-слово LoRA',
    body: 'Кодовое слово-ключ, на которое обучен LoRA-файл. Оно автоматически добавляется в начало промпта и «включает» нужную внешность или стиль внутри базовой модели.\n• Если вы обучили LoRA на нашем ПК-сервере — триггер подставится сам.\n• Если скачали готовую LoRA — впишите trigger word со страницы автора (многие стилевые LoRA работают и с пустым полем).',
    example: 'slx_lyra',
  },
  loraStrength: {
    title: 'Сила влияния LoRA (0.20–1.20)',
    body: 'Регулирует, насколько сильно насадка LoRA меняет картинку базовой модели:\n• 0.75–0.90 — оптимально для внешности персонажа и необычной анатомии.\n• 0.50–0.70 — мягкое влияние (отлично подходит для стилевых LoRA).\n• Выше 1.00 — жёсткая фиксация черт, но меньше свободы для сложных поз и ракурсов.',
  },
  loraTrain: {
    title: 'Локальное обучение LoRA по вашим фото',
    body: 'Позволяет прямо на вашем ПК (видеокарта от 6 ГБ VRAM) обучить персональный файл .safetensors по 1–4 загруженным выше референс-фото.\n\nКак это работает:\n1. Сжатые .gguf-модели предназначены только для быстрой генерации, поэтому само обучение всегда идёт поверх полного базового чекпоинта .safetensors (SDXL, Illustrious, Pony, Animagine или SD 1.5) из папки server/models/image.\n2. Если в базе выбрана специализированная модель (например Illustrious или Pony в .safetensors), адаптер обучится именно под её стиль и анатомию.\n3. Готовый маленький LoRA-файл сохраняется в server/models/loras и дальше работает как с .safetensors, так и с .gguf моделями этого же семейства.',
    example: 'Загрузите 2–4 чётких арта/фото персонажа -> проверьте английское описание внешности -> выберите базовый чекпоинт -> нажмите «Обучить LoRA».',
  },
  slashScene: {
    title: 'Команда /scene в чате',
    body: 'Напишите /scene (или /сцена, /фото, /кадр) в строку сообщения, чтобы сгенерировать иллюстрацию текущего момента переписки. После пробела можно сразу указать желаемый ракурс или деталь кадра.',
    example: '/scene крупный план у окна\n/сцена вид со спины, смотрит на ночной город',
  },
  sceneCard: {
    title: 'Управление готовым кадром и быстрая смена ракурса',
    body: 'Под сгенерированной сценой можно:\n• «Перегенерить» — создать новый вариант того же кадра.\n• «Ракурс» — выбрать готовый ракурс в 1 нажатие («Крупный план», «Со спины», «В полный рост» и др.) или вписать свой.\nПока вы перегенерируете сцену или меняете ракурсы, графическая модель остаётся прогретой в видеопамяти ПК. Когда вы напишете обычное сообщение в чат, сервер сам вернёт текстовую ИИ.',
  },
  locationAnchor: {
    title: 'Якорь локации (удержание целостности фона)',
    body: 'Перед первой генерацией сцены текстовый ИИ-режиссёр анализирует диалог и фиксирует архитектуру места, мебель, освещение, одежду и облик героев. Пока «Фон закреплён», смена ракурса оставляет персонажей в той же локации и одежде. Если герои по сюжету перешли в новое место, якорь обновится автоматически — либо вы можете сбросить его вручную.',
  },
  sceneRouting: {
    title: 'Маршрутизация сцен: Локальный ПК или Облако',
    body: 'Генерация сцены состоит из двух этапов:\n1. «Режиссёр сцен (анализ)» — читает последние реплики чата до загрузки графической модели и составляет композицию кадра.\n2. «Движок генерации сцен» — рисует само изображение.\nВ режиме «Локальный ПК» любая базовая модель (FLUX, Qwen-Image, Chroma/Kroma, Z-Image, SDXL, Illustrious, Pony, Animagine, SD 1.5) выбирается в веб-панели на компьютере, а сервер сам настраивает её сэмплер, CFG и компаньоны. В режиме «Облако» генерация идёт через ваш API-ключ.',
  },
  aspectRatio: {
    title: 'Формат кадра по умолчанию',
    body: 'Определяет пропорции создаваемых иллюстраций:\n• Портрет (3:4) — лучше всего подходит для одного персонажа по пояс или крупным планом.\n• Квадрат (1:1) — универсальный формат.\n• Горизонтальный (4:3) — удобен для парных сцен, групповых чатов и широких панорам локации.',
  },
};

const TOPICS_EN: Record<SceneHelpTopic, TopicEntry> = {
  enableScene: {
    title: 'Character Scene Generation Toggle',
    body: 'Includes this character’s likeness and appearance settings when you run /scene in chat. In 1-on-1 chats the active partner is used; in group chats only members with this toggle enabled are included in the visual prompt (your user persona never overrides character cards).',
    example: 'If a group has 4 members and 2 have this enabled, /scene renders those 2 characters cleanly.',
  },
  modeSelect: {
    title: 'Likeness Mode: Reference Photos vs LoRA',
    body: 'Choose how the image engine preserves your character’s face, species, and style:\n• Reference Photos (zero training): attach 1–4 character images plus English traits. Multimodal edit models (FLUX Kontext, Qwen-Image-Edit) and cloud models (Gemini, GPT Image, FLUX.2) read reference photos directly; on standard checkpoints (SDXL, Illustrious, Pony, Chroma, Z-Image) photos power 1-tap Vision trait extraction.\n• Character / Style LoRA: attaches a modular .safetensors adapter from server/models/loras. Ideal for specialized models (SDXL, Illustrious, Pony, Animagine, Chroma/Kroma, FLUX, SD 1.5), non-human/unusual characters (anthro/furry, elves, demons, cyborgs), and custom art styles.',
  },
  refPhotos: {
    title: 'Character Reference Photos (1–4 images)',
    body: 'Upload 1 to 4 clear portraits or waist-up shots without text bubbles or watermarks, or tap "Use Avatar". These images serve three roles: direct visual references on multimodal engines, source art for Vision auto-description, and training samples when building a local LoRA on your PC.',
    example: 'For fantasy or anthropomorphic characters, pick clear shots showing ears, muzzle/face, horns, tail, fur/scale patterns, and signature outfit.',
  },
  appearancePrompt: {
    title: 'Visual Appearance Prompt (English)',
    body: 'Concise English tags describing permanent visual traits — works across every model family (FLUX, SDXL, Illustrious, Pony, Chroma/Kroma, Qwen-Image, Z-Image, SD 1.5). For unusual or non-human characters, always state species and anatomy first (e.g. anthropomorphic wolf, tiefling, elf, cyborg, curved horns, wings, fluffy tail). Tap "Auto-describe with Vision AI" to extract these tags automatically.',
    example: 'anthropomorphic arctic wolf, silver-white fur, amber eyes, pointed fluffy ears, scar on brow, dark techwear jacket',
  },
  styleHint: {
    title: 'Art / Camera Style Hint',
    body: 'Sets the visual aesthetic for scenes: photorealistic cinema, anime, dark fantasy, painterly art, sci-fi/cyberpunk, anthro/furry illustration, or graphic novel ink. Tap a preset chip below or write your own style tags.',
    example: 'detailed anime fantasy illustration, dramatic cel-shaded lighting, rich colors',
  },
  loraAdapter: {
    title: 'What a LoRA (.safetensors), Companion & Base Model Are',
    body: 'Scene generation uses three distinct file types:\n• Base Model (models/image, 4–12 GB, .safetensors or .gguf) — the core painter engine.\n• Companion Files (models/image_aux: VAE, CLIP, T5, Qwen) — vision and text encoders for .gguf models (downloaded automatically in bundles).\n• LoRA Adapter (models/loras, 20 MB up to 5 GB for high-rank DiTs, .safetensors) — a plug-in memory adapter for a specific character, rare species, or art style. A LoRA cannot generate images without a base model.\n\nCompatibility Rule:\n• SDXL / Illustrious / Pony / Animagine LoRA -> SDXL family (both .safetensors and .gguf).\n• Flux LoRA -> FLUX.1 and FLUX Kontext.\n• Chroma / Kroma LoRA -> Chroma and Kroma.\n• SD 1.5 LoRA -> SD 1.5.\nIf you switch base models to another family, incompatible LoRAs are safely skipped without crashing.',
    example: 'Drop any downloaded .safetensors LoRA into server/models/loras and tap Refresh List — the Hub automatically detects its base architecture.',
  },
  loraTrigger: {
    title: 'LoRA Trigger Word',
    body: 'Unique activation token your LoRA was trained with. SilkLora prepends it automatically so the base model activates the learned character or style.\n• Server-trained LoRAs fill their trigger word automatically.\n• For downloaded third-party LoRAs, copy the author’s trigger word (many pure style LoRAs work with an empty trigger).',
    example: 'slx_lyra',
  },
  loraStrength: {
    title: 'LoRA Strength (0.20–1.20)',
    body: 'Controls how strongly the LoRA adapter influences the base model:\n• 0.75–0.90 — sweet spot for character likeness and non-human anatomy.\n• 0.50–0.70 — gentle blend (great for art-style LoRAs).\n• Above 1.00 — maximum lock, though poses or lighting may become stiffer.',
  },
  loraTrain: {
    title: 'Local LoRA Training from Reference Photos',
    body: 'Trains a custom .safetensors character adapter right on your PC (6+ GB VRAM GPU) from the 1–4 reference images uploaded above.\n\nHow it works:\n1. Quantized .gguf files are compressed for fast inference only, so training always runs on top of a full .safetensors base checkpoint (SDXL, Illustrious, Pony, Animagine, or SD 1.5) stored in server/models/image.\n2. Picking a specialized checkpoint (such as Illustrious or Pony .safetensors) teaches the LoRA directly in that model’s anatomy and art style.\n3. Once finished, the compact LoRA file is saved to server/models/loras and works during generation with both .safetensors and .gguf models of the same family.',
    example: 'Upload 2–4 clean character images -> verify English appearance tags -> pick base checkpoint -> tap Train LoRA on Server.',
  },
  slashScene: {
    title: 'The /scene Slash Command',
    body: 'Type /scene (or /сцена, /фото, /кадр) in chat to illustrate the current story moment. Add optional camera framing right after the command.',
    example: '/scene close-up by the rainy window\n/scene over-the-shoulder view from behind',
  },
  sceneCard: {
    title: 'Scene Controls & Instant Warm Camera Angles',
    body: 'Below every generated scene you can:\n• Regenerate — roll a fresh variation of the current shot.\n• Camera Angle — tap a 1-click preset (Close-up, From behind, Full body, etc.) or type custom framing.\nWhile you regenerate or change angles, the image model stays warm in GPU memory on your PC. Sending your next regular chat message automatically restores the text LLM.',
  },
  locationAnchor: {
    title: 'Location Anchor (Background Continuity)',
    body: 'Before loading the image model, the Scene Director AI analyzes recent dialogue and locks room architecture, furniture, lighting, outfits, and character traits. Keeping Location Locked ensures changing camera angles stays in the exact same setting. When characters travel somewhere new, the anchor updates automatically (or you can reset it anytime).',
  },
  sceneRouting: {
    title: 'Scene Routing: Local PC vs Cloud API',
    body: 'Scene creation runs in two steps:\n1. Scene Director AI — reads chat context while the text LLM is active and builds the visual plan.\n2. Scene Image Engine — renders the image.\nOn Local PC, you can run any supported family (FLUX, Qwen-Image, Chroma/Kroma, Z-Image, SDXL, Illustrious, Pony, Animagine, SD 1.5) via the PC dashboard, and the server configures sampler, CFG, negative prompt, and companions automatically.',
  },
  aspectRatio: {
    title: 'Default Aspect Ratio',
    body: 'Controls image proportions:\n• Portrait (3:4) — best for solo character portraits and waist-up framing.\n• Square (1:1) — balanced framing.\n• Landscape (4:3) — ideal for two-character interactions, group scenes, and wide environment shots.',
  },
};

export const SceneHelpButton: React.FC<{
  topic: SceneHelpTopic;
  language: 'en' | 'ru';
  onOpenGuide?: () => void;
  className?: string;
}> = ({ topic, language, onOpenGuide, className = '' }) => {
  const [open, setOpen] = useState(false);
  const entry = language === 'ru' ? TOPICS_RU[topic] : TOPICS_EN[topic];

  const modalNode = open ? (
    <div
      onClick={(e) => {
        e.stopPropagation();
        setOpen(false);
      }}
      className="fixed inset-0 z-[90] flex items-center justify-center p-4 bg-black/80 animate-fade-in"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-sm max-h-[85vh] overflow-y-auto rounded-2xl bg-silk-900 border border-silk-700 p-4 space-y-3 shadow-xl text-left"
      >
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-2">
            <HelpCircle className="w-4 h-4 text-slate-300 shrink-0" />
            <h3 className="text-sm font-semibold text-white leading-snug">{entry.title}</h3>
          </div>
          <button
            type="button"
            onClick={() => setOpen(false)}
            className="p-1 rounded-lg text-slate-400 hover:text-white hover:bg-silk-800 shrink-0"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <p className="text-xs text-slate-300 whitespace-pre-line leading-relaxed">{entry.body}</p>

        {entry.example && (
          <div className="p-2.5 rounded-xl bg-silk-950/80 border border-silk-800 text-[11px] text-slate-300">
            <span className="text-slate-500 block mb-0.5 font-medium">
              {language === 'ru' ? 'Пример:' : 'Example:'}
            </span>
            <span className="whitespace-pre-line font-mono text-[11px] text-slate-200">{entry.example}</span>
          </div>
        )}

        <div className="flex items-center justify-between gap-2 pt-1">
          {onOpenGuide ? (
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                onOpenGuide();
              }}
              className="flex items-center gap-1.5 text-xs font-medium text-slate-200 hover:text-white underline underline-offset-4"
            >
              <BookOpen className="w-3.5 h-3.5" />
              <span>{language === 'ru' ? 'Открыть полный гайд по сценам' : 'Open full Scene Guide'}</span>
            </button>
          ) : (
            <span />
          )}
          <button
            type="button"
            onClick={() => setOpen(false)}
            className="px-3.5 py-1.5 rounded-xl bg-silk-800 hover:bg-silk-700 border border-silk-700 text-xs font-medium text-white"
          >
            {language === 'ru' ? 'Понятно' : 'Got it'}
          </button>
        </div>
      </div>
    </div>
  ) : null;

  return (
    <>
      <button
        type="button"
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setOpen(true);
        }}
        title={entry.title}
        aria-label={entry.title}
        className={`w-5 h-5 rounded-full bg-silk-800 hover:bg-silk-700 border border-silk-600 text-[11px] font-bold text-slate-300 hover:text-white inline-flex items-center justify-center shrink-0 transition-colors ${className}`}
      >
        ?
      </button>

      {modalNode && (typeof document !== 'undefined' ? createPortal(modalNode, document.body) : modalNode)}
    </>
  );
};

export const SceneGuideModal: React.FC<{
  isOpen: boolean;
  onClose: () => void;
  language: 'en' | 'ru';
}> = ({ isOpen, onClose, language }) => {
  if (!isOpen) return null;
  const ru = language === 'ru';

  const sections = ru
    ? [
        {
          icon: CheckCircle2,
          title: '1. Быстрый старт за 3 шага',
          items: [
            'Шаг 1 (Движок генерации): для работы на ПК запустите start-server.bat и во вкладке «Модели -> Генерация сцен» скачайте любую подходящую модель (или найдите свою через поиск Hugging Face / положив файл в server/models/image). Для Облака — выберите API-ключ в Настройках.',
            'Шаг 2 (Карточка персонажа): откройте редактирование персонажа, разверните «Расширенные настройки» ниже эмоций, включите «Генерация картинок (сцены)» и задайте внешность и стиль.',
            'Шаг 3 (Вызов в чате): отправьте /scene (или /сцена, /фото, /кадр). ИИ-режиссёр проанализирует диалог и нарисует кадр прямо в чате.',
          ],
        },
        {
          icon: Sparkles,
          title: '2. Любые базовые модели, стили и необычные персонажи',
          items: [
            'Сервер поддерживает все популярные семейства моделей: модели с прямыми фото-референсами (FLUX Kontext, Qwen-Image-Edit), современные диффузионные GGUF (FLUX.1, Chroma/Kroma, Qwen-Image, Z-Image, SD 3.5) и специализированные чекпоинты/GGUF (SDXL, Illustrious, Pony, Animagine, SD 1.5).',
            'Под каждое семейство сервер сам выставляет правильные параметры (CFG, сэмплер euler / euler_a / dpm++2m, число шагов, negative prompt, score-теги для Pony и нужные модули VAE / CLIP / T5) — переключать модели можно без риска сломать генерацию.',
            'Для нестандартных персонажей (антропоморфные/фурри, эльфы, тифлинги, дракониды, киборги, аниме и сай-фай образы) пишите вид и анатомию в поле «Описание внешности» на английском (или нажмите кнопку Vision — она сама считает уши, морду, рога, крылья, хвост, чешую или окрас с загруженного арта) и выберите подходящий пресет стиля.',
          ],
        },
        {
          icon: Cpu,
          title: '3. Всё о LoRA простым языком: файлы, совместимость и обучение',
          items: [
            'Три типа файлов: Базовая модель (server/models/image, 4–12 ГБ, .safetensors или .gguf) — главный «художник». Модули-компаньоны (server/models/image_aux: VAE, CLIP, T5, Qwen) — её глаза и чтение текста (скачиваются сервером автоматически в сборках). А файл LoRA (server/models/loras, от 20 МБ до нескольких ГБ для высокого ранга, .safetensors) — съёмная «насадка-память» на конкретного персонажа, редкую расу или фирменный стиль.',
            'Зачем нужны LoRA: Модели вроде SDXL, Illustrious, Pony, Animagine, Chroma/Kroma и SD 1.5 не принимают референс-фото напрямую в кадр, зато идеально работают со стилевыми и персонажными LoRA — именно так получают точное попадание в необычных персонажей и узкие художественные стили.',
            'Правило совместимости архитектур: LoRA работает только с тем семейством моделей, под которое создана: SDXL / Illustrious / Pony / Animagine LoRA — к семейству SDXL; Flux LoRA — к FLUX.1 и FLUX Kontext; Chroma / Kroma LoRA — к Chroma и Kroma; SD 1.5 LoRA — к SD 1.5. При смене базовой модели на другое семейство несовместимая LoRA безопасно пропускается без сбоя.',
            'Локальное обучение LoRA по вашим фото: На ПК с видеокартой от 6 ГБ VRAM нажмите «Обучить LoRA на сервере из фото». Поскольку сжатые .gguf-файлы подходят только для быстрой генерации, обучение запускается поверх полного чекпоинта .safetensors (SDXL, Illustrious, Pony, Animagine или SD 1.5) из server/models/image. Готовый .safetensors адаптер с триггер-словом (например slx_hero) сохраняется в server/models/loras и дальше работает как с .safetensors, так и с .gguf моделями того же семейства.',
          ],
        },
        {
          icon: Camera,
          title: '4. Режим «Референс-фото» против режима «LoRA»',
          items: [
            'Когда выбирать «Референс-фото»: если у вас включены FLUX Kontext, Qwen-Image-Edit или Облако (Gemini Flash Image, GPT Image, FLUX.2) — просто прикрепите 1–4 фото без всякого обучения.',
            'Когда выбирать «LoRA»: если вы рендерите на специализированных моделях (Illustrious, Pony, Animagine, Chroma/Kroma, SDXL, SD 1.5) либо хотите закрепить сложный авторский дизайн или стиль через готовый/обученный .safetensors адаптер.',
          ],
        },
        {
          icon: Layers,
          title: '5. Команды /scene, ракурсы и работа видеопамяти',
          items: [
            'Поддерживаются команды /scene, /сцена, /фото и /кадр с любым уточнением ракурса (например «/scene крупный план» или «/сцена со спины»).',
            'Под готовой сценой кнопка «Ракурс» меняет план в 1 касание, пока графическая модель остаётся прогретой в памяти ПК. При отправке следующей реплики в чат сервер сам возвращает текстовую модель.',
          ],
        },
        {
          icon: Lock,
          title: '6. Якорь локации и групповые чаты',
          items: [
            'Текстовый ИИ-режиссёр фиксирует архитектуру комнаты, свет и одежду героев («Фон закреплён»), чтобы при смене ракурса обстановка не менялась случайно.',
            'В групповых чатах в кадр попадают только те участники группы, у которых включён тумблер «Генерация картинок (сцены)».',
          ],
        },
        {
          icon: Monitor,
          title: '7. Локальный ПК-сервер и Облако',
          items: [
            'В приложении на телефоне выбирается маршрут («Локальный ПК» или «Облако») и формат кадра (3:4, 1:1, 4:3), а конкретные локальные модели и пакеты с модулями VAE/CLIP/T5 скачиваются и переключаются в веб-панели ПК.',
          ],
        },
      ]
    : [
        {
          icon: CheckCircle2,
          title: '1. Quick Start in 3 Steps',
          items: [
            'Step 1 (Engine): For Local PC, launch start-server.bat and download any model under Models -> Scene Generation (or via Hugging Face search / dropping weights into server/models/image). For Cloud, activate an API key in Settings.',
            'Step 2 (Character Card): Edit your character, open Advanced Settings below Emotions, enable "Scene image generation", and set appearance traits and style.',
            'Step 3 (In Chat): Send /scene in chat. The Scene Director AI analyzes recent dialogue and renders the illustration inline.',
          ],
        },
        {
          icon: Sparkles,
          title: '2. Any Base Model Family, Visual Styles & Unusual Characters',
          items: [
            'The Hub natively supports multi-reference edit models (FLUX Kontext, Qwen-Image-Edit), modern GGUF diffusion backbones (FLUX.1, Chroma/Kroma, Qwen-Image, Z-Image, SD 3.5), and specialized checkpoints/GGUFs (SDXL, Illustrious, Pony, Animagine, SD 1.5).',
            'Each family automatically receives its proper sampler (euler / euler_a / dpm++2m), CFG scale, step count, negative prompt rules, Pony score tags, and matched VAE / CLIP / T5 companions without breaking parameters when you switch models.',
            'For non-human or unusual characters (anthropomorphic/furry, elves, tieflings, dragonborn, cyborgs, anime or sci-fi designs), list species and anatomy in the English Appearance Prompt (or tap Vision Auto-describe to extract muzzle, ears, horns, wings, tail, fur/scales automatically) and pick a matching style preset.',
          ],
        },
        {
          icon: Cpu,
          title: '3. Understanding LoRA: Files, Architecture Matching & Local Training',
          items: [
            'Three File Types: A Base Model (server/models/image, 4–12 GB, .safetensors or .gguf) is the core painter engine. Companion Files (server/models/image_aux: VAE, CLIP, T5, Qwen) are its vision/text encoders (downloaded automatically in bundles). A LoRA file (server/models/loras, 20 MB up to several GB for high-rank DiTs, .safetensors) is a plug-in memory adapter trained for a specific character, unusual species, or art style.',
            'Why LoRAs matter: Specialized models like SDXL, Illustrious, Pony, Animagine, Chroma/Kroma, and SD 1.5 do not take raw reference photos directly during sampling — instead, character and style LoRAs teach them exact character designs, rare species anatomy, and distinct rendering styles.',
            'Architecture Compatibility Rule: Every LoRA matches its base model family: SDXL / Illustrious / Pony / Animagine LoRAs work with SDXL-family models; Flux LoRAs work with FLUX.1 and FLUX Kontext; Chroma / Kroma LoRAs work with Chroma and Kroma; SD 1.5 LoRAs work with SD 1.5. Switching base models to another family safely skips incompatible LoRAs without crashing.',
            'Local LoRA Training from Reference Photos: On a PC with 6+ GB VRAM, tap "Train LoRA on Server from Refs". Because quantized .gguf files are compressed for inference only, training runs on top of a full .safetensors checkpoint (SDXL, Illustrious, Pony, Animagine, or SD 1.5) in server/models/image. Once trained, the resulting .safetensors LoRA is saved to server/models/loras with its trigger word (e.g. slx_hero) and works during generation with both .safetensors and .gguf models of that same architecture.',
          ],
        },
        {
          icon: Camera,
          title: '4. When to Use Reference Photos vs LoRA',
          items: [
            'Use Reference Photos mode with FLUX Kontext, Qwen-Image-Edit, or Cloud multimodal models (Gemini Flash Image, GPT Image, FLUX.2) for instant zero-training likeness from 1–4 images.',
            'Use Character / Style LoRA mode when rendering on specialized checkpoints/GGUFs (Illustrious, Pony, Animagine, Chroma/Kroma, SDXL, SD 1.5) or when applying downloaded/trained .safetensors adapters.',
          ],
        },
        {
          icon: Layers,
          title: '5. /scene Commands, Camera Angles & Smart VRAM',
          items: [
            'Use /scene (or /сцена, /фото, /кадр) optionally followed by framing notes like "/scene close-up portrait" or "/scene from behind".',
            'Tap "Camera Angle" under any rendered scene for 1-tap angle presets while the image model stays warm in GPU memory. Sending your next regular chat message automatically restores your text LLM.',
          ],
        },
        {
          icon: Lock,
          title: '6. Location Anchor & Group Chats',
          items: [
            'The Scene Director locks room architecture, lighting, and character outfits ("Location Locked") so perspective changes stay in the exact same room.',
            'In group chats, /scene includes only group members whose cards have "Scene image generation" enabled.',
          ],
        },
        {
          icon: Monitor,
          title: '7. Local PC Hub vs Cloud Routing',
          items: [
            'On mobile under Settings -> Models & Routing, pick Local PC vs Cloud and default aspect ratio (3:4, 1:1, 4:3); local model bundles and companions are managed on the PC web dashboard.',
          ],
        },
      ];

  const guideNode = (
    <div
      onClick={onClose}
      className="fixed inset-0 z-[95] flex items-center justify-center p-3 sm:p-5 bg-black/85 animate-fade-in"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-lg max-h-[88vh] rounded-2xl bg-silk-900 border border-silk-700 flex flex-col overflow-hidden shadow-2xl"
      >
        <div className="flex items-center justify-between gap-3 px-4 py-3.5 border-b border-silk-800 bg-silk-950/70 shrink-0">
          <div className="flex items-center gap-2.5 min-w-0">
            <div className="p-1.5 rounded-xl bg-silk-800 border border-silk-700 text-slate-200 shrink-0">
              <BookOpen className="w-4 h-4" />
            </div>
            <div className="min-w-0">
              <h2 className="text-sm font-bold text-white truncate">
                {ru ? 'Полный гайд по генерации сцен' : 'Complete Scene Generation Guide'}
              </h2>
              <p className="text-[11px] text-slate-400 truncate">
                {ru
                  ? 'Настройка внешности, ракурсы, удержание фона и работа видеопамяти'
                  : 'Character likeness, camera angles, location locking & VRAM'}
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 rounded-xl text-slate-400 hover:text-white hover:bg-silk-800 shrink-0"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-4 space-y-3.5">
          {sections.map((sec, idx) => {
            const Icon = sec.icon;
            return (
              <div key={idx} className="p-3.5 rounded-xl bg-silk-950/60 border border-silk-800 space-y-2">
                <div className="flex items-center gap-2 text-xs font-semibold text-white">
                  <Icon className="w-4 h-4 text-slate-300 shrink-0" />
                  <span>{sec.title}</span>
                </div>
                <ul className="space-y-1.5 text-xs text-slate-300 leading-relaxed pl-1">
                  {sec.items.map((line, lineIdx) => (
                    <li key={lineIdx} className="flex gap-2">
                      <span className="text-slate-500 select-none">•</span>
                      <span>{line}</span>
                    </li>
                  ))}
                </ul>
              </div>
            );
          })}
        </div>

        <div className="px-4 py-3 border-t border-silk-800 bg-silk-950/70 flex justify-end shrink-0">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-1.5 rounded-xl bg-white text-black hover:bg-slate-200 text-xs font-semibold transition-colors"
          >
            {ru ? 'Закрыть гайд' : 'Close guide'}
          </button>
        </div>
      </div>
    </div>
  );

  return typeof document !== 'undefined' ? createPortal(guideNode, document.body) : guideNode;
};
