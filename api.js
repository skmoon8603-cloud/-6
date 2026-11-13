'use strict';
const C = require('./catalog');
const K = require('./const');
const { Accounts, STAKES } = require('./accounts');

const hits = new Map();
function limited(key, max = 30, windowMs = 10000) {
  const now = Date.now();
  let h = hits.get(key);
  if (!h || now - h.t > windowMs) { h = { t: now, n: 0 }; hits.set(key, h); }
  h.n++;
  if (hits.size > 5000) for (const [k, v] of hits) if (now - v.t > windowMs) hits.delete(k);
  return h.n > max;
}

function catalogPayload() {
  return {
    rarities: C.RARITIES.map(({ key, name, rate, color }) => ({ key, name, rate, color })),
    slots: C.SLOTS, posName: C.POS_NAME, maxDup: C.MAX_DUP_LEVEL, pullCost: K.PULL_COST, winReward: K.WIN_REWARD,
    stakes: STAKES, players: C.CATALOG.map(C.publicPlayer),
  };
}

function create({ accounts, auth }) {
  const rand01 = () => require('crypto').randomInt(0, 1e9) / 1e9;
  const bearer = (req) => { const h = req.headers.authorization || ''; return h.startsWith('Bearer ') ? h.slice(7) : ''; };
  const who = (req) => { const s = auth.verifySession(bearer(req)); return s ? s.uid : null; };
  const wrap = (fn) => async (req, res) => {
    try {
      const r = await fn(req);
      res.status(r.status).json(r.body);
    } catch (e) { console.error('[api]', e && e.stack || e); res.status(500).json({ error: 'server_error' }); }
  };
  const authed = (fn) => wrap(async (req) => {
    if (limited('i:' + req.ip, 60)) return { status: 429, body: { error: 'too_many_requests' } };
    const uid = who(req);
    if (!uid) return { status: 401, body: { error: 'unauthorized' } };
    return fn(req, uid);
  });

  const cookie = (req, k) => { const m = (req.headers.cookie || '').split(/;\s*/).find((c) => c.startsWith(k + '=')); return m ? decodeURIComponent(m.slice(k.length + 1)) : ''; };
  const redirectUri = (req) => `${req.protocol}://${req.get('host')}/auth/github/callback`;
  return {
    githubStart: (req, res) => {
      if (!auth.GITHUB) return res.status(503).send('GitHub login is not configured');
      if (limited('g:' + req.ip, 20, 60000)) return res.status(429).send('too many requests');
      const st = auth.newState(); const legacy = String(req.query.legacy || '').slice(0, 2000);
      const opt = `; Max-Age=600; Path=/; HttpOnly; SameSite=Lax${req.secure ? '; Secure' : ''}`;
      res.setHeader('Set-Cookie', [`rf_st=${st}${opt}`, `rf_lg=${encodeURIComponent(legacy)}${opt}`]);
      res.redirect(auth.githubUrl(st, redirectUri(req)));
    },
    githubCallback: async (req, res) => {
      try {
        const st = String(req.query.state || '');
        if (!st || st !== cookie(req, 'rf_st') || !auth.okState(st)) return res.redirect('/#autherr=state');
        const prof = await auth.githubProfile(String(req.query.code || ''), redirectUri(req));
        if (!prof) return res.redirect('/#autherr=github');
        const legacy = cookie(req, 'rf_lg') || null;
        const acct = await accounts.login(prof, legacy);
        res.setHeader('Set-Cookie', ['rf_st=; Max-Age=0; Path=/', 'rf_lg=; Max-Age=0; Path=/']);
        res.redirect('/#auth=' + encodeURIComponent(auth.signSession(acct.id)));
      } catch (e) { console.error('[api]', e); res.redirect('/#autherr=server'); }
    },
    config: (_req, res) => res.json({ googleClientId: auth.GOOGLE_CLIENT_ID, github: auth.GITHUB, devLogin: auth.DEV_LOGIN }),
    register: wrap(async (req) => {
      if (limited('r:' + req.ip, 5, 60000)) return { status: 429, body: { error: 'too_many_requests' } };
      const b = req.body || {};
      const r = await accounts.register(b.username, b.password, typeof b.legacyToken === 'string' ? b.legacyToken : null);
      if (r.error) return { status: r.error === 'exists' ? 409 : 400, body: { error: r.error } };
      return { status: 200, body: { session: auth.signSession(r.acct.id), account: r.acct } };
    }),
    signin: wrap(async (req) => {
      if (limited('s:' + req.ip, 15, 60000)) return { status: 429, body: { error: 'too_many_requests' } };
      const b = req.body || {};
      const r = await accounts.signin(b.username, b.password);
      if (r.error) return { status: r.error === 'locked' ? 429 : 401, body: { error: r.error } };
      return { status: 200, body: { session: auth.signSession(r.acct.id), account: r.acct } };
    }),
    login: wrap(async (req) => {
      if (limited('l:' + req.ip, 10, 60000)) return { status: 429, body: { error: 'too_many_requests' } };
      const b = req.body || {};
      const prof = await auth.verifyGoogle(b.credential);
      if (!prof) return { status: 401, body: { error: 'bad_credential' } };
      const acct = await accounts.login(prof, typeof b.legacyToken === 'string' ? b.legacyToken : null);
      return { status: 200, body: { session: auth.signSession(acct.id), account: acct } };
    }),
    me: authed(async (_req, uid) => {
      const a = await accounts.get(uid);
      return a ? { status: 200, body: { account: a } } : { status: 401, body: { error: 'unauthorized' } };
    }),
    pull: authed(async (req, uid) => {
      const n = req.body && req.body.n === 10 ? 10 : 1;
      const out = await accounts.pull(uid, n, rand01);
      if (out.error === 'not_enough') return { status: 402, body: out };
      if (out.error) return { status: 401, body: out };
      return { status: 200, body: out };
    }),
    nick: authed(async (req, uid) => {
      const a = await accounts.setNick(uid, req.body && req.body.nick);
      return a ? { status: 200, body: { account: a } } : { status: 400, body: { error: 'invalid' } };
    }),
  };
}

module.exports = { catalogPayload, create };
