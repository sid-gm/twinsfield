// Render pipeline (one pass, video-to-video): template clip + persona → hybrid meme.
//
// The model sees the WHOLE source video plus identity references and re-renders it with the main
// character turned into a hybrid: the persona's head (and, for animals, furry arms + paws) on the
// character's body, clothes, props and motion. Same mechanism as Higgsfield Genjutsu "replace"
// and the Seedance-based "Cat Human" template.
//
// The reference is the approved HYBRID STILL (frame 1 already transformed), never the raw pet photos:
// given a whole cat as reference, edit models paste the whole cat.
//   kling     fal-ai/kling-video/o3/pro/video-to-video/edit   hybrid → @Image1
//   seedance  bytedance/seedance-2.5/reference-to-video        hybrid → [Image1], face close-up → [Image2], clip → [Video1]
import fs from 'node:fs';
import path from 'node:path';
import { fal, MOCK, uploadFile, download, falError } from './fal.js';
import { ensureAudio, ensureEditableClip } from './media.js';
import { personaUrl } from './persona.js';
import { hybridUrl, animalWord } from './hybrid.js';

export { MOCK };
export const API_VERSION = 5; // the page warns if the running server is older than this

const SEEDANCE_RES = process.env.SEEDANCE_RESOLUTION === '720p' ? '720p' : '480p';
export const ENGINES = {
  kling: { id: 'fal-ai/kling-video/o3/pro/video-to-video/edit', name: 'Kling O3' },
  seedance: { id: 'bytedance/seedance-2.5/reference-to-video', name: 'Seedance 2.5' },
};
// fal list prices (Nov 2026). Seedance with a video reference bills (input + output seconds).
const PRICE = { kling: 0.168, seedance: { '480p': 0.1323, '720p': 0.2838 } };

export function estimateCost(t, engine) {
  const s = t.duration_s;
  const usd = engine === 'seedance' ? PRICE.seedance[SEEDANCE_RES] * s * 2 : PRICE.kling * s;
  return Math.round(usd * 100) / 100;
}

export function settings() {
  return { mock: MOCK, has_key: !!process.env.FAL_KEY, seedance_resolution: SEEDANCE_RES, engines: ENGINES, api_version: API_VERSION };
}

async function templateUrl(db, t, key, file) {
  const c = t.fal_urls?.[key];
  if (c && Date.now() - c.at < 20 * 3600 * 1000) return c.url;
  const url = await uploadFile(file);
  db.update('templates', t.id, { fal_urls: { ...(db.get('templates', t.id).fal_urls || {}), [key]: { url, at: Date.now() } } });
  return url;
}

// ---------- prompt ----------

/**
 * @param hyb    how the model names the hybrid still: '@Image1' (Kling) or '[Image1]' (Seedance)
 * @param face   optional name of a face close-up reference (Seedance '[Image2]')
 * @param video  how the model names the source clip: 'the video' (Kling) or '[Video1]' (Seedance)
 */
export function buildPrompt({ persona, brief, direction, hyb, face, video }) {
  const who = brief?.main_subject ? `the ${brief.main_subject.replace(/^the /i, '')}` : 'the main character';
  const animal = animalWord(persona);
  const look = animal
    ? `a human–${animal} hybrid: ${animal} head and face, fur-covered arms and paws for hands, human body and clothes`
    : 'the same person with a different head and face';
  const keep = (brief?.keep || []).length ? ` Keep unchanged: ${brief.keep.join(', ')}.` : '';
  return [
    `Edit ${video}: ${hyb} is the first frame of ${video} with ${who} already transformed into ${look}.`,
    `Apply exactly that transformation to ${who} in every frame: match ${hyb}'s head, face, fur${animal ? ', paws' : ''}, clothing and accessories precisely${face ? `, with facial detail from ${face}` : ''}.`,
    `The transformed character performs every motion, gesture, head turn and expression of the original, frame for frame, with the same timing.`,
    `Do not add any extra ${animal || 'person'} or body; only ${who} changes.`,
    `Keep the camera movement, background, lighting and all other people and animals exactly as in ${video}.${keep}`,
    `Photorealistic, natural ${animal ? 'fur' : 'skin'} and lighting, like real footage; no mask, costume or cut-out look.`,
    direction ? direction.trim() : '',
  ].join(' ');
}

