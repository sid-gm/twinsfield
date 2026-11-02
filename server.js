import 'dotenv/config';
import express from 'express';
import multer from 'multer';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDb } from './lib/db.js';
import { prepareTemplate, makePreview, cutClip, frameAt, MIN_TEMPLATE_SECONDS, MAX_TEMPLATE_SECONDS } from './lib/media.js';
import { analyzeTemplate, fallbackBrief, usability } from './lib/brief.js';
import { buildPersona } from './lib/persona.js';
import { downloadClip, hasYtdlp } from './lib/fetchvideo.js';
import { buildHybrid, HYBRID_PRICE } from './lib/hybrid.js';
import { startRender, estimateCost, settings, planFor, ENGINES, events } from './lib/pipeline.js';
import {
  COLORS, FREE_TRIAL_CENTS, DEFAULT_DAILY_LIMIT, newId, newToken, slugFor, priceCents,
  balanceCents, rendersToday, addLedger, faceUsable,
} from './lib/rooms.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(ROOT, 'data');
for (const d of ['uploads', 'templates', 'renders', 'personas', 'hybrids', 'sources']) fs.mkdirSync(path.join(DATA, d), { recursive: true });

const db = createDb(DATA);
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { db.flush(); process.exit(0); });

// Stored template paths are absolute; if the folder moved (or another Mac runs it), re-root them under ./data.
const reroot = (p) => (p && !fs.existsSync(p) && p.includes(`${path.sep}data${path.sep}`) ? path.join(DATA, p.split(`${path.sep}data${path.sep}`).pop()) : p);
for (const t of db.list('templates')) for (const k of Object.keys(t.files || {})) t.files[k] = reroot(t.files[k]);

const upload = multer({ dest: path.join(DATA, 'uploads'), limits: { fileSize: 300 * 1024 * 1024 } });
const rel = (p) => path.relative(DATA, p);
const media = (p) => (p ? `/media/${p}` : null);
const now = () => new Date().toISOString();
const DEFAULT_ENGINE = ENGINES[process.env.BLOOP_ENGINE] ? process.env.BLOOP_ENGINE : 'kling';

// ======================================================================
// Public shapes
// ======================================================================
const brief = (t) => t.brief || { ...fallbackBrief(), main_subject: t.qa?.vision?.main_subject || null };
const publicTemplate = (t) => ({
  id: t.id, title: t.title, duration_s: t.duration_s, width: t.width, height: t.height,
  renders: t.renders || 0, created_at: t.created_at, room_id: t.room_id || null,
  clip_url: media(rel(t.files.clip)), thumb_url: media(rel(t.files.thumb)), frame_url: media(rel(t.files.frame)),
  brief: brief(t), analyzing: !!t.analyzing,
  remix_of: t.parent_render_id || null, protect: !!t.protect, source_url: t.source_url || null, source_id: t.source_id || null, usability: usability(t),
  est_cost: Object.fromEntries(Object.keys(ENGINES).map((e) => [e, estimateCost(t, e)])), hybrid_cost: HYBRID_PRICE,
  price_cents: priceCents(estimateCost(t, DEFAULT_ENGINE)),
});
const publicPersona = (p) => p && ({
  id: p.id, status: p.status, error: p.error || null, warnings: p.warnings || [], subject_check: p.subject_check || null,
  cost_usd: p.cost_usd ?? null, original_url: media(p.original_path), clean_url: media(p.clean_path),
  angles: (p.angles || []).map((a) => ({ key: a.key, label: a.label, url: media(a.path) })),
});
const publicHybrid = (h) => h && ({
  id: h.id, template_id: h.template_id, persona_id: h.persona_id, face_id: h.face_id || null, room_id: h.room_id || null,
  created_by: h.created_by || null, status: h.status, error: h.error || null,
  image_url: media(h.image_path), notes: h.notes || null, prompt: h.prompt || null, cost_usd: h.cost_usd ?? null, took_s: h.took_s ?? null, created_at: h.created_at,
});
const publicRender = (r) => ({
  id: r.id, group_id: r.group_id || null, template_id: r.template_id, persona_id: r.persona_id || null, hybrid_id: r.hybrid_id || null,
  face_id: r.face_id || null, room_id: r.room_id || null, created_by: r.created_by || null,
  engine: r.engine || r.mode || null, engine_name: ENGINES[r.engine]?.name || (r.mode ? 'older version' : ''), status: r.status,
  plan: r.engine ? planFor(r.engine, !!db.get('templates', r.template_id)?.protect) : null,
  queue_position: r.queue_position ?? null, started_at: r.started_at || null, fal_request_id: r.fal_request_id || null,
  direction: r.direction || r.notes || null, prompt: r.prompt || null, error: r.error || null,
  est_cost_usd: r.est_cost_usd ?? null, cost_usd: r.cost_usd ?? null, price_cents: r.price_cents ?? null, refunded: !!r.refunded,
  latency_s: r.latency_s ?? null, created_at: r.created_at,
  output_url: media(r.output_path), persona: r.persona_id ? publicPersona(db.get('personas', r.persona_id)) : null,
  hybrid: r.hybrid_id ? publicHybrid(db.get('hybrids', r.hybrid_id)) : null,
  protect: r.protect ? { region: r.protect.region || null, error: r.protect.error || null, full_url: media(r.protect.full_path) } : null,
});

