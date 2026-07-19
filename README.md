# oh-my-harness

Codex, OpenCode, Claude Code, Pi에 같은 Compound Engineering 자산과 안전 정책을 배포하기 위한 cross-runtime coding-agent harness입니다. 기존 Pi 확장은 v1 동안 호환 surface로 유지합니다.

## 현재 구현 범위

- U1: Compound Engineering upstream을 고정하는 trust receipt와 29개 skill inventory
- U2: runtime-neutral feature, profile, adapter, conformance contract
- U3: Codex, OpenCode, Claude Code, Pi의 정확한 버전과 플랫폼 acquisition descriptor

Native pre-model gate 실행, 실제 설치·업데이트 오케스트레이션, conformance runner는 후속 unit에서 구현합니다. 현재 descriptor가 존재한다는 사실만으로 native gate 또는 설치가 완료됐다고 보지 않습니다.

## 요구사항

- Node.js 22.19 이상
- npm
- Git
- Pi 호환 확장을 사용할 경우 Pi

## 빠른 시작

```bash
git clone https://github.com/zzanghyunmoo/oh-my-harness.git
cd oh-my-harness
npm ci
npm run profile:verify
npm run harness:descriptors:verify
npm run test:harness
npm run test:workspace-connectors
```

Descriptor 검증이 성공하면 `personal-v1` profile 기준으로 4개 runtime, 8개 runtime/platform tuple, 116개 expected conformance key와 canonical SHA-256을 출력합니다.

Pi 패키지만 설치하려면 다음 명령을 사용합니다.

```bash
pi install git:github.com/zzanghyunmoo/oh-my-harness
```

SSH 또는 private repository를 사용한다면:

```bash
pi install git:git@github.com:zzanghyunmoo/oh-my-harness
```

이전 `zzanghyunmoo/oh-my-pi` 설치는 위 source로 옮겨야 합니다. `/oh-my-pi`, `/oh-my-pi-doctor`, `omp:`, `OH_MY_PI_*` 호환 surface는 v1 동안 유지됩니다.

## 저장소 구성

- `harness/contracts`: runtime-neutral schema
- `harness/adapters`: 네 runtime의 immutable descriptor
- `harness/profiles`: 설치·검증 대상 tuple을 닫는 profile
- `harness/inventory`, `harness/locks`: 검토된 upstream inventory와 trust receipt
- `scripts/harness`: descriptor, acquisition, upstream 검증기
- `extensions/env-loader`: CWD `.env`를 가장 먼저 읽는 opt-in 환경 로더
- `extensions/workspace-connectors`: Linear/Notion MCP와 read-only GitHub/GitLab CLI bridge
- `extensions/quotio-provider`: OpenAI-compatible Quotio LiteLLM provider
- `extensions/setup-doctor`: read-only setup doctor와 command palette
- `docs/profiles`: commit-safe Pi compatibility profile pack

## Pi compatibility profile

커밋 가능한 설정 의도와 로컬 secret의 분리는 `docs/blueprints/secret-references.md`에 설명되어 있습니다. 적용 전에 deterministic lock을 검증합니다.

```bash
npm run profile:verify
npm run profile:apply -- --profile proxy-provider
npm run profile:apply -- --profile workspace
npm run profile:apply -- --profile full
```

`profile:apply`는 기본적으로 `pi install`을 실행하거나 `.env`와 settings를 수정하거나 OAuth를 시작하지 않습니다. 대신 선택한 profile에 필요한 안전한 checklist와 복사 가능한 `settings.json` package entry를 출력합니다.

그 다음 Pi 안에서 connector 노출 범위를 선택합니다.

```text
/connector-setup full
/connector-setup selective tenant:company capability:git
/connector-setup selective service:linear service:notion
/connector-setup minimal
```

## CWD `.env`

에이전트를 실행하는 작업 디렉터리의 `.env`가 환경변수 source입니다. 값은 기존 `process.env`를 덮어쓰며, 각 확장은 명시적으로 `true`인 토글만 활성화합니다.

```bash
ENABLE_QUOTIO=true
ENABLE_WORKSPACE_CONNECTORS=true

LINEAR_API_KEY=<local-linear-api-key>
NOTION_API_KEY=<local-notion-integration-token>
# 또는 NOTION_TOKEN=<local-notion-integration-token>

GITLAB_HOST=<company-gitlab-host>

QUOTIO_BASE_URL=<local-quotio-openai-compatible-base-url>
QUOTIO_API_KEY=<local-quotio-api-key>
```

OAuth token은 저장소 밖의 `~/.pi/agent/workspace-connectors-auth.json`에, connector setup state는 `~/.pi/agent/workspace-connectors-setup.json`에 저장됩니다. Browser OAuth를 쓸 수 없을 때만 CWD `.env`의 access key로 fallback합니다.

## 주요 명령

- `/oh-my-harness`: command palette와 setup 도움말
- `/oh-my-harness-doctor`: 환경, capability, provider, safety policy, CLI auth, 로컬 경로 점검
- `/connector-login linear|notion`: browser OAuth 시작
- `/connector-status [service]`: setup 및 auth 상태 확인
- `/connector-logout <selector> [--confirm]`: preview 후 Pi-managed OAuth state만 삭제
- `/connector-tools linear|notion`: 준비된 connector tool 목록
- `/quotio-status`: Quotio 연결과 인증 상태 확인

GitHub와 GitLab은 각각 인증된 `gh`, `glab` 실행파일을 fail-closed read-only allowlist로 사용합니다. oh-my-harness는 GitLab token을 저장하지 않습니다. Jira와 Confluence는 setup에서 보이지만 non-interactive Atlassian auth 경로가 정해질 때까지 runtime tool은 닫혀 있습니다.

## 커밋하지 않을 항목

- `.env`와 API key 또는 token
- `node_modules/`
- `~/.pi/agent/auth.json`
- `.mcp-auth/`
- `~/.pi/agent/workspace-connectors-auth.json`
- `~/.pi/agent/workspace-connectors-setup.json`
- `~/.pi/agent/sessions/`
