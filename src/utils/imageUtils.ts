/**
 * Client-side image validation, scaling, and JPEG encoding helpers so character reference packs,
 * LoRA training samples, and stored scene assets stay compact and universally supported
 * across sd-server / sd-cli, ComfyUI, Automatic1111, OpenRouter, and Gemini APIs.
 */

/**
 * Returns true ONLY for real raster data URLs (PNG, JPEG, WebP, BMP) and strictly rejects
 * SVG (`data:image/svg+xml`) or empty/corrupt strings that crash native diffusion loaders.
 */
export function isRasterImageDataUrl(url?: string | null): boolean {
  if (!url || typeof url !== 'string') return false;
  const trimmed = url.trim();
  if (!trimmed.startsWith('data:image/')) return false;
  if (/^data:image\/svg/i.test(trimmed)) return false;
  const commaIdx = trimmed.indexOf(',');
  if (commaIdx === -1) return false;
  const header = trimmed.slice(0, commaIdx).toLowerCase();
  if (!header.includes(';base64')) return false;
  const payload = trimmed.slice(commaIdx + 1).trim();
  if (payload.length < 2) return false;
  if (payload.startsWith('PHN2Zy') || payload.startsWith('PD94bWwg')) return false; // base64 "<svg" / "<?xml"
  return /^data:image\/(?:jpeg|jpg|png|webp|bmp|gif);base64$/i.test(header);
}

export async function fileToCompressedJpeg(
  file: Blob,
  maxDim = 1024,
  quality = 0.88
): Promise<string> {
  const objectUrl = URL.createObjectURL(file);
  try {
    return await loadAndCompressImage(objectUrl, maxDim, quality);
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

export async function compressDataUrlToJpeg(
  dataUrl: string,
  maxDim = 1280,
  quality = 0.88
): Promise<string> {
  if (!isRasterImageDataUrl(dataUrl)) return '';
  if (typeof Image === 'undefined' || typeof document === 'undefined') {
    return dataUrl;
  }
  try {
    return await loadAndCompressImage(dataUrl, maxDim, quality);
  } catch {
    return dataUrl;
  }
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return typeof btoa === 'function' ? btoa(binary) : '';
}

/**
 * Normalizes a rendered scene image (`data:image/*;base64,...` or `http(s)://...` URL such as
 * `/v1/images/files/...` on Local Hub or cloud CDN URLs) for persistence in `db.sceneAssets`
 * without ever wiping valid HTTP URLs to an empty string.
 */
export async function normalizeSceneOutputImage(
  src: string,
  maxDim = 1280,
  quality = 0.9
): Promise<string> {
  if (!src || typeof src !== 'string') return '';
  const trimmed = src.trim();
  if (!trimmed) return '';

  if (isRasterImageDataUrl(trimmed)) {
    const compressed = await compressDataUrlToJpeg(trimmed, maxDim, quality).catch(() => trimmed);
    return compressed || trimmed;
  }

  if (/^https?:\/\//i.test(trimmed)) {
    const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = ctrl ? setTimeout(() => ctrl.abort(), 10_000) : null;
    try {
      const res = await fetch(trimmed, ctrl ? { signal: ctrl.signal } : undefined);
      if (res.ok) {
        const blob = await res.blob();
        const rawMime = (blob.type || res.headers.get('content-type') || 'image/png').split(';')[0].trim().toLowerCase();
        if (rawMime.startsWith('image/') && !rawMime.includes('svg') && blob.size >= 4) {
          if (typeof Image !== 'undefined' && typeof document !== 'undefined' && typeof URL?.createObjectURL === 'function') {
            const jpeg = await fileToCompressedJpeg(blob, maxDim, quality).catch(() => '');
            if (jpeg) return jpeg;
          }
          const bytes = new Uint8Array(await blob.arrayBuffer());
          const b64 = bytesToBase64(bytes);
          if (b64) {
            const candidate = `data:${rawMime};base64,${b64}`;
            if (isRasterImageDataUrl(candidate)) return candidate;
          }
        }
      }
    } catch {
      // Keep original HTTP(S) URL when CORS or network prevents inline conversion
    } finally {
      if (timer) clearTimeout(timer);
    }
    return trimmed;
  }

  return trimmed;
}

function loadAndCompressImage(src: string, maxDim: number, quality: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const origW = img.naturalWidth || img.width || maxDim;
      const origH = img.naturalHeight || img.height || maxDim;
      const scale = Math.min(1, maxDim / Math.max(origW, origH));
      const w = Math.max(16, Math.round(origW * scale));
      const h = Math.max(16, Math.round(origH * scale));
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        reject(new Error('Canvas 2D context unavailable'));
        return;
      }
      ctx.fillStyle = '#121216';
      ctx.fillRect(0, 0, w, h);
      ctx.drawImage(img, 0, 0, w, h);
      resolve(canvas.toDataURL('image/jpeg', quality));
    };
    img.onerror = () => reject(new Error('Failed to decode image'));
    img.src = src;
  });
}

export function dimensionsForAspect(aspect?: 'portrait' | 'landscape' | 'square'): {
  width: number;
  height: number;
  aspectString: string;
} {
  if (aspect === 'landscape') {
    return { width: 1024, height: 768, aspectString: '4:3' };
  }
  if (aspect === 'square') {
    return { width: 896, height: 896, aspectString: '1:1' };
  }
  return { width: 768, height: 1024, aspectString: '3:4' };
}