// ======================================================================
// Engine operations (shared by the studio API and the room API)
// ======================================================================
async function runAnalysis(id, keepUserDirection, target) {
  const t = db.get('templates', id);
  db.update('templates', id, { analyzing: true });
  const fixed = target || (t.brief?.target_source === 'user' ? t.brief.main_subject : null); // a user-chosen target survives
  const b = await analyzeTemplate(t, { target: fixed });
  const cur = db.get('templates', id);
  if (keepUserDirection && cur.brief?.source === 'user') { b.direction = cur.brief.direction; b.source = 'user'; }
  db.update('templates', id, { brief: b, analyzing: false });
}

async function createTemplate(srcPath, { title, direction, target, room_id = null, created_by = null, parent_render_id = null, protect = false, source_url = null, source_start_s = null, source_id = null }) {
  const id = newId();
  try {
    const prepared = await prepareTemplate(srcPath, path.join(DATA, 'templates', id));
    const userDir = (direction || '').trim();
    db.insert('templates', {
      id, title: (title || 'Untitled').slice(0, 120), status: 'live', created_at: now(), renders: 0, ...prepared,
      room_id, created_by, parent_render_id, protect, source_url, source_start_s, source_id,
      brief: target ? { ...fallbackBrief(), main_subject: target, target_source: 'user' }
        : userDir ? { ...fallbackBrief(), direction: userDir.slice(0, 400), source: 'user' } : null,
    });
    db.update('templates', id, { analyzing: true });
    runAnalysis(id, !target, target); // background: who gets replaced + what to keep
    return db.get('templates', id);
  } catch (e) {
    fs.rmSync(path.join(DATA, 'templates', id), { recursive: true, force: true });
    throw e;
  }
}

function createPersona(file) {
  const id = newId();
  const dir = path.join(DATA, 'personas', id);
  fs.mkdirSync(dir, { recursive: true });
  const original = path.join(dir, `original${(path.extname(file.originalname) || '.jpg').toLowerCase()}`);
  fs.renameSync(file.path, original);
  db.insert('personas', { id, original_path: rel(original), status: 'queued', created_at: now() });
  buildPersona(db, id, DATA);
  return db.get('personas', id);
}

async function createHybrid({ template, persona, direction, notes, room_id = null, created_by = null, face_id = null }) {
  const id = newId();
  db.insert('hybrids', {
    id, template_id: template.id, persona_id: persona.id, face_id, room_id, created_by,
    status: template.brief?.main_subject ? 'queued' : 'analyzing',
    direction: (direction ?? brief(template).direction ?? '').trim().slice(0, 400) || null,
    notes: (notes || '').trim().slice(0, 300) || null, created_at: now(),
  });
  (async () => {
    if (!template.brief || !template.brief.main_subject) await runAnalysis(template.id, true);
    buildHybrid(db, id, DATA);
  })();
  return db.get('hybrids', id);
}

function createRender({ template, hybrid, engine, direction, room_id = null, created_by = null, price_cents = null, group_id = null }) {
  const r = db.insert('renders', {
    id: newId(), group_id, template_id: template.id, persona_id: hybrid.persona_id, hybrid_id: hybrid.id, face_id: hybrid.face_id || null,
    engine, direction: (direction ?? brief(template).direction ?? '').trim().slice(0, 400) || null, status: 'queued',
    est_cost_usd: estimateCost(template, engine), price_cents, room_id, created_by, created_at: now(), updated_at: now(),
  });
  startRender(db, r.id, DATA);
  return r;
}

// Failed room renders are refunded to the pool.
events.on('render:failed', (id) => {
  const r = db.get('renders', id);
  if (!r?.room_id || !r.price_cents || r.refunded) return;
  addLedger(db, { room_id: r.room_id, member_id: r.created_by, amount_cents: r.price_cents, kind: 'refund', ref: r.id, note: 'Render failed' });
  db.update('renders', id, { refunded: true });
});

// ======================================================================
// App
// ======================================================================
const app = express();
app.set('trust proxy', true);
app.use(express.json());
app.get('/healthz', (_req, res) => res.send('ok'));

// ----- hosting guards (all optional; unset = local behaviour) -----
// ADMIN_PASSWORD     protects /studio, the studio API and /api/admin/* with HTTP basic auth (any username).
// BLOOP_ACCESS_CODE  required to create a room (joining by link stays open).
// TEST_TOPUPS=off    turns off the fake "+$5/$10/$20" buttons; add credit with /api/admin/rooms/:slug/credit instead.
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const ACCESS_CODE = process.env.BLOOP_ACCESS_CODE || '';
const TEST_TOPUPS = !/^(0|off|false|no)$/i.test(process.env.TEST_TOPUPS || 'on');
const adminOnly = (req, res, next) => {
  if (!ADMIN_PASSWORD) return next();
  const [, b64] = (req.get('authorization') || '').split(' ');
  const pass = b64 ? Buffer.from(b64, 'base64').toString().split(':').slice(1).join(':') : '';
  if (pass === ADMIN_PASSWORD) return next();
  res.set('WWW-Authenticate', 'Basic realm="bloop admin"').status(401).send('Admin only');
};
const STUDIO_API = /^\/api\/(templates|personas|hybrids|renders)(\/|$)/;
app.use((req, res, next) => (req.path === '/studio' || req.path === '/studio.html' || STUDIO_API.test(req.path) || req.path.startsWith('/api/admin/') ? adminOnly(req, res, next) : next()));

