// Render pipeline: template + subject photo -> new meme video via fal.
//
//   1. check subject   vision model classifies the photo (human / animal / object, face visible, quality)
//   2. build character (non-humans only) Nano Banana turns the pet/object into a human-shaped character
//                      in the template character's pose + outfit, on a plain background
//   kling mode:
//   3. edit frame      Nano Banana replaces the main character in the template's first frame
//   4. verify frame    vision model checks the original person is gone; one retry with a stronger prompt
//   5. animate         Kling 3.0 Motion Control animates the edited frame with the template's motion
//   wan mode:
//   3. animate         Wan 2.2 Animate Replace swaps the (character) image straight into the video
//   then: download, put original audio back.
import fs from 'node:fs';
import path from 'node:path';
import { fal, MOCK, uploadFile, download, falError, visionJSON } from './fal.js';
import { ensureAudio, nearestAspect } from './media.js';

export { MOCK };
const KLING_TIER = process.env.KLING_TIER === 'pro' ? 'pro' : 'standard';
const WAN_RES = ['480p', '580p', '720p'].includes(process.env.WAN_RESOLUTION) ? process.env.WAN_RESOLUTION : '480p';

export const MODELS = {
  edit: 'fal-ai/nano-banana/edit',
  kling: `fal-ai/kling-video/v3/${KLING_TIER}/motion-control`,
  wan: 'fal-ai/wan/v2.2-14b/animate/replace',
};
// USD list prices on fal (Oct 2026). Vision checks are fractions of a cent and ignored here.
const PRICE = { edit: 0.0398, kling: { standard: 0.126, pro: 0.168 }, wan: { '480p': 0.04, '580p': 0.06, '720p': 0.08 } };

export function estimateCost(template, mode) {
  const s = template.duration_s;
  // Wan input is pre-converted to 16fps, so billed "video seconds" (= frames/16) == real seconds.
  const usd = mode === 'wan' ? s * PRICE.wan[WAN_RES] : PRICE.edit + s * PRICE.kling[KLING_TIER];
  return Math.round(usd * 100) / 100;
}

export function settings() {
  return { mock: MOCK, has_key: !!process.env.FAL_KEY, kling_tier: KLING_TIER, wan_resolution: WAN_RES, models: MODELS };
}

// Upload template assets to fal storage once and reuse the URL for ~a day.
async function templateUrl(db, template, key) {
  const cached = template.fal_urls?.[key];
  if (cached && Date.now() - cached.at < 20 * 3600 * 1000) return cached.url;
  const url = await uploadFile(template.files[key]);
  db.update('templates', template.id, { fal_urls: { ...(template.fal_urls || {}), [key]: { url, at: Date.now() } } });
  return url;
}

// ---------- prompts ----------

const SUBJECT_PROMPT = `This photo was uploaded by a user who wants to put its subject into a meme video, replacing the video's main character.
Return JSON with exactly these keys:
{
  "kind": "human" | "animal" | "object" | "other",
  "description": "<5-12 words, e.g. 'tabby and white cat lying on an ottoman'>",
  "count": <int, number of distinct main subjects>,
  "face_visible": <bool, subject's face clearly visible and unobstructed>,
  "body": "full_body" | "upper_body" | "face_only" | "partial",
  "quality": "good" | "ok" | "poor",
  "issues": ["<short concrete problems, max 3>"]
}`;

function characterPrompt(subject, mainSubject, notes) {
  return [
    `Image 2 shows ${subject.description || 'an animal'}.`,
    `Create ONE photorealistic anthropomorphic character based on this exact ${subject.kind}: keep its face, head shape, eye color, fur/skin colors and markings identical so it is instantly recognizable as the same individual.`,
    'Give it a human-proportioned body: head, neck, shoulders, two arms with hands, torso, two legs.',
    `Pose it exactly like the main character in image 1${mainSubject ? ` (${mainSubject})` : ''}, wearing the same outfit as that character.`,
    'Plain light-gray studio background, soft even lighting, entire body visible, facing the camera, no other characters, no text.',
    notes ? `Extra direction: ${notes}` : '',
  ].join(' ');
}

