// Portail CGT Concentrix Compiègne — fonction serveur unique (Vercel, Node).
// Toutes les routes passent par /api/cse?a=...
const crypto = require('crypto');

const REDIS_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const ADMIN_EMAIL = String(process.env.ADMIN_EMAIL || 'admin').trim().toLowerCase();
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
const SETTINGS = ['email', 'telephone', 'tel_note', 'responsable', 'responsable_tel', 'adresse', 'permanences', 'facebook', 'instagram', 'snapchat', 'tiktok', 'threads', '_v2'];
const LONG = ['contenu', 'description', 'message', 'permanences'];
const MAX_FILE = 3.2 * 1024 * 1024;

/* ---------- stockage : Upstash Redis si configuré, sinon Vercel Blob ---------- */
const BLOB_TOKEN = process.env.BLOB_READ_WRITE_TOKEN;
const VAPID_PUBLIC = process.env.VAPID_PUBLIC_KEY || '', VAPID_PRIVATE = process.env.VAPID_PRIVATE_KEY || '';
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || 'mailto:cgtwebhelpcompiegne@gmail.com';
const storageReady = () => Boolean((REDIS_URL && REDIS_TOKEN) || BLOB_TOKEN);
async function redisHttp(cmd) {
  const r = await fetch(REDIS_URL, { method: 'POST', headers: { Authorization: `Bearer ${REDIS_TOKEN}`, 'Content-Type': 'application/json' }, body: JSON.stringify(cmd) });
  const d = await r.json().catch(() => ({}));
  if (!r.ok || d.error) throw new Error(d.error || `Redis ${r.status}`);
  return d.result;
}
/* Petit magasin clé/valeur au-dessus de Vercel Blob (offre gratuite : opérations comptées).
   - un fichier par enregistrement : db/<clé>/<champ>.txt (écrasé à chaque écriture)
   - lecture d'un enregistrement : head() (opération simple) + lecture CDN versionnée
   - listes (HGETALL) : list() mis en cache 2 min en mémoire, invalidé à chaque écriture
   - compteurs anti-abus : en mémoire uniquement (aucune opération de stockage) */
