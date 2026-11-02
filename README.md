# twin: meme maker

Turn any clip into a meme template, drop in a pet or friend, and get the **"Cat Human" style** back:
their head (and, for pets, furry arms and paws) on the template character's body, with the same
clothes, props, motion and scene.

## Run it

Double-click **`start.command`** (macOS). It finds Node (20+), installs dependencies for this Mac,
picks a free port, opens the browser, and reloads the server when code changes.

Manual: `cp .env.example .env` (add `FAL_KEY`), `npm install`, `npm start` → http://localhost:3000.
`npm run mock` runs the whole flow without calling fal.

## How it works

1. **Template:** the clip is trimmed to 3–10s, scaled so the short side is ≥720px (Kling O3's minimum),
   and capped at 30fps. A vision pass (`openrouter/router/vision`, Gemini Flash) writes a brief:
   who gets replaced, what to keep (clothes, held objects, other people/animals), and a fit rating.
   The "what to keep" text is editable and saved per template.
2. **Persona:** from one photo, a vision check, then Nano Banana makes a clean front portrait
   (removes hats, glasses, background), then Qwen Image Edit *Multiple Angles* makes ¾, side and
   other-¾ views. About $0.15.
3. **Hybrid still (~$0.15, you approve it):** Nano Banana Pro edits the template's first frame so the
   main character is already transformed: pet head and fur paws on the human body, or a friend's head,
   with outfit, wig and props kept. The pet photos are only used as a face/fur reference here.
   **Why:** when edit models get raw pet photos as the reference, they paste the whole animal (chest,
   legs and all) onto the person. The hybrid gives them a human-shaped target to copy.
   Templates without a brief are analyzed automatically first.
4. **Render, one video-to-video pass.** The model sees the whole clip plus the approved hybrid:

| Engine | fal endpoint | References | Price |
|---|---|---|---|
| **Kling O3 edit** (default) | `fal-ai/kling-video/o3/pro/video-to-video/edit` | hybrid as `@Image1` | $0.168/s |
| **Seedance 2.5** | `bytedance/seedance-2.5/reference-to-video` | hybrid `[Image1]`, clean face `[Image2]`, clip `[Video1]` | ~$0.13/s at 480p, billed on input+output seconds |
| **Compare** | both, side by side | | sum |

   The prompt adapts to the photo. **Animals** get a photoreal human–animal hybrid: animal head and
   fur, arms become furry front legs with paws, human body, clothes and props kept. **Humans** get a
   head/face swap with the body and outfit kept. "What to keep" is appended. The original audio is
   kept or muxed back in.

## Remix (chained edits)

**Remix this meme** (on any result or recent meme) turns a finished video into a new *protected*
template. You say who to replace, e.g. "the tabby cat on his lap". You can change it later in
"Gets replaced"; the brief is then re-analyzed around that target, so everyone else goes in "keep".
A person's photo on an animal target gives a human head on the animal's body.
After rendering, a vision model boxes the target in 6 frames, and ffmpeg pastes the new render back
**only inside that region, with a soft edge**. Everything else stays pixel-identical to the meme you
started from. The unprotected full render is kept and linked for comparison.

This is the same mechanism as Higgsfield Genjutsu's *replace* (source video + reference images +
prompt) and the viral "Cat Human" template (Seedance 2.5 + one pet photo).

## Data

`data/db.json` holds four tables: `templates` (clip, brief), `personas` (photo, clean, angles),
`hybrids` (approved first-frame stills) and `renders` (engine, prompt, status, cost). Media is stored under `data/`.

## Removed in this version

The quality score, SAM outline preview, Wan 2.2, Kling motion control, frame-1 edit/verify and
face/person toggle are gone. They're in git history if needed.
