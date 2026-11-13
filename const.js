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
  PLAYER_SPEED_SCALE: 0.6, // 모든 선수 이동 속도 배율 (1.0 = 이전 속도) — 단순/느리게
  BALL_SPEED_SCALE: 0.7,  // 킥(슛/패스) 속도 배율
  SPRINT_MUL: 1.2,        // 달리기 배율
  ONE_BOUNCE: true,       // 원바 규칙: 찬 공은 바닥에 한 번 튕긴 뒤에야 터치할 수 있다
  GRAVITY: 900,           // 공 높이(z) 중력
  TOUCH_Z: 14,            // 이 높이 이하일 때만 선수가 공을 칠 수 있음
  GK_TOUCH_Z: 32,         // 골키퍼는 더 높이까지 손이 닿는다
  BOT_SKILL: 0.55,        // CPU 상대 AI 실력 (0~1, 낮을수록 멍청)
  MATE_SKILL: 0.75,       // 내 팀 AI 팀원 실력
  PULL_COST: 1000,        // 뽑기 1회 가격 (게임 내 가상 재화 '원')
  WIN_REWARD: 1000,       // CPU 연습경기 승리 보상
  START_BAL: 0,           // 처음 시작 잔액 (0원: CPU를 이겨서 벌어야 함)
};
