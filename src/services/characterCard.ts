import type { Character } from '../types';

export interface ParsedCharacterCard {
  name: string;
  description: string;
  scenario: string;
  exampleDialogue: string;
  greeting: string;
  greetingEnabled: boolean;
  avatar?: string;
}

function decodeBase64Utf8(b64: string): string {
  const clean = b64.trim();
  const binary = atob(clean);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new TextDecoder('utf-8').decode(bytes);
}

function arrayBufferToDataUrl(bytes: Uint8Array, mime = 'image/png'): string {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return `data:${mime};base64,${btoa(binary)}`;
}

/** Extract the base64 `chara` tEXt metadata payload embedded inside a SillyTavern PNG card. */
export function extractCharaJsonFromPng(buffer: ArrayBuffer | Uint8Array): string | null {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  const pngSig = [137, 80, 78, 71, 13, 10, 26, 10];
  if (bytes.length < 24 || pngSig.some((v, idx) => bytes[idx] !== v)) {
    return null;
  }

  const decoder = new TextDecoder('latin1');
  let offset = 8;

  while (offset + 12 <= bytes.length) {
    const length =
      ((bytes[offset] << 24) |
        (bytes[offset + 1] << 16) |
        (bytes[offset + 2] << 8) |
        bytes[offset + 3]) >>>
      0;
    const type = decoder.decode(bytes.subarray(offset + 4, offset + 8));
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    if (dataEnd + 4 > bytes.length) break;

    if (type === 'tEXt') {
      const chunkBytes = bytes.subarray(dataStart, dataEnd);
      const nulIdx = chunkBytes.indexOf(0);
      if (nulIdx > 0) {
        const keyword = decoder.decode(chunkBytes.subarray(0, nulIdx)).toLowerCase();
        if (keyword === 'chara' || keyword === 'ccv3') {
          const b64 = decoder.decode(chunkBytes.subarray(nulIdx + 1));
          return decodeBase64Utf8(b64);
        }
      }
    }

    offset = dataEnd + 4;
  }

  return null;
}

/** Replace {{char}} / {{user}} placeholders cleanly when needed without breaking raw authoring. */
function cleanCardField(val: unknown): string {
  return typeof val === 'string' ? val.replace(/\r\n/g, '\n').trim() : '';
}

/** Parse either SillyTavern V2/V1 JSON or Silklora JSON into a Character draft. */
export function parseCharacterCardJson(rawText: string, avatarDataUrl?: string): ParsedCharacterCard {
  const parsed = JSON.parse(rawText) as Record<string, unknown>;
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('Invalid character card JSON');
  }

  // Handle CharaCard V2 / V3 wrapper (`{ spec: 'chara_card_v2', data: {...} }`) or Silklora export wrapper.
  const nested =
    parsed.data && typeof parsed.data === 'object'
      ? (parsed.data as Record<string, unknown>)
      : parsed.character && typeof parsed.character === 'object'
        ? (parsed.character as Record<string, unknown>)
        : parsed;

  const name = cleanCardField(nested.name);
  if (!name) {
    throw new Error('Character card is missing required name');
  }

  const baseDesc = cleanCardField(nested.description);
  const personality = cleanCardField(nested.personality);
  const combinedDesc =
    baseDesc && personality && !baseDesc.includes(personality)
      ? `${baseDesc}\n\n${personality}`
      : baseDesc || personality;

  const scenario = cleanCardField(nested.scenario);
  const exampleDialogue = cleanCardField(nested.mes_example ?? nested.exampleDialogue);
  const greeting = cleanCardField(nested.first_mes ?? nested.greeting);
  const greetingEnabled =
    typeof nested.greetingEnabled === 'boolean' ? nested.greetingEnabled : Boolean(greeting);

  const avatar =
    avatarDataUrl ||
    (typeof nested.avatar === 'string' && nested.avatar.startsWith('data:image/')
      ? nested.avatar
      : undefined);

  return {
    name,
    description: combinedDesc,
    scenario,
    exampleDialogue,
    greeting,
    greetingEnabled,
    avatar,
  };
}

/** Parse either a PNG card (embedding `chara` chunk + avatar image) or JSON card file bytes. */
export function parseCharacterCardFile(
  fileName: string,
  bytes: Uint8Array,
  mimeType = ''
): ParsedCharacterCard {
  const lowerName = fileName.toLowerCase();
  const isPng =
    mimeType === 'image/png' ||
    lowerName.endsWith('.png') ||
    (bytes.length >= 8 && bytes[0] === 137 && bytes[1] === 80 && bytes[2] === 78 && bytes[3] === 71);

  if (isPng) {
    const jsonStr = extractCharaJsonFromPng(bytes);
    if (!jsonStr) {
      throw new Error('PNG does not contain SillyTavern character metadata (chara chunk)');
    }
    const avatarDataUrl = arrayBufferToDataUrl(bytes, 'image/png');
    return parseCharacterCardJson(jsonStr, avatarDataUrl);
  }

  const text = new TextDecoder('utf-8').decode(bytes);
  return parseCharacterCardJson(text);
}

/** Serialize a Silklora Character to SillyTavern CharaCard V2 compatible JSON. */
export function exportCharacterCardV2Json(character: Character): string {
  const payload = {
    spec: 'chara_card_v2',
    spec_version: '2.0',
    data: {
      name: character.name,
      description: character.description,
      personality: '',
      scenario: character.scenario || '',
      first_mes: character.greeting || '',
      mes_example: character.exampleDialogue || '',
      creator_notes: 'Exported from SilkloraAI',
      tags: ['silklora'],
      extensions: {
        silklora: {
          greetingEnabled: character.greetingEnabled,
        },
      },
    },
  };
  return JSON.stringify(payload, null, 2);
}
