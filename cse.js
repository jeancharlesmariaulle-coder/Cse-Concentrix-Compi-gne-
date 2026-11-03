// Fonction unique du portail CSE — à placer dans le dossier api/ (fichier api/cse.js)
// Outils partagés par les fonctions serverless (non exposé comme route : le nom commence par "_").
const crypto = require('crypto');

const REDIS_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const SECRET = process.env.SESSION_SECRET || ADMIN_PASSWORD;

const COLLECTIONS = ['actus', 'events', 'avantages', 'documents', 'galerie', 'messages'];
const PRIVATE = ['messages'];

function storageReady() { return Boolean(REDIS_URL && REDIS_TOKEN); }

async function redis(...cmd) {
  if (!storageReady()) throw Object.assign(new Error('Stockage non configuré'), { status: 503 });
  const r = await fetch(REDIS_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${REDIS_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(cmd),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok || data.error) throw new Error(data.error || `Redis ${r.status}`);
  return data.result;
}

function sign(payload) {
  return crypto.createHmac('sha256', SECRET).update(payload).digest('base64url');
}
function makeToken() {
  const exp = Date.now() + 1000 * 60 * 60 * 12; // 12 h
  const payload = `admin.${exp}`;
  return `${payload}.${sign(payload)}`;
}
function isAdmin(req) {
  if (!ADMIN_PASSWORD) return false;
  const h = req.headers.authorization || '';
  const tok = h.startsWith('Bearer ') ? h.slice(7) : '';
  const parts = tok.split('.');
  if (parts.length !== 3) return false;
  const payload = `${parts[0]}.${parts[1]}`;
  const expected = sign(payload);
  if (expected.length !== parts[2].length) return false;
  if (!crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(parts[2]))) return false;
  return Number(parts[1]) > Date.now();
}
function checkPassword(pw) {
  if (!ADMIN_PASSWORD || typeof pw !== 'string') return false;
  const a = crypto.createHash('sha256').update(pw).digest();
  const b = crypto.createHash('sha256').update(ADMIN_PASSWORD).digest();
  return crypto.timingSafeEqual(a, b);
}

async function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') { try { return JSON.parse(req.body); } catch { return {}; } }
  return {};
}

function send(res, status, obj) {
  res.status(status).setHeader('Cache-Control', 'no-store');
  res.json(obj);
}

function newId() { return Date.now().toString(36) + crypto.randomBytes(4).toString('hex'); }

const _lib = { redis, storageReady, isAdmin, checkPassword, makeToken, readBody, send, newId, COLLECTIONS, PRIVATE, ADMIN_PASSWORD };

// API unique pour les contenus du site.
//   GET    /api/data?col=actus            -> liste (public, sauf "messages" réservé aux élu·e·s)
//   POST   /api/data?col=actus            -> ajout / modification (élu·e·s ; "messages" ouvert à tous)
//   DELETE /api/data?col=actus&id=xxx     -> suppression (élu·e·s)

const FIELDS = {
  actus: ['titre', 'cat', 'contenu', 'auteur', 'date', 'une'],
  events: ['titre', 'date', 'heure', 'lieu', 'description'],
  avantages: ['titre', 'cat', 'description', 'lien', 'code', 'validite'],
  documents: ['titre', 'cat', 'description', 'lien'],
  galerie: ['titre', 'album', 'date'],
  messages: ['nom', 'service', 'contact', 'sujet', 'message'],
};
const LONG = ['contenu', 'description', 'message'];
const MAX_FILE = 3.2 * 1024 * 1024; // ~2,4 Mo de fichier réel une fois encodé

function clean(col, body) {
  const out = {};
  for (const f of FIELDS[col]) {
    if (body[f] === undefined || body[f] === null) continue;
    let v = String(body[f]).trim();
    v = v.slice(0, LONG.includes(f) ? 8000 : 300);
    out[f] = v;
  }
  return out;
}