let blobLib;
const B = () => (blobLib = blobLib || require('@vercel/blob'));
const enc = s => Buffer.from(String(s)).toString('base64url'); // noms de fichiers sûrs
const dec = s => Buffer.from(s, 'base64url').toString();
const pathOf = (key, field) => `db/${enc(key)}/${enc(field)}.txt`;
const memRec = new Map();   // pathname -> { v, at, exp }
const memList = new Map();  // key -> { items:[[field,value]], exp }
const memCount = new Map(); // compteurs anti-abus
const REC_TTL = 20e3, LIST_TTL = 120e3;
function isNotFound(e) {
  const lib = B();
  return (lib.BlobNotFoundError && e instanceof lib.BlobNotFoundError) || /not.?found|does not exist|n'existe pas|404/i.test(`${e && e.name} ${e && e.message}`);
}
async function fetchVersion(url, at) {
  const r = await fetch(`${url}?v=${new Date(at).getTime()}`, { cache: 'no-store' });
  if (!r.ok) throw new Error('Lecture Blob ' + r.status);
  return r.text();
}
async function readField(key, field) {
  const p = pathOf(key, field); const c = memRec.get(p);
  if (c && c.exp > Date.now()) return c.v;
  let h;
  try { h = await B().head(p, { token: BLOB_TOKEN }); }
  catch (e) { if (isNotFound(e)) { memRec.set(p, { v: null, exp: Date.now() + REC_TTL }); return null; } throw e; }
  const v = c && c.at === String(h.uploadedAt) ? c.v : await fetchVersion(h.url, h.uploadedAt);
  memRec.set(p, { v, at: String(h.uploadedAt), exp: Date.now() + REC_TTL });
  return v;
}
async function writeField(key, field, value) {
  const p = pathOf(key, field);
  const r = await B().put(p, String(value), { access: 'public', addRandomSuffix: false, allowOverwrite: true, contentType: 'text/plain; charset=utf-8', cacheControlMaxAge: 60, token: BLOB_TOKEN });
  memRec.set(p, { v: String(value), at: '', exp: Date.now() + REC_TTL }); memList.delete(key);
  return r;
}
async function delField(key, field) {
  const p = pathOf(key, field);
  let h; try { h = await B().head(p, { token: BLOB_TOKEN }); } catch { h = null; }
  if (h) await B().del(h.url, { token: BLOB_TOKEN });
  memRec.set(p, { v: null, exp: Date.now() + REC_TTL }); memList.delete(key);
  return h ? 1 : 0;
}
async function getAll(key) {
  const c = memList.get(key); if (c && c.exp > Date.now()) return c.items;
  const prefix = `db/${enc(key)}/`; const blobs = []; let cursor;
  do { const r = await B().list({ prefix, cursor, limit: 1000, token: BLOB_TOKEN }); blobs.push(...r.blobs); cursor = r.hasMore ? r.cursor : undefined; } while (cursor);
  const items = await Promise.all(blobs.map(async b => {
    const field = dec(b.pathname.slice(prefix.length).replace(/\.txt$/, ''));
    const m = memRec.get(b.pathname);
    const v = m && m.at === String(b.uploadedAt) ? m.v : await fetchVersion(b.url, b.uploadedAt);
    memRec.set(b.pathname, { v, at: String(b.uploadedAt), exp: Date.now() + REC_TTL });
    return [field, v];
  }));
  memList.set(key, { items, exp: Date.now() + LIST_TTL });
  return items;
}
async function blobCmd(c, a) {
  switch (c) {
    case 'HGET': return readField(a[0], a[1]);
    case 'HSET': await writeField(a[0], a[1], a[2]); return 1;
    case 'HDEL': return delField(a[0], a[1]);
    case 'HGETALL': return (await getAll(a[0])).flat();
    case 'GET': return readField(a[0], '_');
    case 'SET': await writeField(a[0], '_', a[1]); return 'OK';
    case 'DEL': return delField(a[0], '_');
    case 'INCR': { const o = memCount.get(a[0]); const n = o && o.exp > Date.now() ? o.n + 1 : 1; memCount.set(a[0], { n, exp: o && o.exp > Date.now() ? o.exp : Date.now() + 3600e3 }); return n; }
    case 'EXPIRE': return 1;
  }
  throw new Error('Commande inconnue ' + c);
}
/* Transfert automatique Blob → Redis (une seule fois, dès que Redis est branché) */
let migration = null;
function migrateIfNeeded() {
  if (!(REDIS_URL && REDIS_TOKEN && BLOB_TOKEN)) return Promise.resolve();
  if (!migration) migration = (async () => {
    if (await redisHttp(['GET', 'cse:migrated'])) return;
    const lock = await redisHttp(['SET', 'cse:migrating', '1', 'NX', 'EX', '600']);
    if (lock !== 'OK') { await new Promise(r => setTimeout(r, 4000)); return; }
    const blobs = []; let cursor;
    do { const r = await B().list({ prefix: 'db/', cursor, limit: 1000, token: BLOB_TOKEN }); blobs.push(...r.blobs); cursor = r.hasMore ? r.cursor : undefined; } while (cursor);
    let n = 0;
    for (let i = 0; i < blobs.length; i += 8) {
      await Promise.all(blobs.slice(i, i + 8).map(async b => {
        const m = b.pathname.match(/^db\/([^/]+)\/([^/]+)\.txt$/); if (!m) return;
        const key = dec(m[1]), field = dec(m[2]);
        const value = await fetchVersion(b.url, b.uploadedAt);
        if (field === '_') await redisHttp(['SET', key, value]); else await redisHttp(['HSET', key, field, value]);
        n++;
      }));
    }
    await redisHttp(['SET', 'cse:migrated', JSON.stringify({ at: new Date().toISOString(), count: n })]);
    await redisHttp(['DEL', 'cse:migrating']);
  })().catch(e => { migration = null; console.error('Migration Blob → Redis', e); });
  return migration;
}
async function redis(...cmd) {
  if (!storageReady()) throw Object.assign(new Error('Stockage non configuré'), { status: 503 });
  if (REDIS_URL && REDIS_TOKEN) return redisHttp(cmd);
  return blobCmd(String(cmd[0]).toUpperCase(), cmd.slice(1));
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
const publicUser = u => u && ({ id: u.id, email: u.email, prenom: u.prenom, nom: u.nom, service: u.service, role: u.role, status: u.status, created: u.created, owner: !!u.owner, type: u.type === 'elu' ? 'elu' : 'salarie' });
async function rateLimit(req, key, max) {
  const ip = String(req.headers['x-forwarded-for'] || 'x').split(',')[0].trim();
  const k = `cse:rl:${key}:${ip}`;
  const n = await redis('INCR', k); if (n === 1) await redis('EXPIRE', k, 3600);
  if (n > max) throw fail(429, 'Trop de tentatives. Réessayez dans une heure.');
}
async function getUser(id) { const v = await redis('HGET', 'cse:users', id); return v ? JSON.parse(v) : null; }
async function allUsers() { const f = (await redis('HGETALL', 'cse:users')) || []; const o = []; for (let i = 1; i < f.length; i += 2) o.push(JSON.parse(f[i])); return o; }
async function saveUser(u) { await redis('HSET', 'cse:users', u.id, JSON.stringify(u)); }
const ADMIN_USER = { id: 'admin', email: ADMIN_EMAIL, prenom: 'Administrateur', nom: 'CGT', role: 'elu', status: 'active', created: '2026-01-01T00:00:00.000Z', owner: true, principal: true, type: 'elu' };

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

/* ---------- Messagerie instantanée ---------- */
const CHAT_MAX = 500, CHAT_KEEP = 400;
const chatKey = uid => `cse:chat:${uid}`;
async function chatMeta(uid) { const v = await redis('HGET', 'cse:chats', uid); return v ? JSON.parse(v) : null; }
async function chatRead(meta, since) {
  // messages d'index absolu >= since (les plus anciens peuvent avoir été archivés)
  const base = meta.base || 0, from = Math.max(0, Number(since || 0) - base);
  if (Number(since || 0) >= meta.n) return [];
  const raw = (await redis('LRANGE', chatKey(meta.uid), from, -1)) || [];
  return raw.map(x => { try { return JSON.parse(x); } catch { return null; } }).filter(Boolean);
}
async function chatPush(uid, msg, metaInit) {
  let meta = (await chatMeta(uid)) || { uid, base: 0, n: 0, unreadCgt: 0, unreadUser: 0, ...metaInit };
  msg.i = meta.n; msg.at = new Date().toISOString();
  const len = await redis('RPUSH', chatKey(uid), JSON.stringify(msg));
  meta.n = (meta.base || 0) + Number(len);
  if (len > CHAT_MAX) { await redis('LTRIM', chatKey(uid), len - CHAT_KEEP, -1); meta.base = meta.n - CHAT_KEEP; }
  Object.assign(meta, { lastText: msg.text.slice(0, 120), lastAt: msg.at, lastFrom: msg.from });
  if (msg.from === 'user') meta.unreadCgt = (meta.unreadCgt || 0) + 1; else meta.unreadUser = (meta.unreadUser || 0) + 1;
  await redis('HSET', 'cse:chats', uid, JSON.stringify(meta));
  if (msg.from === 'user') await notify({ to: 'admins', except: uid, pref: 'chat', title: `💬 ${msg.by}`, body: msg.text, url: '/?open=chat', tag: 'chat-' + uid });
  else await notify({ to: uid, pref: 'chat', title: `💬 ${msg.by || 'Section CGT'}`, body: msg.text, url: '/?open=chat', tag: 'chat' });
  return { msg, meta };
}


/* ---------- Communauté (flux) + réactions et commentaires ---------- */
const REACTIONS = ['👍', '❤️', '👏', '✊', '😢'];
const TARGET_RE = /^(actus|events|galerie|feed):[A-Za-z0-9_-]{1,48}$/;
const FEED_MAX = 300;
const who = u => u.id === 'admin' ? 'Section CGT' : `${u.prenom} ${u.nom}`.trim();
async function bumpFeed() { try { await redis('INCR', 'cse:fver'); } catch {} }
async function socSummary(t) {
  const f = (await redis('HGETALL', `cse:soc:${t}`)) || []; const r = {}; let c = 0; const last = [];
  for (let i = 0; i < f.length; i += 2) {
    if (f[i].startsWith('r:')) r[f[i + 1]] = (r[f[i + 1]] || 0) + 1;
    else if (f[i].startsWith('c:')) { c++; try { last.push(JSON.parse(f[i + 1])); } catch {} }
  }
  const sum = { r, c };
  if (c || Object.keys(r).length) await redis('HSET', 'cse:socsum', t, JSON.stringify(sum)); else await redis('HDEL', 'cse:socsum', t);
  return sum;
}
async function saveDataFile(f) {
  const data = String(f && f.data || '');
  if (!/^data:image\/(jpeg|png|webp);base64,/.test(data)) throw fail(400, 'Photo invalide.');
  if (data.length > MAX_FILE) throw fail(413, 'Photo trop lourde.');
  const id = newId(); await redis('SET', `cse:file:${id}`, data);
  return { fileId: id, fileName: clip(f.name || 'photo.jpg'), fileType: data.slice(5, data.indexOf(';')) };
}
async function dropTarget(t) {
  const f = (await redis('HGETALL', `cse:soc:${t}`)) || [];
  for (let i = 0; i < f.length; i += 2) if (f[i].startsWith('r:')) await redis('HDEL', `cse:myr:${f[i].slice(2)}`, t);
  await redis('DEL', `cse:soc:${t}`); await redis('HDEL', 'cse:socsum', t);
}


/* ---------- Discussion de groupe (salon commun à tous les membres) ---------- */
const GROUP_MAX = 500, GROUP_KEEP = 400;
async function groupMeta(room = '') { const v = await redis('GET', 'cse:gmeta' + room); return v ? JSON.parse(v) : { n: 0, base: 0, v: 0 }; }
const isEluCse = u => !!u && (u.type === 'elu' || u.role === 'elu');
async function saveMedia(f) {
  const data = String(f && f.data || '');
  const m = data.match(/^data:((image\/(jpeg|png|webp|gif))|(video\/(mp4|webm|quicktime)));base64,/);
  if (!m) throw fail(400, 'Fichier non pris en charge (photo ou vidéo uniquement).');
  if (data.length > MAX_FILE) throw fail(413, 'Fichier trop lourd (2,4 Mo maximum). Pour une vidéo plus longue, partagez plutôt un lien.');
  const id = newId(); await redis('SET', `cse:file:${id}`, data);
  return { fileId: id, fileName: clip(f.name || 'fichier'), fileType: data.slice(5, data.indexOf(';')) };
}

/* ---------- Adhésions : IBAN chiffré (AES-256-GCM) ---------- */
const ENC_KEY = crypto.createHash('sha256').update('cse-iban:' + SECRET).digest();
function encrypt(txt) {
  if (!txt) return '';
  const iv = crypto.randomBytes(12); const c = crypto.createCipheriv('aes-256-gcm', ENC_KEY, iv);
  const enc = Buffer.concat([c.update(String(txt), 'utf8'), c.final()]);
  return [iv, c.getAuthTag(), enc].map(b => b.toString('base64url')).join('.');
}
function decrypt(v) {
  try { const [iv, tag, enc] = String(v).split('.').map(x => Buffer.from(x, 'base64url'));
    const d = crypto.createDecipheriv('aes-256-gcm', ENC_KEY, iv); d.setAuthTag(tag);
    return Buffer.concat([d.update(enc), d.final()]).toString('utf8'); } catch { return ''; }
}
function ibanOk(iban) {
  const s = String(iban || '').replace(/\s+/g, '').toUpperCase();
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(s)) return false;
  const r = (s.slice(4) + s.slice(0, 4)).replace(/[A-Z]/g, ch => String(ch.charCodeAt(0) - 55));
  let m = 0; for (const d of r) m = (m * 10 + Number(d)) % 97; return m === 1;
}
const ADH_FIELDS = ['civilite', 'nom', 'prenom', 'adresse', 'cp', 'ville', 'email', 'telephone', 'naissance', 'entreprise', 'site',
  'classification', 'grade', 'fonction', 'coefficient', 'salaire', 'entree', 'temps', 'prelevement', 'stage', 'fait_a',
  'sepa_nom', 'sepa_adresse', 'sepa_cp', 'sepa_ville', 'tiers_nom', 'message'];
