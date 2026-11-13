# ⚽ RANDOM FOOTBALL

선수를 뽑고, 편성하고, 친구와 **실시간 1대1** 축구 대결을 하는 모바일 웹 게임.
Node.js + Express + Socket.IO (서버 권한) / HTML + CSS + Canvas (클라이언트). 앱 설치 없이 안드로이드 크롬에서 실행됩니다.

## 파일 구조 (이 위치 그대로 올리세요)
```
package.json      server.js      render.yaml     README.md     .gitignore
lib/   const.js  catalog.js  inventory.js  ai.js  engine.js  net.js  api.js
public/ index.html  style.css  meta.js  render.js  game.js
test/  (선택: 테스트 코드. 배포에는 필요 없음)
```

## 🚀 휴대폰만으로 배포하기 (GitHub + Render, 무료)
> 무료 Render는 15분간 접속이 없으면 잠들고, 다시 접속하면 깨어나는 데 약 1분 걸립니다. 한 번 접속한 뒤에는 계속 빠릅니다.
> 월 750시간 무료 / 신용카드 불필요(Render 공식 문서 기준).

### 1단계. GitHub에 코드 올리기
1. 크롬에서 github.com 가입/로그인 → 우상단 **+ → New repository** → 이름 `random-football`, **Public** → Create.
2. 크롬 메뉴(⋮) → **데스크톱 사이트** 체크(업로드 화면이 잘 보입니다).
3. 폰의 ZIP을 **파일(Files) 앱에서 압축 해제**해 둡니다.
4. 저장소 화면에서 **Add file → Upload files** → 루트 파일 5개(`package.json server.js render.yaml README.md .gitignore`) 선택 → **Commit changes**.
5. 폴더 만들기: **Add file → Create new file** → 이름칸에 `lib/.gitkeep` 입력(슬래시를 치면 폴더가 됩니다) → Commit. 같은 방법으로 `public/.gitkeep`.
6. 저장소에서 `lib` 폴더를 열고 **Add file → Upload files** → `lib` 안의 파일 7개 선택 → Commit. `public` 폴더도 같은 방법으로 파일 5개 업로드.

### 2단계. Render에 배포하기
1. render.com 에서 **Get Started**(GitHub 계정으로 가입).
2. **New + → Blueprint**(또는 **Web Service**) → GitHub 연결 → `random-football` 선택.
   - Blueprint: `render.yaml`이 자동 적용됩니다 → **Apply**.
   - Web Service로 직접 만들 경우: Runtime `Node`, Build `npm install`, Start `npm start`, Instance **Free**,
     Environment에 `INVENTORY_SECRET` = 아무 긴 임의 문자열(예: 영문숫자 32자) **반드시 추가**.
3. 배포가 끝나면 `https://random-football-xxxx.onrender.com` 주소가 생깁니다 (**HTTPS 자동 적용**, WebSocket 지원).

### 3단계. 친구와 플레이
1. 내 폰 크롬에서 위 주소 접속 → (선택) 메뉴 ⋮ → **홈 화면에 추가**.
2. 닉네임 입력 → **방 만들기** → 6자리 코드 표시 → **초대 링크 공유**(카톡 등)로 친구에게 전달.
3. 친구는 링크를 누르거나 주소 접속 후 코드 입력 → **입장** → 둘 다 **준비 완료** → 시작!
4. 혼자 연습: **CPU 연습 경기**.

## 🎮 조작
| | 모바일 | PC |
|---|---|---|
| 이동 | 왼쪽 가상 조이스틱 | WASD / 방향키 |
| 슛 | 슛 버튼(길게 누르면 강하게) | Space |
| 패스 | 패스 버튼 | E |
| 질주 | 질주 버튼(탭=고정, 누름=유지) | Shift |
| 선수 변경 | 교체 버튼 | Q |
- 화면은 **가로**로 돌려 플레이하세요. 내 팀은 항상 왼쪽→오른쪽으로 공격합니다.
- 패스하면 받는 선수로 자동 전환됩니다. 6인제(GK1·DF2·MF1·FW2), 3분 경기, 벽에 맞고 튕기는 아케이드 방식.

## 🎁 뽑기 / 보관함
- 확률: 일반 55% · 희귀 25% · 영웅 12% · 전설 6% · 신화 2% (서버 난수로 추첨, 무료·무제한).
- 능력치: 속도·슛·패스·수비·체력·골키퍼. 등급이 높을수록 평균이 높음.
- 중복 획득 시 강화 레벨 +1(능력치 +2%, 최대 +10%).
- 보관함은 서버가 **서명한 토큰**으로 기기(localStorage)에 저장되어 새로고침해도 유지되고, 위조하면 무효 처리됩니다.
  (계정/DB가 없으므로 브라우저 데이터를 지우거나 다른 기기에서는 보관함이 따로입니다.)

## 🔒 서버 권한 / 멀티플레이
- 물리·충돌·골 판정·점수·시간은 모두 서버(`lib/engine.js`)가 계산. 클라이언트는 입력(이동/슛/패스/교체)만 전송.
- 편성은 서버가 보유 여부·포지션을 검증하고, 능력치는 서버 카탈로그 값만 사용.
- 방마다 독립된 경기 인스턴스. 방 코드 6자리(입장은 6~8자리 허용), 최대 2명.
- 연결이 끊기면 경기 일시정지 → 30초 안에 같은 기기로 돌아오면(새로고침 포함) 이어서 진행, 초과 시 남은 사람 승리.
- 방을 나가면 상대에게 알림, 진행 중이면 기권승.

## 💻 로컬 실행 (PC)
```
npm install
npm start        # http://localhost:3000
```
환경변수: `PORT`, `INVENTORY_SECRET`(필수 권장), `MATCH_SECONDS`(기본 180), `RECONNECT_GRACE_MS`(기본 30000).

## ✅ 검증 현황 (솔직한 보고)
- `npm test` 의 서버 로직 테스트 30개 통과: 방 코드, 입장 제한, 점수 위조 방지, 골 판정, 방 격리, 끊김/재접속/기권, 뽑기 API.
- AI 대 AI 시뮬레이션: 경기당 평균 약 5.8골, 골 이벤트와 점수 불일치 0건, NaN 0건.
- 실제 브라우저(Chromium, 모바일 에뮬레이션) 2개로 로비 → 뽑기 → 보관함 → 방 생성/입장 → 경기 → 새로고침 재접속 → 나가기 흐름 통과.
- ⚠️ 위 브라우저 테스트는 `test/devserver.js`(Socket.IO 호환 임시 서버)로 수행했습니다. 제 작업 환경에서는 패키지 설치가 막혀 **실제 Express+Socket.IO(`server.js`)는 직접 실행해 보지 못했습니다.** 첫 배포 때 Render 로그에서 `RANDOM FOOTBALL listening` 이 보이는지, `/healthz` 가 `{"ok":true}` 인지 확인해 주세요.
- 실제 안드로이드 기기 터치 테스트와 인터넷 환경에서의 두 사람 접속은 아직 하지 못했습니다.
