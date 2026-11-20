'use strict';
// 채팅·이름 욕설 거르기 (플레이스토어 사용자 제작 콘텐츠 정책). 글자 사이에 숫자·기호·공백을 끼워 넣어도 잡는다.
const WORDS = [
  '씨발', '시발', '씨바', '쓰발', '씨팔', '시팔', 'ㅅㅂ', 'ㅆㅂ', 'ㅅ ㅂ', '샹년', '썅',
  '병신', '븅신', '빙신', 'ㅂㅅ', '등신', '지랄', 'ㅈㄹ', '좆', '존나', '졸라', 'ㅈㄴ', '좃',
  '개새끼', '개새', '이새끼', '저새끼', '니새끼', '쌔끼', '개색', 'ㄱㅅㄲ', '느금', '느그어매', '느그엄마', '느그애미', '니애미', '니엄마', '니어미', '애미', '애비', '엠창', '앰창', '느개비',
  '미친놈', '미친년', '미친새', '또라이', '닥쳐', '꺼져', '염병', '육시랄', '호로', '후레자식', '창녀', '창년', '걸레년', '보지', '자지', '섹스', '쎅스', '야동', '딸딸이',
  '한남충', '김치녀', '틀딱', '급식충', '맘충', '짱깨', '쪽바리', '흑형', '장애새끼', '정신병자',
  'fuck', 'fuk', 'shit', 'bitch', 'asshole', 'dick', 'pussy', 'cunt', 'nigger', 'nigga', 'faggot', 'porn', 'sex', 'whore', 'slut', 'retard',
];
const norm = (c) => c.toLowerCase();
const keep = (c) => /[\p{L}]/u.test(c); // 글자만 비교 (숫자·기호·공백은 건너뛴다)
const LIST = WORDS.map((w) => [...w].filter(keep).map(norm).join('')).filter(Boolean).sort((a, b) => b.length - a.length);
function clean(text) {
  const s = [...String(text == null ? '' : text)];
  const idx = []; let flat = '';
  s.forEach((c, i) => { if (keep(c)) { idx.push(i); flat += norm(c); } });
  const hit = new Array(s.length).fill(false); let found = false;
  for (const w of LIST) {
    let p = flat.indexOf(w);
    while (p >= 0) { found = true; for (let k = p; k < p + w.length; k++) hit[idx[k]] = true; p = flat.indexOf(w, p + 1); }
  }
  return found ? s.map((c, i) => (hit[i] ? '*' : c)).join('') : s.join('');
}
const bad = (text) => clean(text) !== String(text == null ? '' : text);
module.exports = { clean, bad };
