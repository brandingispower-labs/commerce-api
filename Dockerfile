# syntax=docker/dockerfile:1
# commerce-api — Medusa v2 백엔드 이미지
# 단계: rds-ca(RDS CA 묶음 받기 · 해시 확인) → build(워크스페이스 설치 → medusa build → .medusa/server 에 운영 의존성 설치) → runner

# RDS 서버 인증서를 검증할 CA 묶음. 출처와 확인 방식은 운영자 이미지
# (cloud-platform-infrastructure 의 tools/database-operator/install-rds-ca.sh)와 같다 —
# 공식 URL 에서 받고, 적어 둔 SHA-256 과 다르면 빌드를 멈춘다.
# AWS 가 묶음을 갱신하면 여기서 멈춘다. 그때는 새 해시를 직접 확인한 뒤 아래 값을 바꾼다:
#   curl -fsSLo global-bundle.pem "$RDS_CA_BUNDLE_URL" && sha256sum global-bundle.pem
FROM node:22-alpine AS rds-ca
ARG RDS_CA_BUNDLE_URL=https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem
ARG RDS_CA_BUNDLE_SHA256=e5bb2084ccf45087bda1c9bffdea0eb15ee67f0b91646106e466714f9de3c7e3
RUN mkdir -p /certs \
 && wget -qO /certs/rds-global-bundle.pem "$RDS_CA_BUNDLE_URL" \
 && printf '%s  /certs/rds-global-bundle.pem\n' "$RDS_CA_BUNDLE_SHA256" | sha256sum -c - \
 && [ "$(grep -c 'BEGIN CERTIFICATE' /certs/rds-global-bundle.pem)" -ge 10 ] \
 && chmod 0444 /certs/rds-global-bundle.pem

FROM node:22-alpine AS build
WORKDIR /repo
RUN corepack enable
# 매니페스트만 먼저 넣어 의존성 레이어를 소스 변경과 분리한다.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY apps/backend/package.json ./apps/backend/package.json
RUN pnpm install --frozen-lockfile
COPY . .
# medusa build 는 medusa-config.ts 를 읽는다. 그 파일은 모듈 스코프에서
# REDIS_URL 까지 읽으므로 더미 값을 함께 준다. ENV 가 아니라 이 RUN 한 줄의 환경으로만 주므로
# 이미지 메타데이터에 남지 않고(빌더 경고 SecretsUsedInArgOrEnv 도 없다), 실제 값은 실행 시점에 주입한다.
# MEDUSA_BACKEND_URL 은 일부러 주지 않는다. 관리자 UI 번들은 이 시점에 백엔드 주소를 굽는데,
# 값이 없으면 medusa-config.ts 가 "/" 를 넣어 /app 이 자기를 내려 준 origin 으로 요청한다.
# 환경별 주소를 여기서 구우면 같은 digest 를 Dev · Prod 가 함께 쓸 수 없다.
RUN DATABASE_URL=postgres://build:build@127.0.0.1:5432/build \
    REDIS_URL=redis://127.0.0.1:6379 \
    JWT_SECRET=build-only \
    COOKIE_SECRET=build-only \
    STORE_CORS=http://localhost:3000 \
    ADMIN_CORS=http://localhost:9000 \
    AUTH_CORS=http://localhost:9000 \
    pnpm --filter @dtc/backend build
# .medusa/server 는 pnpm-workspace.yaml 이 "!apps/backend/.medusa/**" 로 제외한
# 디렉터리다. 그대로 pnpm install 을 하면 pnpm 이 위로 올라가 /repo 를 워크스페이스
# 루트로 잡고 거기에 설치해 버려서, .medusa/server/node_modules 가 만들어지지 않는다.
# --ignore-workspace 로 이 디렉터리만의 설치로 못 박는다.
# 루트 lockfile 과 .npmrc 를 함께 넣어 해석 결과를 최대한 재사용한다
# (importer 가 달라 --frozen-lockfile 은 쓸 수 없다).
RUN cp pnpm-lock.yaml .npmrc apps/backend/.medusa/server/ \
 && cd apps/backend/.medusa/server \
 && pnpm install --prod --ignore-workspace
# medusa db:migrate 는 모듈마다 <패키지>/dist/migrations 가 있는지 보고, 없으면 만든다.
# 마이그레이션이 없는 모듈(Redis 모듈 · file · locking 등)은 패키지에 그 디렉터리가 없어서,
# 읽기 전용 루트 파일 시스템으로 도는 마이그레이션 Job 이 mkdir 에서 실패한다.
# 빈 디렉터리를 이미지에 미리 만들어 둔다 (쓰기 가능한 환경에서 medusa 가 만드는 것과 같은 결과).
RUN cd apps/backend/.medusa/server \
 && for d in node_modules/.pnpm/@medusajs+*/node_modules/@medusajs/*/dist; do mkdir -p "$d/migrations"; done

FROM node:22-alpine AS runner
WORKDIR /app
# DB_SSL_CA_FILE: DB_SSL=true 일 때 medusa-config.ts 가 읽는 CA 묶음의 경로. medusa start 와
#   마이그레이션 Job(같은 이미지의 medusa db:migrate)이 함께 쓴다.
# XDG_CONFIG_HOME: medusa CLI 는 뜨자마자 설정 저장소(configstore)를 $XDG_CONFIG_HOME/medusa 에
#   만든다. 기본 자리는 ~/.config 인데 읽기 전용 루트 파일 시스템에서는 만들 수 없어 start 도
#   db:migrate 도 첫 줄에서 죽는다. 배포가 쓰기 경로로 주는 /tmp 아래로 옮긴다.
ENV NODE_ENV=production \
    PORT=9000 \
    DB_SSL_CA_FILE=/opt/playbuilder/certs/rds-global-bundle.pem \
    XDG_CONFIG_HOME=/tmp/.config
RUN addgroup -S -g 10001 app && adduser -S -u 10001 -G app app
COPY --from=rds-ca /certs/rds-global-bundle.pem /opt/playbuilder/certs/rds-global-bundle.pem
# .medusa/server 안에 서버 · 관리자 UI(public/admin) · node_modules 가 모두 들어 있다.
COPY --from=build --chown=10001:10001 /repo/apps/backend/.medusa/server ./
USER 10001:10001
EXPOSE 9000
# medusa 는 @medusajs/cli 가 설치한 로컬 실행 파일이다. medusa start 는 NODE_ENV 를 production 으로 둔다.
CMD ["./node_modules/.bin/medusa", "start"]
