// Persona: turn one uploaded photo into a clean, multi-view identity reference.
//   1. check     vision model: human / animal / object, face visible, quality
//   2. clean     Nano Banana: remove hats, sunglasses, masks, hands; front-facing head & shoulders, plain background
//   3. angles    Qwen Image Edit "Multiple Angles": ¾ left, profile, ¾ right of the clean portrait
// Kling 3.0 uses clean + angles as a face-consistency "element"; Wan and the frame edit use the clean portrait.
import fs from 'node:fs';
import path from 'node:path';
import { fal, MOCK, uploadFile, download, falError, visionJSON } from './fal.js';

export const PERSONA_MODELS = { clean: 'fal-ai/nano-banana/edit', angles: 'fal-ai/qwen-image-edit-2511-multiple-angles' };
const PRICE = { clean: 0.0398, angle: 0.035 }; // angle ≈ $0.035/MP at ~1MP
const ANGLES = [
  { key: 'three_quarter_left', label: '¾ view', h: 45 },
  { key: 'profile', label: 'side', h: 90 },
  { key: 'three_quarter_right', label: '¾ other side', h: 315 },
];

export const SUBJECT_PROMPT = `This photo was uploaded by a user who wants to put its subject into a meme video.
Return JSON with exactly these keys:
{
  "kind": "human" | "animal" | "object" | "other",
  "description": "<5-12 words, e.g. 'older man with grey beard wearing a baseball cap'>",
  "count": <int, number of distinct main subjects>,
  "face_visible": <bool, subject's face clearly visible>,
  "face_coverings": ["<things covering the head/face that should be removed for a clean reference: hat, cap, hood, sunglasses, mask, hand...; empty if none>"],
  "body": "full_body" | "upper_body" | "face_only" | "partial",
  "quality": "good" | "ok" | "poor",
  "issues": ["<short concrete problems, max 3>"]
}`;

function cleanPrompt(sub) {
  const cover = (sub.face_coverings || []).length ? ` In particular remove: ${sub.face_coverings.join(', ')}.` : '';
  if (sub.kind === 'human' || !sub.kind) {
    return 'Create a clean identity reference portrait of the exact same person from this photo.'
      + ' Remove anything covering the head or face: hats, caps, hoods, sunglasses, masks, headphones, hands, hair accessories.' + cover
      + ' Show their natural hair as it would look without headwear. Keep their face shape, facial features, facial hair, skin tone, hair color, eye color, age and all identifying marks identical.'
      + ' Neutral relaxed expression, looking straight into the camera, head and shoulders, plain light-gray studio background, soft even lighting, sharp focus, photorealistic.';
  }
  return `Create a clean identity reference portrait of this exact ${sub.description || sub.kind}.`
    + ' Keep its face, head shape, eye color, fur/skin colors and markings identical.' + cover
    + ' Remove collars, costumes or objects covering the head. Facing the camera, head and shoulders, plain light-gray studio background, soft even lighting, sharp focus, photorealistic.';
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Upload a persona image once and reuse the fal URL for ~a day. */
export async function personaUrl(db, persona, key, localPath) {
  const c = persona.fal_urls?.[key];
  if (c && Date.now() - c.at < 20 * 3600 * 1000) return c.url;
  const url = await uploadFile(localPath);
  const cur = db.get('personas', persona.id);
  db.update('personas', persona.id, { fal_urls: { ...(cur.fal_urls || {}), [key]: { url, at: Date.now() } } });
  return url;
}

export async function buildPersona(db, id, dataDir) {
  const p = db.get('personas', id);
  const dir = path.join(dataDir, 'personas', id);
  const rel = (f) => path.relative(dataDir, f);
  const set = (patch) => db.update('personas', id, { ...patch, updated_at: new Date().toISOString() });
  const warn = (w) => set({ warnings: [...(db.get('personas', id).warnings || []), w] });
  const started = Date.now();
  let cost = 0;
  set({ status: 'checking', warnings: [], error: null, angles: [], clean_path: null });

  try {
    const original = path.join(dataDir, p.original_path);
    if (MOCK || !process.env.FAL_KEY) {
      await sleep(600);
      set({ status: 'cleaning', subject_check: { kind: 'human', description: 'mock subject', face_visible: true, face_coverings: [] } });
      await sleep(600);
      const clean = path.join(dir, 'clean' + path.extname(original)); fs.copyFileSync(original, clean);
      set({ status: 'angles', clean_path: rel(clean) });
      await sleep(600);
      set({ angles: ANGLES.map((a) => { const f = path.join(dir, `${a.key}${path.extname(original)}`); fs.copyFileSync(original, f); return { key: a.key, label: a.label, path: rel(f) }; }) });
    } else {
      const origUrl = await personaUrl(db, p, 'original', original);

      let sub = { kind: 'human' };
      try {
        ({ json: sub } = await visionJSON({ prompt: SUBJECT_PROMPT, imageUrls: [origUrl] }));
        set({ subject_check: sub });
        if (sub.count > 1) warn('More than one subject in the photo: crop to one for best results.');
        if (sub.kind === 'human' && !sub.face_visible) warn("Face isn't clearly visible: likeness will suffer.");
        if (sub.quality === 'poor') warn('Low-quality photo (blurry/dark): results will suffer.');
      } catch (e) { warn(`Photo check skipped (${falError(e)})`); }

      set({ status: 'cleaning' });
      const cl = await fal.subscribe(PERSONA_MODELS.clean, { input: { prompt: cleanPrompt(sub), image_urls: [origUrl], num_images: 1, output_format: 'png', aspect_ratio: '3:4' } });
      const cleanUrl = cl.data?.images?.[0]?.url;
      if (!cleanUrl) throw new Error('Clean-up returned no image (possibly blocked by the safety filter).');
      const clean = await download(cleanUrl, path.join(dir, 'clean.png'));
      cost += PRICE.clean;
      db.update('personas', id, { fal_urls: { ...(db.get('personas', id).fal_urls || {}), clean: { url: cleanUrl, at: Date.now() } } });
      set({ status: 'angles', clean_path: rel(clean) });

      const results = await Promise.allSettled(ANGLES.map(async (a) => {
        const r = await fal.subscribe(PERSONA_MODELS.angles, {
          input: { image_urls: [cleanUrl], horizontal_angle: a.h, vertical_angle: 0, zoom: 6, num_images: 1, output_format: 'png',
            additional_prompt: 'same person/animal, same identity, plain light-gray background, soft even lighting, photorealistic' },
        });
        const url = r.data?.images?.[0]?.url;
        if (!url) throw new Error('no image');
        const f = await download(url, path.join(dir, `${a.key}.png`));
        return { key: a.key, label: a.label, path: rel(f), url };
      }));
      const angles = [];
      results.forEach((r, i) => { if (r.status === 'fulfilled') { angles.push(r.value); cost += PRICE.angle; } else warn(`${ANGLES[i].label} view failed (${falError(r.reason)})`); });
      const fu = { ...(db.get('personas', id).fal_urls || {}) };
      for (const a of angles) fu[a.key] = { url: a.url, at: Date.now() };
      set({ angles: angles.map(({ url, ...a }) => a), fal_urls: fu });
    }
    set({ status: 'done', cost_usd: Math.round(cost * 100) / 100, took_s: Math.round((Date.now() - started) / 1000) });
  } catch (e) {
    console.error('[persona]', e);
    set({ status: 'failed', error: falError(e) });
  }
}