const handler_data = async (req, res) => {
  try {
    const col = String(req.query.col || '');
    if (!COLLECTIONS.includes(col)) return send(res, 400, { error: 'Collection inconnue' });
    const key = `cse:${col}`;
    const admin = isAdmin(req);

    if (req.method === 'GET') {
      if (PRIVATE.includes(col) && !admin) return send(res, 401, { error: 'Réservé aux élu·e·s' });
      const flat = (await redis('HGETALL', key)) || [];
      const items = [];
      for (let i = 1; i < flat.length; i += 2) { try { items.push(JSON.parse(flat[i])); } catch {} }
      items.sort((a, b) => String(b.created || '').localeCompare(String(a.created || '')));
      return send(res, 200, { items });
    }

    if (req.method === 'POST') {
      const body = await readBody(req);
      if (col === 'messages') {
        if (body.website) return send(res, 200, { ok: true }); // pot de miel anti-robots
        const ip = String(req.headers['x-forwarded-for'] || 'x').split(',')[0].trim();
        const n = await redis('INCR', `cse:rl:${ip}`);
        if (n === 1) await redis('EXPIRE', `cse:rl:${ip}`, 3600);
        if (n > 8) return send(res, 429, { error: 'Trop de messages envoyés. Réessayez dans une heure.' });
        if (!body.message || String(body.message).trim().length < 3) return send(res, 400, { error: 'Message vide.' });
      } else if (!admin) {
        return send(res, 401, { error: 'Session élu·e expirée. Reconnectez-vous.' });
      }

      const isUpdate = admin && body.id && col !== 'messages';
      let item = {};
      if (isUpdate) {
        const prev = await redis('HGET', key, String(body.id));
        if (prev) item = JSON.parse(prev);
      }
      Object.assign(item, clean(col, body));
      item.id = item.id || newId();
      item.created = item.created || new Date().toISOString();

      if (body.file && body.file.data && col !== 'messages') {
        const data = String(body.file.data);
        if (!/^data:[\w.+-]+\/[\w.+-]+;base64,/.test(data)) return send(res, 400, { error: 'Fichier invalide' });
        if (data.length > MAX_FILE) return send(res, 413, { error: 'Fichier trop lourd (2,4 Mo maximum).' });
        if (item.fileId) await redis('DEL', `cse:file:${item.fileId}`);
        item.fileId = newId();
        await redis('SET', `cse:file:${item.fileId}`, data);
        item.fileName = String(body.file.name || 'fichier').slice(0, 150);
        item.fileType = data.slice(5, data.indexOf(';'));
        item.fileSize = Math.round((data.length - data.indexOf(',') - 1) * 0.75);
      }
      if (col === 'galerie' && !item.fileId) return send(res, 400, { error: 'Ajoutez une photo.' });

      await redis('HSET', key, item.id, JSON.stringify(item));
      return send(res, 200, { item });
    }

    if (req.method === 'DELETE') {
      if (!admin) return send(res, 401, { error: 'Session élu·e expirée. Reconnectez-vous.' });
      const id = String(req.query.id || '');
      const prev = await redis('HGET', key, id);
      if (prev) {
        try { const it = JSON.parse(prev); if (it.fileId) await redis('DEL', `cse:file:${it.fileId}`); } catch {}
      }
      await redis('HDEL', key, id);
      return send(res, 200, { ok: true });
    }

    send(res, 405, { error: 'Méthode non autorisée' });
  } catch (e) {
    send(res, e.status || 500, { error: e.status === 503 ? 'Stockage non configuré' : 'Erreur serveur : ' + e.message });
  }
};


const handler_login = async (req, res) => {
  if (req.method !== 'POST') return send(res, 405, { error: 'Méthode non autorisée' });
  if (!ADMIN_PASSWORD) return send(res, 503, { error: "Le mot de passe élu·e n'est pas encore configuré sur Vercel (variable ADMIN_PASSWORD)." });
  const body = await readBody(req);
  // petite temporisation contre les essais en rafale
  await new Promise(r => setTimeout(r, 400));
  if (!checkPassword(body.password)) return send(res, 401, { error: 'Mot de passe incorrect.' });
  send(res, 200, { token: makeToken() });
};

// Sert un fichier (photo, PDF…) déposé par les élu·e·s : /api/file?id=xxx&name=doc.pdf

const handler_file = async (req, res) => {
  try {
    const id = String(req.query.id || '').replace(/[^a-z0-9]/gi, '');
    if (!id) return send(res, 400, { error: 'id manquant' });
    const data = await redis('GET', `cse:file:${id}`);
    if (!data) return send(res, 404, { error: 'Fichier introuvable' });
    const comma = data.indexOf(',');
    const type = data.slice(5, data.indexOf(';'));
    const buf = Buffer.from(data.slice(comma + 1), 'base64');
    const name = String(req.query.name || 'fichier').replace(/["\r\n]/g, '');
    res.setHeader('Content-Type', type);
    res.setHeader('Content-Length', buf.length);
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    res.setHeader('Content-Disposition', `${req.query.dl ? 'attachment' : 'inline'}; filename*=UTF-8''${encodeURIComponent(name)}`);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.status(200).end(buf);
  } catch (e) {
    send(res, 500, { error: e.message });
  }
};


const handler_health = (req, res) => {
  send(res, 200, { ok: true, storage: storageReady(), auth: Boolean(ADMIN_PASSWORD) });
};

module.exports = async (req, res) => {
  const a = String(req.query.a || '');
  if (a === 'data') return handler_data(req, res);
  if (a === 'login') return handler_login(req, res);
  if (a === 'file') return handler_file(req, res);
  return handler_health(req, res);
};
