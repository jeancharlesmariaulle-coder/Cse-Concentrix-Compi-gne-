// Portail CSE Concentrix Compiègne — fonction serveur unique (Vercel, Node).
// Toutes les routes passent par /api/cse?a=...
const crypto = require('crypto');

const REDIS_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const SECRET = process.env.SESSION_SECRET || ADMIN_PASSWORD || 'cse';

const CONTENT = ['actus', 'events', 'avantages', 'documents', 'galerie'];
const FIELDS = {
  actus: ['titre', 'cat', 'contenu', 'auteur', 'date'],
  events: ['titre', 'date', 'heure', 'lieu', 'description'],
  avantages: ['titre', 'cat', 'description', 'lien', 'code', 'validite'],
  documents: ['titre', 'cat', 'description', 'lien'],
  galerie: ['titre', 'album', 'date', 'video'],
  messages: ['sujet', 'message', 'contact'],
};
const SETTINGS = ['email', 'telephone', 'adresse', 'permanences'];
const LONG = ['contenu', 'description', 'message', 'permanences'];
const MAX_FILE = 3.2 * 1024 * 1024;

/* ---------- utilitaires ---------- */
const storageReady = () => Boolean(REDIS_URL && REDIS_TOKEN);
async function redis(...cmd) {
  if (!storageReady()) throw Object.assign(new Error('Stockage non configuré'), { status: 503 });
  const r = await fetch(REDIS_URL, { method: 'POST', headers: { Authorization: `Bearer ${REDIS_TOKEN}`, 'Content-Type': 'application/json' }, body: JSON.stringify(cmd) });
  const d = await r.json().catch(() => ({}));
  if (!r.ok || d.error) throw new Error(d.error || `Redis ${r.status}`);
  return d.result;
}
const newId = () => Date.now().toString(36) + crypto.randomBytes(4).toString('hex');
const b64 = s => Buffer.from(s).toString('base64url');
const sign = p => crypto.createHmac('sha256', SECRET).update(p).digest('base64url');
function makeToken(user) {
  const hours = user.role === 'elu' ? 24 : 24 * 14;
  const payload = b64(JSON.stringify({ uid: user.id, role: user.role, exp: Date.now() + hours * 3600e3 }));
  return `${payload}.${sign(payload)}`;
}
function readToken(req) {
  const h = req.headers.authorization || '';
  const tok = h.startsWith('Bearer ') ? h.slice(7) : String(req.query.t || '');
  const [p, s] = tok.split('.');
  if (!p || !s) return null;
  const exp = sign(p);
  if (exp.length !== s.length || !crypto.timingSafeEqual(Buffer.from(exp), Buffer.from(s))) return null;
  try { const d = JSON.parse(Buffer.from(p, 'base64url').toString()); return d.exp > Date.now() ? d : null; } catch { return null; }
}
function hashPw(pw, salt = crypto.randomBytes(16).toString('hex')) {
  return { salt, hash: crypto.scryptSync(String(pw), salt, 32).toString('hex') };
}
function checkPw(pw, user) {
  const h = crypto.scryptSync(String(pw), user.salt, 32);
  return crypto.timingSafeEqual(h, Buffer.from(user.hash, 'hex'));
}
const sameSecret = (a, b) => { const x = crypto.createHash('sha256').update(String(a)).digest(); const y = crypto.createHash('sha256').update(String(b)).digest(); return crypto.timingSafeEqual(x, y); };
function body(req) { if (req.body && typeof req.body === 'object') return req.body; try { return JSON.parse(req.body || '{}'); } catch { return {}; } }
function send(res, status, obj) { res.status(status).setHeader('Cache-Control', 'no-store'); res.json(obj); }
const fail = (status, msg) => Object.assign(new Error(msg), { status });
const clip = (v, f) => String(v ?? '').trim().slice(0, LONG.includes(f) ? 8000 : 300);
const publicUser = u => u && ({ id: u.id, email: u.email, prenom: u.prenom, nom: u.nom, service: u.service, role: u.role, status: u.status, created: u.created });
async function rateLimit(req, key, max) {
  const ip = String(req.headers['x-forwarded-for'] || 'x').split(',')[0].trim();
  const k = `cse:rl:${key}:${ip}`;
  const n = await redis('INCR', k); if (n === 1) await redis('EXPIRE', k, 3600);
  if (n > max) throw fail(429, 'Trop de tentatives. Réessayez dans une heure.');
}
async function getUser(id) { const v = await redis('HGET', 'cse:users', id); return v ? JSON.parse(v) : null; }
async function allUsers() { const f = (await redis('HGETALL', 'cse:users')) || []; const o = []; for (let i = 1; i < f.length; i += 2) o.push(JSON.parse(f[i])); return o; }
async function saveUser(u) { await redis('HSET', 'cse:users', u.id, JSON.stringify(u)); }
const ADMIN_USER = { id: 'admin', email: 'admin', prenom: 'Administrateur', nom: 'CSE', role: 'elu', status: 'active', created: '2026-01-01T00:00:00.000Z' };