function editPrompt({ mainSubject, notes, retryReason }) {
  return [
    'Image 1 is a still frame from a video. Image 2 shows a character.',
    `Replace ${mainSubject ? `the main character in image 1 (${mainSubject})` : 'the main character in image 1'} with the character from image 2.`,
    'The original person must be completely removed: no part of their face, hair or skin may remain.',
    "The new character takes exactly the same position, pose, size and orientation in the frame as the original. Do NOT paste it as a small cut-out, sticker, or on top of / next to the original person.",
    'Keep the new character clearly recognizable (face, fur, markings, hair) and match the scene lighting, color cast and grain.',
    'Keep the background, camera angle, framing, other people and every other detail of image 1 exactly the same. Photorealistic, one image.',
    retryReason ? `IMPORTANT: a previous attempt failed because: ${retryReason}. Fix that.` : '',
    notes ? `Extra direction: ${notes}` : '',
  ].join(' ');
}

const VERIFY_PROMPT = `Image 1 is an original video frame. Image 2 is an AI edit that was supposed to REPLACE the main character of image 1 with the character shown in image 3.
Return JSON with exactly these keys:
{
  "original_person_still_visible": <bool, the original main character's face/body is still clearly visible in image 2>,
  "replaced_in_place": <bool, the new character occupies the original character's position and pose>,
  "looks_pasted": <bool, the new character looks like a small sticker/cut-out rather than integrated>,
  "subject_recognizable": <bool, image 3's character is recognizable in image 2>,
  "notes": "<one short sentence on what is wrong, or 'ok'>"
}`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- runner ----------

export function startRender(db, renderId, dataDir) {
  run(db, renderId, dataDir); // fire and forget; client polls status
}

function basePlan(mode) {
  return mode === 'kling'
    ? [['uploading', 'Uploading'], ['checking_subject', 'Checking your photo'], ['editing_frame', 'Putting them in the scene'], ['verifying_frame', 'Verifying the swap'], ['animating', 'Animating with Kling 3.0'], ['finishing', 'Adding audio'], ['done', 'Done']]
    : [['uploading', 'Uploading'], ['checking_subject', 'Checking your photo'], ['animating', 'Swapping with Wan 2.2'], ['finishing', 'Adding audio'], ['done', 'Done']];
}
const CHARACTER_STEP = ['building_character', 'Turning them into a character'];