const SIG_RE = /^data:image\/png;base64,[A-Za-z0-9+/=]+$/;

/* ---------- actions ---------- */

/* ---------- Billetterie du CSE (catalogue de l'affiche « Offres du CSE ») ----------
   Prix en centimes. « from » = prix « à partir de » (variable selon les dates). */
const BILLETS = [
  { id: 'majestic', cat: 'cinema', emoji: '🎬', nom: 'Cinéma Majestic', lieu: 'Compiègne', public: 12.00, variants: [
    { id: 'priv', label: 'Place tarif privilégié*', sub: '5 premières places du semestre', prix: 500 }, { id: 'sup', label: 'Place suivante', prix: 730 }] },
  { id: 'paradisio', cat: 'cinema', emoji: '🍿', nom: 'Cinéma Paradisio', lieu: 'Noyon', public: 9.90, variants: [
    { id: 'priv', label: 'Place tarif privilégié*', sub: '5 premières places du semestre', prix: 500 }, { id: 'sup', label: 'Place suivante', prix: 660 }] },
  { id: 'speedpark', cat: 'sorties', emoji: '🎳', nom: 'Speed Park', lieu: 'Bowling, laser, billard, karaoké, karting', variants: [
    { id: 'ticket', label: 'Ticket 1 activité', prix: 500 }],
    note: 'Bowling hors location de chaussures. Du lundi au vendredi : 1 ticket par personne. Samedi, dimanche, jours fériés et vacances scolaires : 2 tickets par personne.' },
  { id: 'ibidem', cat: 'sorties', emoji: '🧖', nom: 'Ibidem', lieu: 'Spa privatisé 2 h', public: 65.00, variants: [
    { id: 'pers', label: 'Par personne', prix: 4500 }] },
  { id: 'experimental', cat: 'sorties', emoji: '🎮', nom: 'Experimental Park', lieu: '1 h de jeu, 7j/7', variants: [
    { id: 'ticket', label: 'Ticket 1 h de jeu', prix: 500 }], note: 'Le samedi, valable uniquement à partir de 17h30.' },
  { id: 'beauval', cat: 'parcs', emoji: '🦁', nom: 'ZooParc de Beauval', lieu: 'Billet 1 journée', variants: [
    { id: 'adulte', label: 'Adulte', prix: 3400, public: 40.00 }, { id: 'enfant', label: 'Enfant', prix: 2600, public: 28.00 }] },
  { id: 'asterix', cat: 'parcs', emoji: '⚔️', nom: 'Parc Astérix', lieu: 'Billet non daté', public: 62.00, from: true, variants: [
    { id: 'billet', label: 'Billet', prix: 5200 }] },
  { id: 'futuroscope', cat: 'parcs', emoji: '🚀', nom: 'Futuroscope', lieu: 'Billet', public: 60.00, from: true, variants: [
    { id: 'billet', label: 'Billet', prix: 5000 }] },
  { id: 'mersable', cat: 'parcs', emoji: '🏜️', nom: 'La Mer de Sable', lieu: 'Billet', public: 28.00, from: true, variants: [
    { id: 'billet', label: 'Billet', prix: 2700 }] },
  { id: 'franceminiature', cat: 'parcs', emoji: '🗼', nom: 'France Miniature', lieu: 'Billet non daté', from: true, variants: [
    { id: 'billet', label: 'Billet', prix: 2000 }] },
  { id: 'grevin', cat: 'parcs', emoji: '🗿', nom: 'Musée Grévin', lieu: 'Billet non daté', from: true, variants: [
    { id: 'billet', label: 'Billet', prix: 1800 }] },
];
const BILLET_ST = ['nouvelle', 'prete', 'retiree', 'annulee'];


