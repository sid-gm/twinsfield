// Hybrid still: the template's first frame with the main character already transformed
// (pet head + fur paws on the human body, or a friend's head for people), outfit/props/scene kept.
// This still — not the raw pet photos — is what the video model copies, so it never has a
// "whole cat" to paste. The user approves it before paying for video.
import fs from 'node:fs';
import path from 'node:path';
import { fal, MOCK, uploadFile, download, falError } from './fal.js';
import { nearestAspect } from './media.js';
import { personaUrl } from './persona.js';

export const HYBRID_MODEL = 'fal-ai/nano-banana-pro/edit';
export const HYBRID_PRICE = 0.15;

export function animalWord(persona) {
  const sc = persona?.subject_check || {};
  if (!sc.kind || sc.kind === 'human') return null;
  return sc.description?.match(/\b(cat|kitten|dog|puppy|rabbit|bunny|hamster|parrot|bird|fox|horse|pig|goat|monkey)\b/i)?.[1]?.toLowerCase() || sc.kind;
}

function hybridPrompt({ persona, brief, direction, notes }) {
  const sc = persona.subject_check || {};
  const who = brief?.main_subject ? `the ${brief.main_subject.replace(/^the /i, '')}` : 'the main character';
  const keep = (brief?.keep || []).length ? ` Keep exactly as they are: ${brief.keep.join(', ')}.` : '';
  const animal = animalWord(persona);
  const tail = [
    'Everything else in image 1 stays pixel-identical: background, lighting, camera angle, framing, every other person and animal.',
    'Photorealistic, natural lighting matching image 1, seamless blend, it must look like a real photo, not a mask, costume, sticker or cut-out.',
    direction ? `Also: ${direction}` : '', notes ? `Also: ${notes}` : '',
  ];
  if (!animal) {
    return [
      `Image 1 is a frame from a video. The other images show one person (${sc.description || 'the reference person'}).`,
      `Edit image 1: replace the head and face of ${who} with this person's head and face (same face, skin tone, hair and facial hair), keeping ${who}'s head angle, expression and position.`,
      `Keep ${who}'s body, pose, clothing, hands and everything they hold or wear, including headwear, wigs or glasses (place them on the new head).${keep}`,
      ...tail,
    ].join(' ');
  }
  return [
    `Image 1 is a frame from a video. The other images show one ${animal} (${sc.description || animal}) from different angles; use them ONLY as the reference for the ${animal}'s head, face, fur colors and markings.`,
    `Edit image 1: turn ${who} into a human–${animal} hybrid. Replace ONLY their head with this ${animal}'s head (same fur pattern, eye color, ears, nose, whiskers), at the same position, size, angle and direction as the original head, sitting naturally on the human neck.`,
    `Turn their visible hands and forearms into furry ${animal} paws and arms with matching fur, in exactly the same hand pose, still holding whatever the hands hold.`,
    `Keep their human body, posture, clothing and everything they wear or hold, including headwear, wigs or glasses (place them on the ${animal} head).${keep}`,
    `Do NOT add a whole ${animal}, a ${animal} body, ${animal} chest or extra legs anywhere.`,
    ...tail,
  ].join(' ');
}

export async function buildHybrid(db, id, dataDir) {
  const h = db.get('hybrids', id);
  const t = db.get('templates', h.template_id);
  const p = db.get('personas', h.persona_id);
  const dir = path.join(dataDir, 'hybrids', id);
  fs.mkdirSync(dir, { recursive: true });
  const set = (patch) => db.update('hybrids', id, { ...patch, updated_at: new Date().toISOString() });
  const started = Date.now();
  set({ status: 'generating', error: null });
  try {
    const prompt = hybridPrompt({ persona: p, brief: t.brief, direction: h.direction, notes: h.notes });
    set({ prompt });
    const out = path.join(dir, 'hybrid.png');
    if (MOCK || !process.env.FAL_KEY) {
      if (!MOCK) throw new Error('FAL_KEY is not set.');
      await new Promise((r) => setTimeout(r, 1200));
      fs.copyFileSync(t.files.frame, out);
    } else {
      const abs = (f) => path.join(dataDir, f);
      const frameUrl = await uploadFile(t.files.frame);
      const refs = [await personaUrl(db, p, p.clean_path ? 'clean' : 'original', abs(p.clean_path || p.original_path))];
      for (const a of (p.angles || []).filter((x) => x.key !== 'three_quarter_right').slice(0, 2)) refs.push(await personaUrl(db, p, a.key, abs(a.path)));
      const res = await fal.subscribe(HYBRID_MODEL, {
        input: { prompt, image_urls: [frameUrl, ...refs], num_images: 1, output_format: 'png', resolution: '1K', aspect_ratio: nearestAspect(t.width, t.height) },
      });
      const url = res.data?.images?.[0]?.url;
      if (!url) throw new Error('The image model returned nothing (possibly blocked by its safety filter).');
      await download(url, out);
      set({ fal_url: { url, at: Date.now() } });
    }
    set({ status: 'done', image_path: path.relative(dataDir, out), cost_usd: MOCK ? 0 : HYBRID_PRICE, took_s: Math.round((Date.now() - started) / 1000) });
  } catch (e) {
    console.error('[hybrid]', e);
    set({ status: 'failed', error: falError(e) });
  }
}

/** fal URL for an approved hybrid (re-upload if the cached one is old). */
export async function hybridUrl(db, h, dataDir) {
  if (h.fal_url && Date.now() - h.fal_url.at < 20 * 3600 * 1000) return h.fal_url.url;
  const url = await uploadFile(path.join(dataDir, h.image_path));
  db.update('hybrids', h.id, { fal_url: { url, at: Date.now() } });
  return url;
}