app.use('/media', express.static(DATA));
app.get('/studio', (_req, res) => res.sendFile(path.join(ROOT, 'public', 'studio.html')));
app.use(express.static(path.join(ROOT, 'public')));
const bad = (res, code, error, extra = {}) => res.status(code).json({ error, ...extra });
const wrap = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch((e) => { console.error(e); bad(res, 500, e.message); });

app.get('/api/settings', (_req, res) => res.json({ ...settings(), app: 'bloop', default_engine: DEFAULT_ENGINE, links: hasYtdlp(), access_code: !!ACCESS_CODE, test_topups: TEST_TOPUPS }));
app.get('/api/engines', (_req, res) => res.json({ default: DEFAULT_ENGINE, engines: Object.fromEntries(Object.entries(ENGINES).map(([k, v]) => [k, v.name])) }));

// Link → template: yt-dlp grabs ~11s starting at `start` (or the link's own ?t=), then the normal template prep runs.
async function templateFromLink(body, extra = {}) {
  const work = path.join(DATA, 'uploads', `link-${newId()}`);
  try {
    const d = await downloadClip(body?.url, { start: body?.start, workDir: work });
    const title = String(body?.title || '').trim() || d.title;
    return await createTemplate(d.file, { title, source_url: d.source_url, source_start_s: d.start_s, direction: body?.direction, ...extra });
  } finally { fs.rmSync(work, { recursive: true, force: true }); }
}

// ======================================================================
// Rooms
// ======================================================================
const roomBySlug = (slug) => db.find('rooms', (r) => r.slug === slug);
const memberOf = (req, room) => {
  const token = req.get('x-bloop-member');
  return token ? db.find('members', (m) => m.token === token && m.room_id === room.id) : null;
};
// Resolves the room and the calling member (the token from joining is the only identity).
const inRoom = () => (req, res, next) => {
  const room = roomBySlug(req.params.slug);
  if (!room) return bad(res, 404, 'Room not found');
  const me = memberOf(req, room);
  if (!me) return bad(res, 401, 'Join the room first', { code: 'not_member' });
  req.room = room; req.me = me; next();
};

const publicMember = (m) => ({ id: m.id, name: m.name, color: m.color, joined_at: m.created_at });
const publicFace = (f) => ({
  id: f.id, label: f.label, kind: f.kind, status: f.status, added_by: f.added_by, subject_member_id: f.subject_member_id || null,
  created_at: f.created_at, persona: publicPersona(db.get('personas', f.persona_id)),
});

function roomState(room, me) {
  const members = db.where('members', (m) => m.room_id === room.id);
  const faces = db.where('faces', (f) => f.room_id === room.id && f.status !== 'declined');
  const likes = db.where('likes', (l) => l.room_id === room.id);
  const hybrids = db.where('hybrids', (h) => h.room_id === room.id).slice(-12).reverse();
  const renders = db.where('renders', (r) => r.room_id === room.id).slice(-30).reverse();
  const ledger = db.where('ledger', (l) => l.room_id === room.id);
  const tpl = (id) => { const t = db.get('templates', id); return t ? { id: t.id, title: t.title, thumb_url: media(rel(t.files.thumb)), price_cents: priceCents(estimateCost(t, DEFAULT_ENGINE)),
    prices: Object.fromEntries(Object.keys(ENGINES).map((e) => [e, priceCents(estimateCost(t, e))])) } : null; };
  const face = (id) => { const f = db.get('faces', id); return f ? { id: f.id, label: f.label } : null; };
  return {
    room: { id: room.id, name: room.name, slug: room.slug, created_at: room.created_at, daily_limit: room.daily_limit, balance_cents: balanceCents(db, room.id) },
    me: { ...publicMember(me), renders_today: rendersToday(db, me.id) },
    members: members.map(publicMember),
    faces: faces.map(publicFace),
    drafts: hybrids.map((h) => ({ ...publicHybrid(h), template: tpl(h.template_id), face: face(h.face_id),
      likes: likes.filter((l) => l.hybrid_id === h.id).map((l) => l.member_id) })),
    renders: renders.map((r) => ({ ...publicRender(r), template: tpl(r.template_id), face: face(r.face_id) })),
    contributions: members.map((m) => ({ member_id: m.id, cents: ledger.filter((l) => l.member_id === m.id && l.kind === 'topup').reduce((s, l) => s + l.amount_cents, 0) })),
    ledger: ledger.slice(-30).reverse().map((l) => ({ id: l.id, member_id: l.member_id, amount_cents: l.amount_cents, kind: l.kind, note: l.note, ref: l.ref, created_at: l.created_at })),
  };
}

// Create a room: the creator becomes its first member.
app.post('/api/rooms', (req, res) => {
  const name = String(req.body?.name || '').trim().slice(0, 40);
  const creator = String(req.body?.creator_name || '').trim().slice(0, 30) || 'Me';
  if (!name) return bad(res, 400, 'Name your room');
  if (ACCESS_CODE && String(req.body?.access_code || '').trim().toLowerCase() !== ACCESS_CODE.toLowerCase()) return bad(res, 403, 'That access code didn’t work', { code: 'access_code' });
  const room = db.insert('rooms', { id: newId(), name, slug: slugFor(name, (s) => !!roomBySlug(s)), daily_limit: DEFAULT_DAILY_LIMIT, created_at: now() });
  const me = db.insert('members', { id: newId(), room_id: room.id, name: creator, token: newToken(), color: COLORS[0], created_at: now() });
  db.update('rooms', room.id, { created_by: me.id });
  if (req.body?.free_trial !== false && FREE_TRIAL_CENTS > 0) addLedger(db, { room_id: room.id, member_id: null, amount_cents: FREE_TRIAL_CENTS, kind: 'trial', note: 'Free trial' });
  res.json({ token: me.token, ...roomState(room, me) });
});

