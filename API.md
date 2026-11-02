# twin meme maker: HTTP API

Local API behind the web app (`server.js`). The same calls will back the iMessage bot later.

- **Base URL:** `http://localhost:3000` (or `PORT` from `.env`)
- **Auth:** none (local only)
- **Format:** JSON in and out, except the two upload endpoints (`multipart/form-data`)
- **API version:** `6`, from `GET /api/settings`. The page refuses to run against an older server.
- **IDs:** 10-character hex strings, e.g. `ac56f38213`
- **Media URLs:** every `*_url` field is a path under `/media/…` served by the same server

## The flow

```
1. Template   POST /api/templates            upload a clip  ──► brief + fit rating (async)
   or pick    GET  /api/templates
   or remix   POST /api/renders/:id/remix    a finished meme becomes a protected template
2. Brief      PATCH /api/templates/:id       edit who gets replaced (main_subject) / what to keep (direction)
3. Persona    POST /api/personas             upload the replacement photo ──► clean + 3 angles (async)
4. Hybrid     POST /api/hybrids              frame 1 already transformed (async) ──► user approves by using it
5. Render     POST /api/renders              Kling O3 / Seedance 2.5 / both (async) ──► output video
6. Remix      POST /api/renders/:id/remix    back to step 2 with the output as the new template
```

Steps 1 to 5 are **asynchronous**: the POST returns immediately with `status`, and you poll the
matching `GET` every 1.5–2.5s until `status` is `done` or `failed`. There are no webhooks yet.

| Object | Poll with | In-progress statuses | Typical time |
|---|---|---|---|
| Template brief | `GET /api/templates` (`analyzing: true`) | - | 5–15s |
| Persona | `GET /api/personas/:id` | `queued → checking → cleaning → angles` | 30–60s |
| Hybrid | `GET /api/hybrids/:id` | `analyzing → queued → generating` | 20–40s |
| Render | `GET /api/renders/:id` | `queued → uploading → generating → finishing → [protecting]` | 2–8 min |

Jobs in flight when the server restarts are marked `failed` with `error: "Server restarted mid-…"`.

## Costs (fal list prices, USD)

| Step | Model | Cost |
|---|---|---|
| Brief (per analysis) | `openrouter/router/vision` (Gemini 2.5 Flash) | < $0.01 |
| Persona | Nano Banana edit + 3× Qwen Multiple Angles | ~$0.15 |
| Hybrid still | `fal-ai/nano-banana-pro/edit` | $0.15 |
| Render, Kling | `fal-ai/kling-video/o3/pro/video-to-video/edit` | $0.168 × clip seconds |
| Render, Seedance | `bytedance/seedance-2.5/reference-to-video` | $0.1323 (480p) or $0.2838 (720p) × 2 × clip seconds |
| Remix protection | vision boxes on 6 frames + local ffmpeg | < $0.01 |

Estimates per template are in `est_cost` and `hybrid_cost` (see Template).

---

## Settings

### `GET /api/settings`

```json
{
  "mock": false,
  "has_key": true,
  "seedance_resolution": "480p",
  "engines": {
    "kling":    { "id": "fal-ai/kling-video/o3/pro/video-to-video/edit", "name": "Kling O3" },
    "seedance": { "id": "bytedance/seedance-2.5/reference-to-video",     "name": "Seedance 2.5" }
  },
  "api_version": 6
}
```

`mock: true` (`MOCK_FAL=1`) runs every step without calling fal: the "outputs" are copies of the inputs.

---

## Templates

### Template object

```json
{
  "id": "ac56f38213",
  "title": "guy sitting on a chair with legs crossed with cat on his lap",
  "duration_s": 10,
  "width": 720,
  "height": 1280,
  "renders": 3,
  "created_at": "2026-11-02T02:26:20.953Z",
  "clip_url": "/media/templates/ac56f38213/clip.mp4",
  "thumb_url": "/media/templates/ac56f38213/thumb.jpg",
  "frame_url": "/media/templates/ac56f38213/frame.jpg",
  "brief": {
    "main_subject": "bald man in a white t-shirt and grey sweatpants sitting in a black office chair",
    "target_source": "auto",
    "keep": ["white t-shirt", "grey sweatpants", "black smartphone", "tabby cat"],
    "direction": "Keep his white t-shirt, grey sweatpants, black smartphone and the tabby cat unchanged.",
    "source": "auto",
    "fit": "good",
    "fit_reason": "The main character's head and hands are clearly visible throughout.",
    "error": null
  },
  "analyzing": false,
  "remix_of": null,
  "protect": false,
  "est_cost": { "kling": 1.68, "seedance": 2.65 },
  "hybrid_cost": 0.15
}
```

| Field | Meaning |
|---|---|
| `brief.main_subject` | **Who gets replaced.** `target_source: "user"` means a person set it; re-analysis keeps it. |
| `brief.keep`, `brief.direction` | **What stays.** `direction` is the editable sentence sent with every hybrid/render; `source: "user"` means it was edited. |
| `brief.fit`, `brief.fit_reason` | **Template rating:** `good` / `ok` / `poor`, meaning one clear character with head and hands visible. `null` until analyzed. |
| `analyzing` | Brief is being (re)generated; poll `GET /api/templates`. |
| `remix_of`, `protect` | Set on remix templates: the render it came from, and that renders composite only the target's region back into it. |

