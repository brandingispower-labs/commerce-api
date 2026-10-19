# 로컬 실행 절차

전제: Node 22 이상 · pnpm(Corepack) · Docker Desktop 실행 중.

## 1. 의존성

    pnpm install

## 2. 데이터베이스 · Redis

    docker compose -f compose.local.yaml up -d
    docker compose -f compose.local.yaml ps

두 컨테이너가 `(healthy)` 가 될 때까지 기다립니다.

## 3. 환경 파일

    cd apps/backend
    cp .env.example .env

`.env` 에서 세 값을 채웁니다.

- `DATABASE_URL` 의 `CHANGE_ME` → `compose.local.yaml` 의 `POSTGRES_PASSWORD`(기본값 `medusa_local_password`)
- `JWT_SECRET` · `COOKIE_SECRET` → 각각 `openssl rand -hex 32` 결과

한 번에 하려면:

    cp .env.example .env
    sed -i.bak "s#postgres://medusa:CHANGE_ME@#postgres://medusa:medusa_local_password@#" .env
    sed -i.bak "s#^JWT_SECRET=.*#JWT_SECRET=$(openssl rand -hex 32)#" .env
    sed -i.bak "s#^COOKIE_SECRET=.*#COOKIE_SECRET=$(openssl rand -hex 32)#" .env
    rm -f .env.bak

`.env` 는 `.gitignore` 대상이라 커밋되지 않습니다.

## 4. 마이그레이션 + 시드

    cd ../..
    pnpm --filter @dtc/backend exec medusa db:migrate --execute-safe-links

시드(`src/migration-scripts/initial-data-seed.ts`)가 이때 1회 자동 실행되어 상품 4개 ·
지역 1개 · 판매 채널 · publishable key 를 만듭니다. 별도의 seed 명령은 없습니다.
`--execute-safe-links` 는 링크 마이그레이션까지 확인 없이 진행하게 합니다(비대화형).

## 5. 기동

    pnpm backend:dev

- 헬스: http://localhost:9000/health  (본문 `OK`)
- 관리자 UI: http://localhost:9000/app
- Store API: http://localhost:9000/store  (`x-publishable-api-key` 헤더 필수)

## 6. 관리자 계정

    pnpm --filter @dtc/backend exec medusa user -e admin@commerce.local -p <비밀번호>

## 7. publishable key

관리자 UI: Settings > Publishable API Keys > Default Publishable API Key
또는(테이블 · 컬럼 이름은 Medusa 버전에 따라 다를 수 있으므로, 실패하면 위의 관리자 UI 에서 봅니다):

    docker compose -f ../../compose.local.yaml exec -T postgres \
      psql -U medusa -d commerce -tAc "select token from api_key where type = 'publishable';"

## 8. 정리

4절에서 저장소 루트로 돌아왔으므로 그대로 실행합니다.

    docker compose -f compose.local.yaml down          # 컨테이너만 삭제(데이터 유지)
    docker compose -f compose.local.yaml down -v       # 볼륨까지 삭제(처음부터 다시)
