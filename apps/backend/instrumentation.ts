// 실행 위치의 파일: ~/play-builder/commerce-api/apps/backend/instrumentation.ts
// Medusa 는 프로젝트 루트의 이 파일을 기동 때 읽고 register() 를 부른다.
import { registerOtel } from "@medusajs/medusa"
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-grpc"

// 수집 게이트웨이가 없는 환경(로컬 · CI · 첫 배포 전)에서도 앱은 그대로 떠야 한다.
// 그래서 주소가 비어 있으면 registerOtel 을 아예 부르지 않는다.
export function register() {
  const endpoint = process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT
  const serviceName = process.env.OTEL_SERVICE_NAME || "commerce-api"

  if (!endpoint) {
    console.log(
      JSON.stringify({
        level: "info",
        message: "otel disabled: OTEL_EXPORTER_OTLP_TRACES_ENDPOINT is empty",
        service: serviceName,
      })
    )
    return
  }

  try {
    // 예: http://collection-gateway.observability.svc.cluster.local:4317
    const exporter = new OTLPTraceExporter({ url: endpoint })

    registerOtel({
      serviceName,
      exporter,
      instrument: {
        http: true,       // 예: 들어오는 HTTP 요청 · 나가는 fetch 의 server · client span
        query: true,      // 예: Medusa Query(모듈 간 조회)의 span
        workflows: true,  // 예: 워크플로 스텝 하나가 span 하나
        db: true,         // 예: PostgreSQL 질의 구간 span
      },
    })
  } catch (err) {
    // 등록이 실패해도 상거래 요청 처리는 계속되어야 한다.
    console.log(
      JSON.stringify({
        level: "error",
        message: "otel register failed",
        service: serviceName,
        error: err instanceof Error ? err.message : String(err),
      })
    )
  }
}
