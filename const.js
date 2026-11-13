'use strict';
// 경기장/물리 상수 (월드 단위). 팀0은 +x 방향(오른쪽 골대)으로 공격한다.
module.exports = {
  W: 1050,
  H: 680,
  GOAL_W: 190,      // 골 입구 폭
  GOAL_D: 56,       // 골대 깊이
  PR: 15,           // 선수 반지름
  BR: 8,            // 공 반지름
  POST_R: 5,
  TICK: 1 / 60,     // 물리 고정 스텝
  SNAP_EVERY: 2,    // 2틱마다 스냅샷 전송 (30Hz)
  MATCH_SECONDS: Number(process.env.MATCH_SECONDS) || 180,
  COUNTDOWN: 3,
  GOAL_PAUSE: 2.8,
  BALL_FRICTION: 0.85,   // 지수 감쇠 계수 (1/s)
  TEAM_SIZE: 6,
};
