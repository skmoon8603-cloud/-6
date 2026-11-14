'use strict';
// 경기장/물리 상수 (월드 단위). 팀0은 +x 방향(오른쪽 골대)으로 공격한다.
module.exports = {
  W: 1400,        // 넓어진 경기장 (카메라가 공을 따라가므로 먼 곳은 화면에 안 보임)
  H: 860,
  GOAL_W: 230,      // 골 입구 폭
  GOAL_D: 64,       // 골대 깊이
  PR: 15,           // 선수 반지름
  BR: 8,            // 공 반지름
  POST_R: 5,
  TICK: 1 / 60,     // 물리 고정 스텝
  SNAP_EVERY: 2,    // 2틱마다 스냅샷 전송 (30Hz)
  MATCH_SECONDS: Number(process.env.MATCH_SECONDS) || 180,
  COUNTDOWN: 3,
  GOAL_PAUSE: 7.6,  // 골 세레모니 + 슬로모션 확정 리플레이(약 6초) 시간
  BALL_FRICTION: 0.85,   // 지수 감쇠 계수 (1/s)
  TEAM_SIZE: 6,
  PLAYER_SPEED_SCALE: 0.66, // 모든 선수 이동 속도 배율 (1.0 = 이전 속도) — 단순/느리게
  SPRINT_MUL: 1.2,        // 달리기 배율
  BOT_SKILL: 0.55,        // CPU 상대 AI 실력 (0~1, 낮을수록 멍청)
  MATE_SKILL: 0.75,       // 내 팀 AI 팀원 실력
  PULL_COST: 1000,        // 뽑기 1회 가격 (게임 내 가상 재화 '원')
  WIN_REWARD: 3000,       // 축구 CPU 연습경기 승리 보상
  BOUNCE_REWARD: 1000,    // 원 바운스 AI 대결 승리 보상
  ATTEND: [1000, 2000, 3000, 4000, 5000, 5000, 6000], // 일일 출석 보상 (주간 7일, 매주 월요일 00시(KST) 초기화)
  ATTEND_TZ_H: 9,         // 출석 기준 시간대: 한국(UTC+9)
  BOUNCE_CPU_LEVEL: 0.55, // 원 바운스 AI 실력 (0~1)
  START_BAL: 0,           // 처음 시작 잔액 (0원: CPU를 이겨서 벌어야 함)
};
