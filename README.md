# bloop

Meme rooms for group chats. One link per group chat (iMessage, WhatsApp, SMS, anything): people join with
just a name, pick a template, put someone from the room (or a pet) in it, and share the video back to the chat.

Turn any clip into a meme template, drop in a pet or friend, and get the **"Cat Human" style** back:
their head (and, for pets, furry arms and paws) on the template character's body, with the same
clothes, props, motion and scene.

## Run it

Double-click **`start.command`** (macOS). It finds Node (20+), installs dependencies for this Mac,
picks a free port, opens the browser, and reloads the server when code changes.

Manual: `cp .env.example .env` (add `FAL_KEY`), `npm install`, `npm start` → http://localhost:3000.

- `/` is the mobile app (rooms). Open it on your phone over the same Wi-Fi at `http://<mac-ip>:3000`.
- `/studio` is the old single-user page, for debugging the engine.
`npm run mock` runs the whole flow without calling fal.

## Rooms (the app at `/`)

| Screen | What happens |
|---|---|
| Start a room | Group chat name + your name. You get the invite link (`/r/<slug>`) to drop in the chat. |
| Join | Name only, no sign-up. A member token is saved in the browser. |
| Room home | Pool balance chip, **Make a meme**, now-cooking cards, frame 1 drafts with likes, feed with Remix / Share. |
| Pick template | Search the shared + room library (each tile shows its usability score), upload a video, or **paste a link** (TikTok, YouTube, Instagram, X, Reddit, direct .mp4) with an optional start time. |
| Trim | Uploads and links open a trimmer: looping preview, filmstrip with start/end handles (3–10s), overview bar for long videos, and the first and last frame. |
| Template check | Usability score (0–100) with plain checks, who gets swapped (editable) and what's kept. **Use this template** or **Re-trim**. |
| Who's going in | Faces in the room, Take a selfie, Add someone (a member, who must approve, or a pet), optional note. |
| Frame 1 | The hybrid still (free). Room likes, Try again, Tweak, **Make video** (paid from the pool). |
| Result | Video plays; **Send to the chat** shares the .mp4 file (Web Share API), download fallback on desktop. |
| Pool | Balance, +$5/$10/$20, who chipped in, activity, daily limit per person. |

**Rules (server-enforced):**
- The room link is the only way in. Joining needs just a name; the browser keeps a member token. No phone or sign-up.
- Any member can make frame 1, like, make a video from the pool and top up.
- A selfie and a pet photo are usable right away. A photo of another member waits until that member approves it in the room.
- Price = fal cost × `BLOOP_MARKUP` (default 1). It's debited when the render starts and refunded automatically if it fails.
- New rooms get a `BLOOP_FREE_TRIAL_CENTS` credit (default $5). Daily limit per person defaults to 3.
- Top-ups are test payments for now.

### Usability score

| Check | Weight | Source |
|---|---|---|
| One clear main character | 30 | vision model, 0–10 |
| Face visible, front-ish, big enough | 30 | vision model, 0–10 |
| One continuous shot | 20 | ffmpeg scene-change detection (0 cuts = full, 1 = half, 2+ = none) |
| Source sharpness | 10 | original resolution (≥720p full, ≥480p 60%) |
| Length | 10 | ≥4s full |

80+ Great, 60–79 Good, 40–59 Risky, under 40 Poor. Older templates without vision sub-scores fall back to the good/ok/poor fit rating.

### Links → templates

`yt-dlp` downloads 2 minutes from the start time (`Start at`, or the link's own `?t=`) at ≤1080p into the trimmer,
then the chosen 3–10s is cut frame-accurately from that download and the normal template prep runs. If a site doesn't allow partial downloads, the whole video is
fetched and cut locally. Links to private networks are refused. `start.command` installs yt-dlp with Homebrew if it's missing.
Sites change often, so run `brew upgrade yt-dlp` when a link that used to work starts failing.
Private, login-only and age-restricted videos aren't supported.

## How the engine works

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

`data/db.json` holds the engine tables `templates`, `personas`, `hybrids`, `renders` and the room tables
`rooms`, `members`, `faces` (consent status), `likes` and `ledger` (every top-up, render debit, refund).
The shapes match a future Postgres schema one-to-one. Media is stored under `data/`.

## Removed in this version

The quality score, SAM outline preview, Wan 2.2, Kling motion control, frame-1 edit/verify and
face/person toggle are gone. They're in git history if needed.

## Hosting (Railway)

The repo deploys as one Docker container (Node 22 + ffmpeg + yt-dlp). See `Dockerfile` and `railway.json`.

1. Railway → New Project → Deploy from GitHub repo → pick this repo.
2. Service → Settings → **Volumes** → add a volume mounted at **`/app/data`** (holds `db.json` and every video/image).
3. Service → **Variables**:

| Variable | Value |
|---|---|
| `FAL_KEY` | your fal key |
| `ADMIN_PASSWORD` | protects `/studio`, the studio API and `/api/admin/*` (basic auth, any username) |
| `BLOOP_ACCESS_CODE` | needed to create a room; joining by link stays open |
| `TEST_TOPUPS` | `off`, so nobody can add free money to a pool |
| `BLOOP_FREE_TRIAL_CENTS` | credit each new room starts with, e.g. `500` |
| `BLOOP_ENGINE` | `kling` or `seedance` |

4. Settings → Networking → **Generate domain** (HTTPS, so the share sheet can send video files).

Add credit to a room: `curl -u :$ADMIN_PASSWORD -XPOST https://<domain>/api/admin/rooms/<slug>/credit -H 'content-type: application/json' -d '{"amount_cents":1000}'`.
List rooms: `curl -u :$ADMIN_PASSWORD https://<domain>/api/admin/rooms`.

Keep it at **one replica**: the JSON database and in-flight renders live in one process. A redeploy fails renders that are running
(they're refunded to the pool automatically). YouTube often blocks downloads from cloud servers; TikTok/Instagram/X/Reddit links usually work.
