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

module.exports = { signSession, verifySession, verifyGoogle, GOOGLE_CLIENT_ID, DEV_LOGIN };
