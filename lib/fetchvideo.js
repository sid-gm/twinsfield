// Download a clip from a link (TikTok, YouTube, Instagram, X, Reddit, direct .mp4, …) with yt-dlp,
// so it can become a template. Only the needed section is downloaded.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import dns from 'node:dns/promises';
import net from 'node:net';
import { FFMPEG, MAX_TEMPLATE_SECONDS, run as runMedia } from './media.js';

const works = (bin) => { try { return spawnSync(bin, ['--version'], { timeout: 8000 }).status === 0; } catch { return false; } };
const YTDLP = [process.env.YTDLP_PATH, 'yt-dlp', '/opt/homebrew/bin/yt-dlp', '/usr/local/bin/yt-dlp', `${process.env.HOME}/.local/bin/yt-dlp`].find((b) => b && works(b)) || null;
export const hasYtdlp = () => !!YTDLP;

// yt-dlp wants a real path to ffmpeg (a bare name fails); prefer the folder when ffprobe sits next to it.
function ffmpegLocation() {
  let bin = FFMPEG;
  if (!bin.includes(path.sep)) bin = spawnSync('sh', ['-c', `command -v ${bin}`]).stdout?.toString().trim() || bin;
  const dir = path.dirname(bin);
  return fs.existsSync(path.join(dir, 'ffprobe')) ? dir : bin;
}

/** "1:23", "83", "83s", "1m23s" → seconds */
export function parseTime(v) {
  if (v == null || v === '') return 0;
  const s = String(v).trim();
  if (/^\d+(\.\d+)?s?$/.test(s)) return parseFloat(s);
  const hms = s.match(/^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/);
  if (hms && s) return (+hms[1] || 0) * 3600 + (+hms[2] || 0) * 60 + (+hms[3] || 0);
  const parts = s.split(':').map(Number);
  if (parts.every((n) => Number.isFinite(n))) return parts.reduce((a, n) => a * 60 + n, 0);
  return 0;
}

// Links shared from the app usually carry their own start time (?t=83, &t=1m23s, #t=83).
function startFromUrl(u) {
  const t = u.searchParams.get('t') || u.searchParams.get('start') || (u.hash.match(/t=([\dhms:.]+)/) || [])[1];
  return t ? parseTime(t) : 0;
}

const isPrivate = (ip) => {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  const l = ip.toLowerCase();
  return l === '::1' || l === '::' || l.startsWith('fc') || l.startsWith('fd') || l.startsWith('fe80') || l.startsWith('::ffff:127.') || l.startsWith('::ffff:10.') || l.startsWith('::ffff:192.168.');
};

async function checkUrl(raw) {
  let u;
  try { u = new URL(String(raw || '').trim()); } catch { throw new Error('That doesn’t look like a link'); }
  if (!/^https?:$/.test(u.protocol)) throw new Error('Use an http(s) link');
  if (process.env.BLOOP_ALLOW_LOCAL_URLS !== '1') {
    const addrs = net.isIP(u.hostname) ? [u.hostname] : (await dns.lookup(u.hostname, { all: true }).catch(() => [])).map((a) => a.address);
    if (!addrs.length) throw new Error('Couldn’t reach that site');
    if (addrs.some(isPrivate)) throw new Error('That link points to a private network');
  }
  return u;
}

function run(args, timeoutMs) {
  return new Promise((resolve, reject) => {
    const p = spawn(YTDLP, args);
    let out = '', err = '';
    const timer = setTimeout(() => { p.kill('SIGKILL'); reject(new Error('Download took too long')); }, timeoutMs);
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('error', (e) => { clearTimeout(timer); reject(e); });
    p.on('close', (code) => { clearTimeout(timer); code === 0 ? resolve(out) : reject(new Error(friendly(err))); });
  });
}

function friendly(err) {
  const line = (err.match(/ERROR: (.*)/g) || []).pop()?.replace(/^ERROR:\s*(\[[^\]]+\]\s*)?/, '') || err.trim().split('\n').pop() || 'Download failed';
  if (/\b404\b|not available|removed|not found/i.test(line)) return 'That video isn’t available';
  if (/unsupported url/i.test(line)) return 'Can’t find a video at that link';
  if (/private|log ?in|sign in|cookies|age.restricted|confirm your age/i.test(line)) return 'That video is private or needs a login';
  if (/max.?filesize|larger than/i.test(line)) return 'That video is too large';
  return line.slice(0, 200);
}

/**
 * @returns {{ file: string, title: string, source_url: string, start_s: number }}
 */
export async function downloadClip(rawUrl, { start, workDir, length = MAX_TEMPLATE_SECONDS + 1 }) {
  if (!YTDLP) throw new Error('Links need yt-dlp on the server. Install it with: brew install yt-dlp');
  const u = await checkUrl(rawUrl);
  const from = Math.max(0, start != null && start !== '' ? parseTime(start) : startFromUrl(u));
  const to = from + length;
  fs.mkdirSync(workDir, { recursive: true });
  const grab = (sections) => run([
    '--no-playlist', '--no-warnings', '--no-progress', '--restrict-filenames',
    '--max-filesize', '300M',
    '-f', 'bv*[height<=1080][ext=mp4]+ba[ext=m4a]/bv*[height<=1080]+ba/b[height<=1080]/b',
    '--merge-output-format', 'mp4',
    ...(sections ? ['--download-sections', `*${from}-${to}`, '--force-keyframes-at-cuts'] : []),
    '--ffmpeg-location', ffmpegLocation(),
    '-o', path.join(workDir, 'source.%(ext)s'),
    '--print', 'after_move:%(title)s\t%(filepath)s',
    u.href,
  ], 4 * 60 * 1000);
  const located = (out) => {
    const [title, file] = out.trim().split('\n').pop().split('\t');
    const found = file && fs.existsSync(file) ? file : fs.readdirSync(workDir).map((f) => path.join(workDir, f)).find((f) => /^source\.(mp4|mkv|webm|mov)$/i.test(path.basename(f)));
    if (!found) throw new Error('Download finished but no video came back');
    return { title, found };
  };
  let title, found;
  try { ({ title, found } = located(await grab(true))); }
  catch (e) {
    // Some hosts don't allow partial downloads: fetch the whole video, then cut it here.
    if (/isn’t available|private|Can’t find|too large|too long/.test(e.message)) throw e;
    for (const f of fs.readdirSync(workDir)) fs.rmSync(path.join(workDir, f), { force: true });
    ({ title, found } = located(await grab(false)));
    if (from > 0) {
      const cut = path.join(workDir, 'cut.mp4');
      await runMedia(FFMPEG, ['-y', '-ss', String(from), '-i', found, '-t', String(to - from), '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-c:a', 'aac', cut]);
      found = cut;
    }
  }
  return { file: found, title: (title && title !== 'NA' ? title : u.hostname).slice(0, 120), source_url: u.href, start_s: from };
}
