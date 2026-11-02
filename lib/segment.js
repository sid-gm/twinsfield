// "What will be replaced" preview.
//  1. Target: a vision model boxes the main character on frame 1 (or the user clicks a person).
//  2. target.jpg: frame 1 with that box / click drawn on it (instant, local).
//  3. SAM 3 video (fal) tracks that one object through the clip and returns a highlighted video.
//     Falls back to a box-only overlay if SAM fails (and in mock mode).
import fs from 'node:fs';
import path from 'node:path';
import { FFMPEG, run } from './media.js';
import { fal, MOCK, uploadFile, download, falError, visionJSON } from './fal.js';

export const SAM_MODEL = 'fal-ai/sam-3/video';
const SAM_PRICE_PER_16_FRAMES = 0.005;

const BOX_PROMPT = `This is the first frame of a short video that will be used as a meme template.
An AI will replace the clip's MAIN character (the single most prominent, central, in-focus person or creature) with someone else.
Find that main character and return JSON:
{
  "box_2d": [ymin, xmin, ymax, xmax],   // tight box around the main character's whole visible body, normalized 0-1000
  "label": "<5-10 word description of the main character>",
  "confidence": "high" | "medium" | "low",
  "other_people": <int, other clearly visible people who could be confused with the main character>
}`;

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

async function autoTarget(t, frameUrl) {
  if (MOCK || !process.env.FAL_KEY) {
    // Mock: centre box so the UI flow can be exercised.
    return { type: 'box', box: { x_min: Math.round(t.width * 0.25), y_min: Math.round(t.height * 0.2), x_max: Math.round(t.width * 0.75), y_max: Math.round(t.height * 0.9) }, label: 'mock: centre of frame', confidence: 'low', source: 'auto' };
  }
  const { json } = await visionJSON({ prompt: BOX_PROMPT, imageUrls: [frameUrl] });
  const [ymin, xmin, ymax, xmax] = (json.box_2d || []).map(Number);
  if (![ymin, xmin, ymax, xmax].every(Number.isFinite)) throw new Error('Vision model did not return a box');
  const box = {
    x_min: Math.round(clamp(xmin, 0, 1000) / 1000 * t.width), y_min: Math.round(clamp(ymin, 0, 1000) / 1000 * t.height),
    x_max: Math.round(clamp(xmax, 0, 1000) / 1000 * t.width), y_max: Math.round(clamp(ymax, 0, 1000) / 1000 * t.height),
  };
  return { type: 'box', box, label: json.label || null, confidence: json.confidence || null, other_people: json.other_people ?? null, source: 'auto' };
}

function drawFilter(target, w) {
  const th = Math.max(3, Math.round(w / 200));
  if (target.type === 'box') {
    const b = target.box;
    return `drawbox=x=${b.x_min}:y=${b.y_min}:w=${Math.max(2, b.x_max - b.x_min)}:h=${Math.max(2, b.y_max - b.y_min)}:color=0xC6FF3D@0.95:t=${th}`;
  }
  const r = Math.round(w / 40);
  return `drawbox=x=${target.point.x - r}:y=${target.point.y - r}:w=${r * 2}:h=${r * 2}:color=0xC6FF3D@0.95:t=fill`;
}

/** Run the full preview. `click` = {x, y} in clip pixels to override the auto target. */
export async function segmentTemplate(db, templateId, click) {
  const t = db.get('templates', templateId);
  const dir = path.dirname(t.files.clip);
  const set = (patch) => db.update('templates', t.id, { segment: { ...(db.get('templates', t.id).segment || {}), ...patch } });
  const rel = (p) => path.relative(path.resolve(dir, '..', '..'), p); // relative to data/
  const started = Date.now();
  set({ status: 'targeting', error: null, warning: null, started_at: new Date().toISOString() });

  try {
    let frameUrl = null, clipUrl = null;
    if (!MOCK && process.env.FAL_KEY) [frameUrl, clipUrl] = await Promise.all([uploadFile(t.files.frame), uploadFile(t.files.wan)]);

    const target = click
      ? { type: 'point', point: { x: Math.round(clamp(click.x, 0, t.width - 1)), y: Math.round(clamp(click.y, 0, t.height - 1)) }, label: 'picked by you', source: 'click' }
      : await autoTarget(t, frameUrl);

    const targetImg = path.join(dir, 'target.jpg');
    await run(FFMPEG, ['-y', '-i', t.files.frame, '-vf', drawFilter(target, t.width), '-q:v', '3', targetImg]);
    set({ status: 'tracking', target, target_path: rel(targetImg) });

    const out = path.join(dir, 'segment.mp4');
    let model = 'box-overlay', cost = 0;
    if (MOCK || !process.env.FAL_KEY) {
      await run(FFMPEG, ['-y', '-i', t.files.wan, '-vf', drawFilter(target, t.width), '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', out]);
    } else {
      try {
        const input = { video_url: clipUrl, apply_mask: true, prompt: '' };
        if (target.type === 'box') input.box_prompts = [{ ...target.box, object_id: 1 }];
        else input.point_prompts = [{ ...target.point, label: 1, object_id: 1 }];
        const res = await fal.subscribe(SAM_MODEL, { input, logs: true });
        const url = res.data?.video?.url;
        if (!url) throw new Error('SAM returned no video');
        await download(url, path.join(dir, 'segment_raw.mp4'));
        // Re-encode so every browser plays it and it loops cleanly.
        await run(FFMPEG, ['-y', '-i', path.join(dir, 'segment_raw.mp4'), '-an', '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', out]);
        fs.rmSync(path.join(dir, 'segment_raw.mp4'), { force: true });
        model = SAM_MODEL;
        cost = Math.round(Math.ceil((t.duration_s * 16) / 16) * SAM_PRICE_PER_16_FRAMES * 100) / 100;
      } catch (e) {
        // Still show *something*: the target box drawn over the clip.
        await run(FFMPEG, ['-y', '-i', t.files.wan, '-vf', drawFilter(target, t.width), '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', out]);
        set({ warning: `Tracking failed, showing the target box only (${falError(e)})` });
      }
    }
    set({ status: 'done', video_path: rel(out), model, cost_usd: cost, took_s: Math.round((Date.now() - started) / 1000), version: Date.now() });
  } catch (e) {
    console.error('[segment]', e);
    set({ status: 'failed', error: falError(e) });
  }
}