// Public preview for the join screen (no auth).
app.get('/api/rooms/:slug/preview', (req, res) => {
  const room = roomBySlug(req.params.slug);
  if (!room) return bad(res, 404, 'Room not found');
  const members = db.where('members', (m) => m.room_id === room.id);
  const done = db.where('renders', (r) => r.room_id === room.id && r.status === 'done').slice(-3).reverse();
  const creator = members.find((m) => m.id === room.created_by);
  res.json({
    name: room.name, slug: room.slug, invited_by: creator?.name || null,
    members: members.map((m) => ({ name: m.name, color: m.color })),
    recent: done.map((r) => ({ thumb_url: media(rel(db.get('templates', r.template_id)?.files.thumb || '')), output_url: media(r.output_path) })),
  });
});

app.post('/api/rooms/:slug/join', (req, res) => {
  const room = roomBySlug(req.params.slug);
  if (!room) return bad(res, 404, 'Room not found');
  const name = String(req.body?.name || '').trim().slice(0, 30);
  if (!name) return bad(res, 400, 'Tell the room your name');
  const count = db.where('members', (m) => m.room_id === room.id).length;
  const me = db.insert('members', { id: newId(), room_id: room.id, name, token: newToken(), color: COLORS[count % COLORS.length], created_at: now() });
  res.json({ token: me.token, ...roomState(room, me) });
});

app.get('/api/rooms/:slug', inRoom(), (req, res) => res.json(roomState(req.room, req.me)));

app.patch('/api/rooms/:slug', inRoom(), (req, res) => {
  const patch = {};
  if (typeof req.body?.name === 'string' && req.body.name.trim()) patch.name = req.body.name.trim().slice(0, 40);
  if (Number.isInteger(req.body?.daily_limit) && req.body.daily_limit >= 0 && req.body.daily_limit <= 50) patch.daily_limit = req.body.daily_limit;
  db.update('rooms', req.room.id, patch);
  res.json(roomState(db.get('rooms', req.room.id), req.me));
});

// ----- wallet -----
app.post('/api/rooms/:slug/topup', inRoom(), (req, res) => {
  const cents = Math.round(Number(req.body?.amount_cents));
  if (![500, 1000, 2000].includes(cents)) return bad(res, 400, 'Choose $5, $10 or $20');
  // TODO(payments): create a Stripe Checkout session and add the ledger row from its webhook.
  if (!TEST_TOPUPS) return bad(res, 501, 'Top-ups aren’t open yet');
  addLedger(db, { room_id: req.room.id, member_id: req.me.id, amount_cents: cents, kind: 'topup', note: 'Top up (test payment)' });
  res.json(roomState(req.room, req.me));
});

// Admin: add credit to a room (no payments yet). curl -u :$ADMIN_PASSWORD -XPOST .../api/admin/rooms/<slug>/credit -d '{"amount_cents":1000}'
app.post('/api/admin/rooms/:slug/credit', (req, res) => {
  const room = roomBySlug(req.params.slug);
  if (!room) return bad(res, 404, 'Room not found');
  const cents = Math.round(Number(req.body?.amount_cents));
  if (!(cents > 0 && cents <= 100000)) return bad(res, 400, 'amount_cents must be 1–100000');
  addLedger(db, { room_id: room.id, member_id: null, amount_cents: cents, kind: 'trial', note: String(req.body?.note || 'Credit from bloop').slice(0, 60) });
  res.json({ ok: true, balance_cents: balanceCents(db, room.id) });
});
app.get('/api/admin/rooms', (_req, res) => res.json(db.list('rooms').map((r) => ({ slug: r.slug, name: r.name, created_at: r.created_at, members: db.where('members', (m) => m.room_id === r.id).length, balance_cents: balanceCents(db, r.id), renders: db.where('renders', (x) => x.room_id === r.id).length }))));

