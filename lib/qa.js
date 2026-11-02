// Template quality scoring.
//  1) Local ffmpeg metrics: hard scene cuts, motion intensity, brightness.
//  2) Vision LLM on a 6-frame contact sheet: subject count, face visibility, size, occlusion, blur, lighting, camera.
//  3) Rule-based score (0-100) + grade (A/B/C) + plain-English issues + recommended render mode.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { FFMPEG, run } from './media.js';
import { MOCK, uploadFile, visionJSON, VISION_MODEL } from './fal.js';

function ffStderr(args) {
  return new Promise((resolve, reject) => {
    const p = spawn(FFMPEG, args);
    let err = '';
    p.stderr.on('data', (d) => (err += d));
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve(err) : reject(new Error(`ffmpeg failed: ${err.slice(-400)}`))));
  });
}

const r2 = (n) => Math.round(n * 100) / 100;

/** Scene-change scores (0..1 per frame) and average luma, sampled at 8fps on a small copy. */
export async function localMetrics(clipPath) {
  const log = await ffStderr(['-v', 'info', '-i', clipPath, '-vf',
    "fps=8,scale=320:-2,select='gte(scene,0)',metadata=print:key=lavfi.scene_score,signalstats,metadata=print:key=lavfi.signalstats.YAVG",
    '-an', '-f', 'null', '-']);
  const scene = [...log.matchAll(/lavfi\.scene_score=([\d.]+)/g)].map((m) => Number(m[1])).slice(1); // first frame is meaningless
  const luma = [...log.matchAll(/lavfi\.signalstats\.YAVG=([\d.]+)/g)].map((m) => Number(m[1]));
  const avg = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);
  const sorted = [...scene].sort((a, b) => a - b);
  return {
    scene_cuts: scene.filter((s) => s > 0.4).length,                 // hard cuts break motion transfer
    motion_avg: r2(avg(scene) * 100),                                // ~0-5 calm, 5-12 lively, >12 chaotic
    motion_p90: r2((sorted[Math.floor(sorted.length * 0.9)] || 0) * 100),
    brightness: Math.round(avg(luma)),                               // 0-255; <55 is dark
  };
}

/** 6 evenly spaced frames tiled 3x2, for the vision model. */
export async function contactSheet(clipPath, durationS, outPath) {
  const fps = 6 / Math.max(durationS, 1);
  await run(FFMPEG, ['-y', '-i', clipPath, '-vf', `fps=${fps},scale=360:-2,tile=3x2`, '-frames:v', '1', '-q:v', '3', outPath]);
  return outPath;
}

const VISION_PROMPT = `This image is a contact sheet of 6 frames (left-to-right, top-to-bottom) sampled from one short video clip.
The clip will be used as a meme TEMPLATE: an AI model will replace the clip's MAIN character with a person or pet from a user's photo, copying the main character's motion.
Judge how well this clip will work for that. Return JSON with exactly these keys:
{
  "main_subject": "<5-12 word description of the main character>",
  "prominent_people": <int, people large/central enough to be confused with the main character>,
  "subject_visibility": "full_body" | "upper_body" | "face_only" | "partial",
  "face_visible_ratio": <0..1, fraction of the 6 frames where the main character's face is clearly visible and unobstructed>,
  "subject_size": "large" | "medium" | "small",
  "occlusion": "none" | "some" | "heavy",
  "motion_blur": "none" | "some" | "heavy",
  "lighting": "good" | "ok" | "poor",
  "camera": "static" | "moderate" | "shaky",
  "style": "realistic" | "stylized",
  "signature_look": ["<what makes the main character recognizable in this meme besides their face: hair/wig, hat, glasses, costume, outfit, props; max 5, empty if nothing notable>"],
  "default_replace": "face" | "person",
  "default_direction": "<one sentence instruction for the swap, written to the editor, e.g. 'Replace only the face with this face; keep the blue wig, sunglasses and Hawaiian shirt.'>",
  "issues": ["<short concrete problems, max 5>"],
  "tips": ["<short concrete advice to get a better template, max 3>"]
}
default_replace: "face" when the character's look (costume, wig, props, outfit) is part of the joke and should stay; "person" when the meme is about the action/motion and anyone could do it.
Notes: colored stage lighting, strong backlight or darkness = poor lighting. Hands/objects covering the face = occlusion. A busy crowd near the subject counts toward prominent_people only if they are large/central.`;

