// Protect a previous edit when remixing: only the region around the new target is replaced.
//  1. region   vision model boxes the target in 6 frames across the clip → union + padding (pixels)
//  2. composite ffmpeg pastes the remix render into the original clip inside that region with a
//              feathered (soft) edge; everything outside stays pixel-identical to the original.
import fs from 'node:fs';
import path from 'node:path';
import { FFMPEG, run, probe } from './media.js';
import { MOCK, uploadFile, visionJSON, falError } from './fal.js';

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const even = (n) => Math.max(2, Math.round(n / 2) * 2);

export async function findRegion(t, target) {
  if (MOCK || !process.env.FAL_KEY) {
    return { x: even(t.width * 0.2), y: even(t.height * 0.45), w: even(t.width * 0.6), h: even(t.height * 0.35), source: 'mock' };
  }
  const dir = path.join(path.dirname(t.files.clip), 'region');
  fs.mkdirSync(dir, { recursive: true });
  const urls = [];
  for (let i = 0; i < 6; i++) {
    const at = Math.min(t.duration_s - 0.05, (t.duration_s * i) / 5).toFixed(2);
    const f = path.join(dir, `f${i}.jpg`);
    await run(FFMPEG, ['-y', '-ss', at, '-i', t.files.clip, '-frames:v', '1', '-vf', 'scale=480:-2', '-q:v', '3', f]);
    urls.push(await uploadFile(f));
  }
  const { json } = await visionJSON({
    prompt: `These are 6 frames, in order, from one video. In EACH frame, find: ${target}.
Return JSON: {"boxes": [[ymin, xmin, ymax, xmax], ...]} with exactly 6 entries in frame order, each a tight box around that subject's whole visible body, normalized 0-1000; use null for a frame where it is not visible.`,
    imageUrls: urls,
  });
  const boxes = (json.boxes || []).filter((b) => Array.isArray(b) && b.length === 4 && b.every(Number.isFinite));
  if (!boxes.length) throw new Error(`Could not find "${target}" in the clip`);
  let [y0, x0, y1, x1] = [Math.min(...boxes.map((b) => b[0])), Math.min(...boxes.map((b) => b[1])), Math.max(...boxes.map((b) => b[2])), Math.max(...boxes.map((b) => b[3]))];
  const padX = (x1 - x0) * 0.15, padY = (y1 - y0) * 0.15;
  x0 = clamp(x0 - padX, 0, 1000); x1 = clamp(x1 + padX, 0, 1000); y0 = clamp(y0 - padY, 0, 1000); y1 = clamp(y1 + padY, 0, 1000);
  const x = even((x0 / 1000) * t.width), y = even((y0 / 1000) * t.height);
  return { x, y, w: even(Math.min(t.width - x, ((x1 - x0) / 1000) * t.width)), h: even(Math.min(t.height - y, ((y1 - y0) / 1000) * t.height)), frames_found: boxes.length, source: 'vision' };
}

/** Paste `remixPath` into `basePath` inside `region` (template pixels) with a soft edge. */
export async function compositeRegion(basePath, remixPath, region, outPath) {
  const b = await probe(basePath);
  const W = b.width, H = b.height, fps = Math.round(b.fps) || 30, dur = b.duration.toFixed(3);
  const feather = Math.max(4, Math.round(Math.min(region.w, region.h) * 0.08));
  // Inset the white box by the feather so the blur stays inside the region.
  const ix = region.x + feather, iy = region.y + feather, iw = Math.max(2, region.w - 2 * feather), ih = Math.max(2, region.h - 2 * feather);
  const filter = [
    `[1:v]scale=${W}:${H},fps=${fps},setpts=PTS-STARTPTS,format=yuva420p[o]`,
    `color=c=black:s=${W}x${H}:r=${fps}:d=${dur},drawbox=x=${ix}:y=${iy}:w=${iw}:h=${ih}:color=white:t=fill,gblur=sigma=${feather / 2},format=gray[m]`,
    `[o][m]alphamerge[oa]`,
    `[0:v]setpts=PTS-STARTPTS[b]`,
    `[b][oa]overlay=shortest=1:format=auto,format=yuv420p[v]`,
  ].join(';');
  await run(FFMPEG, ['-y', '-i', basePath, '-i', remixPath, '-filter_complex', filter, '-map', '[v]', '-map', '0:a?',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-c:a', 'aac', '-movflags', '+faststart', outPath]);
  return outPath;
}

export { falError };
