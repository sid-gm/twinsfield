import 'dotenv/config';
import express from 'express';
import multer from 'multer';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createDb } from './lib/db.js';
import { prepareTemplate } from './lib/media.js';
import { startRender, estimateCost, settings } from './lib/pipeline.js';
import { assessTemplate } from './lib/qa.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(ROOT, 'data');
for (const d of ['uploads', 'templates', 'renders']) fs.mkdirSync(path.join(DATA, d), { recursive: true });

const db = createDb(DATA);

// Stored paths are absolute; if the folder moved (or another machine runs it), re-root them under ./data.
const reroot = (p) => (p && !fs.existsSync(p) && p.includes(`${path.sep}data${path.sep}`) ? path.join(DATA, p.split(`${path.sep}data${path.sep}`).pop()) : p);
for (const t of db.list('templates')) for (const k of Object.keys(t.files || {})) t.files[k] = reroot(t.files[k]);
for (const r of db.list('renders')) r.subject_file = reroot(r.subject_file);
const upload = multer({ dest: path.join(DATA, 'uploads'), limits: { fileSize: 300 * 1024 * 1024 } });
const newId = () => crypto.randomBytes(5).toString('hex');
const rel = (p) => path.relative(DATA, p);

// Shape a template for the client (paths -> /media URLs, add cost estimates)
const publicTemplate = (t) => ({
  id: t.id, title: t.title, source: t.source, render_mode: t.render_mode, status: t.status,
  duration_s: t.duration_s, width: t.width, height: t.height, has_audio: t.has_audio,
  renders: t.renders || 0, created_at: t.created_at, last_used_at: t.last_used_at || null,
  clip_url: `/media/${rel(t.files.clip)}`, thumb_url: `/media/${rel(t.files.thumb)}`, frame_url: `/media/${rel(t.files.frame)}`,
  est_cost: { kling: estimateCost(t, 'kling'), wan: estimateCost(t, 'wan') },
  qa: t.qa ? {
    score: t.qa.score, grade: t.qa.grade, partial: !!t.qa.partial, issues: t.qa.issues, tips: t.qa.tips,
    recommended_mode: t.qa.recommended_mode, main_subject: t.qa.vision?.main_subject || null, metrics: t.qa.metrics, checked_at: t.qa.checked_at,
  } : null,
});
const publicRender = (r) => ({
  ...r, subject_file: undefined,
  subject_url: `/media/${rel(r.subject_file)}`,
  output_url: r.output_path ? `/media/${r.output_path}` : null,
  edited_frame_url: r.edited_frame_path ? `/media/${r.edited_frame_path}` : null,
  character_url: r.character_path ? `/media/${r.character_path}` : null,
  edit_attempts: (r.edit_attempts || []).map((a) => ({ ...a, url: `/media/${a.path}` })),
});

const app = express();
app.use(express.json());
app.use(express.static(path.join(ROOT, 'public')));
app.use('/media', express.static(DATA));

app.get('/api/settings', (_req, res) => res.json(settings()));

app.get('/api/templates', (_req, res) => {
  const rows = db.list('templates').filter((t) => t.status === 'live')
    .sort((a, b) => (b.renders || 0) - (a.renders || 0) || b.created_at.localeCompare(a.created_at));
  res.json(rows.map(publicTemplate));
});

