# 배포 가이드 (서버 관리자용)

모집 게시판 — Node.js 무의존성 앱 + Docker + Cloudflare 터널.
공인 IP / 포트포워딩 / 방화벽 / DNS 설정이 **필요 없습니다**. 터널이 아웃바운드로 연결되고,
도메인(`jayden730.site`)은 이 서버가 터널에 붙는 순간 자동으로 연결됩니다.

## 저장소에 없는 것 (소유자에게 별도로 받아야 함)
- **`.env`** — `TUNNEL_TOKEN`(터널 토큰). `.env.example`을 복사해 채우세요.
- **`data/data.json`** — 기존 회원·공고·점수·상점 데이터. 기존 데이터를 이어받을 때만 필요.
  (없으면 빈 상태로 시작하며, 관리자 계정은 `.env`의 `ADMIN_INITIAL_PW`로 최초 1회 생성됩니다.)

## 1) Docker 설치 (Ubuntu/Debian)
```bash
curl -fsSL https://get.docker.com | sudo sh
sudo systemctl enable --now docker      # 부팅 시 자동 시작
sudo usermod -aG docker $USER           # sudo 없이 docker 사용 (재로그인 필요)
```

## 2) 소스 받기
```bash
git clone <이-저장소-URL> recruit-board
cd recruit-board
```

## 3) 비밀 값 설정
```bash
cp .env.example .env
nano .env      # TUNNEL_TOKEN 붙여넣기 (소유자에게 받은 값)
```
기존 데이터를 이어받는다면 소유자에게 받은 `data/data.json`을 `data/` 아래에 넣으세요:
```bash
mkdir -p data
# 받은 data.json 을 ./data/data.json 로 복사
```

## 4) 실행
```bash
docker compose --profile tunnel up -d --build
docker compose logs -f recruit-board     # "listening on ..." 확인 (Ctrl+C 로 빠져나옴)
```
`jayden730.site` 접속해서 정상 동작 확인.

## 5) 재부팅 자동 복구
`systemctl enable docker` + compose의 `restart: unless-stopped` 조합으로 재부팅해도 자동 기동됩니다. 추가 설정 불필요.

---

## ⚠️ 중요: 터널은 한 곳에서만
같은 `TUNNEL_TOKEN`으로 **두 대 이상**이 동시에 `--profile tunnel`로 켜지면, 접속자마다
서로 다른 서버(서로 다른 데이터)로 갈려서 데이터가 꼬입니다.
**이 서버에서 켜기 전에, 기존에 돌던 PC/서버의 터널을 반드시 내려야 합니다:**
```bash
docker compose --profile tunnel down
```

## 자주 쓰는 명령
```bash
docker compose --profile tunnel up -d --build   # 코드 변경 후 재배포
docker compose logs -f recruit-board            # 로그 보기
docker compose --profile tunnel down            # 정지
docker compose restart recruit-board            # 재시작
```

## 백업
사용자 데이터는 전부 `data/data.json` 한 파일에 있습니다. 주기적으로 이 파일만 백업하면 됩니다.
```bash
cp data/data.json backups/data-$(date +%F).json
```
