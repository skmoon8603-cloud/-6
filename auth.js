'use strict';
/**
 * 인증: 구글 ID 토큰 검증 + 우리 서버의 세션 토큰(서명, 30일).
 * - 구글 ID 토큰은 Google tokeninfo 엔드포인트로 검증(aud=내 Client ID, iss, 만료, 이메일 인증).
 * - 세션 토큰은 SESSION_SECRET 으로 HMAC 서명. 비밀번호는 어디에도 저장하지 않는다.
 */
const crypto = require('crypto');

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
const DEV_LOGIN = process.env.DEV_LOGIN === '1'; // 테스트 전용. 운영에서는 절대 켜지 마세요.
let SECRET = process.env.SESSION_SECRET || process.env.INVENTORY_SECRET;
if (!SECRET) {
  SECRET = crypto.randomBytes(32).toString('hex');
  console.warn('[경고] SESSION_SECRET 이 없어 임시 키를 사용합니다. 서버가 재시작되면 모두 다시 로그인해야 합니다.');
}
const SESSION_MS = 30 * 86400000;

const b64 = (s) => Buffer.from(s).toString('base64url');
const sig = (p) => crypto.createHmac('sha256', SECRET).update('session:' + p).digest('base64url');
const eq = (a, b) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && crypto.timingSafeEqual(x, y); };

function signSession(uid) {
  const p = b64(JSON.stringify({ u: uid, exp: Date.now() + SESSION_MS }));
  return p + '.' + sig(p);
}
function verifySession(t) {
  if (typeof t !== 'string' || t.length > 600) return null;
  const i = t.indexOf('.');
  if (i < 1 || !eq(t.slice(i + 1), sig(t.slice(0, i)))) return null;
  try {
    const o = JSON.parse(Buffer.from(t.slice(0, i), 'base64url').toString('utf8'));
    if (!o || typeof o.u !== 'string' || !(o.exp > Date.now())) return null;
    return { uid: o.u };
  } catch (e) { return null; }
}

/** 구글 credential(ID 토큰) 검증 → { sub, email, name, picture } | null */
async function verifyGoogle(credential) {
  if (typeof credential !== 'string' || credential.length > 4000) return null;
  if (DEV_LOGIN && credential.startsWith('dev:')) {
    const name = credential.slice(4).replace(/[^\w\-]/g, '').slice(0, 20) || 'dev';
    return { sub: 'dev-' + name, email: name + '@dev.local', name, picture: '' };
  }
  if (!GOOGLE_CLIENT_ID) return null;
  try {
    const r = await fetch('https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(credential), { signal: AbortSignal.timeout(8000) });
    if (!r.ok) return null;
    const c = await r.json();
    const okIss = c.iss === 'accounts.google.com' || c.iss === 'https://accounts.google.com';
    if (c.aud !== GOOGLE_CLIENT_ID || !okIss || !(Number(c.exp) * 1000 > Date.now()) || !c.sub) return null;
    if (c.email && String(c.email_verified) !== 'true') return null;
    return { sub: 'g-' + c.sub, email: c.email || '', name: c.name || (c.email || '').split('@')[0] || 'PLAYER', picture: c.picture || '' };
  } catch (e) { console.error('[auth] google verify failed:', e.message); return null; }
}

const GITHUB_CLIENT_ID = process.env.GITHUB_CLIENT_ID || '';
const GITHUB_CLIENT_SECRET = process.env.GITHUB_CLIENT_SECRET || '';
const GITHUB = !!(GITHUB_CLIENT_ID && GITHUB_CLIENT_SECRET);
const hsig = (p) => crypto.createHmac('sha256', SECRET).update('gh:' + p).digest('base64url');
/** OAuth state: 무작위 값 + 만료, 서명 (쿠키와 대조해 CSRF 방지) */
function newState() { const p = crypto.randomBytes(16).toString('base64url') + '.' + (Date.now() + 10 * 60000); return p + '.' + hsig(p); }
function okState(st) {
  if (typeof st !== 'string') return false;
  const i = st.lastIndexOf('.'); if (i < 1 || !eq(st.slice(i + 1), hsig(st.slice(0, i)))) return false;
  return Number(st.slice(0, i).split('.')[1]) > Date.now();
}
function githubUrl(state, redirect) {
  return 'https://github.com/login/oauth/authorize?' + new URLSearchParams({ client_id: GITHUB_CLIENT_ID, redirect_uri: redirect, scope: 'read:user', state, allow_signup: 'true' });
}
/** 깃허브 인증 코드 → { sub, email, name } | null */
async function githubProfile(code, redirect) {
  if (!GITHUB || typeof code !== 'string' || code.length > 200) return null;
  try {
    const t = await fetch('https://github.com/login/oauth/access_token', { method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/json' }, body: JSON.stringify({ client_id: GITHUB_CLIENT_ID, client_secret: GITHUB_CLIENT_SECRET, code, redirect_uri: redirect }), signal: AbortSignal.timeout(8000) });
    const tj = await t.json(); if (!tj.access_token) return null;
    const u = await fetch('https://api.github.com/user', { headers: { Authorization: 'Bearer ' + tj.access_token, 'User-Agent': 'random-football', Accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(8000) });
    if (!u.ok) return null; const j = await u.json();
    if (!j.id || !j.login) return null;
    return { sub: 'gh-' + j.id, email: j.login, name: j.login };
  } catch (e) { console.error('[auth] github failed:', e.message); return null; }
}

module.exports = { newState, okState, githubUrl, githubProfile, GITHUB, signSession, verifySession, verifyGoogle, GOOGLE_CLIENT_ID, DEV_LOGIN };
