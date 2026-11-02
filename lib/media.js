// ffmpeg helpers: probe, template prep (trim/normalize/first frame), audio mux.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { spawnSync } from 'node:child_process';

// Pick a working ffmpeg/ffprobe: env override -> bundled static binary (only if it runs on this OS) -> system/Homebrew.
const works = (bin) => { try { return spawnSync(bin, ['-version'], { timeout: 5000 }).status === 0; } catch { return false; } };
async function pick(envVar, fallback, loadStatic) {
  if (process.env[envVar]) return process.env[envVar];
  try { const p = await loadStatic(); if (p && fs.existsSync(p) && works(p)) return p; } catch {}
  for (const c of [fallback, `/opt/homebrew/bin/${fallback}`, `/usr/local/bin/${fallback}`]) if (works(c)) return c;
  return fallback;
}
export const FFMPEG = await pick('FFMPEG_PATH', 'ffmpeg', async () => (await import('ffmpeg-static')).default);
const FFPROBE = await pick('FFPROBE_PATH', 'ffprobe', async () => (await import('ffprobe-static')).default?.path);

export const MAX_TEMPLATE_SECONDS = 10;
export const MIN_TEMPLATE_SECONDS = 3; // Kling O3 edit accepts 3–10s
const MIN_SHORT_SIDE = 720, MAX_ANY_SIDE = 2160;
const MAX_LONG_SIDE = 1280;

export function run(bin, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(bin, args);
    let out = '', err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('error', (e) => reject(new Error(`Could not run ${bin}: ${e.message}. Install ffmpeg (brew install ffmpeg) or run npm install.`)));
    p.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(`${path.basename(bin)} failed: ${err.slice(-600)}`))));
  });
}

export async function probe(file) {
  const json = JSON.parse(await run(FFPROBE, ['-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', file]));
  const v = json.streams.find((s) => s.codec_type === 'video');
  const a = json.streams.find((s) => s.codec_type === 'audio');
  let fps = 0;
  if (v?.r_frame_rate) { const [n, d] = v.r_frame_rate.split('/').map(Number); fps = d ? n / d : n; }
  // Respect rotation metadata (phone videos) so width/height reflect what you see.
  const rot = Math.abs(Number(v?.tags?.rotate || v?.side_data_list?.find((s) => s.rotation != null)?.rotation || 0));
  const swap = rot === 90 || rot === 270;
  return {
    hasVideo: !!v,
    hasAudio: !!a,
    duration: Number(json.format?.duration || v?.duration || 0),
    width: swap ? v?.height : v?.width,
    height: swap ? v?.width : v?.height,
    fps,
  };
}

const even = (n) => Math.max(2, Math.round(n / 2) * 2);

/**
 * Turn an uploaded clip into a template that video-edit models accept:
 *  clip.mp4   3–10s, short side ≥720px (Kling O3 edit minimum), long side ≤~1280 when possible, ≤30fps, h264/aac
 *  frame.jpg  first frame (template analysis + thumbnails)
 *  thumb.jpg  small preview
 */
export function targetSize(w, h) {
  let s = Math.min(1, MAX_LONG_SIDE / Math.max(w, h));
  s = Math.max(s, MIN_SHORT_SIDE / Math.min(w, h));        // never below 720 on the short side
  s = Math.min(s, MAX_ANY_SIDE / Math.max(w, h));          // and never above 2160 on the long side
  return { w: even(w * s), h: even(h * s) };
}

export async function prepareTemplate(inputPath, outDir) {
  fs.mkdirSync(outDir, { recursive: true });
  const info = await probe(inputPath);
  if (!info.hasVideo) throw new Error('That file has no video stream.');
  if (!(info.duration >= MIN_TEMPLATE_SECONDS)) throw new Error(`Clip is too short or not a video (min ${MIN_TEMPLATE_SECONDS}s).`);

  const duration = Math.min(info.duration, MAX_TEMPLATE_SECONDS);
  const { w, h } = targetSize(info.width, info.height);
  const fps = Math.min(Math.round(info.fps) || 30, 30);

  const clip = path.join(outDir, 'clip.mp4');
  await run(FFMPEG, [
    '-y', '-i', inputPath, '-t', String(duration),
    '-vf', `scale=${w}:${h}:flags=lanczos,fps=${fps}`,
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '19', '-pix_fmt', 'yuv420p', '-movflags', '+faststart',
    ...(info.hasAudio ? ['-c:a', 'aac', '-b:a', '128k'] : ['-an']),
    clip,
  ]);

  const frame = path.join(outDir, 'frame.jpg');
  await run(FFMPEG, ['-y', '-i', clip, '-frames:v', '1', '-q:v', '2', frame]);
  const thumb = path.join(outDir, 'thumb.jpg');
  await run(FFMPEG, ['-y', '-i', frame, '-vf', 'scale=360:-2', '-q:v', '4', thumb]);

  const final = await probe(clip);
  return { duration_s: Math.round(final.duration * 100) / 100, width: w, height: h, fps, has_audio: final.hasAudio, files: { clip, frame, thumb },
    tech: { src_short: Math.min(info.width, info.height), cuts: await countCuts(clip) } };
}