// ---------- runner ----------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const planFor = (engine) => [['uploading', 'Uploading'], ['generating', `Generating with ${ENGINES[engine].name}`], ['finishing', 'Adding original audio'], ['done', 'Done']];

export function startRender(db, renderId, dataDir) { run(db, renderId, dataDir); }

async function run(db, renderId, dataDir) {
  const r = db.get('renders', renderId);
  const t = db.get('templates', r.template_id);
  const p = db.get('personas', r.persona_id);
  const dir = path.join(dataDir, 'renders', r.id);
  fs.mkdirSync(dir, { recursive: true });
  const abs = (f) => path.join(dataDir, f);
  const started = Date.now();
  const set = (patch) => db.update('renders', r.id, { ...patch, updated_at: new Date().toISOString() });
  const step = (status, extra = {}) => set({ status, ...extra });
  const onQueueUpdate = (u) => { if (u.status === 'IN_QUEUE') set({ queue_position: u.queue_position ?? null }); };

  try {
    const raw = path.join(dir, 'raw.mp4');
    if (MOCK || !process.env.FAL_KEY) {
      if (!MOCK) throw new Error('FAL_KEY is not set. Add it to .env (or run with MOCK_FAL=1).');
      step('uploading'); await sleep(500);
      step('generating', { prompt: r.prompt }); await sleep(2000);
      fs.copyFileSync(t.files.clip, raw);
    } else {
      step('uploading');
      const h = db.get('hybrids', r.hybrid_id);
      if (!h || h.status !== 'done') throw new Error('No approved hybrid still for this render.');
      const clip = await ensureEditableClip(t);
      const clipUrl = await templateUrl(db, t, path.basename(clip), clip);
      const hyb = await hybridUrl(db, h, dataDir);

      let res;
      if (r.engine === 'kling') {
        const prompt = buildPrompt({ persona: p, brief: t.brief, direction: r.direction, hyb: '@Image1', video: 'the video' });
        step('generating', { prompt });
        res = await fal.subscribe(ENGINES.kling.id, { input: { prompt, video_url: clipUrl, image_urls: [hyb], keep_audio: true }, logs: true, onQueueUpdate });
      } else {
        const faceUrl = await personaUrl(db, p, p.clean_path ? 'clean' : 'original', abs(p.clean_path || p.original_path));
        const prompt = buildPrompt({ persona: p, brief: t.brief, direction: r.direction, hyb: '[Image1]', face: '[Image2]', video: '[Video1]' });
        step('generating', { prompt });
        res = await fal.subscribe(ENGINES.seedance.id, {
          input: {
            prompt, video_urls: [clipUrl], image_urls: [hyb, faceUrl], resolution: SEEDANCE_RES, aspect_ratio: 'auto',
            duration: t.duration_s >= 4 ? String(Math.min(30, Math.round(t.duration_s))) : 'auto', generate_audio: false,
          },
          logs: true, onQueueUpdate,
        });
      }
      const url = res.data?.video?.url;
      if (!url) throw new Error('The model returned no video (it may have been blocked by a safety filter).');
      step('finishing', { fal_request_id: res.requestId });
      await download(url, raw);
    }
    const out = path.join(dir, 'output.mp4');
    await ensureAudio(raw, t.files.clip, out);
    fs.rmSync(raw, { force: true });
    step('done', { output_path: path.relative(dataDir, out), cost_usd: MOCK ? 0 : estimateCost(t, r.engine), latency_s: Math.round((Date.now() - started) / 1000) });
    db.update('templates', t.id, { renders: (db.get('templates', t.id).renders || 0) + 1, last_used_at: new Date().toISOString() });
  } catch (e) {
    console.error(`[render ${r.id}]`, e);
    step('failed', { error: falError(e), latency_s: Math.round((Date.now() - started) / 1000) });
  }
}
