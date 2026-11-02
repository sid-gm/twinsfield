import 'dotenv/config';
import express from 'express';
import multer from 'multer';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createDb } from './lib/db.js';
import { prepareTemplate } from './lib/media.js';
import { analyzeTemplate, fallbackBrief } from './lib/brief.js';
import { buildPersona } from './lib/persona.js';
import { buildHybrid, HYBRID_PRICE } from './lib/hybrid.js';
import { startRender, estimateCost, settings, planFor, ENGINES } from './lib/pipeline.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(ROOT, 'data');
for (const d of ['uploads', 'templates', 'renders', 'personas', 'hybrids']) fs.mkdirSync(path.join(DATA, d), { recursive: true });

const db = createDb(DATA);
// Stored template paths are absolute; if the folder moved (or another Mac runs it), re-root them under ./data.
const reroot = (p) => (p && !fs.existsSync(p) && p.includes(`${path.sep}data${path.sep}`) ? path.join(DATA, p.split(`${path.sep}data${path.sep}`).pop()) : p);
for (const t of db.list('templates')) for (const k of Object.keys(t.files || {})) t.files[k] = reroot(t.files[k]);

const upload = multer({ dest: path.join(DATA, 'uploads'), limits: { fileSize: 300 * 1024 * 1024 } });
const newId = () => crypto.randomBytes(5).toString('hex');
const rel = (p) => path.relative(DATA, p);
const media = (p) => (p ? `/media/${p}` : null);

// ----- public shapes -----
const brief = (t) => t.brief || { ...fallbackBrief(), main_subject: t.qa?.vision?.main_subject || null };
const publicTemplate = (t) => ({
  id: t.id, title: t.title, duration_s: t.duration_s, width: t.width, height: t.height,
  renders: t.renders || 0, created_at: t.created_at,
  clip_url: media(rel(t.files.clip)), thumb_url: media(rel(t.files.thumb)), frame_url: media(rel(t.files.frame)),
  brief: brief(t), analyzing: !!t.analyzing,
  est_cost: Object.fromEntries(Object.keys(ENGINES).map((e) => [e, estimateCost(t, e)])), hybrid_cost: HYBRID_PRICE,
});
const publicPersona = (p) => p && ({
  id: p.id, status: p.status, error: p.error || null, warnings: p.warnings || [], subject_check: p.subject_check || null,
  cost_usd: p.cost_usd ?? null, original_url: media(p.original_path), clean_url: media(p.clean_path),
  angles: (p.angles || []).map((a) => ({ key: a.key, label: a.label, url: media(a.path) })),
});
const publicHybrid = (h) => h && ({
  id: h.id, template_id: h.template_id, persona_id: h.persona_id, status: h.status, error: h.error || null,
  image_url: media(h.image_path), prompt: h.prompt || null, cost_usd: h.cost_usd ?? null, took_s: h.took_s ?? null,
});
const publicRender = (r) => ({
  id: r.id, group_id: r.group_id || null, template_id: r.template_id, persona_id: r.persona_id || null,
  engine: r.engine || r.mode || null, engine_name: ENGINES[r.engine]?.name || (r.mode ? 'older version' : ''), status: r.status,
  plan: r.engine ? planFor(r.engine) : null, queue_position: r.queue_position ?? null,
  direction: r.direction || r.notes || null, prompt: r.prompt || null, error: r.error || null,
  est_cost_usd: r.est_cost_usd ?? null, cost_usd: r.cost_usd ?? null, latency_s: r.latency_s ?? null, created_at: r.created_at,
  output_url: media(r.output_path), persona: r.persona_id ? publicPersona(db.get('personas', r.persona_id)) : null,
  hybrid: r.hybrid_id ? publicHybrid(db.get('hybrids', r.hybrid_id)) : null,
});

const app = express();
app.use(express.json());
app.use(express.static(path.join(ROOT, 'public')));
app.use('/media', express.static(DATA));

app.get('/api/settings', (_req, res) => res.json(settings()));

