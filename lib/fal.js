// Shared fal helpers: config, storage upload, download, vision LLM, error formatting.
import fs from 'node:fs';
import path from 'node:path';
import { fal } from '@fal-ai/client';

// Accept a few common names for the key (FAL_KEY is the official one).
process.env.FAL_KEY ||= process.env.fal_api || process.env.FAL_API || process.env.FAL_API_KEY || '';
export const MOCK = process.env.MOCK_FAL === '1';
if (process.env.FAL_KEY) fal.config({ credentials: process.env.FAL_KEY });
export { fal };

export const VISION_ENDPOINT = 'openrouter/router/vision';
export const VISION_MODEL = process.env.QA_MODEL || 'google/gemini-2.5-flash';

const MIME = { '.mp4': 'video/mp4', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.heic': 'image/heic' };
export async function uploadFile(p) {
  const file = new File([fs.readFileSync(p)], path.basename(p), { type: MIME[path.extname(p).toLowerCase()] || 'application/octet-stream' });
  return fal.storage.upload(file);
}

export async function download(url, out) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Download failed (${res.status}) for ${url}`);
  fs.writeFileSync(out, Buffer.from(await res.arrayBuffer()));
  return out;
}

export function falError(e) {
  const d = e?.body?.detail;
  if (Array.isArray(d)) return d.map((x) => x.msg || JSON.stringify(x)).join('; ');
  if (d) return typeof d === 'string' ? d : JSON.stringify(d);
  return e?.message || String(e);
}

/** Ask a vision model for strict JSON about one or more images. Returns { json, cost }. */
export async function visionJSON({ prompt, imageUrls, system }) {
  const res = await fal.subscribe(VISION_ENDPOINT, {
    input: {
      model: VISION_MODEL,
      prompt: `${prompt}\n\nRespond with ONLY a JSON object, no markdown fences, no commentary.`,
      image_urls: imageUrls,
      system_prompt: system || 'You are a meticulous video-production QA assistant. You judge source footage and photos for AI character-replacement. Be strict and concrete.',
      temperature: 0,
      max_tokens: 900,
    },
  });
  const text = String(res.data?.output || '').trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  const start = text.indexOf('{'), end = text.lastIndexOf('}');
  if (start < 0 || end < 0) throw new Error(`Vision model returned non-JSON: ${text.slice(0, 200)}`);
  return { json: JSON.parse(text.slice(start, end + 1)), cost: res.data?.usage?.cost ?? null };
}
