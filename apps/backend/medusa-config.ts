// 실행 위치의 파일: ~/play-builder/commerce-api/apps/backend/medusa-config.ts
import { readFileSync } from "node:fs"
import { loadEnv, defineConfig, MedusaError } from "@medusajs/framework/utils"

loadEnv(process.env.NODE_ENV || "development", process.cwd())

const REDIS_URL = process.env.REDIS_URL!

// DB 의 TLS 는 DB_SSL 한 곳에서만 정한다. pg 는 연결 문자열의 sslmode · sslrootcert 를
// 드라이버 옵션 위에 덮어쓰므로, URL 에 그런 매개변수가 있으면 아래 ca 가 조용히 버려진다.
// 두 설정이 어긋난 채 뜨지 않도록 기동을 멈춘다.
if (/[?&](ssl|sslmode|sslrootcert|sslcert|sslkey|uselibpqcompat)=/i.test(process.env.DATABASE_URL || "")) {
  throw new MedusaError(
    MedusaError.Types.INVALID_DATA,
    "DATABASE_URL must not carry TLS parameters (sslmode, sslrootcert, ...). Use DB_SSL=true."
  )
}

// DB_SSL=true 면 CA 묶음으로 서버 인증서와 호스트 이름을 검증한다.
// 검증을 끄는 경로(rejectUnauthorized: false)는 두지 않는다.
const databaseSsl = (): false | { ca: string; rejectUnauthorized: true } => {
  if (process.env.DB_SSL !== "true") return false
  // 예: /opt/playbuilder/certs/rds-global-bundle.pem  (이미지의 ENV 가 준다)
  const caFile = process.env.DB_SSL_CA_FILE
  if (!caFile) {
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      "DB_SSL=true requires DB_SSL_CA_FILE (path to the CA bundle)."
    )
  }
  return { ca: readFileSync(caFile, "utf8"), rejectUnauthorized: true }
}

// 숫자로 읽히지 않는 값(빈 문자열 · 오타)이 NaN 으로 실리는 것을 막는다.
const num = (v: string | undefined, fallback: number): number =>
  v && Number.isFinite(Number(v)) ? Number(v) : fallback

const workerMode = (process.env.MEDUSA_WORKER_MODE || "shared") as
  | "shared"
  | "server"
  | "worker"

// S3_BUCKET 이 비어 있으면 파일 모듈을 싣지 않는다 (로컬 · CI 용).
const fileModule = process.env.S3_BUCKET
  ? [
      {
        resolve: "@medusajs/medusa/file",
        options: {
          providers: [
            {
              resolve: "@medusajs/medusa/file-s3",
              id: "s3",
              options: {
                // 예: https://media.dev.example.com  (필수 옵션)
                file_url: process.env.S3_FILE_URL,
                bucket: process.env.S3_BUCKET,
                region: process.env.AWS_REGION,
                prefix: process.env.S3_PREFIX || "media/",
                // 기본값 "access-key" 면 정적 키가 없어 기동이 멈춘다.
                // "s3-iam-role" 이면 AWS SDK 기본 자격 증명 체인 = Pod Identity.
                authentication_method: "s3-iam-role",
                // Object Ownership 이 BucketOwnerEnforced 인 버킷은 ACL 헤더를 거부한다.
                acl: false,
                cache_control: "public, max-age=31536000, immutable",
                download_file_duration: 3600,
              },
            },
          ],
        },
      },
    ]
  : []

module.exports = defineConfig({
  projectConfig: {
    databaseUrl: process.env.DATABASE_URL,
    databaseDriverOptions: {
      pool: {
        // 예: 복제본 최대 수 × max + 마이그레이션 Job + 사람 ≤ max_connections × 0.8
        min: num(process.env.DB_POOL_MIN, 2),
        max: num(process.env.DB_POOL_MAX, 10),
      },
      connection: {
        // 예: 로컬 Docker 는 평문(false), RDS 는 { ca, rejectUnauthorized: true }.
        ssl: databaseSsl(),
      },
    },
    // 세션 저장소용이며 아래 Redis 모듈들과는 별개다.
    redisUrl: REDIS_URL,
    workerMode,
    http: {
      storeCors: process.env.STORE_CORS!,
      adminCors: process.env.ADMIN_CORS!,
      authCors: process.env.AUTH_CORS!,
      jwtSecret: process.env.JWT_SECRET,
      cookieSecret: process.env.COOKIE_SECRET,
    },
  },
  admin: {
    path: "/app",
    // 이 값은 build 시점에 관리자 UI 번들로 구워진다(실행 시점 env 로는 바뀌지 않는다).
    // 이미지 build 단계는 값을 주지 않으므로 "/" — /app 이 자기를 내려 준 origin 의
    // /auth · /admin 을 부른다. 그래서 같은 digest 를 Dev · Prod 가 함께 쓴다.
    backendUrl: process.env.MEDUSA_BACKEND_URL || "/",
  },
  modules: [
    // 기본값은 모두 in-memory 이고 복제본이 2 이상이면 성립하지 않는다.
    {
      resolve: "@medusajs/medusa/event-bus-redis",
      options: { redisUrl: REDIS_URL },
    },
    {
      // 주의: 여기만 한 겹 더 깊다 (options.redis.redisUrl)
      resolve: "@medusajs/medusa/workflow-engine-redis",
      options: { redis: { redisUrl: REDIS_URL } },
    },
    {
      resolve: "@medusajs/medusa/cache-redis",
      options: { redisUrl: REDIS_URL },
    },
    {
      resolve: "@medusajs/medusa/locking",
      options: {
        providers: [
          {
            resolve: "@medusajs/medusa/locking-redis",
            id: "locking-redis",
            is_default: true,
            options: { redisUrl: REDIS_URL },
          },
        ],
      },
    },
    ...fileModule,
  ],
})