// ----- templates -----
app.get('/api/templates', (_req, res) => {
  const rows = db.list('templates').filter((t) => t.status === 'live')
    .sort((a, b) => b.created_at.localeCompare(a.created_at));
  res.json(rows.map(publicTemplate));
});

async function runAnalysis(id, keepUserDirection) {
  const t = db.get('templates', id);
  db.update('templates', id, { analyzing: true });
  const b = await analyzeTemplate(t);
  const cur = db.get('templates', id);
  if (keepUserDirection && cur.brief?.source === 'user') { b.direction = cur.brief.direction; b.source = 'user'; }
  db.update('templates', id, { brief: b, analyzing: false });
}

app.post('/api/templates', upload.single('video'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Attach a video file.' });
  if (/^(image|audio|text)\//.test(req.file.mimetype)) { fs.rmSync(req.file.path, { force: true }); return res.status(400).json({ error: 'That file is not a video.' }); }
  const id = newId();
  try {
    const prepared = await prepareTemplate(req.file.path, path.join(DATA, 'templates', id));
    const userDir = (req.body.direction || '').trim();
    const t = db.insert('templates', {
      id, title: (req.body.title || '').trim() || req.file.originalname.replace(/\.[^.]+$/, ''),
      status: 'live', created_at: new Date().toISOString(), renders: 0, ...prepared,
      brief: userDir ? { ...fallbackBrief(), direction: userDir.slice(0, 400), source: 'user' } : null,
    });
    runAnalysis(id, true); // background: who gets replaced + what to keep
    res.json(publicTemplate(db.get('templates', t.id)));
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
  if (typeof req.body.direction === 'string') patch.brief = { ...brief(t), direction: req.body.direction.trim().slice(0, 400), source: 'user' };
  if (req.body.status === 'retired') patch.status = 'retired';
  res.json(publicTemplate(db.update('templates', t.id, patch)));
});

app.post('/api/templates/:id/analyze', async (req, res) => {
  const t = db.get('templates', req.params.id);
  if (!t) return res.status(404).json({ error: 'Template not found' });
  await runAnalysis(t.id, false);
  res.json(publicTemplate(db.get('templates', t.id)));
});

// ----- personas: one photo -> clean portrait + 3 angles -----
app.post('/api/personas', upload.single('image'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Attach an image.' });
  if (/^(video|audio|text)\//.test(req.file.mimetype)) { fs.rmSync(req.file.path, { force: true }); return res.status(400).json({ error: 'That file is not an image.' }); }
  const id = newId();
  const dir = path.join(DATA, 'personas', id);
  fs.mkdirSync(dir, { recursive: true });
  const original = path.join(dir, `original${(path.extname(req.file.originalname) || '.jpg').toLowerCase()}`);
  fs.renameSync(req.file.path, original);
  db.insert('personas', { id, original_path: rel(original), status: 'queued', created_at: new Date().toISOString() });
  buildPersona(db, id, DATA);
  res.json(publicPersona(db.get('personas', id)));
});
app.get('/api/personas/:id', (req, res) => {
  const p = db.get('personas', req.params.id);
  p ? res.json(publicPersona(p)) : res.status(404).json({ error: 'Persona not found' });
});
app.post('/api/personas/:id/rebuild', (req, res) => {
  const p = db.get('personas', req.params.id);
  if (!p) return res.status(404).json({ error: 'Persona not found' });
  if (['checking', 'cleaning', 'angles'].includes(p.status)) return res.status(409).json({ error: 'Already building' });
  db.update('personas', p.id, { status: 'queued', fal_urls: { original: p.fal_urls?.original } });
  buildPersona(db, p.id, DATA);
  res.json(publicPersona(db.get('personas', p.id)));
});

// ----- hybrid still: frame 1 already transformed; the video copies it -----
// Body: { template_id, persona_id, direction?, notes? }
app.post('/api/hybrids', async (req, res) => {
  const b = req.body || {};
  const t = db.get('templates', b.template_id);
  if (!t || t.status !== 'live') return res.status(404).json({ error: 'Template not found' });
  const p = db.get('personas', b.persona_id);
  if (!p || p.status !== 'done') return res.status(409).json({ error: 'Build the persona first.' });
  const id = newId();
  db.insert('hybrids', {
    id, template_id: t.id, persona_id: p.id, status: t.brief?.main_subject ? 'queued' : 'analyzing',
    direction: (b.direction ?? brief(t).direction ?? '').trim().slice(0, 400) || null, notes: (b.notes || '').trim().slice(0, 300) || null,
    created_at: new Date().toISOString(),
  });
  res.json(publicHybrid(db.get('hybrids', id)));
  // Templates made before the brief existed: analyze first so the wig / lap cat etc. get named.
  if (!t.brief || !t.brief.main_subject) await runAnalysis(t.id, true);
  buildHybrid(db, id, DATA);
});
app.get('/api/hybrids/:id', (req, res) => {
  const h = db.get('hybrids', req.params.id);
  h ? res.json(publicHybrid(h)) : res.status(404).json({ error: 'Hybrid not found' });
});

// ----- renders -----
// Body: { template_id, hybrid_id, engine: 'kling' | 'seedance' | 'compare', direction? }
app.post('/api/renders', (req, res) => {
  const b = req.body || {};
  const t = db.get('templates', b.template_id);
  if (!t || t.status !== 'live') return res.status(404).json({ error: 'Template not found' });
  const h = db.get('hybrids', b.hybrid_id);
  if (!h || h.status !== 'done' || h.template_id !== t.id) return res.status(409).json({ error: 'Create and approve a hybrid still for this template first.' });
  const p = db.get('personas', h.persona_id);
  const engines = b.engine === 'compare' ? ['kling', 'seedance'] : [ENGINES[b.engine] ? b.engine : 'kling'];
  const group_id = engines.length > 1 ? newId() : null;
  const direction = (b.direction ?? brief(t).direction ?? '').trim().slice(0, 400) || null;
  const out = engines.map((engine) => {
    const r = db.insert('renders', {
      id: newId(), group_id, template_id: t.id, persona_id: p.id, hybrid_id: h.id, engine, direction, status: 'queued',
      est_cost_usd: estimateCost(t, engine), created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    });
    startRender(db, r.id, DATA);
    return publicRender(r);
  });
  res.json(out);
});
app.get('/api/renders/:id', (req, res) => {
  const r = db.get('renders', req.params.id);
  r ? res.json(publicRender(r)) : res.status(404).json({ error: 'Render not found' });
});
app.get('/api/renders', (_req, res) => res.json(db.list('renders').filter((r) => r.output_path).slice(-24).reverse().map(publicRender)));

// Jobs interrupted by a restart can't resume.
for (const p of db.list('personas')) if (!['done', 'failed'].includes(p.status)) db.update('personas', p.id, { status: 'failed', error: 'Server restarted mid-build' });
for (const r of db.list('renders')) if (!['done', 'failed', 'preview_ready'].includes(r.status)) db.update('renders', r.id, { status: 'failed', error: 'Server restarted mid-render' });
for (const h of db.list('hybrids')) if (!['done', 'failed'].includes(h.status)) db.update('hybrids', h.id, { status: 'failed', error: 'Server restarted mid-generation' });
for (const t of db.list('templates')) if (t.analyzing) db.update('templates', t.id, { analyzing: false });

const PORT = Number(process.env.PORT) || 3000;
app.listen(PORT, () => {
  const s = settings();
  console.log(`\n  twin meme MVP → http://localhost:${PORT}`);
  console.log(`  mode: ${s.mock ? 'MOCK (no fal calls)' : s.has_key ? 'LIVE (fal)' : 'LIVE but FAL_KEY missing!'} · Kling O3 edit / Seedance 2.5 (${s.seedance_resolution})\n`);
});
