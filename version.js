'use strict';
/** 클라이언트 버전: 배포 커밋(Render) 또는 클라이언트 파일 내용 해시. 새 배포가 되면 값이 바뀌어 브라우저가 자동 새로고침한다. */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const FILES = ['index.html', 'style.css', 'meta.js', 'render.js', 'game.js', 'bounce.js', 'hub.js'];
function compute(...dirs) {
  const h = crypto.createHash('sha1');
  h.update(String(process.env.RENDER_GIT_COMMIT || ''));
  for (const f of FILES) for (const d of dirs) { try { h.update(fs.readFileSync(path.join(d, f))); break; } catch (e) { /* 다음 폴더 */ } }
  return h.digest('hex').slice(0, 12);
}
module.exports = { compute };
