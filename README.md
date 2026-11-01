# twin: meme templater (MVP)

Turn any clip into a reusable **meme template**, then drop in a **selfie, a friend or a dog** and get a new AI meme video back.
This is the core loop that the iMessage bot (Linq) will wrap later.

## Run it

```bash
cd ~/Desktop/upgraded_twin
cp .env.example .env        # paste your FAL_KEY (https://fal.ai/dashboard/keys)
npm install
npm start                   # → http://localhost:3000
```

- Requires **Node 20+** (`brew install node`).
- ffmpeg ships via `ffmpeg-static` on install. If that fails, install it with `brew install ffmpeg`.
- **No key yet?** Run `npm run mock`. The whole flow works without calling fal: the "result" is just the template clip.

## How it works

1. **Make a template**: the upload is trimmed to ≤10s, scaled to a long side of ≤1280px and ≤30fps, and saved to `data/templates/<id>/`:
   - `clip.mp4`: the Kling motion reference, with original audio
   - `wan16.mp4`: a 16fps copy for Wan (fal bills Wan per 16 frames, so this keeps cost = real seconds)
   - `frame.jpg`: the exact first frame
2. **Drop someone in**: pick a template, upload an image, choose a mode:

| Mode | fal pipeline | Best for | ~cost (5s) |
|---|---|---|---|
| **Kling 3.0** (default) | `nano-banana/edit` puts the subject into frame 1, then `kling-video/v3/{standard,pro}/motion-control` animates that frame with the clip's motion (`character_orientation: image`, keeps original sound) | One main character | $0.67 std / $0.88 pro |
| **Wan 2.2** | `wan/v2.2-14b/animate/replace` swaps the subject directly into the video, then the original audio is muxed back in | Multi-person clips, keeping the scene exact | $0.20 @480p |

3. The output is saved to `data/renders/<id>/output.mp4`. For Kling renders, the edited frame is shown so you can see where a bad result came from.

## Quality controls

**Template score (on upload, or "Re-check")**: `lib/qa.js`
- ffmpeg metrics: hard scene cuts, motion intensity, average brightness
- A vision model (`openrouter/router/vision` on fal, default `google/gemini-2.5-flash`, fractions of a cent) reads a 6-frame contact sheet. It checks the number of prominent people, face visibility, subject size, occlusion, blur, lighting, camera shake and style.
- These combine into a 0–100 score: **A** (≥75), **B** (50–74), **C** (<50). The result also lists the issues, tips, and a recommended mode (Auto mode uses it). Without the vision pass, the score is capped at B and marked "metrics only".

**Render safeguards**: `lib/pipeline.js`
1. **Subject check:** the photo is classified as human, animal or object, and checked for a visible face and for quality. Problems are shown as warnings.
2. **Pet → character:** if the photo is an animal or object, Nano Banana first builds a human-shaped version of it (same face and fur, the template character's pose and outfit, plain background). Motion models need arms and legs to drive, so a loaf-shaped cat photo fails without this step.
3. **Swap verification (Kling):** a vision model compares the original and edited frames. If the original person is still visible or the subject looks pasted on, the edit retries once with the failure reason added to the prompt.

## Settings (`.env`)

| Var | Default | Notes |
|---|---|---|
| `FAL_KEY` | (none) | Required for live renders |
| `KLING_TIER` | `standard` | `pro` = higher quality, $0.168/s |
| `WAN_RESOLUTION` | `480p` | `580p` / `720p` cost more |
| `MOCK_FAL` | `0` | `1` = no fal calls |
| `QA_MODEL` | `google/gemini-2.5-flash` | Any vision model on fal's OpenRouter endpoint |

## Data model (JSON now, Postgres/Supabase later)

`data/db.json` holds two tables:
- **templates**: id, title, source, render_mode, duration_s, width, height, fps, has_audio, files, fal_urls (cached fal storage URLs), renders, last_used_at, status
- **renders**: id, template_id, mode, notes, status (`queued → uploading → editing_frame → animating → finishing → done|failed`), est_cost_usd, cost_usd, latency_s, fal_request_ids, error

## Known limits / next steps

- HEIC photos (iPhone default) may be rejected by fal. Export as JPG for now. Next: convert on upload.
- Kling needs a clearly visible, realistic main character (head + upper body). Pets work best in Wan mode or with a clear side or front pose.
- Renders in flight are lost if the server restarts. Next: fal webhooks + a real queue.
- **Next:** Linq webhook → same `POST /api/renders` path, template search by text (pgvector), group-chat prompt contributions, consent step.