async function run(db, renderId, dataDir) {
  const r = db.get('renders', renderId);
  const t = db.get('templates', r.template_id);
  const dir = path.join(dataDir, 'renders', r.id);
  const started = Date.now();
  const rel = (p) => path.relative(dataDir, p);
  const set = (patch) => db.update('renders', r.id, { ...patch, updated_at: new Date().toISOString() });
  const step = (status, extra = {}) => set({ status, ...extra });
  const warn = (w) => set({ warnings: [...(db.get('renders', r.id).warnings || []), w] });
  const log = (m) => set({ logs: [...(db.get('renders', r.id).logs || []), m].slice(-30) });
  const mainSubject = t.qa?.vision?.main_subject || null;
  let extraCost = 0;

  let plan = basePlan(r.mode);
  set({ plan, warnings: [] });

  try {
    let outUrl;
    if (MOCK) {
      for (const [k] of plan.slice(0, -2)) { step(k); await sleep(700); }
      if (r.mode === 'kling') { fs.copyFileSync(t.files.frame, path.join(dir, 'edited_frame.jpg')); set({ edited_frame_path: rel(path.join(dir, 'edited_frame.jpg')) }); }
      fs.copyFileSync(t.files.clip, path.join(dir, 'raw.mp4'));
    } else {
      if (!process.env.FAL_KEY) throw new Error('FAL_KEY is not set. Add it to .env (or run with MOCK_FAL=1).');
      const onQueueUpdate = (u) => {
        if (u.status === 'IN_QUEUE') set({ queue_position: u.queue_position ?? null });
        if (u.status === 'IN_PROGRESS') u.logs?.forEach((l) => l?.message && log(l.message));
      };

      step('uploading');
      const subjectUrl = await uploadFile(r.subject_file);
      const frameUrl = await templateUrl(db, t, 'frame');

      // 1. What did the user give us?
      step('checking_subject');
      let subject = { kind: 'human' };
      try {
        ({ json: subject } = await visionJSON({ prompt: SUBJECT_PROMPT, imageUrls: [subjectUrl] }));
        set({ subject_check: subject });
        if (subject.count > 1) warn('Photo has more than one subject: the model may blend them. Crop to one.');
        if (subject.kind === 'human' && !subject.face_visible) warn("Face isn't clearly visible in the photo: likeness will suffer.");
        if (subject.quality === 'poor') warn('Low-quality photo (blurry/dark): results will suffer.');
      } catch (e) { warn(`Photo check skipped (${falError(e)})`); }

      // 2. Pets/objects -> human-shaped character so motion models have arms/legs to drive.
      let characterUrl = subjectUrl;
      if (subject.kind && subject.kind !== 'human') {
        plan = [...plan.slice(0, 2), CHARACTER_STEP, ...plan.slice(2)];
        step('building_character', { plan });
        const ch = await fal.subscribe(MODELS.edit, {
          input: { prompt: characterPrompt(subject, mainSubject, r.notes), image_urls: [frameUrl, subjectUrl], num_images: 1, output_format: 'png', aspect_ratio: nearestAspect(t.width, t.height) },
          logs: true, onQueueUpdate,
        });
        characterUrl = ch.data?.images?.[0]?.url;
        if (!characterUrl) throw new Error('Character generation returned no image (possibly blocked by the safety filter).');
        set({ character_path: rel(await download(characterUrl, path.join(dir, 'character.png'))) });
        extraCost += PRICE.edit;
      }

      if (r.mode === 'kling') {
        const clipUrl = await templateUrl(db, t, 'clip');

        // 3+4. Edit the first frame, verify, retry once.
        let editedUrl, editedPath, check = null, retryReason = null;
        const attempts = [];
        for (let attempt = 1; attempt <= 2; attempt++) {
          step('editing_frame', { edit_attempt: attempt });
          const ed = await fal.subscribe(MODELS.edit, {
            input: { prompt: editPrompt({ mainSubject, notes: r.notes, retryReason }), image_urls: [frameUrl, characterUrl], num_images: 1, output_format: 'png', aspect_ratio: nearestAspect(t.width, t.height) },
            logs: true, onQueueUpdate,
          });
          extraCost += attempt > 1 ? PRICE.edit : 0;
          editedUrl = ed.data?.images?.[0]?.url;
          if (!editedUrl) throw new Error('Image edit returned no image (possibly blocked by the safety filter).');
          editedPath = await download(editedUrl, path.join(dir, attempt === 1 ? 'edited_frame.png' : `edited_frame_${attempt}.png`));
          set({ edited_frame_path: rel(editedPath) });

          step('verifying_frame');
          try {
            ({ json: check } = await visionJSON({ prompt: VERIFY_PROMPT, imageUrls: [frameUrl, editedUrl, characterUrl] }));
          } catch (e) { check = null; warn(`Swap check skipped (${falError(e)})`); }
          const ok = !check || (!check.original_person_still_visible && check.replaced_in_place && !check.looks_pasted);
          attempts.push({ attempt, ok, check, path: rel(editedPath) });
          set({ edit_attempts: attempts });
          if (ok) break;
          retryReason = check.notes || 'the original person was still visible or the character looked pasted on';
          if (attempt === 2) warn(`Swap still imperfect after a retry: ${retryReason}`);
        }

        // 5. Animate.
        step('animating');
        const mv = await fal.subscribe(MODELS.kling, {
          input: { image_url: editedUrl, video_url: clipUrl, character_orientation: 'image', keep_original_sound: true, ...(r.notes ? { prompt: r.notes } : {}) },
          logs: true, onQueueUpdate,
        });
        outUrl = mv.data?.video?.url;
      } else {
        const clipUrl = await templateUrl(db, t, 'wan');
        step('animating');
        const res = await fal.subscribe(MODELS.wan, {
          input: { video_url: clipUrl, image_url: characterUrl, resolution: WAN_RES, video_quality: 'high' },
          logs: true, onQueueUpdate,
        });
        outUrl = res.data?.video?.url;
      }
      if (!outUrl) throw new Error('Model returned no video.');
      step('finishing');
      await download(outUrl, path.join(dir, 'raw.mp4'));
    }

    const out = path.join(dir, 'output.mp4');
    await ensureAudio(path.join(dir, 'raw.mp4'), t.files.clip, out);
    fs.rmSync(path.join(dir, 'raw.mp4'), { force: true });
    step('done', { output_path: rel(out), cost_usd: MOCK ? 0 : Math.round((estimateCost(t, r.mode) + extraCost) * 100) / 100, latency_s: Math.round((Date.now() - started) / 1000) });
    db.update('templates', t.id, { renders: (t.renders || 0) + 1, last_used_at: new Date().toISOString() });
  } catch (e) {
    console.error(`[render ${r.id}]`, e);
    step('failed', { error: falError(e), latency_s: Math.round((Date.now() - started) / 1000) });
  }
}