Clips are normalized on upload: trimmed to **3–10s**, short side **≥720px**, ≤30fps, H.264/AAC.

### `GET /api/templates`

All live templates, newest first. Returns `Template[]`.

### `POST /api/templates` (multipart)

| Field | Required | |
|---|---|---|
| `video` | yes | Video file (mp4/mov…, ≤300MB, ≥3s) |
| `title` | no | Defaults to the file name |
| `direction` | no | "What to keep". If given, it is kept and the analysis fills in the rest. |

Returns the Template with `analyzing: true`. Errors `400`: not a video, too short.

```bash
curl -F video=@party.mp4 -F title="Guy serving cake" localhost:3000/api/templates
```

### `PATCH /api/templates/:id` (JSON)

| Field | Effect |
|---|---|
| `title` | Rename |
| `direction` | Save "what to keep" as this template's default |
| `main_subject` | Change **who gets replaced**. Re-runs the analysis around that target (`analyzing: true`) so other characters move into `keep`, and resets the remix protection region. |
| `status: "retired"` | Hide from the list |

```bash
curl -X PATCH -H 'Content-Type: application/json' \
  -d '{"main_subject":"the tabby cat on his lap"}' localhost:3000/api/templates/ac56f38213
```

### `POST /api/templates/:id/analyze`

Re-runs the brief synchronously (5–15s) and returns the Template. A user-set `main_subject` is kept;
`direction` is regenerated.

---

## Personas (the replacement: pet or person)

### Persona object

```json
{
  "id": "2d92b31236",
  "status": "done",
  "error": null,
  "warnings": [],
  "subject_check": {
    "kind": "animal",
    "description": "black and white cat with green eyes and pink nose",
    "count": 1, "face_visible": true, "face_coverings": [],
    "body": "upper_body", "quality": "good", "issues": []
  },
  "cost_usd": 0.15,
  "original_url": "/media/personas/2d92b31236/original.jpeg",
  "clean_url": "/media/personas/2d92b31236/clean.png",
  "angles": [
    { "key": "three_quarter_left", "label": "¾ view", "url": "/media/personas/2d92b31236/three_quarter_left.png" },
    { "key": "profile", "label": "side", "url": "/media/personas/2d92b31236/profile.png" },
    { "key": "three_quarter_right", "label": "¾ other side", "url": "/media/personas/2d92b31236/three_quarter_right.png" }
  ]
}
```

`subject_check.kind` decides the transformation: `animal` gives the animal's head plus fur paws on
the character, `human` gives a head/face swap. `warnings` flag photos likely to give weak results
(several subjects, hidden face, blurry). An angle view that fails adds a warning but doesn't fail
the persona.

### `POST /api/personas` (multipart)

| Field | Required | |
|---|---|---|
| `image` | yes | One clear face. For pets, having the front legs in view helps. |

Returns the Persona (`status: "queued"`). Poll `GET /api/personas/:id`.

### `GET /api/personas/:id`

### `POST /api/personas/:id/rebuild`

Regenerates the clean portrait and angles from the same photo. `409` if already building.

---

## Hybrid stills (preview before paying for video)

A hybrid is the template's **first frame with the main character already transformed**. The video
models copy it, so it is the single best predictor of the final result. Create as many as needed;
**approving one means passing its `id` to `POST /api/renders`**.

### Hybrid object

```json
{
  "id": "de6a4f6e86",
  "template_id": "ac56f38213",
  "persona_id": "2d92b31236",
  "status": "done",
  "error": null,
  "image_url": "/media/hybrids/de6a4f6e86/hybrid.png",
  "prompt": "Image 1 is a frame from a video. The other images show one cat …",
  "cost_usd": 0.15,
  "took_s": 24
}
```

### `POST /api/hybrids` (JSON)

| Field | Required | |
|---|---|---|
| `template_id` | yes | |
| `persona_id` | yes | Persona must be `done` (else `409`) |
| `direction` | no | Overrides the template's "what to keep" for this still |
| `notes` | no | Extra one-off instruction, e.g. "make the head a bit smaller" |

Returns the Hybrid. If the template has never been analyzed, `status` starts at `analyzing`.

### `GET /api/hybrids/:id`

---

## Renders (the meme video)

### Render object

```json
{
  "id": "e1d3a75501",
  "group_id": null,
  "template_id": "ac56f38213",
  "persona_id": "8f463e064c",
  "engine": "kling",
  "engine_name": "Kling O3",
  "status": "done",
  "plan": [["uploading","Uploading"],["generating","Generating with Kling O3"],["finishing","Adding original audio"],["done","Done"]],
  "queue_position": null,
  "direction": "Keep his white t-shirt, … and the tabby cat unchanged.",
  "prompt": "Edit the video: @Image1 is the first frame of the video with …",
  "error": null,
  "est_cost_usd": 1.68,
  "cost_usd": 1.68,
  "latency_s": 412,
  "created_at": "2026-11-02T06:10:03.120Z",
  "output_url": "/media/renders/e1d3a75501/output.mp4",
  "persona": { "…": "Persona object" },
  "hybrid":  { "…": "Hybrid object" },
  "protect": null
}
```