/* ---------- Notifications push (Web Push, RFC 8291 + VAPID RFC 8292), sans module externe ---------- */
const ub64 = s => Buffer.from(String(s || ''), 'base64url');
const hkdf = (salt, ikm, info, len) => Buffer.from(crypto.hkdfSync('sha256', ikm, salt, info, len));
function wpEncrypt(payload, p256dh, auth, opts = {}) { // opts : clé éphémère / sel imposés (tests)
  const ua = ub64(p256dh), authSecret = ub64(auth);
  const ecdh = crypto.createECDH('prime256v1');
  if (opts.asPrivate) ecdh.setPrivateKey(ub64(opts.asPrivate)); else ecdh.generateKeys();
  const asPub = ecdh.getPublicKey(); const secret = ecdh.computeSecret(ua);
  const ikm = hkdf(authSecret, secret, Buffer.concat([Buffer.from('WebPush: info\0'), ua, asPub]), 32);
  const salt = opts.salt ? ub64(opts.salt) : crypto.randomBytes(16);
  const cek = hkdf(salt, ikm, Buffer.from('Content-Encoding: aes128gcm\0'), 16);
  const nonce = hkdf(salt, ikm, Buffer.from('Content-Encoding: nonce\0'), 12);
  const c = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  const ct = Buffer.concat([c.update(Buffer.concat([Buffer.from(payload), Buffer.from([2])])), c.final(), c.getAuthTag()]);
  const rs = Buffer.alloc(4); rs.writeUInt32BE(4096);
  return Buffer.concat([salt, rs, Buffer.from([asPub.length]), asPub, ct]);
}
function vapidAuth(endpoint) {
  const pub = ub64(VAPID_PUBLIC);
  const key = crypto.createPrivateKey({ key: { kty: 'EC', crv: 'P-256', d: VAPID_PRIVATE, x: pub.subarray(1, 33).toString('base64url'), y: pub.subarray(33, 65).toString('base64url') }, format: 'jwk' });
  const enc = o => Buffer.from(JSON.stringify(o)).toString('base64url');
  const data = enc({ typ: 'JWT', alg: 'ES256' }) + '.' + enc({ aud: new URL(endpoint).origin, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: VAPID_SUBJECT });
  const sig = crypto.sign('sha256', Buffer.from(data), { key, dsaEncoding: 'ieee-p1363' }).toString('base64url');
  return `vapid t=${data}.${sig}, k=${VAPID_PUBLIC}`;
}
async function wpSend(sub, payload) {
  const body = wpEncrypt(JSON.stringify(payload), sub.keys.p256dh, sub.keys.auth);
  const r = await fetch(sub.endpoint, { method: 'POST', body, signal: AbortSignal.timeout(6000),
    headers: { TTL: '86400', Urgency: 'high', 'Content-Encoding': 'aes128gcm', 'Content-Type': 'application/octet-stream', Authorization: vapidAuth(sub.endpoint) } });
  return r.status;
}
const PUSH_PREFS = ['chat', 'global', 'elus', 'contact', 'gestion', 'mention'];
const pushId = ep => crypto.createHash('sha256').update(String(ep)).digest('base64url').slice(0, 24);
/* to : 'all' | 'admins' | 'elus' | uid ; except : uid de l'auteur ; pref : type de notification */
async function notify({ to, except, exceptList = [], pref, title, body, url = '/', tag }) {
  if (!(VAPID_PUBLIC && VAPID_PRIVATE && REDIS_URL)) return;
  try {
    const f = (await redis('HGETALL', 'cse:push')) || []; let subs = [];
    for (let i = 0; i < f.length; i += 2) { try { const o = JSON.parse(f[i + 1]); o.k = f[i]; subs.push(o); } catch {} }
    subs = subs.filter(o => o.uid !== except && !exceptList.includes(o.uid) && (!pref || !o.prefs || o.prefs[pref] !== false));
    if (to !== 'all') {
      if (to === 'admins' || to === 'elus') {
        const users = Object.fromEntries((await allUsers()).map(u => [u.id, u])); users.admin = ADMIN_USER;
        subs = subs.filter(o => { const u = users[o.uid]; return u && u.status === 'active' && (to === 'admins' ? u.role === 'elu' : isEluCse(u)); });
      } else { const set = new Set([].concat(to)); subs = subs.filter(o => set.has(o.uid)); }
    }
    const payload = { title: String(title).slice(0, 80), body: String(body || '').slice(0, 180), url, tag: tag || pref || 'cgt' };
    for (let i = 0; i < subs.length; i += 40) {
      const res = await Promise.allSettled(subs.slice(i, i + 40).map(o => wpSend(o.sub, payload)));
      for (const [j, r] of res.entries()) if (r.status === 'fulfilled' && (r.value === 404 || r.value === 410)) await redis('HDEL', 'cse:push', subs[i + j].k);
    }
  } catch (e) { console.warn('notify', e.message); }
}


/* Mentions « @Prénom Nom » : seules les personnes réellement citées dans le texte sont retenues */
async function resolveMentions(ids, text, onlyElus) {
  ids = [...new Set((Array.isArray(ids) ? ids : []).map(String))].slice(0, 15); if (!ids.length || !text) return [];
  const users = Object.fromEntries((await allUsers()).map(u => [u.id, u])); users.admin = ADMIN_USER;
  return ids.map(id => users[id]).filter(u => u && u.status === 'active' && (!onlyElus || isEluCse(u)))
    .map(u => ({ id: u.id, name: u.id === 'admin' ? 'Section CGT' : `${u.prenom} ${u.nom}`.trim() })).filter(m => text.includes('@' + m.name));
}