/** Turn metrics + vision into score, grade, issues, recommended mode. */
export function score(metrics, v) {
  let s = 100;
  const issues = [];
  const hit = (pts, msg) => { s -= pts; if (msg) issues.push(msg); };

  if (metrics.scene_cuts > 0) hit(Math.min(40, 25 * metrics.scene_cuts), `${metrics.scene_cuts} hard cut(s): use one continuous shot`);
  if (metrics.motion_avg > 12) hit(15, 'Very fast motion / camera movement');
  else if (metrics.motion_avg > 7) hit(6, 'Lots of motion');
  if (metrics.brightness < 45) hit(15, 'Very dark footage');
  else if (metrics.brightness < 65) hit(6, 'Dim footage');

  if (v) {
    if (v.prominent_people > 1) hit(10, `${v.prominent_people} prominent people: the model may swap the wrong one`);
    if (v.face_visible_ratio < 0.5) hit(20, 'Main face hidden in most frames');
    else if (v.face_visible_ratio < 0.8) hit(10, 'Main face hidden in some frames');
    if (v.subject_size === 'small') hit(20, 'Main character is small in frame');
    else if (v.subject_size === 'medium') hit(5);
    if (v.occlusion === 'heavy') hit(20, 'Heavy occlusion (hands/objects over the subject)');
    else if (v.occlusion === 'some') hit(8, 'Some occlusion');
    if (v.motion_blur === 'heavy') hit(15, 'Heavy motion blur');
    else if (v.motion_blur === 'some') hit(7, 'Some motion blur');
    if (v.lighting === 'poor') hit(12, 'Poor / colored lighting');
    else if (v.lighting === 'ok') hit(4);
    if (v.camera === 'shaky') hit(8, 'Shaky camera');
    if (v.style === 'stylized') hit(10, 'Stylized / non-realistic footage');
    if (v.subject_visibility === 'partial') hit(12, 'Main character only partly in frame');
    else if (v.subject_visibility === 'face_only') hit(6, 'Only the face is visible (body motion is lost)');
    for (const i of v.issues || []) if (issues.length < 8 && !issues.some((x) => x.toLowerCase().includes(String(i).toLowerCase().slice(0, 12)))) issues.push(i);
  }

  s = Math.max(0, Math.min(100, Math.round(s)));
  const grade = s >= 75 ? 'A' : s >= 50 ? 'B' : 'C';
  // Kling animates one character from a still; Wan keeps the scene and copes better with crowds.
  const recommended_mode = v && (v.prominent_people > 1 || v.subject_size === 'small') ? 'wan' : 'kling';
  return { score: s, grade, issues: issues.slice(0, 8), tips: (v?.tips || []).slice(0, 3), recommended_mode };
}

export async function assessTemplate(template, dir) {
  const started = Date.now();
  const metrics = await localMetrics(template.files.clip);
  let vision = null, vision_error = null, cost = null;
  if (!MOCK && process.env.FAL_KEY) {
    try {
      const sheet = await contactSheet(template.files.clip, template.duration_s, path.join(dir, 'sheet.jpg'));
      const url = await uploadFile(sheet);
      ({ json: vision, cost } = await visionJSON({ prompt: VISION_PROMPT, imageUrls: [url] }));
    } catch (e) { vision_error = e.message; }
  }
  const result = score(metrics, vision);
  // Without the vision pass we can't see faces/occlusion/blur, so never claim an A.
  if (!vision) { result.partial = true; if (result.grade === 'A') { result.grade = 'B'; result.score = Math.min(result.score, 74); } result.issues.push('Metrics only: vision check did not run'); }
  result.defaults = defaultsFrom(vision);
  return { ...result, metrics, vision, vision_error, model: vision ? VISION_MODEL : null, cost_usd: cost, checked_at: new Date().toISOString(), took_s: Math.round((Date.now() - started) / 1000) };
}

/** Default swap instruction for a template (used to prefill "Direction"). */
export function defaultsFrom(v) {
  const look = (v?.signature_look || []).filter(Boolean);
  const replace = v?.default_replace === 'person' ? 'person' : 'face';
  const direction = v?.default_direction
    || (replace === 'face'
      ? `Replace only the face with this face; keep ${look.length ? 'the ' + look.join(', ') : 'the hair, outfit and props from the template'}.`
      : 'Replace the whole character with this person, keeping the same pose and motion.');
  return { replace, direction, signature_look: look, source: 'auto' };
}