/* Session courante : vérifie le jeton ET que le compte est toujours actif */
async function session(req) {
  const t = readToken(req); if (!t) return null;
  if (t.uid === 'admin') return ADMIN_PASSWORD ? ADMIN_USER : null;
  const u = await getUser(t.uid);
  return u && u.status === 'active' ? u : null;
}
async function need(req, role) {
  const u = await session(req);
  if (!u) throw fail(401, 'Veuillez vous connecter.');
  if (role === 'elu' && u.role !== 'elu') throw fail(403, 'Réservé aux élu·e·s.');
  return u;
}

/* ---------- actions ---------- */
const A = {
  async health() { return { ok: true, storage: storageReady(), auth: Boolean(ADMIN_PASSWORD) }; },

  async register(req) {
    const b = body(req);
    const email = String(b.email || '').trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw fail(400, 'Adresse email invalide.');
    if (String(b.password || '').length < 8) throw fail(400, 'Le mot de passe doit faire au moins 8 caractères.');
    if (!String(b.prenom || '').trim() || !String(b.nom || '').trim()) throw fail(400, 'Indiquez votre prénom et votre nom.');
    await rateLimit(req, 'reg', 5);
    const existing = await redis('HGET', 'cse:emails', email);
    if (existing) throw fail(409, 'Un compte existe déjà avec cet email.');
    const u = { id: newId(), email, prenom: clip(b.prenom), nom: clip(b.nom), service: clip(b.service), role: 'salarie', status: 'pending', created: new Date().toISOString(), ...hashPw(b.password) };
    await saveUser(u); await redis('HSET', 'cse:emails', email, u.id);
    return { ok: true, status: 'pending' };
  },

  async login(req) {
    const b = body(req);
    const email = String(b.email || '').trim().toLowerCase();
    await new Promise(r => setTimeout(r, 300));
    if (email === 'admin') {
      if (!ADMIN_PASSWORD) throw fail(503, "Le mot de passe administrateur n'est pas configuré.");
      await rateLimit(req, 'adm', 15);
      if (!sameSecret(b.password || '', ADMIN_PASSWORD)) throw fail(401, 'Identifiant ou mot de passe incorrect.');
      return { token: makeToken(ADMIN_USER), user: publicUser(ADMIN_USER) };
    }
    await rateLimit(req, 'log', 30);
    const id = await redis('HGET', 'cse:emails', email);
    const u = id && await getUser(id);
    if (!u || !checkPw(b.password || '', u)) throw fail(401, 'Identifiant ou mot de passe incorrect.');
    if (u.status === 'pending') throw fail(403, 'Votre compte est en attente de validation par un·e élu·e du CSE.');
    if (u.status !== 'active') throw fail(403, "Votre compte n'est pas actif. Contactez un·e élu·e du CSE.");
    return { token: makeToken(u), user: publicUser(u) };
  },

  async me(req) { return { user: publicUser(await need(req)) }; },

  async password(req) {
    const u = await need(req); const b = body(req);
    if (u.id === 'admin') throw fail(400, 'Le mot de passe administrateur se change dans Vercel.');
    if (!checkPw(b.old || '', u)) throw fail(401, 'Mot de passe actuel incorrect.');
    if (String(b.password || '').length < 8) throw fail(400, 'Le nouveau mot de passe doit faire au moins 8 caractères.');
    Object.assign(u, hashPw(b.password)); await saveUser(u); return { ok: true };
  },

  async users(req) {
    await need(req, 'elu');
    if (req.method === 'GET') return { items: (await allUsers()).map(publicUser).sort((a, b) => b.created.localeCompare(a.created)) };
    const b = body(req); const u = await getUser(String(b.id || ''));
    if (!u) throw fail(404, 'Compte introuvable.');
    if (b.op === 'approve') u.status = 'active';
    else if (b.op === 'suspend') u.status = 'suspended';
    else if (b.op === 'elu') u.role = 'elu';
    else if (b.op === 'salarie') u.role = 'salarie';
    else if (b.op === 'reset') {
      const temp = crypto.randomBytes(5).toString('base64url').replace(/[-_]/g, 'x') + '7';
      Object.assign(u, hashPw(temp)); await saveUser(u); return { ok: true, temp };
    } else if (b.op === 'delete') {
      await redis('HDEL', 'cse:users', u.id); await redis('HDEL', 'cse:emails', u.email); return { ok: true };
    } else throw fail(400, 'Action inconnue');
    await saveUser(u); return { ok: true, user: publicUser(u) };
  },

  async settings(req) {
    if (req.method === 'GET') { await need(req); const v = await redis('GET', 'cse:settings'); return { settings: v ? JSON.parse(v) : {} }; }
    await need(req, 'elu'); const b = body(req); const s = {};
    for (const f of SETTINGS) s[f] = clip(b[f], f);
    await redis('SET', 'cse:settings', JSON.stringify(s)); return { settings: s };
  },

  async data(req) {
    const col = String(req.query.col || '');
    if (![...CONTENT, 'messages'].includes(col)) throw fail(400, 'Collection inconnue');
    const key = `cse:${col}`;
    if (req.method === 'GET') {
      await need(req, col === 'messages' ? 'elu' : null);
      const f = (await redis('HGETALL', key)) || []; const items = [];
      for (let i = 1; i < f.length; i += 2) { try { items.push(JSON.parse(f[i])); } catch {} }
      items.sort((a, b) => String(b.created || '').localeCompare(String(a.created || '')));
      return { items };
    }
    if (req.method === 'DELETE') {
      await need(req, 'elu'); const id = String(req.query.id || '');
      const prev = await redis('HGET', key, id);
      if (prev) { try { const it = JSON.parse(prev); if (it.fileId) await redis('DEL', `cse:file:${it.fileId}`); } catch {} }
      await redis('HDEL', key, id); return { ok: true };
    }
    // POST
    const b = body(req);
    if (col === 'messages') {
      const u = await need(req);
      await rateLimit(req, 'msg', 10);
      if (String(b.message || '').trim().length < 3) throw fail(400, 'Message vide.');
      const anon = Boolean(b.anonyme);
      const item = { id: newId(), created: new Date().toISOString(), sujet: clip(b.sujet), message: clip(b.message, 'message'), contact: clip(b.contact),
        nom: anon ? '' : `${u.prenom} ${u.nom}`, service: anon ? '' : (u.service || ''), email: anon ? '' : u.email, anonyme: anon };
      await redis('HSET', key, item.id, JSON.stringify(item)); return { item };
    }
    await need(req, 'elu');
    let item = {};
    if (b.id) { const prev = await redis('HGET', key, String(b.id)); if (prev) item = JSON.parse(prev); }
    for (const f of FIELDS[col]) if (b[f] !== undefined) item[f] = clip(b[f], f);
    item.id = item.id || newId(); item.created = item.created || new Date().toISOString();
    if (b.file && b.file.data) {
      const data = String(b.file.data);
      if (!/^data:[\w.+-]+\/[\w.+-]+;base64,/.test(data)) throw fail(400, 'Fichier invalide');
      if (data.length > MAX_FILE) throw fail(413, 'Fichier trop lourd (2,4 Mo maximum).');
      if (item.fileId) await redis('DEL', `cse:file:${item.fileId}`);
      item.fileId = newId(); await redis('SET', `cse:file:${item.fileId}`, data);
      item.fileName = clip(b.file.name || 'fichier'); item.fileType = data.slice(5, data.indexOf(';'));
      item.fileSize = Math.round((data.length - data.indexOf(',') - 1) * 0.75);
    }
    if (col === 'galerie' && !item.fileId && !item.video) throw fail(400, 'Ajoutez une photo, une vidéo ou un lien vidéo.');
    await redis('HSET', key, item.id, JSON.stringify(item)); return { item };
  },

  async file(req, res) {
    await need(req);
    const id = String(req.query.id || '').replace(/[^a-z0-9]/gi, '');
    const data = id && await redis('GET', `cse:file:${id}`);
    if (!data) throw fail(404, 'Fichier introuvable');
    const type = data.slice(5, data.indexOf(';'));
    const buf = Buffer.from(data.slice(data.indexOf(',') + 1), 'base64');
    const name = String(req.query.name || 'fichier').replace(/["\r\n]/g, '');
    res.setHeader('Content-Type', type); res.setHeader('Content-Length', buf.length);
    res.setHeader('Cache-Control', 'private, max-age=86400');
    res.setHeader('Content-Disposition', `${req.query.dl ? 'attachment' : 'inline'}; filename*=UTF-8''${encodeURIComponent(name)}`);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.status(200).end(buf); return null;
  },
};

module.exports = async (req, res) => {
  try {
    const fn = A[String(req.query.a || 'health')];
    if (!fn) return send(res, 404, { error: 'Action inconnue' });
    const out = await fn(req, res);
    if (out !== null) send(res, 200, out);
  } catch (e) {
    send(res, e.status || 500, { error: e.status ? e.message : 'Erreur serveur : ' + e.message });
  }
};