const A = {
  async health() { let migrated = null; if (REDIS_URL && REDIS_TOKEN) { try { migrated = JSON.parse(await redisHttp(['GET', 'cse:migrated']) || 'null'); } catch {} } return { ok: true, storage: storageReady(), backend: REDIS_URL && REDIS_TOKEN ? 'redis' : BLOB_TOKEN ? 'blob' : 'none', migrated, auth: Boolean(ADMIN_PASSWORD) }; },

  async register(req) {
    const b = body(req);
    const email = String(b.email || '').trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw fail(400, 'Adresse email invalide.');
    if (String(b.password || '').length < 8) throw fail(400, 'Le mot de passe doit faire au moins 8 caractères.');
    if (!String(b.prenom || '').trim() || !String(b.nom || '').trim()) throw fail(400, 'Indiquez votre prénom et votre nom.');
    if (email === ADMIN_EMAIL) throw fail(409, 'Cette adresse est réservée au compte administrateur.');
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
    if (email === 'admin' || email === ADMIN_EMAIL) {
      if (!ADMIN_PASSWORD) throw fail(503, "Le mot de passe administrateur n'est pas configuré.");
      await rateLimit(req, 'adm', 15);
      if (!sameSecret(b.password || '', ADMIN_PASSWORD)) throw fail(401, 'Identifiant ou mot de passe incorrect.');
      return { token: makeToken(ADMIN_USER), user: publicUser(ADMIN_USER) };
    }
    await rateLimit(req, 'log', 30);
    const id = await redis('HGET', 'cse:emails', email);
    const u = id && await getUser(id);
    if (!u || !checkPw(b.password || '', u)) throw fail(401, 'Identifiant ou mot de passe incorrect.');
    if (u.status === 'pending') throw fail(403, 'Votre compte est en attente de validation par un·e responsable de la section CGT.');
    if (u.status !== 'active') throw fail(403, "Votre compte n'est pas actif. Contactez la section CGT.");
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
    const me = await need(req, 'elu');
    if (req.method === 'GET') return { items: (await allUsers()).map(publicUser).sort((a, b) => b.created.localeCompare(a.created)) };
    const b = body(req); const u = await getUser(String(b.id || ''));
    if (!u) throw fail(404, 'Compte introuvable.');
    // Gestion des administrateurs : réservée au compte principal et aux comptes qui ont « la main »
    const roleOps = ['elu', 'salarie', 'owner', 'unowner'];
    if ((roleOps.includes(b.op) || (u.role === 'elu' && ['suspend', 'delete', 'reset'].includes(b.op))) && !me.owner)
      throw fail(403, 'Seul le compte principal (ou une personne qui a la main) peut gérer les administrateurs.');
    if (u.id === me.id && ['salarie', 'unowner', 'suspend', 'delete'].includes(b.op)) throw fail(400, 'Vous ne pouvez pas retirer vos propres droits.');
    if (b.op === 'approve') u.status = 'active';
    else if (b.op === 'type_elu') u.type = 'elu';
    else if (b.op === 'type_salarie') u.type = 'salarie';
    else if (b.op === 'owner') { if (u.status !== 'active') throw fail(400, "Validez d'abord ce compte."); u.role = 'elu'; u.owner = true; }
    else if (b.op === 'unowner') u.owner = false;
    else if (b.op === 'suspend') u.status = 'suspended';
    else if (b.op === 'elu') { if (u.status !== 'active') throw fail(400, "Validez d'abord ce compte."); u.role = 'elu'; }
    else if (b.op === 'salarie') { u.role = 'salarie'; u.owner = false; }
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
      if (prev) { try { const it = JSON.parse(prev); if (it.fileId) await redis('DEL', `cse:file:${it.fileId}`); if (it.docId) await redis('DEL', `cse:file:${it.docId}`); } catch {} }
      await redis('HDEL', key, id);
      if (['actus', 'events', 'galerie'].includes(col)) { try { await dropTarget(`${col}:${id}`); } catch {} }
      return { ok: true };
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
      await redis('HSET', key, item.id, JSON.stringify(item));
      await notify({ to: 'admins', except: u.id, pref: 'contact', title: '✉️ Nouveau message « Nous contacter »', body: `${anon ? 'Anonyme' : item.nom} · ${item.sujet || ''} : ${item.message}`, url: '/#/messages', tag: 'contact' });
      return { item };
    }
    await need(req, 'elu');
    let item = {};
    if (b.id) { const prev = await redis('HGET', key, String(b.id)); if (prev) item = JSON.parse(prev); }
    for (const f of FIELDS[col]) if (b[f] !== undefined) item[f] = clip(b[f], f);
    item.id = item.id || newId(); item.created = item.created || new Date().toISOString();
    async function storeFile(f, prefix) {
      const data = String(f.data);
      if (!/^data:[\w.+-]+\/[\w.+-]+;base64,/.test(data)) throw fail(400, 'Fichier invalide');
      if (data.length > MAX_FILE) throw fail(413, 'Fichier trop lourd (2,4 Mo maximum).');
      if (item[prefix + 'Id']) await redis('DEL', `cse:file:${item[prefix + 'Id']}`);
      item[prefix + 'Id'] = newId(); await redis('SET', `cse:file:${item[prefix + 'Id']}`, data);
      item[prefix + 'Name'] = clip(f.name || 'fichier'); item[prefix + 'Type'] = data.slice(5, data.indexOf(';'));
      item[prefix + 'Size'] = Math.round((data.length - data.indexOf(',') - 1) * 0.75);
    }
    // ancienne actualité : le PDF était rangé comme fichier principal → on le déplace en document joint
    if (b.file && b.file.data && item.fileId && !/^image\//.test(item.fileType || '') && !item.docId) {
      item.docId = item.fileId; item.docName = item.fileName; item.docType = item.fileType; item.docSize = item.fileSize;
      delete item.fileId;
    }
    if (b.file && b.file.data) await storeFile(b.file, 'file');   // photo / image principale
    if (b.doc && b.doc.data) await storeFile(b.doc, 'doc');       // document joint (PDF, Word…)
    if (b.removeDoc && item.docId) { await redis('DEL', `cse:file:${item.docId}`); for (const k of ['docId', 'docName', 'docType', 'docSize']) delete item[k]; }
    if (col === 'galerie' && !item.fileId && !item.video) throw fail(400, 'Ajoutez une photo, une vidéo ou un lien vidéo.');
    await redis('HSET', key, item.id, JSON.stringify(item)); return { item };
  },

  async chat(req) {
    if (!(REDIS_URL && REDIS_TOKEN)) throw fail(503, 'La messagerie nécessite le stockage Upstash.');
    const u = await need(req); const op = String(req.query.op || 'me'); const elu = u.role === 'elu';
    const read = req.query.read === '1';
    if (op === 'me') { // conversation de la personne connectée avec la section
      const meta = await chatMeta(u.id);
      if (!meta) return { n: 0, unread: 0, messages: [] };
      const messages = await chatRead(meta, req.query.since);
      const unread = meta.unreadUser || 0;
      if (read && unread) { meta.unreadUser = 0; await redis('HSET', 'cse:chats', u.id, JSON.stringify(meta)); }
      return { n: meta.n, unread: read ? 0 : unread, messages };
    }
    if (op === 'send') {
      const b = body(req); const text = String(b.text || '').replace(/\r\n?/g, '\n').trim().slice(0, 2000);
      if (!text) throw fail(400, 'Message vide.');
      await rateLimit(req, 'chat', 120);
      if (b.to) { // réponse de la section
        if (!elu) throw fail(403, 'Réservé aux responsables.');
        const meta = await chatMeta(String(b.to)); if (!meta) throw fail(404, 'Conversation introuvable.');
        const by = u.id === 'admin' ? 'Section CGT' : `${u.prenom} · CGT`;
        const r = await chatPush(meta.uid, { from: 'cgt', by, text });
        return { n: r.meta.n, msg: r.msg };
      }
      const r = await chatPush(u.id, { from: 'user', by: `${u.prenom} ${u.nom}`, text },
        { name: `${u.prenom} ${u.nom}`, email: u.email, service: u.service || '' });
      return { n: r.meta.n, msg: r.msg };
    }
    if (!elu) throw fail(403, 'Réservé aux responsables.');
    if (op === 'inbox') {
      const f = (await redis('HGETALL', 'cse:chats')) || []; const items = [];
      for (let i = 1; i < f.length; i += 2) { try { items.push(JSON.parse(f[i])); } catch {} }
      items.sort((a, b) => String(b.lastAt).localeCompare(String(a.lastAt)));
      return { items, unread: items.reduce((t, c) => t + (c.unreadCgt ? 1 : 0), 0) };
    }
    const uid = String(req.query.uid || ''); const meta = await chatMeta(uid);
    if (!meta) throw fail(404, 'Conversation introuvable.');
    if (op === 'thread') {
      const messages = await chatRead(meta, req.query.since);
      if (read && meta.unreadCgt) { meta.unreadCgt = 0; await redis('HSET', 'cse:chats', uid, JSON.stringify(meta)); }
      return { n: meta.n, meta, messages };
    }
    if (op === 'delete') { await redis('DEL', chatKey(uid)); await redis('HDEL', 'cse:chats', uid); return { ok: true }; }
    throw fail(400, 'Action inconnue');
  },


  /* Réactions + commentaires : résumé global, ou commentaires d'un élément */
  async social(req) {
    const u = await need(req);
    if (req.method === 'GET') {
      const t = String(req.query.t || '');
      if (t) {
        if (!TARGET_RE.test(t)) throw fail(400, 'Élément inconnu');
        const f = (await redis('HGETALL', `cse:soc:${t}`)) || []; const items = [];
        for (let i = 0; i < f.length; i += 2) if (f[i].startsWith('c:')) { try { items.push(JSON.parse(f[i + 1])); } catch {} }
        items.sort((a, b) => String(a.at).localeCompare(String(b.at)));
        return { comments: items };
      }
      const [sumF, mineF] = await Promise.all([redis('HGETALL', 'cse:socsum'), redis('HGETALL', `cse:myr:${u.id}`)]);
      const sum = {}, mine = {};
      for (let i = 0; i < (sumF || []).length; i += 2) { try { sum[sumF[i]] = JSON.parse(sumF[i + 1]); } catch {} }
      for (let i = 0; i < (mineF || []).length; i += 2) mine[mineF[i]] = mineF[i + 1];
      return { sum, mine };
    }
    const b = body(req); const t = String(b.t || req.query.t || '');
    if (!TARGET_RE.test(t)) throw fail(400, 'Élément inconnu');
    const op = String(req.query.op || '');
    if (op === 'react') {
      const e = String(b.e || '');
      const prev = await redis('HGET', `cse:soc:${t}`, `r:${u.id}`);
      if (!e || e === prev) { await redis('HDEL', `cse:soc:${t}`, `r:${u.id}`); await redis('HDEL', `cse:myr:${u.id}`, t); }
      else { if (!REACTIONS.includes(e)) throw fail(400, 'Réaction inconnue'); await redis('HSET', `cse:soc:${t}`, `r:${u.id}`, e); await redis('HSET', `cse:myr:${u.id}`, t, e); }
      const sum = await socSummary(t); if (t.startsWith('feed:')) await bumpFeed();
      return { sum, mine: !e || e === prev ? '' : e };
    }
    if (op === 'comment') {
      const text = String(b.text || '').replace(/\r\n?/g, '\n').trim().slice(0, 1000);
      if (!text) throw fail(400, 'Commentaire vide.');
      await rateLimit(req, 'cmt', 40);
      const c = { id: newId(), uid: u.id, by: who(u), elu: u.role === 'elu', text, at: new Date().toISOString() };
      await redis('HSET', `cse:soc:${t}`, `c:${c.id}`, JSON.stringify(c));
      const sum = await socSummary(t); if (t.startsWith('feed:')) await bumpFeed();
      return { comment: c, sum };
    }
    if (op === 'uncomment') {
      const id = String(b.id || ''); const v = await redis('HGET', `cse:soc:${t}`, `c:${id}`);
      if (!v) throw fail(404, 'Commentaire introuvable.');
      const c = JSON.parse(v); if (c.uid !== u.id && u.role !== 'elu') throw fail(403, 'Vous ne pouvez supprimer que vos propres commentaires.');
      await redis('HDEL', `cse:soc:${t}`, `c:${id}`);
      const sum = await socSummary(t); if (t.startsWith('feed:')) await bumpFeed();
      return { sum };
    }
    throw fail(400, 'Action inconnue');
  },

  /* Communauté : flux de publications entre membres */
  async feed(req) {
    const u = await need(req);
    if (req.method === 'GET') {
      if (req.query.v) return { v: Number(await redis('GET', 'cse:fver') || 0) };
      const [f, v] = await Promise.all([redis('HGETALL', 'cse:feed'), redis('GET', 'cse:fver')]); const items = [];
      for (let i = 1; i < (f || []).length; i += 2) { try { items.push(JSON.parse(f[i])); } catch {} }
      items.sort((a, b) => String(b.at).localeCompare(String(a.at)));
      return { items: items.slice(0, 80), v: Number(v || 0) };
    }
    if (req.method === 'DELETE') {
      const id = String(req.query.id || ''); const prev = await redis('HGET', 'cse:feed', id);
      if (!prev) return { ok: true };
      const p = JSON.parse(prev); if (p.uid !== u.id && u.role !== 'elu') throw fail(403, 'Vous ne pouvez supprimer que vos propres publications.');
      if (p.fileId) await redis('DEL', `cse:file:${p.fileId}`);
      await redis('HDEL', 'cse:feed', id); await dropTarget(`feed:${id}`); await bumpFeed();
      return { ok: true };
    }
    const b = body(req); const text = String(b.text || '').replace(/\r\n?/g, '\n').trim().slice(0, 3000);
    if (!text && !(b.file && b.file.data)) throw fail(400, 'Publication vide.');
    await rateLimit(req, 'post', 15);
    const p = { id: newId(), uid: u.id, by: who(u), elu: u.role === 'elu', service: u.id === 'admin' ? '' : (u.service || ''), text, at: new Date().toISOString() };
    const mentions = (await resolveMentions(b.mentions, text, false)).filter(m => m.id !== u.id); if (mentions.length) p.mentions = mentions;
    if (b.file && b.file.data) Object.assign(p, await saveDataFile(b.file));
    await redis('HSET', 'cse:feed', p.id, JSON.stringify(p));
    if (mentions.length) await notify({ to: mentions.map(m => m.id), pref: 'mention', title: `📣 ${p.by} vous a mentionné·e`, body: `Messagerie : ${text}`, url: '/#/communaute', tag: 'mention' });
    // on garde les FEED_MAX publications les plus récentes
    const n = Number(await redis('HLEN', 'cse:feed'));
    if (n > FEED_MAX) {
      const f = (await redis('HGETALL', 'cse:feed')) || []; const all = [];
      for (let i = 1; i < f.length; i += 2) { try { all.push(JSON.parse(f[i])); } catch {} }
      all.sort((a, b2) => String(a.at).localeCompare(String(b2.at)));
      for (const old of all.slice(0, n - FEED_MAX)) { if (old.fileId) await redis('DEL', `cse:file:${old.fileId}`); await redis('HDEL', 'cse:feed', old.id); await dropTarget(`feed:${old.id}`); }
    }
    await bumpFeed();
    return { item: p };
  },


  /* Discussion de groupe : tous les membres connectés */
  async group(req) {
    // deux salons : '' = discussion globale (tout le monde), ':elus' = discussion réservée aux élu·e·s
    const room = req.query.room === 'elus' ? ':elus' : ''; const LK = 'cse:group' + room, MK = 'cse:gmeta' + room;
    if (req.method === 'GET' && req.query.ping) { // vérification légère : jeton signé seulement, 1 seule lecture
      if (!readToken(req)) throw fail(401, 'Veuillez vous connecter.');
      if (room && !isEluCse(await session(req))) throw fail(403, 'Réservé aux élu·e·s.');
      const m = await groupMeta(room); return { n: m.n, v: m.v || 0 };
    }
    const u = await need(req);
    if (room && !isEluCse(u)) throw fail(403, 'Réservé aux élu·e·s.');
    if (req.method === 'GET') {
      const m = await groupMeta(room); const since = req.query.since !== undefined ? Number(req.query.since) : Math.max(m.base, m.n - 60);
      if (since >= m.n) return { n: m.n, v: m.v || 0, base: m.base, messages: [] };
      const from = Math.max(0, since - m.base);
      const raw = (await redis('LRANGE', LK, from, -1)) || [];
      return { n: m.n, v: m.v || 0, base: m.base, messages: raw.map(x => { try { return JSON.parse(x); } catch { return null; } }).filter(Boolean) };
    }
    if (req.method === 'DELETE') {
      const i = Number(req.query.i); const m = await groupMeta(room);
      if (!(i >= m.base && i < m.n)) throw fail(404, 'Message introuvable.');
      const raw = await redis('LINDEX', LK, i - m.base); const msg = raw && JSON.parse(raw);
      if (!msg) throw fail(404, 'Message introuvable.');
      if (msg.uid !== u.id && u.role !== 'elu') throw fail(403, 'Vous ne pouvez supprimer que vos propres messages.');
      if (msg.fileId) await redis('DEL', `cse:file:${msg.fileId}`);
      await redis('LSET', LK, i - m.base, JSON.stringify({ i, uid: msg.uid, by: msg.by, at: msg.at, deleted: true }));
      m.v = (m.v || 0) + 1; await redis('SET', MK, JSON.stringify(m));
      return { ok: true };
    }
    const b = body(req); const text = String(b.text || '').replace(/\r\n?/g, '\n').trim().slice(0, 2000);
    if (!text && !(b.file && b.file.data)) throw fail(400, 'Message vide.');
    await rateLimit(req, 'grp', 120);
    const msg = { uid: u.id, by: who(u), elu: u.role === 'elu', typ: u.type === 'elu' ? 'elu' : '', text, at: new Date().toISOString() };
    const mentions = (await resolveMentions(b.mentions, text, !!room)).filter(m => m.id !== u.id); if (mentions.length) msg.mentions = mentions;
    if (b.file && b.file.data) Object.assign(msg, await saveMedia(b.file));
    const m = await groupMeta(room); msg.i = m.n;
    const len = Number(await redis('RPUSH', LK, JSON.stringify(msg)));
    m.n = m.base + len;
    if (len > GROUP_MAX) { // on garde les GROUP_KEEP derniers messages et on libère les fichiers des plus anciens
      const old = (await redis('LRANGE', LK, 0, len - GROUP_KEEP - 1)) || [];
      for (const x of old) { try { const o = JSON.parse(x); if (o.fileId) await redis('DEL', `cse:file:${o.fileId}`); } catch {} }
      await redis('LTRIM', LK, len - GROUP_KEEP, -1); m.base = m.n - GROUP_KEEP;
    }
    await redis('SET', MK, JSON.stringify(m));
    if (mentions.length) await notify({ to: mentions.map(m => m.id), pref: 'mention', title: `📣 ${msg.by} vous a mentionné·e`, body: `${room ? '🗳️ Discussion élus' : '👥 Discussion globale'} : ${text}`, url: room ? '/#/communaute/elus' : '/#/communaute/discussion', tag: 'mention' });
    const ml = mentions.map(m => m.id);
    await notify(room ? { to: 'elus', except: u.id, exceptList: ml, pref: 'elus', title: '🗳️ Discussion élus', body: `${msg.by} : ${text || '📷 Photo / vidéo'}`, url: '/#/communaute/elus', tag: 'grp-elus' }
      : { to: 'all', except: u.id, exceptList: ml, pref: 'global', title: '👥 Discussion globale', body: `${msg.by} : ${text || '📷 Photo / vidéo'}`, url: '/#/communaute/discussion', tag: 'grp' });
    return { n: m.n, msg };
  },

  async members(req) { // annuaire pour les mentions @ : prénom, nom, type (pas d'email)
    await need(req);
    const items = (await allUsers()).filter(u => u.status === 'active').map(u => ({ id: u.id, prenom: u.prenom, nom: u.nom, elu: isEluCse(u) ? 1 : 0 }));
    items.push({ id: 'admin', prenom: 'Section', nom: 'CGT', elu: 1 });
    return { items: items.sort((a, b) => (a.prenom + a.nom).localeCompare(b.prenom + b.nom, 'fr')) };
  },

  async push(req) {
    if (req.method === 'GET') return { key: VAPID_PUBLIC, enabled: !!(VAPID_PUBLIC && VAPID_PRIVATE) };
    const u = await need(req); const b = body(req); const sub = b.sub || {};
    if (!/^https:\/\//.test(String(sub.endpoint || '')) || !sub.keys || !sub.keys.p256dh || !sub.keys.auth) throw fail(400, 'Abonnement invalide.');
    const k = pushId(sub.endpoint);
    if (req.method === 'DELETE') { await redis('HDEL', 'cse:push', k); return { ok: true }; }
    const prefs = {}; for (const p of PUSH_PREFS) prefs[p] = !(b.prefs && b.prefs[p] === false);
    await redis('HSET', 'cse:push', k, JSON.stringify({ uid: u.id, sub: { endpoint: sub.endpoint, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth } }, prefs, at: new Date().toISOString() }));
    if (req.query.test) { const st = await wpSend(sub, { title: '🔔 Notifications activées', body: 'Vous recevrez ici les nouveaux messages de la CGT Concentrix Compiègne.', url: '/', tag: 'test' }); return { ok: true, prefs, test: st }; }
    return { ok: true, prefs };
  },

  async billet(req) {
    if (req.method === 'GET' && req.query.catalog) return { items: BILLETS };
    const u = await need(req);
    if (req.method === 'POST' && !req.query.id) {
      await rateLimit(req, 'billet', 15);
      const b = body(req); const lines = []; let total = 0, n = 0, from = false;
      for (const l of Array.isArray(b.items) ? b.items.slice(0, 40) : []) {
        const o = BILLETS.find(x => x.id === l.offre); const v = o && o.variants.find(x => x.id === l.variant);
        const q = Math.floor(Number(l.qty) || 0); if (!v || q < 1) continue;
        if (q > 30) throw fail(400, 'Maximum 30 billets par ligne.');
        lines.push({ offre: o.id, nom: o.nom, emoji: o.emoji, variant: v.id, label: v.label, prix: v.prix, qty: q, from: !!o.from });
        total += v.prix * q; n += q; from = from || !!o.from;
      }
      if (!lines.length) throw fail(400, 'Votre panier est vide.');
      const it = { id: newId(), num: 'B' + Date.now().toString(36).slice(-5).toUpperCase(), created: new Date().toISOString(), status: 'nouvelle',
        uid: u.id, nom: clip(b.nom || u.nom, 'nom'), prenom: clip(b.prenom || u.prenom, 'prenom'), email: clip(b.email || u.email, 'email'),
        telephone: clip(b.telephone, 'telephone'), contrat: clip(b.contrat, 'contrat'), paiement: b.paiement === 'cheque' ? 'cheque' : 'especes',
        retrait: b.retrait === 'email' ? 'email' : 'cse', date_visite: clip(b.date_visite, 'date'), note: clip(b.note, 'message').slice(0, 1000),
        lines, total, n, from };
      if (!it.nom || !it.prenom) throw fail(400, 'Indiquez votre nom et votre prénom.');
      if (!it.telephone && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(it.email)) throw fail(400, 'Indiquez un téléphone ou un email.');
      if (!b.engage) throw fail(400, "Merci de confirmer que vous réglerez la commande au CSE.");
      await redis('HSET', 'cse:billets', it.id, JSON.stringify(it));
      await notify({ to: 'admins', except: u.id, pref: 'gestion', title: '🎟️ Nouvelle commande de billets', body: `${it.prenom} ${it.nom} · ${it.n} billet${it.n > 1 ? 's' : ''} · n° ${it.num}`, url: '/#/espace', tag: 'billet' });
      return { ok: true, item: it };
    }
    const all = async () => { const f = (await redis('HGETALL', 'cse:billets')) || []; const o = []; for (let i = 1; i < f.length; i += 2) { try { o.push(JSON.parse(f[i])); } catch {} } return o.sort((a, c) => String(c.created).localeCompare(String(a.created))); };
    if (req.method === 'GET' && req.query.mine) return { items: (await all()).filter(x => x.uid === u.id).slice(0, 30) };
    const getIt = async () => { const v = await redis('HGET', 'cse:billets', String(req.query.id || '')); if (!v) throw fail(404, 'Commande introuvable.'); return JSON.parse(v); };
    if (req.method === 'DELETE') {
      const it = await getIt();
      if (u.role !== 'elu' && !(it.uid === u.id && it.status === 'nouvelle')) throw fail(403, 'Cette commande ne peut plus être annulée en ligne. Contactez le CSE.');
      await redis('HDEL', 'cse:billets', it.id); return { ok: true };
    }
    // Changement de date : le CSE ou le salarié propose une date, l'autre accepte (ou repropose)
    if (req.method === 'POST' && ['propose', 'accept'].includes(body(req).action)) {
      const it = await getIt(); const b = body(req); const elu = u.role === 'elu';
      if (!elu && it.uid !== u.id) throw fail(403, 'Commande introuvable.');
      const side = elu ? 'cse' : 'salarie'; const fd = d => d.split('-').reverse().join('/');
      it.dates = it.dates || [];
      if (b.action === 'propose') {
        const date = String(b.date || '');
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw fail(400, 'Choisissez une date.');
        const msg = clip(b.msg, 'message').slice(0, 500);
        it.proposal = { date, msg, by: side, at: new Date().toISOString() };
        it.dates.push({ type: 'propose', by: side, date, msg, at: it.proposal.at });
        await redis('HSET', 'cse:billets', it.id, JSON.stringify(it));
        const txt = `📅 Commande ${it.num} : ${side === 'cse' ? 'le CSE vous propose' : 'je propose'} le ${fd(date)} comme date${msg ? ` — « ${msg} »` : ''}.${side === 'cse' ? ' Répondez dans Avantages → Mes commandes.' : ''}`;
        if (it.uid !== 'admin') try { side === 'cse' ? await chatPush(it.uid, { from: 'cgt', by: u.id === 'admin' ? 'Section CGT' : `${u.prenom} · CGT`, text: txt })
          : await chatPush(it.uid, { from: 'user', by: `${u.prenom} ${u.nom}`, text: txt }, { name: `${u.prenom} ${u.nom}`, email: u.email, service: u.service || '' }); } catch {}
        return { ok: true, item: it };
      }
      if (!it.proposal) throw fail(400, 'Aucune date à accepter.');
      if (it.proposal.by === side) throw fail(400, "C'est à l'autre partie d'accepter cette date.");
      it.date_visite = it.proposal.date; it.dates.push({ type: 'accept', by: side, date: it.proposal.date, at: new Date().toISOString() }); it.proposal = null;
      await redis('HSET', 'cse:billets', it.id, JSON.stringify(it));
      const txt = `✅ Commande ${it.num} : date du ${fd(it.date_visite)} acceptée${side === 'cse' ? ' par le CSE' : ''}.`;
      if (it.uid !== 'admin') try { side === 'cse' ? await chatPush(it.uid, { from: 'cgt', by: 'Section CGT', text: txt })
        : await chatPush(it.uid, { from: 'user', by: `${u.prenom} ${u.nom}`, text: txt }, { name: `${u.prenom} ${u.nom}`, email: u.email, service: u.service || '' }); } catch {}
      return { ok: true, item: it };
    }
    if (u.role !== 'elu') throw fail(403, 'Réservé aux élu·e·s.');
    if (req.method === 'GET') return { items: await all() };
    const it = await getIt(); const st = String(body(req).status || '');
    if (!BILLET_ST.includes(st)) throw fail(400, 'Statut inconnu');
    it.status = st; it.updated = new Date().toISOString(); await redis('HSET', 'cse:billets', it.id, JSON.stringify(it)); return { ok: true };
  },

  async adhesion(req) {
    // Envoi public (pas besoin de compte) — lecture / suivi réservés aux responsables
    if (req.method === 'POST' && !req.query.id) {
      const b = body(req);
      if (b.website) return { ok: true }; // pot de miel anti-robots
      await rateLimit(req, 'adh', 5);
      const it = { id: newId(), created: new Date().toISOString(), status: 'nouvelle' };
      for (const f of ADH_FIELDS) it[f] = clip(b[f], f === 'message' ? 'message' : f);
      if (!it.nom || !it.prenom) throw fail(400, 'Indiquez votre nom et votre prénom.');
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(it.email) && !it.telephone) throw fail(400, 'Indiquez un email ou un téléphone.');
      if (!b.rgpd) throw fail(400, "Merci d'accepter l'utilisation de vos données pour traiter l'adhésion.");
      if (!SIG_RE.test(String(b.signature || '')) || String(b.signature).length > 200000) throw fail(400, 'Merci de signer le bulletin.');
      it.signature = b.signature;
      if (it.prelevement === 'oui') {
        const iban = String(b.iban || '').replace(/\s+/g, '').toUpperCase();
        if (!ibanOk(iban)) throw fail(400, "L'IBAN saisi n'est pas valide. Vérifiez-le.");
        if (!b.sepa_ok) throw fail(400, "Merci de cocher l'autorisation de prélèvement SEPA.");
        if (!SIG_RE.test(String(b.sepa_signature || '')) || String(b.sepa_signature).length > 200000) throw fail(400, 'Merci de signer le mandat de prélèvement.');
        it.iban_enc = encrypt(iban); it.iban_fin = iban.slice(-4); it.iban_pays = iban.slice(0, 2);
        it.sepa_signature = b.sepa_signature;
      }
      await redis('HSET', 'cse:adhesions', it.id, JSON.stringify(it));
      await notify({ to: 'admins', pref: 'gestion', title: '✊ Nouvelle adhésion en ligne', body: `${it.prenom} ${it.nom}`, url: '/#/adhesions', tag: 'adhesion' });
      return { ok: true, id: it.id };
    }
    await need(req, 'elu');
    const strip = it => { const o = { ...it }; delete o.iban_enc; return o; };
    if (req.method === 'GET' && req.query.id) {
      const v = await redis('HGET', 'cse:adhesions', String(req.query.id)); if (!v) throw fail(404, 'Adhésion introuvable.');
      const it = JSON.parse(v); const o = strip(it);
      if (req.query.full && it.iban_enc) o.iban = decrypt(it.iban_enc).replace(/(.{4})/g, '$1 ').trim();
      return { item: o };
    }
    if (req.method === 'GET') {
      const f = (await redis('HGETALL', 'cse:adhesions')) || []; const items = [];
      for (let i = 1; i < f.length; i += 2) { try { const it = strip(JSON.parse(f[i])); delete it.signature; delete it.sepa_signature; items.push(it); } catch {} }
      items.sort((a, b) => String(b.created).localeCompare(String(a.created)));
      return { items };
    }
    if (req.method === 'DELETE') { await redis('HDEL', 'cse:adhesions', String(req.query.id || '')); return { ok: true }; }
    const v = await redis('HGET', 'cse:adhesions', String(req.query.id)); if (!v) throw fail(404, 'Adhésion introuvable.');
    const it = JSON.parse(v); const st = String(body(req).status || '');
    if (!['nouvelle', 'traitee'].includes(st)) throw fail(400, 'Statut inconnu');
    it.status = st; await redis('HSET', 'cse:adhesions', it.id, JSON.stringify(it)); return { ok: true };
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
    await migrateIfNeeded();
    const fn = A[String(req.query.a || 'health')];
    if (!fn) return send(res, 404, { error: 'Action inconnue' });
    const out = await fn(req, res);
    if (out !== null) send(res, 200, out);
  } catch (e) {
    send(res, e.status || 500, { error: e.status ? e.message : 'Erreur serveur : ' + e.message });
  }
};
