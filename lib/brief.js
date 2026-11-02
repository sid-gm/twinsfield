// Template brief: one vision pass over a 6-frame contact sheet that says WHO gets replaced
// and WHAT must stay (outfit, props, other people/animals). The brief becomes the template's
// default direction and is woven into the swap prompt.
import path from 'node:path';
import { contactSheet } from './media.js';
import { MOCK, uploadFile, visionJSON, falError } from './fal.js';

const PROMPT = `This image is a contact sheet of 6 frames (left-to-right, top-to-bottom) from one short video clip.
The clip is a meme TEMPLATE: an AI video editor will turn its MAIN character into a hybrid of a user's pet or friend
(the pet's/friend's head, and for animals their furry arms and paws) while keeping the main character's body, clothes, props, motion and the rest of the scene.
Return JSON with exactly these keys:
{
  "main_subject": "<who gets replaced, 6-14 words, specific enough to pick them out, e.g. 'bald man in a white t-shirt sitting cross-legged in an office chair'>",
  "keep": ["<things that must stay exactly as they are: clothing items, headwear/wigs/glasses worn on the head, held objects, other people/animals in the scene; max 6, concrete, e.g. 'curly blue wig', 'grey cat on his lap'>"],
  "direction": "<one sentence for the editor about what to keep, naming each item, e.g. 'Keep his curly blue wig on the new head, his black jacket, and the real grey cat on his lap unchanged.'>",
  "fit": "good" | "ok" | "poor",
  "fit_reason": "<one short sentence a non-expert understands: the biggest reason this clip will or won't swap well>",
  "scores": {
    "subject": <0-10: is there ONE clear main character who stays the focus? 10 = one obvious person/animal throughout, 0 = crowd or nobody>,
    "face": <0-10: is the main character's head/face visible, front-ish and big enough in most frames? 10 = clear face most of the clip, 0 = always hidden, tiny or from behind>
  }
}`;

const clamp = (n) => (Number.isFinite(Number(n)) ? Math.max(0, Math.min(10, Number(n))) : null);

export function fallbackBrief() {
  return { main_subject: null, keep: [], direction: 'Keep their clothes, everything they hold and the rest of the scene exactly as in the original.', fit: null, fit_reason: null, source: 'auto' };
}

const targetNote = (target) => `

IMPORTANT: the character to replace is FIXED by the user: "${target}". Set main_subject to that character (you may make the description more specific so it is unambiguous).
Every other character, including AI-edited ones such as an animal-headed person, is NOT replaced and must go in "keep" and "direction".`;

/** @param opts.target  user-chosen character to replace (remixes / overrides) */
export async function analyzeTemplate(t, opts = {}) {
  const target = opts.target || null;
  if (MOCK || !process.env.FAL_KEY) return { ...fallbackBrief(), main_subject: target || 'mock: the main character', fit: 'ok', fit_reason: 'mock mode', scores: { subject: 8, face: 7 }, source: target ? 'user' : 'auto' };
  try {
    const sheet = await contactSheet(t.files.clip, t.duration_s, path.join(path.dirname(t.files.clip), 'sheet.jpg'));
    const { json } = await visionJSON({ prompt: PROMPT + (target ? targetNote(target) : ''), imageUrls: [await uploadFile(sheet)] });
    return {
      main_subject: json.main_subject || target || null, target_source: target ? 'user' : 'auto',
      keep: Array.isArray(json.keep) ? json.keep.slice(0, 6) : [],
      direction: json.direction || fallbackBrief().direction,
      fit: json.fit || null, fit_reason: json.fit_reason || null, source: 'auto',
      scores: json.scores && typeof json.scores === 'object' ? { subject: clamp(json.scores.subject), face: clamp(json.scores.face) } : null,
    };
  } catch (e) {
    return { ...fallbackBrief(), main_subject: target, target_source: target ? 'user' : 'auto', error: falError(e) };
  }
}

/**
 * Usability score (0-100) shown before anyone spends money on a template.
 * Weights: main character 30, face visible 30, one continuous shot 20, source sharpness 10, length 10.
 * `checks` are plain-language lines with ok | warn | bad.
 */
export function usability(t) {
  const b = t.brief || {};
  if (t.analyzing && !b.fit && !b.scores) return { status: 'checking' };
  const fitN = { good: 8.5, ok: 6, poor: 3 }[b.fit];
  const subj = b.scores?.subject ?? fitN ?? null;
  const face = b.scores?.face ?? fitN ?? null;
  const cuts = t.tech?.cuts ?? null;
  const short = t.tech?.src_short ?? Math.min(t.width || 0, t.height || 0);
  const dur = t.duration_s || 0;
  const checks = [];
  let pts = 0, max = 0;
  const add = (weight, frac, state, label) => { if (frac == null) return; pts += weight * frac; max += weight; checks.push({ state, label }); };
  if (subj != null) add(30, subj / 10, subj >= 7 ? 'ok' : subj >= 4 ? 'warn' : 'bad', subj >= 7 ? 'One clear main character' : subj >= 4 ? 'Main character is a bit unclear' : 'No single clear main character');
  if (face != null) add(30, face / 10, face >= 7 ? 'ok' : face >= 4 ? 'warn' : 'bad', face >= 7 ? 'Face visible most of the time' : face >= 4 ? 'Face is small or turned away at times' : 'Face is hidden, tiny or turned away');
  if (cuts != null) add(20, cuts === 0 ? 1 : cuts === 1 ? 0.5 : 0, cuts === 0 ? 'ok' : cuts === 1 ? 'warn' : 'bad', cuts === 0 ? 'One continuous shot' : cuts === 1 ? '1 camera cut: the swap may slip' : `${cuts} camera cuts: trim to one shot`);
  if (short) add(10, short >= 720 ? 1 : short >= 480 ? 0.6 : 0.2, short >= 720 ? 'ok' : short >= 480 ? 'warn' : 'bad', short >= 720 ? `Sharp source (${short >= 1080 ? '1080p+' : '720p'})` : `Low resolution source (${short}p)`);
  if (dur) add(10, dur >= 4 ? 1 : 0.6, dur >= 4 ? 'ok' : 'warn', dur >= 4 ? `${dur.toFixed(1)}s long` : `Very short (${dur.toFixed(1)}s)`);
  if (!max) return { status: 'unknown' };
  const score = Math.round((pts / max) * 100);
  const label = score >= 80 ? 'Great' : score >= 60 ? 'Good' : score >= 40 ? 'Risky' : 'Poor';
  return { status: 'done', score, label, checks, tip: b.fit_reason || null, analyzed: !!(b.fit || b.scores) };
}