| Field | Meaning |
|---|---|
| `plan` | Ordered `[status, label]` steps for progress UI. Includes `protecting` on remix templates. |
| `queue_position` | fal queue position while `generating`, if reported. |
| `prompt` | Exact prompt sent to the video model. |
| `group_id` | Shared by the two renders of a `compare` request. |
| `protect` | Remix only: `{ region: {x,y,w,h}, error, full_url }`. `full_url` is the unprotected render; `error` means the region couldn't be found and `output_url` is the full render. |

### `POST /api/renders` (JSON)

| Field | Required | |
|---|---|---|
| `template_id` | yes | |
| `hybrid_id` | yes | A `done` hybrid **of this template** (else `409`) |
| `engine` | no | `kling` (default), `seedance`, or `compare` (both, side by side) |
| `direction` | no | Defaults to the template's `brief.direction` |

Returns `Render[]`: one item, or two for `compare`. Poll each `GET /api/renders/:id`.

```bash
curl -H 'Content-Type: application/json' \
  -d '{"template_id":"ac56f38213","hybrid_id":"de6a4f6e86","engine":"compare"}' \
  localhost:3000/api/renders
```

### `GET /api/renders/:id`

### `GET /api/renders`

The 24 most recent **finished** renders (those with `output_url`), newest first.

### `POST /api/renders/:id/remix` (JSON)

Turns a finished render's video into a new **protected** template, for chained edits like "now
replace the cat on his lap with me".

| Field | Required | |
|---|---|---|
| `target` | recommended | Who to replace in the remix, e.g. `"the tabby cat on his lap"`. Sets `brief.main_subject` with `target_source: "user"`. |

Returns the new Template (`protect: true`, `remix_of: <render id>`, `analyzing: true`). Continue
from step 3. On render, a vision model boxes the target across 6 frames, and only that padded region
(soft-edged) of the new render is composited back, so everything else stays pixel-identical to the
source meme. A person's photo on an animal target gives a human head on the animal's body.

---

## Errors

Non-2xx responses carry `{ "error": "<message>" }`.

| Code | When |
|---|---|
| `400` | Missing/invalid upload (not a video/image, clip < 3s) |
| `404` | Unknown template / persona / hybrid / render. A 404 **without** a JSON body means the running server is older than the page: restart it. |
| `409` | Prerequisite not ready: persona still building, hybrid missing or for another template, already building |

Failed async jobs end with `status: "failed"` and a human-readable `error` (often the fal safety
filter or a model validation message).

---

## End-to-end example

```bash
B=localhost:3000; J='Content-Type: application/json'
T=$(curl -s -F video=@party.mp4 $B/api/templates | jq -r .id)
P=$(curl -s -F image=@my_cat.jpg $B/api/personas | jq -r .id)
# poll until persona done and template brief ready
until [ "$(curl -s $B/api/personas/$P | jq -r .status)" = done ]; do sleep 2; done
H=$(curl -s -H "$J" -d "{\"template_id\":\"$T\",\"persona_id\":\"$P\"}" $B/api/hybrids | jq -r .id)
until [ "$(curl -s $B/api/hybrids/$H | jq -r .status)" = done ]; do sleep 2; done
open "http://$B$(curl -s $B/api/hybrids/$H | jq -r .image_url)"     # approve by eye
R=$(curl -s -H "$J" -d "{\"template_id\":\"$T\",\"hybrid_id\":\"$H\"}" $B/api/renders | jq -r '.[0].id')
until [ "$(curl -s $B/api/renders/$R | jq -r .status)" = done ]; do sleep 5; done
curl -s $B/api/renders/$R | jq -r .output_url
# remix: replace someone else in the result
curl -s -H "$J" -d '{"target":"the tabby cat on his lap"}' $B/api/renders/$R/remix | jq .id
```

---

## Gaps before this backs the iMessage bot

| Gap | Why it matters for iMessage |
|---|---|
| No auth / users | Anyone on the network can call it. Needs per-sender identity (the phone number from Linq). |
| Polling only | Add webhooks or an event stream so the bot can reply when a job finishes instead of polling. |
| No `GET /api/templates/:id`, no list for personas/hybrids | The bot needs to fetch one object and resume a conversation's state. |
| No delete endpoints | Users should be able to delete their photos and personas (privacy). |
| No consent step for third-party faces | Replacing a friend needs their OK (e.g. a tapback in the group) before rendering. |
| JSON file store, local media | Move to Postgres/Supabase + object storage; keep the same object shapes. |
| No idempotency keys | A retried bot message could double-charge a render. |
| Restarts kill jobs | Use fal's queue IDs + webhooks so jobs resume after a restart. |