// ----- templates -----
app.get('/api/rooms/:slug/templates', inRoom(), (req, res) => {
  const q = String(req.query.q || '').toLowerCase().split(/\s+/).filter(Boolean);
  const scope = req.query.scope;
  let rows = db.where('templates', (t) => t.status === 'live' && (!t.room_id || t.room_id === req.room.id));
  if (scope === 'room') rows = rows.filter((t) => t.room_id === req.room.id);
  if (q.length) {
    const score = (t) => { const b = brief(t); const hay = `${t.title} ${b.main_subject || ''} ${(b.keep || []).join(' ')}`.toLowerCase(); return q.filter((w) => hay.includes(w)).length; };
    rows = rows.map((t) => [t, score(t)]).filter(([, s]) => s > 0).sort((a, b) => b[1] - a[1]).map(([t]) => t);
  } else rows = rows.sort((a, b) => (b.renders || 0) - (a.renders || 0) || b.created_at.localeCompare(a.created_at));
  res.json(rows.slice(0, 60).map((t) => ({ ...publicTemplate(t), made_here: t.room_id === req.room.id })));
});
app.post('/api/rooms/:slug/templates', inRoom(), upload.single('video'), wrap(async (req, res) => {
  if (!req.file) return bad(res, 400, 'Attach a video');
  try {
    if (/^(image|audio|text)\//.test(req.file.mimetype)) return bad(res, 400, 'That file is not a video');
    const t = await createTemplate(req.file.path, { title: req.body.title || req.file.originalname.replace(/\.[^.]+$/, ''), room_id: req.room.id, created_by: req.me.id });
    res.json(publicTemplate(t));
  } catch (e) { bad(res, 400, e.message); } finally { fs.rmSync(req.file.path, { force: true }); }
}));
// ----- sources: a longer video the member trims (start/end) before it becomes a template -----
const publicSource = (src) => ({
  id: src.id, title: src.title, duration_s: src.duration_s, width: src.width, height: src.height, source_url: src.source_url || null,
  offset_s: src.offset_s || 0, start_hint_s: src.start_hint_s || 0, preview_url: media(rel(src.files.preview)), strip_url: media(rel(src.files.strip)), strip_frames: src.strip_frames || 10,
  min_s: MIN_TEMPLATE_SECONDS, max_s: MAX_TEMPLATE_SECONDS,
});
async function createSource(file, { title, room_id, created_by, source_url = null, offset_s = 0 }) {
  const id = newId();
  const dir = path.join(DATA, 'sources', id);
  fs.mkdirSync(dir, { recursive: true });
  const src = path.join(dir, `source${(path.extname(file) || '.mp4').toLowerCase()}`);
  fs.renameSync(file, src);
  try {
    const p = await makePreview(src, dir);
    return db.insert('sources', { id, room_id, created_by, title: (title || 'Untitled').slice(0, 120), source_url, offset_s, ...p, files: { ...p.files, source: src }, created_at: now() });
  } catch (e) { fs.rmSync(dir, { recursive: true, force: true }); throw e; }
}
const SOURCE_WINDOW_S = 120; // links: the trimmer gets 2 minutes from the start time
app.post('/api/rooms/:slug/sources', inRoom(), upload.single('video'), wrap(async (req, res) => {
  if (!req.file) return bad(res, 400, 'Attach a video');
  try {
    if (/^(image|audio|text)\//.test(req.file.mimetype)) return bad(res, 400, 'That file is not a video');
    const tmp = `${req.file.path}${path.extname(req.file.originalname || '') || '.mp4'}`;
    fs.renameSync(req.file.path, tmp);
    const src = await createSource(tmp, { title: (req.body.title || req.file.originalname || '').replace(/\.[^.]+$/, ''), room_id: req.room.id, created_by: req.me.id });
    res.json(publicSource(src));
  } catch (e) { bad(res, 400, e.message); } finally { fs.rmSync(req.file.path, { force: true }); }
}));
app.post('/api/rooms/:slug/sources/link', inRoom(), wrap(async (req, res) => {
  const recent = db.where('sources', (x) => x.created_by === req.me.id && x.source_url && Date.now() - new Date(x.created_at) < 3600e3).length;
  if (recent >= 15) return bad(res, 429, 'Slow down: 15 links an hour');
  const work = path.join(DATA, 'uploads', `link-${newId()}`);
  try {
    const d = await downloadClip(req.body?.url, { start: req.body?.start, workDir: work, length: SOURCE_WINDOW_S });
    const src = await createSource(d.file, { title: d.title, room_id: req.room.id, created_by: req.me.id, source_url: d.source_url, offset_s: d.start_s });
    res.json(publicSource(src));
  } catch (e) { bad(res, 400, e.message); } finally { fs.rmSync(work, { recursive: true, force: true }); }
}));
app.get('/api/rooms/:slug/sources/:id', inRoom(), (req, res) => {
  const src = db.get('sources', req.params.id);
  if (!src || src.room_id !== req.room.id) return bad(res, 404, 'Video not found');
  res.json(publicSource(src));
});
// Same access model as /media (unguessable ids), so plain <img> tags can load it.
app.get('/api/rooms/:slug/sources/:id/frame', wrap(async (req, res) => {
  const src = db.get('sources', req.params.id);
  if (!src || src.room_id !== roomBySlug(req.params.slug)?.id) return bad(res, 404, 'Video not found');
  const t = Math.max(0, Math.min(src.duration_s - 0.05, Number(req.query.t) || 0));
  res.set('cache-control', 'private, max-age=86400').sendFile(await frameAt(src.files.preview, t, path.join(DATA, 'sources', src.id, 'frames')));
}));
// Trim → template. `start`/`end` are seconds within the source (the trimmer's timeline).
app.post('/api/rooms/:slug/sources/:id/template', inRoom(), wrap(async (req, res) => {
  const src = db.get('sources', req.params.id);
  if (!src || src.room_id !== req.room.id) return bad(res, 404, 'Video not found');
  const start = Math.max(0, Number(req.body?.start) || 0);
  const end = Math.min(src.duration_s, Number(req.body?.end) || start + MAX_TEMPLATE_SECONDS);
  const len = end - start;
  if (!(len >= MIN_TEMPLATE_SECONDS - 0.05)) return bad(res, 400, `Pick at least ${MIN_TEMPLATE_SECONDS}s`);
  if (len > MAX_TEMPLATE_SECONDS + 0.05) return bad(res, 400, `Pick at most ${MAX_TEMPLATE_SECONDS}s`);
  const cut = path.join(DATA, 'uploads', `cut-${newId()}.mp4`);
  try {
    await cutClip(src.files.source, start, end, cut);
    const t = await createTemplate(cut, {
      title: String(req.body?.title || '').trim() || src.title, room_id: req.room.id, created_by: req.me.id,
      source_url: src.source_url, source_start_s: (src.offset_s || 0) + start, source_id: src.id,
    });
    db.update('templates', t.id, { source_trim: { start, end } });
    // Re-trimming replaces the earlier unused template from the same video.
    const old = db.get('templates', req.body?.replaces);
    if (old && old.source_id === src.id && old.created_by === req.me.id && !old.renders && old.id !== t.id) db.update('templates', old.id, { status: 'retired' });
    res.json(publicTemplate(db.get('templates', t.id)));
  } catch (e) { bad(res, 400, e.message); } finally { fs.rmSync(cut, { force: true }); }
}));
app.get('/api/rooms/:slug/templates/:id', inRoom(), (req, res) => {
  const t = db.get('templates', req.params.id);
  if (!t || (t.room_id && t.room_id !== req.room.id)) return bad(res, 404, 'Template not found');
  res.json({ ...publicTemplate(t), source_trim: t.source_trim || null, made_here: t.room_id === req.room.id });
});
app.post('/api/rooms/:slug/templates/link', inRoom(), wrap(async (req, res) => {
  const recent = db.where('templates', (t) => t.created_by === req.me.id && t.source_url && Date.now() - new Date(t.created_at) < 3600e3).length;
  if (recent >= 15) return bad(res, 429, 'Slow down: 15 links an hour');
  try { res.json(publicTemplate(await templateFromLink(req.body, { room_id: req.room.id, created_by: req.me.id }))); }
  catch (e) { bad(res, 400, e.message); }
}));
app.patch('/api/rooms/:slug/templates/:id', inRoom(), (req, res) => {
  const t = db.get('templates', req.params.id);
  if (!t || (t.room_id && t.room_id !== req.room.id)) return bad(res, 404, 'Template not found');
  const target = typeof req.body?.main_subject === 'string' ? req.body.main_subject.trim().slice(0, 200) : null;
  if (!target) return bad(res, 400, 'Say who should be replaced');
  if (!t.room_id) return bad(res, 403, 'Shared templates can’t be changed. Remix one instead.');
  db.update('templates', t.id, { brief: { ...brief(t), main_subject: target, target_source: 'user' }, protect_region: null, analyzing: true });
  runAnalysis(t.id, false, target);
  res.json(publicTemplate(db.get('templates', t.id)));
});

// ----- faces (consent) -----
// kind: 'self' (my selfie: approved), 'member' (another member: waits for them to approve),
//       'pet' (approved)
app.post('/api/rooms/:slug/faces', inRoom(), upload.single('image'), (req, res) => {
  if (!req.file) return bad(res, 400, 'Attach a photo');
  if (/^(video|audio|text)\//.test(req.file.mimetype)) { fs.rmSync(req.file.path, { force: true }); return bad(res, 400, 'That file is not a photo'); }
  const kind = ['self', 'member', 'pet'].includes(req.body.kind) ? req.body.kind : 'self';
  let subject = null, label = String(req.body.label || '').trim().slice(0, 30), status;
  if (kind === 'member') {
    subject = db.get('members', req.body.subject_member_id);
    if (!subject || subject.room_id !== req.room.id) { fs.rmSync(req.file.path, { force: true }); return bad(res, 400, 'Pick who this is'); }
    if (subject.id === req.me.id) return bad(res, 400, 'That’s you: use “Take a selfie”');
    label = subject.name; status = 'pending';
  } else if (kind === 'self') {
    label = req.me.name; status = 'approved';
    // One selfie per member: replace the old one.
    for (const f of db.where('faces', (f) => f.room_id === req.room.id && f.kind === 'self' && f.added_by === req.me.id && f.status !== 'declined')) db.update('faces', f.id, { status: 'declined', replaced: true });
  } else {
    if (!label) label = 'Pet';
    status = 'approved';
  }
  const persona = createPersona(req.file);
  const face = db.insert('faces', {
    id: newId(), room_id: req.room.id, persona_id: persona.id, label, kind, status,
    added_by: req.me.id, subject_member_id: kind === 'self' ? req.me.id : subject?.id || null, created_at: now(),
  });
  res.json(publicFace(face));
});
app.post('/api/rooms/:slug/faces/:id/decide', inRoom(), (req, res) => {
  const f = db.get('faces', req.params.id);
  if (!f || f.room_id !== req.room.id) return bad(res, 404, 'Face not found');
  if (f.subject_member_id !== req.me.id) return bad(res, 403, 'Only the person in the photo can decide');
  db.update('faces', f.id, { status: req.body?.approve ? 'approved' : 'declined', decided_at: now() });
  res.json(roomState(req.room, req.me));
});
app.delete('/api/rooms/:slug/faces/:id', inRoom(), (req, res) => {
  const f = db.get('faces', req.params.id);
  if (!f || f.room_id !== req.room.id) return bad(res, 404, 'Face not found');
  if (f.added_by !== req.me.id && f.subject_member_id !== req.me.id) return bad(res, 403, 'Only who added it, or who is in it, can remove it');
  db.update('faces', f.id, { status: 'declined', removed_at: now() });
  res.json(roomState(req.room, req.me));
});

// ----- frame 1 (hybrid) + likes -----
app.post('/api/rooms/:slug/hybrids', inRoom(), wrap(async (req, res) => {
  const t = db.get('templates', req.body?.template_id);
  if (!t || t.status !== 'live' || (t.room_id && t.room_id !== req.room.id)) return bad(res, 404, 'Template not found');
  const f = db.get('faces', req.body?.face_id);
  if (!f || f.room_id !== req.room.id) return bad(res, 404, 'Face not found');
  if (!faceUsable(f)) return bad(res, 409, f.kind === 'member' ? `Waiting for ${f.label} to approve their face` : 'That face isn’t approved', { code: 'face_pending' });
  const p = db.get('personas', f.persona_id);
  if (!p || p.status !== 'done') return bad(res, 409, 'Still preparing that face, try again in a moment');
  const recent = db.where('hybrids', (h) => h.created_by === req.me.id && Date.now() - new Date(h.created_at) < 3600e3).length;
  if (recent >= 20) return bad(res, 429, 'Slow down: 20 previews an hour');
  const h = await createHybrid({ template: t, persona: p, notes: req.body?.notes, room_id: req.room.id, created_by: req.me.id, face_id: f.id });
  res.json(publicHybrid(h));
}));
app.post('/api/rooms/:slug/hybrids/:id/like', inRoom(), (req, res) => {
  const h = db.get('hybrids', req.params.id);
  if (!h || h.room_id !== req.room.id) return bad(res, 404, 'Not found');
  const mine = db.find('likes', (l) => l.hybrid_id === h.id && l.member_id === req.me.id);
  if (mine) db.remove('likes', (l) => l.id === mine.id);
  else db.insert('likes', { id: newId(), room_id: req.room.id, hybrid_id: h.id, member_id: req.me.id, created_at: now() });
  res.json(roomState(req.room, req.me));
});

// ----- renders (paid from the pool) -----
app.post('/api/rooms/:slug/renders', inRoom(), (req, res) => {
  const h = db.get('hybrids', req.body?.hybrid_id);
  if (!h || h.room_id !== req.room.id || h.status !== 'done') return bad(res, 409, 'Make frame 1 first');
  const f = db.get('faces', h.face_id);
  if (!faceUsable(f)) return bad(res, 409, 'That face isn’t approved anymore');
  const t = db.get('templates', h.template_id);
  const engine = ENGINES[req.body?.engine] ? req.body.engine : DEFAULT_ENGINE; // members can switch models after a failure
  const price = priceCents(estimateCost(t, engine));
  if (req.room.daily_limit && rendersToday(db, req.me.id) >= req.room.daily_limit) return bad(res, 429, `Daily limit reached (${req.room.daily_limit} a day)`, { code: 'daily_limit' });
  if (balanceCents(db, req.room.id) < price) return bad(res, 402, 'Not enough in the pool. Top it up first.', { code: 'low_balance', price_cents: price });
  const r = createRender({ template: t, hybrid: h, engine, direction: h.direction, room_id: req.room.id, created_by: req.me.id, price_cents: price });
  addLedger(db, { room_id: req.room.id, member_id: req.me.id, amount_cents: -price, kind: 'render', ref: r.id, note: t.title });
  res.json(publicRender(r));
});
app.post('/api/rooms/:slug/renders/:id/remix', inRoom(), wrap(async (req, res) => {
  const r = db.get('renders', req.params.id);
  if (!r || r.room_id !== req.room.id || !r.output_path) return bad(res, 404, 'Finished meme not found');
  const target = String(req.body?.target || '').trim().slice(0, 200);
  if (!target) return bad(res, 400, 'Say who to replace');
  const parent = db.get('templates', r.template_id);
  try {
    const t = await createTemplate(path.join(DATA, r.output_path), { title: `Remix: ${parent?.title || 'meme'}`, target, room_id: req.room.id, created_by: req.me.id, parent_render_id: r.id, protect: true });
    res.json(publicTemplate(t));
  } catch (e) { bad(res, 400, e.message); }
}));

// ======================================================================
// Studio API (single-user debugging page at /studio, documented in API.md)
// ======================================================================
app.get('/api/templates', (_req, res) => res.json(db.where('templates', (t) => t.status === 'live').sort((a, b) => b.created_at.localeCompare(a.created_at)).map(publicTemplate)));
app.post('/api/templates', upload.single('video'), wrap(async (req, res) => {
  if (!req.file) return bad(res, 400, 'Attach a video file.');
  try {
    if (/^(image|audio|text)\//.test(req.file.mimetype)) return bad(res, 400, 'That file is not a video.');
    res.json(publicTemplate(await createTemplate(req.file.path, { title: (req.body.title || '').trim() || req.file.originalname.replace(/\.[^.]+$/, ''), direction: req.body.direction })));
  } catch (e) { bad(res, 400, e.message); } finally { fs.rmSync(req.file.path, { force: true }); }
}));
app.post('/api/templates/link', wrap(async (req, res) => {
  try { res.json(publicTemplate(await templateFromLink(req.body))); } catch (e) { bad(res, 400, e.message); }
}));
app.patch('/api/templates/:id', (req, res) => {
  const t = db.get('templates', req.params.id);
  if (!t) return bad(res, 404, 'Template not found');
  const patch = {};
  if (typeof req.body.title === 'string' && req.body.title.trim()) patch.title = req.body.title.trim();
  if (typeof req.body.direction === 'string') patch.brief = { ...brief(t), direction: req.body.direction.trim().slice(0, 400), source: 'user' };
  const target = typeof req.body.main_subject === 'string' ? req.body.main_subject.trim().slice(0, 200) : null;
  if (target) { patch.brief = { ...(patch.brief || brief(t)), main_subject: target, target_source: 'user' }; patch.protect_region = null; }
  if (req.body.status === 'retired') patch.status = 'retired';
  db.update('templates', t.id, patch);
  if (target) { db.update('templates', t.id, { analyzing: true }); runAnalysis(t.id, false, target); }
  res.json(publicTemplate(db.get('templates', t.id)));
});
app.post('/api/templates/:id/analyze', wrap(async (req, res) => {
  const t = db.get('templates', req.params.id);
  if (!t) return bad(res, 404, 'Template not found');
  await runAnalysis(t.id, false);
  res.json(publicTemplate(db.get('templates', t.id)));
}));
app.post('/api/personas', upload.single('image'), (req, res) => {
  if (!req.file) return bad(res, 400, 'Attach an image.');
  if (/^(video|audio|text)\//.test(req.file.mimetype)) { fs.rmSync(req.file.path, { force: true }); return bad(res, 400, 'That file is not an image.'); }
  res.json(publicPersona(createPersona(req.file)));
});
app.get('/api/personas/:id', (req, res) => { const p = db.get('personas', req.params.id); p ? res.json(publicPersona(p)) : bad(res, 404, 'Persona not found'); });
app.post('/api/personas/:id/rebuild', (req, res) => {
  const p = db.get('personas', req.params.id);
  if (!p) return bad(res, 404, 'Persona not found');
  if (['checking', 'cleaning', 'angles'].includes(p.status)) return bad(res, 409, 'Already building');
  db.update('personas', p.id, { status: 'queued', fal_urls: { original: p.fal_urls?.original } });
  buildPersona(db, p.id, DATA);
  res.json(publicPersona(db.get('personas', p.id)));
});
app.post('/api/hybrids', wrap(async (req, res) => {
  const t = db.get('templates', req.body?.template_id);
  if (!t || t.status !== 'live') return bad(res, 404, 'Template not found');
  const p = db.get('personas', req.body?.persona_id);
  if (!p || p.status !== 'done') return bad(res, 409, 'Build the persona first.');
  res.json(publicHybrid(await createHybrid({ template: t, persona: p, direction: req.body.direction, notes: req.body.notes })));
}));
app.get('/api/hybrids/:id', (req, res) => { const h = db.get('hybrids', req.params.id); h ? res.json(publicHybrid(h)) : bad(res, 404, 'Hybrid not found'); });
app.post('/api/renders', (req, res) => {
  const b = req.body || {};
  const t = db.get('templates', b.template_id);
  if (!t || t.status !== 'live') return bad(res, 404, 'Template not found');
  const h = db.get('hybrids', b.hybrid_id);
  if (!h || h.status !== 'done' || h.template_id !== t.id) return bad(res, 409, 'Create and approve a hybrid still for this template first.');
  const engines = b.engine === 'compare' ? ['kling', 'seedance'] : [ENGINES[b.engine] ? b.engine : DEFAULT_ENGINE];
  const group_id = engines.length > 1 ? newId() : null;
  res.json(engines.map((engine) => publicRender(createRender({ template: t, hybrid: h, engine, direction: b.direction, group_id }))));
});
app.get('/api/renders/:id', (req, res) => { const r = db.get('renders', req.params.id); r ? res.json(publicRender(r)) : bad(res, 404, 'Render not found'); });
app.get('/api/renders', (_req, res) => res.json(db.where('renders', (r) => r.output_path).slice(-24).reverse().map(publicRender)));
app.post('/api/renders/:id/remix', wrap(async (req, res) => {
  const r = db.get('renders', req.params.id);
  if (!r || !r.output_path) return bad(res, 404, 'Finished render not found');
  const parent = db.get('templates', r.template_id);
  const target = (req.body?.target || '').trim().slice(0, 200) || null;
  try { res.json(publicTemplate(await createTemplate(path.join(DATA, r.output_path), { title: `Remix: ${parent?.title || 'meme'}`, target, parent_render_id: r.id, protect: true }))); }
  catch (e) { bad(res, 400, e.message); }
}));

// SPA routes: /r/<slug> and / serve the mobile app.
app.get(['/', '/r/:slug'], (_req, res) => res.sendFile(path.join(ROOT, 'public', 'index.html')));

// Jobs interrupted by a restart can't resume; failed room renders get refunded.
for (const p of db.list('personas')) if (!['done', 'failed'].includes(p.status)) db.update('personas', p.id, { status: 'failed', error: 'Server restarted mid-build' });
for (const h of db.list('hybrids')) if (!['done', 'failed'].includes(h.status)) db.update('hybrids', h.id, { status: 'failed', error: 'Server restarted mid-generation' });
for (const f of db.list('faces')) if (f.kind === 'self' && f.status === 'pending') db.update('faces', f.id, { status: 'approved' }); // selfies no longer wait on a phone check
for (const t of db.list('templates')) if (t.analyzing) db.update('templates', t.id, { analyzing: false });
for (const r of db.list('renders')) if (!['done', 'failed', 'preview_ready'].includes(r.status)) {
  db.update('renders', r.id, { status: 'failed', error: `Server restarted mid-render${r.fal_request_id ? ` (fal request ${r.fal_request_id} may still finish on fal)` : ''}` });
  events.emit('render:failed', r.id);
}

const PORT = Number(process.env.PORT) || 3000;
app.listen(PORT, () => {
  const s = settings();
  console.log(`\n  bloop → http://localhost:${PORT}   (studio: /studio)`);
  console.log(`  mode: ${s.mock ? 'MOCK (no fal calls)' : s.has_key ? 'LIVE (fal)' : 'LIVE but FAL_KEY missing!'} · engine ${ENGINES[DEFAULT_ENGINE].name}\n`);
});