/** Older templates may be below 720px on the short side: make a compliant copy on demand. */
export async function ensureEditableClip(t) {
  if (Math.min(t.width, t.height) >= MIN_SHORT_SIDE) return t.files.clip;
  const { w, h } = targetSize(t.width, t.height);
  const out = path.join(path.dirname(t.files.clip), 'clip720.mp4');
  if (!fs.existsSync(out)) await run(FFMPEG, ['-y', '-i', t.files.clip, '-vf', `scale=${w}:${h}:flags=lanczos`, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '19', '-pix_fmt', 'yuv420p', '-c:a', 'copy', '-movflags', '+faststart', out]);
  return out;
}

/** 6 evenly spaced frames tiled 3x2 (for the vision model). */
export async function contactSheet(clipPath, durationS, outPath) {
  const fps = 6 / Math.max(durationS, 1);
  await run(FFMPEG, ['-y', '-i', clipPath, '-vf', `fps=${fps},scale=360:-2,tile=3x2`, '-frames:v', '1', '-q:v', '3', outPath]);
  return outPath;
}

/** If the generated video lost its audio, put the template's original audio back. */
export async function ensureAudio(videoPath, audioSourcePath, outPath) {
  const [v, a] = await Promise.all([probe(videoPath), probe(audioSourcePath)]);
  if (v.hasAudio || !a.hasAudio) { fs.copyFileSync(videoPath, outPath); return false; }
  await run(FFMPEG, ['-y', '-i', videoPath, '-i', audioSourcePath, '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'copy', '-c:a', 'aac', '-shortest', '-movflags', '+faststart', outPath]);
  return true;
}

/** Map a width/height to the closest aspect ratio Nano Banana accepts. */
export function nearestAspect(w, h) {
  const opts = ['21:9', '16:9', '3:2', '4:3', '5:4', '1:1', '4:5', '3:4', '2:3', '9:16'];
  const r = w / h;
  return opts.reduce((best, o) => {
    const [a, b] = o.split(':').map(Number);
    return Math.abs(Math.log(a / b / r)) < Math.abs(Math.log(best.r / r)) ? { o, r: a / b } : best;
  }, { o: '1:1', r: 1 }).o;
}

/** Hard camera cuts in a clip (ffmpeg scene-change score). Swaps drift across cuts. */
export function countCuts(clipPath, threshold = 0.4) {
  return new Promise((resolve) => {
    const p = spawn(FFMPEG, ['-hide_banner', '-i', clipPath, '-an', '-vf', `select='gt(scene,${threshold})',showinfo`, '-f', 'null', '-']);
    let err = '';
    p.stderr.on('data', (d) => (err += d));
    p.on('error', () => resolve(null));
    p.on('close', () => resolve((err.match(/Parsed_showinfo.*pts_time/g) || []).length));
  });
}

/**
 * A light, scrubbable copy of a long source for the trimmer: preview.mp4 (long side 640, keyframe every 0.5s)
 * and strip.jpg (10 frames side by side).
 */
export async function makePreview(srcPath, outDir) {
  fs.mkdirSync(outDir, { recursive: true });
  const info = await probe(srcPath);
  if (!info.hasVideo) throw new Error('That file has no video stream.');
  if (!(info.duration >= MIN_TEMPLATE_SECONDS)) throw new Error(`That video is too short (min ${MIN_TEMPLATE_SECONDS}s).`);
  const s = Math.min(1, 640 / Math.max(info.width, info.height));
  const pw = even(info.width * s), ph = even(info.height * s);
  const preview = path.join(outDir, 'preview.mp4');
  await run(FFMPEG, ['-y', '-i', srcPath, '-vf', `scale=${pw}:${ph},fps=30`, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '28', '-g', '15', '-pix_fmt', 'yuv420p',
    ...(info.hasAudio ? ['-c:a', 'aac', '-b:a', '96k'] : ['-an']), '-movflags', '+faststart', preview]);
  const strip = path.join(outDir, 'strip.jpg');
  const th = 120, tw = even(th * info.width / info.height);
  const n = Math.max(10, Math.min(40, Math.ceil(info.duration / 3))); // ~1 frame per 3s so the zoomed trimmer stays readable
  await run(FFMPEG, ['-y', '-i', preview, '-vf', `fps=${n}/${Math.max(info.duration, 1)},scale=${tw}:${th},tile=${n}x1`, '-frames:v', '1', '-q:v', '4', strip]);
  return { duration_s: Math.round(info.duration * 100) / 100, width: info.width, height: info.height, strip_frames: n, files: { preview, strip } };
}

/** Frame-accurate cut of [start, end] from a source, before template prep. */
export async function cutClip(srcPath, start, end, outPath) {
  await run(FFMPEG, ['-y', '-ss', String(start), '-i', srcPath, '-t', String(Math.max(0.1, end - start)),
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '16', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '160k', outPath]);
  return outPath;
}

/** One still from the trimmer preview (cached), for the first/last frame tiles. */
export async function frameAt(previewPath, t, outDir) {
  const key = (Math.round(t * 10) / 10).toFixed(1);
  const out = path.join(outDir, `f${key}.jpg`);
  if (!fs.existsSync(out)) { fs.mkdirSync(outDir, { recursive: true }); await run(FFMPEG, ['-y', '-ss', key, '-i', previewPath, '-frames:v', '1', '-q:v', '4', out]); }
  return out;
}