app.post('/api/templates', upload.single('video'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Attach a video file.' });
  if (/^(image|audio|text)\//.test(req.file.mimetype)) { fs.rmSync(req.file.path, { force: true }); return res.status(400).json({ error: 'That file is not a video.' }); }
  const id = newId();
  try {
    const dir = path.join(DATA, 'templates', id);
    const prepared = await prepareTemplate(req.file.path, dir);
    const draft = { id, ...prepared };
    let qa = null;
    try { qa = await assessTemplate(draft, dir); } catch (e) { console.error('[qa]', e); }
    const chosen = req.body.render_mode;
    const t = db.insert('templates', {
      id,
      title: (req.body.title || '').trim() || req.file.originalname.replace(/\.[^.]+$/, ''),
      source: 'user',
      render_mode: chosen === 'wan' || chosen === 'kling' ? chosen : qa?.recommended_mode || 'kling',
      status: 'live',
      created_at: new Date().toISOString(),
      renders: 0,
      ...prepared,
      qa,
    });
    res.json(publicTemplate(t));
  } catch (e) {
    fs.rmSync(path.join(DATA, 'templates', id), { recursive: true, force: true });
    res.status(400).json({ error: e.message });
  } finally {
    fs.rmSync(req.file.path, { force: true });
  }
});

app.patch('/api/templates/:id', (req, res) => {
  const t = db.get('templates', req.params.id);
  if (!t) return res.status(404).json({ error: 'Template not found' });
  const patch = {};
  if (typeof req.body.title === 'string' && req.body.title.trim()) patch.title = req.body.title.trim();
  if (['kling', 'wan'].includes(req.body.render_mode)) patch.render_mode = req.body.render_mode;
  if (req.body.status === 'retired') patch.status = 'retired';
  res.json(publicTemplate(db.update('templates', t.id, patch)));
});

// Re-run the quality check (e.g. for templates made before QA existed, or after adding a FAL key).
app.post('/api/templates/:id/qa', async (req, res) => {
  const t = db.get('templates', req.params.id);
  if (!t) return res.status(404).json({ error: 'Template not found' });
  try {
    const qa = await assessTemplate(t, path.dirname(t.files.clip));
    res.json(publicTemplate(db.update('templates', t.id, { qa })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/renders', upload.single('image'), (req, res) => {
  const t = db.get('templates', req.body.template_id);
  if (!t || t.status !== 'live') { if (req.file) fs.rmSync(req.file.path, { force: true }); return res.status(404).json({ error: 'Template not found' }); }
  if (!req.file) return res.status(400).json({ error: 'Attach an image (selfie, pet, anything).' });
  if (/^(video|audio|text)\//.test(req.file.mimetype)) { fs.rmSync(req.file.path, { force: true }); return res.status(400).json({ error: 'That file is not an image.' }); }

  const id = newId();
  const dir = path.join(DATA, 'renders', id);
  fs.mkdirSync(dir, { recursive: true });
  const ext = (path.extname(req.file.originalname) || '.jpg').toLowerCase();
  const subject = path.join(dir, `subject${ext}`);
  fs.renameSync(req.file.path, subject);

  const mode = ['kling', 'wan'].includes(req.body.mode) ? req.body.mode : t.render_mode;
  const r = db.insert('renders', {
    id, template_id: t.id, mode, notes: (req.body.notes || '').trim().slice(0, 300) || null,
    subject_file: subject, status: 'queued', est_cost_usd: estimateCost(t, mode),
    created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
  });
  startRender(db, r.id, DATA);
  res.json(publicRender(r));
});

app.get('/api/renders/:id', (req, res) => {
  const r = db.get('renders', req.params.id);
  if (!r) return res.status(404).json({ error: 'Render not found' });
  res.json(publicRender(r));
});

app.get('/api/renders', (_req, res) => {
  res.json(db.list('renders').slice(-24).reverse().map(publicRender));
});

// Renders interrupted by a restart can't resume (the fal job id is lost mid-flight), so mark them.
for (const r of db.list('renders')) if (!['done', 'failed'].includes(r.status)) db.update('renders', r.id, { status: 'failed', error: 'Server restarted mid-render' });

const PORT = Number(process.env.PORT) || 3000;
app.listen(PORT, () => {
  const s = settings();
  console.log(`\n  twin meme MVP → http://localhost:${PORT}`);
  console.log(`  mode: ${s.mock ? 'MOCK (no fal calls)' : s.has_key ? 'LIVE (fal)' : 'LIVE but FAL_KEY missing!'} · kling ${s.kling_tier} · wan ${s.wan_resolution}\n`);
});
