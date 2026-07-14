# 모집 게시판 — 단일 컨테이너 (Node.js 표준 라이브러리만 사용, npm install 불필요)
FROM node:20-alpine

WORKDIR /app

# 앱 파일 복사 (.dockerignore가 데이터/불필요 파일 제외)
COPY . .

# 데이터 디렉터리 (docker-compose에서 볼륨으로 마운트해 영속화)
RUN mkdir -p /app/data

EXPOSE 8931

CMD ["node", "server.js"]
