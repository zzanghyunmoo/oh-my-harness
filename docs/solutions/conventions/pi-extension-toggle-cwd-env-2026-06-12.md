---
title: "Pi 익스텐션 환경변수 opt-in 토글 및 CWD .env 로딩 패턴"
module: oh-my-pi
date: 2026-06-12
problem_type: convention
component: tooling
severity: medium
applies_when:
  - "Pi 패키지에서 익스텐션을 선택적으로 활성화/비활성화하고 싶을 때"
  - "프로젝트별 환경변수를 에이전트 실행 디렉토리에서 관리하고 싶을 때"
  - "여러 익스텐션의 초기화 순서를 보장해야 할 때"
tags:
  - pi-extension
  - env-loader
  - opt-in-toggle
  - environment-variables
  - loading-order
---

# Pi 익스텐션 환경변수 opt-in 토글 및 CWD .env 로딩 패턴

## Context

Pi 패키지 시스템은 `package.json`의 `pi.extensions` 배열에 선언된 익스텐션을 모두 자동 로드한다. 특정 환경에서 불필요한 익스텐션이 에러를 발생시키거나 리소스를 소모해도 끌 방법이 없었고, 환경변수를 패키지 루트나 `.zshrc`에서만 관리해야 하는 제약이 있었다.

## Guidance

### 1. env-loader 익스텐션으로 CWD .env 선행 로딩

별도 `env-loader` 익스텐션을 만들어 `pi.extensions` 배열의 **첫 번째**에 배치한다. Pi는 배열 순서대로 익스텐션을 로드하며, async factory를 await한 후 다음으로 넘어가므로 로딩 순서가 보장된다.

```typescript
// extensions/env-loader/index.ts
export default function (pi: ExtensionAPI) {
  const envPath = resolve(process.cwd(), ".env");
  // 파싱 후 process.env에 override 방식으로 반영
  // CWD에 .env가 없으면 무시 (에러 없이 진행)
}
```

```json
// package.json
{
  "pi": {
    "extensions": [
      "./extensions/env-loader",
      "./extensions/quotio-provider",
      "./extensions/workspace-connectors"
    ]
  }
}
```

### 2. 각 익스텐션 factory 진입부에서 토글 체크

`export default function` 최상단에서 환경변수를 확인하고, `true`가 아니면 early-return한다. 모듈 자체는 Pi에 의해 로드되지만, 도구/커맨드/프로바이더 등록이 발생하지 않는다.

```typescript
export default function (pi: ExtensionAPI) {
  if (process.env.ENABLE_QUOTIO !== "true") return;
  // 이하 등록 로직
}
```

### 3. 비활성화 알림

env-loader의 `session_start` 핸들러에서 토글 미설정 익스텐션 목록을 사용자에게 알려 마이그레이션 혼란을 방지한다.

## Why This Matters

- **Opt-in 방식**: 새 익스텐션이 추가되어도 기존 환경에 자동으로 영향을 주지 않음
- **단일 소스**: CWD `.env` 하나로 토글과 API key를 통합 관리
- **순서 보장**: Pi의 배열 순서 + await 매커니즘으로 환경변수가 다른 익스텐션보다 먼저 세팅됨
- **Override 모드**: CWD `.env`가 기존 `process.env`를 덮어쓰므로 프로젝트별 값 격리 가능

## When to Apply

- Pi 패키지에 2개 이상 익스텐션이 있고 환경에 따라 선택적으로 사용할 때
- 에이전트가 여러 프로젝트 디렉토리에서 실행되며 프로젝트별 환경변수가 필요할 때
- 익스텐션 간 초기화 순서 의존성이 있을 때 (예: 환경변수 → 프로바이더 등록)

## Examples

CWD `.env` 예시:

```bash
# 익스텐션 토글
ENABLE_QUOTIO=true
ENABLE_WORKSPACE_CONNECTORS=true

# 실제 값
QUOTIO_BASE_URL=http://127.0.0.1:8317/v1
QUOTIO_API_KEY=your-key
```

CWD에 `.env`가 없고 `.zshrc`에만 `ENABLE_QUOTIO=true`가 있는 경우에도 정상 동작한다.
