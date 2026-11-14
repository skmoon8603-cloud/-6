'use strict';
/**
 * 티어(랭크) 시스템: 사람과의 대결(친구 방 축구 / 원 바운스)에서 이기면 +1점, 지면 −1점 (0점 아래로는 내려가지 않음).
 * 3점마다 티어가 하나 오른다. 최고 티어(승엄급)는 33점부터.
 * CPU/AI 연습 경기는 점수에 반영되지 않는다. 무승부는 변화 없음.
 */
const TIERS = ['브론즈', '실버', '골드', '동축급', '잠신중급', '잠신고급', '선출급', '프로급', '선수급', '국대급', '월드컵급', '승엄급'];
const STEP = 3;
const COLORS = ['#b87333', '#c0c8d6', '#ffc53d', '#5fd36b', '#3fa9ff', '#4d6cff', '#b65cff', '#ff7adf', '#ff8a3d', '#ff3d6e', '#5cf2ff', '#ffe14a'];
function tierOf(pts) {
  pts = Math.max(0, Math.trunc(pts) || 0);
  const i = Math.min(TIERS.length - 1, Math.floor(pts / STEP));
  const top = i === TIERS.length - 1;
  return { i, name: TIERS[i], color: COLORS[i], into: top ? Math.min(STEP, pts - i * STEP) : pts % STEP, step: STEP, top };
}
module.exports = { TIERS, STEP, COLORS, tierOf };
