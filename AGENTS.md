# AGENTS.md — oh-my-harness 프로젝트 가드레일

Codex, OpenCode, Claude Code, Pi를 위한 cross-runtime coding-agent harness. 기존 Pi 확장은 호환 surface로 유지한다.

## 프로젝트 구조

```
oh-my-harness/
├── .agents/plugins/            # Codex local marketplace manifest
├── .claude-plugin/             # Claude Code local marketplace manifest
├── .opencode/plugins/          # OpenCode native plugin entrypoint
├── omh                         # 사용자용 통합 관리 CLI launcher
├── bin/omh.mjs                 # preview-first CLI 구현
├── plugins/oh-my-harness/      # Codex/Claude plugin, 공용 skills, CLI MCP
├── harness/                    # contracts, adapters, profiles, locks, inventory
├── scripts/harness/            # 검증기와 preview-first fixed installer
├── scripts/tools/              # preview-first external CLI installer/doctor
├── extensions/
│   ├── env-loader/             # CWD .env 로더 (가장 먼저 로드)
│   ├── workspace-connectors/   # Linear/Notion MCP 커넥터
│   ├── workspace-cli-tools/    # Pi role-scoped external CLI tool pack
│   └── quotio-provider/        # Quotio LiteLLM proxy provider
├── docs/
│   ├── brainstorms/            # ce-brainstorm 결과물
│   ├── plans/                  # ce-plan 결과물
│   ├── ideation/               # ce-ideate 결과물
│   └── solutions/              # 문서화된 패턴/컨벤션 (category별, YAML frontmatter로 검색 가능)
├── CONCEPTS.md                 # 공유 도메인 어휘 (엔티티, 프로세스, 상태 개념)
├── package.json                # Pi/OpenCode 패키지 설정과 installer 명령
└── README.md
```

## 고정 설치 규칙

- `omh setup`, `omh agents install`, `omh tools install`은 항상 읽기 전용 preview이고 실제 변경은 `--apply`가 있을 때만 수행한다.
- runtime archive와 executable은 `harness/adapters/`의 reviewed SHA-256과 exact version에 모두 일치해야 한다.
- Compound Engineering은 trust receipt의 exact tag/commit/tree를 검증한 뒤 local snapshot으로만 등록한다.
- Codex는 `.agents/plugins/marketplace.json`, Claude Code는 `.claude-plugin/marketplace.json`, OpenCode는 `.opencode/plugins/*.js`, Pi는 `package.json#pi`를 native source로 사용한다.
- managed payload와 receipt는 기본적으로 `~/.oh-my-harness`에 두고 저장소에는 커밋하지 않는다.
- `npm run harness:install`, `npm run tools:install`, `npm run profile:*`는 기존 자동화를 위한 호환 wrapper로 유지한다. 사용자 문서의 canonical surface는 `omh`다.
- agent runtime/plugin은 에이전트별 선택 대상이지만 외부 CLI executable은 머신에 한 번 설치되어 `PATH`를 통해 공유된다는 scope를 CLI 출력과 문서에서 항상 구분한다.

## External CLI 도구 규칙

- 공통 allowlist와 실행 정책의 source of truth는 `plugins/oh-my-harness/mcp/cli-tools-core.mjs`다.
- Codex/Claude는 MCP, OpenCode는 native custom tools, Pi는 `workspace-cli-tools` extension으로 같은 13개 role/backend mapping을 노출한다.
- 외부 CLI 인증은 각 CLI가 소유한다. token, password, Authorization header를 도구 인자로 전달하거나 harness에 저장하지 않는다.
- 명령은 shell 없이 trusted `PATH`에서 실행하며 workspace-local executable shim과 interactive/browser flag를 거부한다.
- remote/local write로 분류된 명령은 정확한 변경에 대한 사용자 의도와 `confirmedWrite=true`가 모두 필요하다.

## 지식 저장소

- `docs/solutions/`는 과거 문제 해결, 버그, 패턴, 워크플로 지식을 category와 YAML frontmatter(`module`, `tags`, `problem_type`)로 검색할 수 있는 저장소다. 구현, 디버깅, 구조 결정 시 관련 영역의 선례를 찾는 데 유용하다.
- `CONCEPTS.md`는 프로젝트 고유 용어를 정의하는 공유 어휘집이다. connector, provider, profile, safety policy 같은 도메인 개념을 논의하거나 문서화할 때 참고한다.

## Extension 개발 규칙

- 진입점: `export default function(pi: ExtensionAPI)` 패턴
- 도구 등록: `pi.registerTool({ name, parameters: Type.Object(...), execute })`
- 커맨드 등록: `pi.registerCommand(name, { description, handler })`
- 프로바이더 등록: `pi.registerProvider(name, config)` — 실제 resolve된 값을 전달 (`$ENV_VAR` 리터럴은 동작하지 않음)
- 이벤트 훅: `pi.on("session_start", async (_event, ctx) => { ... })`
- 사용자 피드백: `ctx.ui.notify(message, "info" | "error")`
- **토글 패턴**: 각 익스텐션의 factory 최상단에서 `if (process.env.ENABLE_* !== "true") return;` 으로 opt-in 활성화

## 환경변수 관리

- CWD `.env`가 환경변수 소스 (패키지 루트 `.env`는 사용하지 않음)
- CWD `.env`의 값은 기존 `process.env`를 덮어씀 (override 모드)
- 토글 변수와 실제 값을 하나의 `.env`에서 관리
- `env-loader` 익스텐션이 가장 먼저 로드되어 다른 익스텐션보다 앞서 환경변수 세팅

## 커밋 금지 항목

- `.env` (API key, 프록시 URL, 토글 변수)
- `node_modules/`
- `~/.pi/agent/auth.json`
- `.mcp-auth/`

## 의존성

- `@earendil-works/pi-coding-agent` — Pi ExtensionAPI 타입
- `@modelcontextprotocol/sdk` — MCP 클라이언트 (workspace-connectors용)
- TypeScript ^6.0.3, Node.js ESM (`"type": "module"`)
