// Room layer helpers: identity, money, consent rules.
import crypto from 'node:crypto';

export const COLORS = ['#c7d2fe', '#fbcfe8', '#bbf7d0', '#fde68a', '#bae6fd', '#fecaca', '#ddd6fe', '#fed7aa'];
export const MARKUP = Number(process.env.BLOOP_MARKUP || 1); // price = fal cost × markup
export const FREE_TRIAL_CENTS = Number(process.env.BLOOP_FREE_TRIAL_CENTS || 500);
export const DEFAULT_DAILY_LIMIT = 3;

export const newId = () => crypto.randomBytes(5).toString('hex');
export const newToken = () => crypto.randomBytes(18).toString('base64url');

export function slugFor(name, taken) {
  const base = (name || 'room').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24) || 'room';
  let slug;
  do { slug = `${base}-${crypto.randomBytes(2).toString('hex')}`; } while (taken(slug));
  return slug;
}

export const priceCents = (usd) => Math.ceil(usd * MARKUP * 100);

export function balanceCents(db, roomId) {
  return db.where('ledger', (l) => l.room_id === roomId).reduce((s, l) => s + l.amount_cents, 0);
}

export function rendersToday(db, memberId) {
  const since = new Date(); since.setHours(0, 0, 0, 0);
  return db.where('renders', (r) => r.created_by === memberId && r.status !== 'failed' && new Date(r.created_at) >= since).length;
}

export function addLedger(db, { room_id, member_id, amount_cents, kind, ref = null, note = null }) {
  return db.insert('ledger', { id: newId(), room_id, member_id, amount_cents, kind, ref, note, created_at: new Date().toISOString() });
}

/** Consent: who may use a face. */
export function faceUsable(face) { return face && face.status === 'approved'; }

