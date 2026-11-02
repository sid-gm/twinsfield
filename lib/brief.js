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
  "fit_reason": "<one short sentence: is there one clear main character with head and hands visible most of the time?>"
}`;

export function fallbackBrief() {
  return { main_subject: null, keep: [], direction: 'Keep their clothes, everything they hold and the rest of the scene exactly as in the original.', fit: null, fit_reason: null, source: 'auto' };
}

const targetNote = (target) => `

IMPORTANT: the character to replace is FIXED by the user: "${target}". Set main_subject to that character (you may make the description more specific so it is unambiguous).
Every other character, including AI-edited ones such as an animal-headed person, is NOT replaced and must go in "keep" and "direction".`;

/** @param opts.target  user-chosen character to replace (remixes / overrides) */
export async function analyzeTemplate(t, opts = {}) {
  const target = opts.target || null;
  if (MOCK || !process.env.FAL_KEY) return { ...fallbackBrief(), main_subject: target || 'mock: the main character', fit: 'ok', fit_reason: 'mock mode', source: target ? 'user' : 'auto' };
  try {
    const sheet = await contactSheet(t.files.clip, t.duration_s, path.join(path.dirname(t.files.clip), 'sheet.jpg'));
    const { json } = await visionJSON({ prompt: PROMPT + (target ? targetNote(target) : ''), imageUrls: [await uploadFile(sheet)] });
    return {
      main_subject: json.main_subject || target || null, target_source: target ? 'user' : 'auto',
      keep: Array.isArray(json.keep) ? json.keep.slice(0, 6) : [],
      direction: json.direction || fallbackBrief().direction,
      fit: json.fit || null, fit_reason: json.fit_reason || null, source: 'auto',
    };
  } catch (e) {
    return { ...fallbackBrief(), main_subject: target, target_source: target ? 'user' : 'auto', error: falError(e) };
  }
}
