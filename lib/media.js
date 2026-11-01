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

export const MAX_TEMPLATE_SECONDS = 10; // Kling "image" orientation caps reference video at 10s
export const MIN_TEMPLATE_SECONDS = 2;
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
 * Turn an uploaded clip into a template:
 *  clip.mp4      – trimmed (≤10s), long side ≤1280, ≤30fps, h264/aac  → Kling reference video
 *  wan16.mp4     – same clip at 16fps, no audio                      → Wan input (fal bills Wan per 16 frames)
 *  frame.jpg     – exact first frame                                 → gets the subject edited in (Kling mode)
 *  thumb.jpg     – small preview
 */
export async function prepareTemplate(inputPath, outDir) {
  fs.mkdirSync(outDir, { recursive: true });
  const info = await probe(inputPath);
  if (!info.hasVideo) throw new Error('That file has no video stream.');
  if (!(info.duration >= MIN_TEMPLATE_SECONDS)) throw new Error(`Clip is too short or not a video (min ${MIN_TEMPLATE_SECONDS}s).`);

  const duration = Math.min(info.duration, MAX_TEMPLATE_SECONDS);
  const scale = Math.min(1, MAX_LONG_SIDE / Math.max(info.width, info.height));
  const w = even(info.width * scale), h = even(info.height * scale);
  const fps = Math.min(Math.round(info.fps) || 30, 30);

  const clip = path.join(outDir, 'clip.mp4');
  await run(FFMPEG, [
    '-y', '-i', inputPath, '-t', String(duration),
    '-vf', `scale=${w}:${h},fps=${fps}`,
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p', '-movflags', '+faststart',
    ...(info.hasAudio ? ['-c:a', 'aac', '-b:a', '128k'] : ['-an']),
    clip,
  ]);

  const wan = path.join(outDir, 'wan16.mp4');
  await run(FFMPEG, ['-y', '-i', clip, '-vf', 'fps=16', '-an', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p', wan]);

  const frame = path.join(outDir, 'frame.jpg');
  await run(FFMPEG, ['-y', '-i', clip, '-frames:v', '1', '-q:v', '2', frame]);

  const thumb = path.join(outDir, 'thumb.jpg');
  await run(FFMPEG, ['-y', '-i', frame, '-vf', 'scale=360:-2', '-q:v', '4', thumb]);

  const final = await probe(clip);
  return {
    duration_s: Math.round(final.duration * 100) / 100,
    width: w, height: h, fps,
    has_audio: final.hasAudio,
    files: { clip, wan, frame, thumb },
  };
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
