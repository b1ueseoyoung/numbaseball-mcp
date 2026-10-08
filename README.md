# numbaseball-mcp: 숫자야구 MCP 서버 실습

A Korean "number baseball" (Bulls and Cows) game served as an MCP server, built with Bun and the MCP TypeScript SDK v2 as a learning exercise.

숫자야구(상대가 정한 서로 다른 숫자 3~4자리를 스트라이크·볼 힌트로 맞히는 게임)를 MCP 서버로 만든 실습입니다. Claude Code 같은 MCP 호스트가 이 서버에 붙으면, 모델이 tool을 불러 게임을 시작하고 추측하며 끝까지 둡니다. 서버는 상태(대기 중 / 게임 중)에 따라 보여 주는 tool과 resource를 바꾸고, 설정이 빠져 있으면 사용자에게 입력 창(elicitation)을 띄워 묻습니다.

**데모 영상:** [numbaseball-demo.mp4 (2분 3초)](https://github.com/b1ueseoyoung/numbaseball-mcp/releases/download/v0.1.0/numbaseball-demo.mp4) — Claude Code(Sonnet)가 `/mcp__numbaseball__new_game`을 인자 없이 실행하자 서버가 입력 창으로 자릿수·난이도를 묻고(3자리, easy), Claude가 7번 만에 맞힙니다. [v0.1.0 릴리스](https://github.com/b1ueseoyoung/numbaseball-mcp/releases/tag/v0.1.0)에 첨부돼 있습니다.

## 차례

- [이 실습에서 배우는 것](#이-실습에서-배우는-것)
- [MCP를 짧게](#mcp를-짧게)
- [기능](#기능)
- [요구 사항](#요구-사항)
- [설치, 실행, 테스트, 타입 검사](#설치-실행-테스트-타입-검사)
- [Inspector로 확인하기](#inspector로-확인하기)
- [Claude Code에서 한 판 두기](#claude-code에서-한-판-두기)
- [프로젝트 구조](#프로젝트-구조)
- [단계별로 만든 것](#단계별로-만든-것)
- [알아 두면 좋은 것](#알아-두면-좋은-것)
- [출처와 라이선스](#출처와-라이선스)
- [알려진 한계](#알려진-한계)

표기: **[확인됨]** 이 프로젝트를 만들면서 실제로 실행해 본 것, **[문서 기준]** 공식 문서에만 근거한 것, **[미확인]** 아직 실행해 보지 않은 것(Claude Code 항목은 아래 사용자 확인 대상).

## 이 실습에서 배우는 것

공개 MCP 서버 하나(1~100 사이 숫자 맞히기, 아래 [출처](#출처와-라이선스))를 SDK v2로 다시 만들어 보고, 그것을 숫자야구로 바꾸면서 MCP 서버 기능을 하나씩 익힙니다.

| 개념 | 어디서 |
|---|---|
| stdio 전송과 `serveStdio` 팩토리: 연결 하나 = 프로세스 하나 = 서버 인스턴스 하나라서 클로저에 둔 상태가 유지된다 | `src/server.ts` 뀝의 `import.meta.main` 블록, `test/helpers.ts` |
| 프로토콜 협상: modern(2026-07-28)과 legacy(2025-11-25) 두 시대를 같은 서버가 받는다 | `test/helpers.ts`, `wire/` 기록 |
| 상태별 tool 켜고 끄기와 `tools/list_changed` 알림 | `src/server.ts`의 `transitionTo` |
| `RegisteredTool.update`로 tool 설명과 입력 스키마를 게임 중에 바꾸기 | `src/server.ts`의 `record` |
| `outputSchema`와 `structuredContent`, 그리고 `isError` 결과와 프로토콜 에러의 차이 | 세 tool의 정의와 `test/server.test.ts` |
| 리소스 세 종류: 고정 URI, 상태에 따라 보이는 리소스, `ResourceTemplate`과 `list` 콜백 | `src/server.ts`의 `registerResource` |
| prompt: 호스트의 `/` 메뉴에 노출되는 메시지 틀 | `src/server.ts`의 `registerPrompt` |
| elicitation(form): 서버가 사용자에게 설정을 묻고, 답을 받아 같은 핸들러가 다시 실행된다 | `start_game` 핸들러 |
| 검증 세 겹: 한 프로세스 안의 통합 테스트, Inspector CLI, Claude Code | `test/`, `package.json`의 `inspect` 스크립트, `.mcp.json` |

순수 게임 로직(`src/game/`)은 MCP와 분리해 단위 테스트로 고정했습니다. 통합 테스트는 모두 두 시대(modern·legacy)로 돌립니다.

## MCP를 짧게

MCP(Model Context Protocol)는 AI 애플리케이션이 외부 프로그램과 JSON-RPC 메시지로 대화하는 규약입니다. 역할은 셋입니다.

- **호스트(host):** Claude Code, Claude Desktop처럼 모델을 돌리는 애플리케이션입니다. 사용자와 대화하고, 어떤 서버를 붙일지 정합니다.
- **클라이언트(client):** 호스트 안에서 서버 하나와 1:1로 연결을 유지하는 부분입니다. 서버에 요청을 보내고 알림을 받습니다.
- **서버(server):** 이 저장소가 만드는 쪽입니다. 모델이 쓸 수 있는 기능을 내놓습니다. 이 실습의 서버는 표준 입출력(stdio)으로 호스트와 대화하므로 호스트가 자식 프로세스로 띄웁니다.

서버가 내놓는 것은 다음과 같습니다.

- **tool:** 모델이 호출하는 함수입니다. 이름, 설명, 입력 스키마(JSON Schema)를 보고 모델이 고릅니다. 결과는 사람이 읽는 `content`와, 선택적으로 `outputSchema`에 맞춘 `structuredContent`로 돌려줍니다.
- **resource:** URI로 읽는 데이터입니다. 규칙 문서나 현재 게임 상태처럼 "호출"이 아니라 "읽기"가 어울리는 것을 둡니다. 변수가 든 URI 틀(`numbaseball://games/{gameId}`)은 resource template이라고 합니다.
- **prompt:** 사용자가 고르는 메시지 틀입니다. 호스트의 슬래시 메뉴 같은 곳에 노출되고, 고르면 서버가 만든 메시지가 대화에 들어갑니다.
- **elicitation:** 서버가 사용자에게 입력을 요청하는 방법입니다. 서버가 "이 형식의 값을 달라"고 스키마와 함께 요청하면 호스트가 입력 창을 띄우고, 사용자가 채운 값(또는 거절)을 서버에 돌려줍니다.

서버는 tool·resource 목록이 바뀌면 `list_changed` 알림을 보내고, 클라이언트는 목록을 다시 가져옵니다. 이 서버는 게임 상태가 바뀔 때마다 이 알림을 보냅니다.

## 기능

### numbaseball 서버 (`src/server.ts`)

서버 상태는 `LOBBY`(대기)와 `PLAYING`(게임 중) 둘뿐이고, 전이는 동기 함수 `transitionTo` 한 곳에서만 일어납니다.

**tool 세 개. 상태에 맞는 것만 켜져 있습니다.**

| tool | LOBBY | PLAYING | 하는 일 |
|---|---|---|---|
| `start_game` | O | X | 자릿수(3·4)와 난이도(easy·normal·hard)를 받아 새 게임을 시작하고 `gameId`(`g1`, `g2`, …)를 발급 |
| `guess` | X | O | 숫자 문자열 하나를 추측. 결과는 `nS mB` 또는 아웃 |
| `give_up` | X | O | 게임을 포기하고 정답을 봄 |

난이도별 최대 기회(`src/game/rules.ts`의 `MAX_ATTEMPTS`):

| 자릿수 | easy | normal | hard |
|---|---|---|---|
| 3 | 12 | 9 | 7 |
| 4 | 15 | 11 | 8 |

- 상태가 바뀔 때 tool을 켜고 끄며, 그때마다 서버가 `notifications/tools/list_changed`를 보냅니다. 꺼진 tool을 부르면 SDK가 핸들러 전에 `-32602 Tool … disabled` 프로토콜 에러로 거절합니다.
- `guess`의 설명과 입력 스키마는 게임 중에 계속 바뀝니다. 설명은 `3자리 숫자를 추측한다. 0~9, 자리끼리 중복 없음, 0으로 시작 가능. 남은 기회 9번.`처럼 자릿수와 남은 기회를 담고, 스키마는 `guess: string` 길이를 정확히 N으로 제한합니다. 추측할 때마다 `guessTool.update(...)`로 갱신하고, 이것도 `tools/list_changed`를 보냅니다.
- 세 tool 모두 `outputSchema`가 있습니다. 성공 결과는 한국어 한 줄(`content`)과 스키마에 맞는 `structuredContent`를 함께 돌려줍니다. 예를 들어 `guess`는 `{ gameId, guess, strikes, balls, out, attempts, attemptsLeft, status, answer }`를 주고, `answer`는 게임이 끝났을 때(WON·LOST)만 값이 있습니다.
- 규칙 위반(숫자가 아님, 같은 숫자 반복, 이미 한 추측)은 `isError: true`와 한국어 설명으로 돌려주고 `structuredContent`는 없습니다. 기회를 차감하지 않고 상태도 그대로입니다. 입력 스키마 위반(길이가 틀린 `12` 등)은 SDK가 `Input validation error: …`라는 `isError` 결과로 바꿉니다.

**resource 세 개.**

| URI | mimeType | 보이는 때 | 내용 |
|---|---|---|---|
| `numbaseball://rules` | `text/markdown` | 항상 | 규칙 1~10과 난이도별 최대 기회 표(`src/game/rules.ts`) |
| `numbaseball://current` | `application/json` | PLAYING | `{ gameId, digits, difficulty, attempts, attemptsLeft, history }`. 정답 없음 |
| `numbaseball://games/{gameId}` (template) | `application/json` | 항상 | 위 내용에 `status`를 더한 게임 기록. 끝난 게임(WON·LOST·GAVE_UP)만 `answer` 포함 |

- `current`는 한 번 등록해 두고 `enable()`/`disable()`로 켜고 끕니다. 꺼져 있을 때 읽으면 `-32602 … disabled` 프로토콜 에러입니다. 토글마다 `notifications/resources/list_changed`가 나갑니다.
- template의 `list` 콜백이 이 연결에서 만든 게임(`game g1`, `game g2`, …)을 `resources/list`에 넣어 줍니다. 없는 ID를 읽으면 `ResourceNotFoundError`를 던지고, 클라이언트는 `-32602 … not found` 프로토콜 에러를 받습니다.
- 진행 중인 게임의 정답은 tool 설명, 결과, 리소스, 로그 어디에도 넣지 않습니다. 끝난 게임의 `answer`만 예외입니다.

**prompt 하나: `new_game`.** 인자는 `digits`(`'3'` | `'4'`)와 `difficulty`(`'easy'` | `'normal'` | `'hard'`)이고 둘 다 선택입니다. 프로토콜상 prompt 인자는 항상 문자열이라 `z.enum(['3', '4'])`로 받습니다. 결과는 user 메시지 하나로, "start_game을 호출해 시작하고, guess로 하나씩 추측하고, 매번 후보를 좁힌 근거를 말하고, 끝날 때까지 계속해"라는 네 줄짜리 지시입니다. 인자를 비우면 "인자 없이 호출해(서버가 나에게 물어본다)"라고 적습니다.

**elicitation(form).** `start_game`에 `digits`나 `difficulty`가 빠져 있으면 서버가 빠진 항목만 담은 form을 사용자에게 요청합니다(`자릿수와 난이도를 고르세요` / `자릿수를 고르세요` / `난이도를 고르세요`). 사용자가 채우면 같은 핸들러가 답과 함께 다시 실행되어 그때 게임을 시작합니다. 거절·취소하면 `게임을 시작하지 않았다(설정 입력을 취소했다).`라는 `isError` 결과를 주고 LOBBY에 머물며 `gameId`도 쓰지 않습니다. 형식에 맞지 않는 답은 다시 묻지 않고 `isError`로 끝냅니다. 인자를 둘 다 주면 묻지 않습니다.

**두 프로토콜 시대를 모두 받습니다.**

- **modern(2026-07-28):** `initialize` 핸드셰이크가 없고 클라이언트가 `server/discover`를 부릅니다. 알림은 클라이언트가 `subscriptions/listen` 스트림을 열어야 받습니다. elicitation은 MRTR(multi-round-trip: 한 번의 tool 호출을 여러 번 주고받아 끝내는 방식)입니다. 서버가 `input_required` 결과를 돌려주면 클라이언트가 같은 요청에 `inputResponses`를 담아 다시 보냅니다.
- **legacy(2025-11-25):** `initialize`로 시작하고 알림은 바로 밀어 줍니다. elicitation은 SDK가 서버→클라이언트 `elicitation/create` 요청으로 바꿔 보냅니다.
- 서버 코드는 두 시대를 구분하지 않습니다. SDK가 처리합니다. 통합 테스트는 `describe.each`로 두 시대를 모두 돌립니다.

### ngg 서버 (`src/ngg/server.ts`)

1단계에서 원본 프로젝트(1~100 숫자 맞히기)를 SDK v2로 다시 만든 것입니다. numbaseball과 같은 틀(상태별 tool on/off, 동기 `transitionTo`, 동적 스키마, 리소스 토글)을 먼저 작은 게임으로 연습한 결과물입니다.

- tool: `start_game { playerName }`, `guess_number { guess: 1~100 정수 }`, `give_up {}`. 기회는 10번입니다.
- `guess_number`의 `guess` 파라미터 범위와 설명이 추측마다 좁혀집니다. 예: `Your guess (51-100). 9 attempts left.`
- resource: `mcp://number-guessing-game/highscores`(이 연결의 승리 기록), `.../rules`, `.../game_state`(게임 중에만, 비밀 수 없음).
- 응답 문구(`Too low! 9 attempts left.` 등)는 원본에서 그대로 가져왔고 `src/ngg/messages.ts`에 모아 두었습니다. 그 밖의 코드는 새로 썼습니다.

## 요구 사항

- **Bun 1.4 이상.** 이 저장소는 Bun 1.4.2로 만들고 확인했습니다. 패키지 설치, 실행, 테스트 모두 bun만 씁니다(npm·npx·yarn을 쓰지 않습니다).
- **Node.js 24 이상(Inspector를 쓸 때만).** MCP Inspector 2.9.0의 실행 파일은 Node 스크립트(`#!/usr/bin/env node`)입니다. Inspector 자체의 최소 요구(`package.json`의 `engines`)는 `node >= 22.19.0`이지만, 이 저장소는 Node.js 24 이상을 기준으로 하고 Node.js 26으로 확인했습니다.
- **Claude Code(선택).** 마지막 단계에서 실제 호스트로 한 판 둘 때만 필요합니다. 없어도 테스트와 Inspector 확인은 전부 됩니다.
- 고정한 의존성: `@modelcontextprotocol/server` 2.3.1, `@modelcontextprotocol/client` 2.3.1(테스트용), `zod` 4.6.5, MCP Inspector 2.9.0.

## 설치, 실행, 테스트, 타입 검사

```sh
bun install          # 의존성 설치 (bun.lock 그대로)
bun run start        # 서버 실행 = bun src/server.ts
bun run test         # 단위 + 통합 테스트 (modern·legacy 두 시대)
bun run typecheck    # tsc --noEmit
```

- 서버는 stdio로 대화하므로 `bun run start`만 치면 아무것도 안 하는 것처럼 보입니다. stderr에 `numbaseball ready on stdio` 한 줄을 찍고 클라이언트의 입력을 기다리는 중입니다. 종료는 Ctrl+C 또는 stdin을 닫으면 됩니다. `bun src/server.ts </dev/null`처럼 stdin을 바로 닫으면 곧바로 끝나고 exit 0입니다.
- 로그는 모두 stderr로만 나갑니다. stdout은 프로토콜 전용이라 서버 코드에 `console.log`가 없습니다.
- ngg 서버는 `bun src/ngg/server.ts`로 띄웁니다.
- 테스트는 `bun:test`입니다. 통합 테스트는 `InMemoryTransport`로 한 프로세스 안에서 서버와 클라이언트를 잇고, `test/helpers.ts`의 `connectModern`/`connectLegacy`가 시대를 정합니다. 알림 테스트는 고정 대기 대신 알림 수를 세는 `createCounter`로 기다립니다.

## Inspector로 확인하기

[MCP Inspector](https://modelcontextprotocol.io/docs/2026-07-28/tools/inspector.md)는 서버를 직접 두드려 보는 공식 도구입니다. 웹 화면과 CLI가 있습니다.

### 웹 화면

```sh
HOME=${TMPDIR:-/tmp}/numbaseball-inspector-home bunx @modelcontextprotocol/inspector@2.9.0 bun src/server.ts
```

브라우저 화면이 열리고 tool 호출, 리소스 읽기, prompt 보기를 클릭으로 할 수 있습니다 [문서 기준]. 이 저장소의 검증은 아래 CLI로만 했습니다.

### CLI

`package.json`의 `inspect`(numbaseball)와 `inspect:ngg`(ngg) 스크립트가 Inspector CLI를 감쌉니다. 뒤에 붙인 인자는 그대로 Inspector에 전달됩니다. `--protocol-era`는 `modern` 또는 `legacy`이고, 아래 예는 모두 두 시대에서 같은 내용을 돌려줍니다. 차이는 modern의 tools/call·resources/read·prompts/get 응답에 `_meta.io.modelcontextprotocol/serverInfo`가 더 붙는 것, modern의 resources/read 응답에 캐시 힌트 `ttlMs: 0`과 `cacheScope: "private"`가 더 붙는 것, 그리고 스키마 JSON에서 `$schema` 키의 위치뿐입니다.

```sh
# tool 목록. LOBBY라 start_game 하나만 보인다
bun run inspect --protocol-era modern --format json --method tools/list

# 인자를 다 주고 게임 시작. content와 structuredContent가 함께 온다
bun run inspect --protocol-era modern --format json --method tools/call --tool-name start_game --tool-args-json '{"digits":3,"difficulty":"normal"}'

# 리소스 목록(LOBBY라 rules만), 템플릿 목록, 규칙 읽기
bun run inspect --protocol-era modern --format json --method resources/list
bun run inspect --protocol-era modern --format json --method resources/templates/list
bun run inspect --protocol-era modern --format json --method resources/read --uri numbaseball://rules

# prompt 목록과 prompt 본문
bun run inspect --protocol-era modern --format json --method prompts/list
bun run inspect --protocol-era modern --format json --method prompts/get --prompt-name new_game --prompt-args digits=3 difficulty=normal

# ngg 서버
bun run inspect:ngg --protocol-era modern --format json --method tools/list
bun run inspect:ngg --protocol-era modern --format json --method tools/call --tool-name start_game --tool-args-json '{"playerName":"Ann"}'
```

- Inspector CLI는 호출마다 서버 프로세스를 새로 띄웁니다. 그래서 `tools/call start_game` 다음에 `tools/list`를 쳐도 LOBBY 목록이 보입니다. PLAYING 상태에서만 보이는 것(`guess`·`give_up`, `current`, 바뀐 `guess` 설명)은 테스트로 확인합니다.
- 인자 값의 타입을 정확히 넘기려면 `--tool-args-json`을 씁니다.
- 첫 실행은 Inspector를 내려받느라 네트워크가 필요합니다.

### 왜 `HOME`을 임시 폴더로 바꾸는가

`inspect` 스크립트는 `HOME=${TMPDIR:-/tmp}/numbaseball-inspector-home`을 앞에 붙입니다. Inspector는 서버 설정과 비밀값을 홈 폴더 아래 `~/.mcp-inspector/`(`mcp.json`, `secrets.json`, `storage/`)에 저장하도록 되어 있어서, 실습 도구가 실제 홈 폴더에 흔적을 남기지 않도록 임시 폴더를 홈으로 줍니다. `HOME`을 바꾸면 bunx 캐시도 그 아래로 가므로 Inspector 패키지는 그 폴더에 따로 내려받습니다. CLI만 쓴 이 저장소의 검증에서는 임시 홈에 bunx 캐시(`.bun`)와 `Library`만 생겼고 `.mcp-inspector`는 생기지 않았습니다. 지우고 싶으면 그 임시 폴더만 지우면 됩니다.

### 인자 없는 `start_game`이 CLI에서 실패하는 이유

```sh
bun run inspect --protocol-era modern --format json --method tools/call --tool-name start_game --tool-args-json '{}'
bun run inspect --protocol-era legacy --format json --method tools/call --tool-name start_game --tool-args-json '{}'
```

인자를 비우면 서버가 form elicitation을 요청하는데, Inspector CLI는 elicitation capability를 선언하지 않아서 답할 수 없습니다. 시대마다 실패 모양이 다릅니다.

- **modern:** 프로토콜 에러. `{"error":{"code":"error","message":"Cannot request input 'settings' (elicitation/create): the request's client capabilities do not declare the required capability"}}`가 찍히고 Inspector가 exit 1로 끝납니다.
- **legacy:** 정상 결과 안의 `isError: true`. 본문은 `… the client on this 2025-era connection did not declare the required capability`이고, Inspector는 `tool_is_error`를 보고 exit 5로 끝납니다.

CLI에서 게임을 시작하려면 위처럼 인자를 둘 다 주면 됩니다. form이 실제로 뜨는지는 테스트(elicitation 핸들러를 가진 테스트 클라이언트)와 Claude Code에서 확인합니다.

## Claude Code에서 한 판 두기

### `.mcp.json`

프로젝트 루트의 `.mcp.json`에 두 서버가 들어 있습니다.

```json
{
  "mcpServers": {
    "ngg": {
      "type": "stdio",
      "command": "bun",
      "args": ["src/ngg/server.ts"]
    },
    "numbaseball": {
      "type": "stdio",
      "command": "bun",
      "args": ["src/server.ts"]
    }
  }
}
```

- `args`가 상대경로라 **`claude`를 반드시 프로젝트 루트에서 실행**해야 합니다.
- `${CLAUDE_PROJECT_DIR}`는 서버 프로세스의 환경에만 들어가므로 `.mcp.json` 확장에 쓰지 않습니다 [문서 기준].
- 승인 설정(`enableAllProjectMcpServers`, `enabledMcpjsonServers`)은 넣지 않습니다. 서버 승인은 아래 절차에서 사용자가 직접 합니다.

### 사용자 확인 절차

새 터미널에서 직접 실행합니다. 사용량을 아끼려고 sonnet과 3자리 easy를 기본으로 합니다.

```sh
cd <이 저장소 폴더>              # 프로젝트 루트
claude mcp get numbaseball      # 승인 전 상태가 보이면 정상
MCP_PROTOCOL_NEGOTIATION=auto claude --model sonnet --debug-file "${TMPDIR:-/tmp}/numbaseball-cc-debug.log"
```

- `MCP_PROTOCOL_NEGOTIATION=auto`는 2026-07-28 협상을 항상 시도하게 합니다 [문서 기준].
- 처음이면 폴더 신뢰 창과 `.mcp.json` 서버 승인 창에서 사용자가 직접 승인합니다.
- debug 파일은 프로젝트 밖(`$TMPDIR`)에 둡니다. `--debug-file`을 쓰면 같은 폴더에 `latest` 링크가 생기기 때문입니다 [확인됨].
- Claude Code 2.1.294에서 해 보니 폴더 신뢰 창과 서버 승인 창 모두 기본 선택이 '아니오' 쪽(`No, exit`, `Continue without using`)이었습니다. 화살표로 승인 쪽으로 옮긴 뒤 Enter를 누르세요. 브라우저 도구(Chrome 확장)를 쓸지 묻는 창이 하나 더 뜨기도 하는데, 이 실습과는 상관없습니다.

진행 순서입니다.

1. `/mcp`로 서버 상태를 봅니다.
2. `/` 메뉴에서 `numbaseball:new_game`을 고르거나, `/mcp__numbaseball__new_game`을 인자 없이 입력합니다.
3. form 창에서 3자리와 easy를 고릅니다.
4. Claude가 끝까지 두는 것을 지켜봅니다.

입력 창 조작(Claude Code 2.1.294에서 관측): `digits`에는 숫자 3을 치고, `difficulty`에서는 →로 목록을 펼쳐 Space로 고른 뒤, ↓로 `Accept`에 가서 Enter를 누릅니다.

(선택) legacy 확인은 따로 짧게 합니다. `MCP_PROTOCOL_NEGOTIATION=legacy claude --model sonnet --debug-file "${TMPDIR:-/tmp}/numbaseball-cc-debug-legacy.log"`로 띄우고 체크리스트 1, 4, 6번만 확인합니다.

사용량 한도에 걸리면 체크리스트를 거기까지만 채워 돌려줍니다.

### 체크리스트

각 항목에 O/X와 관찰한 내용을 적어 돌려줍니다.

1. `/mcp`에 `numbaseball`이 connected로 보인다.
2. `/` 메뉴에 `/numbaseball:new_game (MCP)`가 보인다. *[문서 기준]*
3. 시작 전에는 `start_game`만 있다. `/mcp`의 서버 상세 화면에서 확인한다.
4. 인자 없이 시작하면 자릿수와 난이도 입력 창이 뜬다. *[미확인: Claude Code의 MRTR elicitation]*
5. 입력 창에서 거절하면 Claude가 게임을 시작하지 않았다고 알린다.
6. 시작한 뒤 같은 대화에서 Claude가 `guess`를 찾아 호출한다. MCP tool은 지연 로드라 ToolSearch를 거치는 것이 정상이다. *[`-p`에서 확인됨]*
7. 결과에 S와 B가 보이고, Claude가 이전 결과로 후보를 좁혀 간다.
8. 게임이 끝나면 `guess`와 `give_up`이 사라지고 `start_game`이 다시 보인다.
9. `@`로 `numbaseball` 리소스(rules, games)를 고를 수 있다. *[미확인]*
10. 진행 중에는 정답이 어디에도 보이지 않는다.
11. debug 로그에서 `negotiatedProtocolVersion` 값(2026-07-28 또는 2025-11-25)을 그대로 적고, `Received tools/list_changed notification`이 있는지 적는다. 확인 명령: `grep -E "negotiatedProtocolVersion|tools/list_changed" "${TMPDIR:-/tmp}/numbaseball-cc-debug.log"`

용어: `-p`는 `claude -p`(비대화형 실행)를 뜻합니다. '지연 로드'와 `ToolSearch`는 Claude Code가 MCP tool을 처음부터 다 싣지 않고 필요할 때 찾아 불러오는 단계입니다.

관측(2026-10-08, Claude Code 2.1.294 · Sonnet, 데모 녹화와 그 준비 세션): 1~11번이 모두 기대대로였습니다. 4번 입력 창이 실제로 떴고(화면에 `Fulfilling input required by 'tools/call'`), 5번 거절 뒤 Claude가 게임을 시작하지 않았다고 알렸습니다. 9번 `@numbaseball`에는 `numbaseball://rules`와 게임 기록이 보였고, 11번 로그의 협상 버전은 2026-07-28, `tools/list_changed` 수신은 10번이었습니다. 7번의 도구 결과 줄은 화면에서 접혀 있어 S·B는 Claude의 설명과 표로 보입니다.

### 막혔을 때

- **4번에서 창이 뜨지 않거나 오류가 날 때:** legacy로 다시 시도합니다. legacy에서는 SDK가 실제 `elicitation/create`를 보냅니다 [확인됨, raw stdio]. 그래도 안 되면 `/mcp__numbaseball__new_game 3 easy`로 인자를 넣어 시작합니다.
- **6번에서 `guess`를 찾지 못할 때:** 서버 항목에 `"alwaysLoad": true`를 넣고 다시 시도합니다 [문서 기준]. list_changed와 함께 쓸 때의 동작은 [미확인]입니다.
- **연결에 실패할 때:**
  - `claude mcp get numbaseball`과 debug 로그를 확인합니다.
  - 프로젝트 루트가 아닌 곳에서 실행했다면 루트에서 다시 실행합니다.
  - `bun`이 PATH에 없으면 `command`를 `which bun`으로 얻은 절대경로로 바꿉니다. args를 절대경로로 바꾸는 것도 방법입니다.
- **승인을 되돌릴 때:** 사용자가 직접 `claude mcp reset-project-choices`를 실행합니다.
- **(선택) 와이어 보기:** 서버 항목을 `"command": "sh", "args": ["scripts/tap.sh"]`로 바꾸면 `wire/wire.*`에 Claude Code의 와이어가 남습니다. 이 래퍼를 쓰면 종료할 때 SIGINT가 실패하고 SIGTERM으로 끝날 수 있는데, 해롭지 않습니다 [확인됨].
- **form을 오래 비워 두면(legacy):** legacy(2025-11-25) 연결에서는 서버 쪽 SDK가 form 한 라운드를 600초까지 기다리지만, SDK 클라이언트의 요청 시간 한도 기본값은 60초입니다. 그래서 form을 오래 비워 두면 서버 쪽 라운드가 끝나기 전에 클라이언트에서 먼저 시간 초과가 날 수 있습니다. 이것은 SDK 코드를 읽고 적은 것이고, Claude Code 자체의 한도는 [미확인]입니다. form은 바로 답하는 것이 안전합니다.
- **(선택) 인자를 넣고 바로 시작:** `/mcp__numbaseball__new_game 3 easy`처럼 prompt 인자를 주면 form 없이 시작합니다. 체크리스트 밖의 추가 확인입니다.

용어: `raw stdio`는 Claude Code 없이 서버의 표준 입출력에 JSON-RPC 메시지를 직접 써서 확인했다는 뜻입니다. `SIGINT`·`SIGTERM`은 프로세스에 종료를 요청하는 신호입니다(SIGINT는 Ctrl+C와 같은 중단 신호, SIGTERM은 종료 요청 신호).

## 프로젝트 구조

```
.
├── .gitignore          # node_modules, ref/, wire/, *.log, latest 등
├── .mcp.json           # Claude Code 프로젝트 범위 서버 설정 (ngg, numbaseball)
├── LICENSE             # MIT License (Copyright (c) 2026 b1ueseoyoung)
├── README.md
├── package.json        # scripts: start, test, typecheck, inspect, inspect:ngg
├── bun.lock
├── tsconfig.json       # bun init 기본값 + exclude ref/
├── scripts/
│   └── tap.sh          # 와이어 기록 래퍼 (아래 설명)
├── src/
│   ├── server.ts       # numbaseball 서버. buildServer(opts)와 serveStdio 진입점
│   ├── game/
│   │   ├── baseball.ts # 순수 게임 로직. MCP를 import하지 않음
│   │   └── rules.ts    # 난이도별 최대 기회 표와 규칙 문서(RULES_MARKDOWN)
│   └── ngg/
│       ├── server.ts   # 1단계 원본 재구현 (1~100 맞히기)
│       └── messages.ts # 원본 응답 문구 (MIT, 출처 표기)
├── test/
│   ├── helpers.ts        # connectModern / connectLegacy / createCounter
│   ├── baseball.test.ts  # 규칙 1~10 단위 테스트
│   ├── ngg.test.ts       # ngg 통합 테스트 (두 시대)
│   └── server.test.ts    # numbaseball 통합 테스트 (두 시대)
├── ref/                # git 제외. 원본 클론과 관측용 스크립트
└── wire/               # git 제외. tap.sh가 남긴 와이어 기록
```

- `buildServer(opts)`는 테스트 주입용 인자를 받습니다. `secretFor(digits, gameNo)`로 정답을, `rng`로 난수를 바꿀 수 있어 테스트가 결정적으로 돕니다. 실제 실행에서는 둘 다 비워 둡니다.
- **`ref/`**(git 제외): 원본 프로젝트를 읽기 전용으로 비교하려고 클론해 두는 자리입니다. 같은 커밋을 받으려면 다음을 실행합니다.

  ```sh
  git clone https://github.com/portal-labs-infrastructure/number-guessing-game-mcp-server ref/number-guessing-game-mcp-server && git -C ref/number-guessing-game-mcp-server switch --detach 45d6900
  ```

  `ref/probes/`에는 0단계에서 SDK 동작을 관측하려고 쓴 일회성 스크립트를 두었습니다(ref/는 git에서 제외되어 저장소에는 들어 있지 않습니다). 테스트가 아니므로 파일 이름에 `.test.`를 쓰지 않습니다(`bun test`가 이름으로 테스트 파일을 고르기 때문입니다).
- **`wire/`**(git 제외)와 **`scripts/tap.sh`**: `tap.sh`는 서버의 stdin과 stdout을 각각 `wire/wire.in`, `wire/wire.out`에 복사해 두는 래퍼입니다(stderr는 그대로). 인자로 서버 파일을 주고(기본 `src/server.ts`), 환경 변수 `TAP_LOG`로 저장 경로를 바꿀 수 있습니다. 다만 Inspector CLI는 부모 셸의 환경 변수를 서버에 넘기지 않으므로, `TAP_LOG=... bunx ...`처럼 앞에 붙이면 조용히 무시되어 기본 경로 `wire/wire.*`에 쓰입니다. Inspector와 같이 쓸 때는 `-e TAP_LOG=<경로>`로 넘깁니다. 예: `HOME=${TMPDIR:-/tmp}/numbaseball-inspector-home bunx @modelcontextprotocol/inspector@2.9.0 --cli sh scripts/tap.sh -e TAP_LOG=${TMPDIR:-/tmp}/nb-tap-check/wire --protocol-era modern --format json --method tools/list`은 `${TMPDIR:-/tmp}/nb-tap-check/wire.in`과 `wire.out`에 기록합니다. 같은 파일에 이어 쓰므로 실행할 때마다 이름을 바꿔 두는 것이 좋습니다. 두 시대의 첫 메시지를 비교하려면 다음처럼 합니다.

  ```sh
  for era in modern legacy; do
    HOME=${TMPDIR:-/tmp}/numbaseball-inspector-home bunx @modelcontextprotocol/inspector@2.9.0 --cli sh scripts/tap.sh --protocol-era $era --format json --method tools/list
    mv wire/wire.in wire/$era.in && mv wire/wire.out wire/$era.out
  done; head -n 2 wire/modern.in wire/legacy.in
  ```

  `wire/modern.in`의 첫 두 요청은 `server/discover`와 `subscriptions/listen`, `wire/legacy.in`은 `initialize`와 `notifications/initialized`입니다.

## 단계별로 만든 것

이 실습은 다섯 단계로 나눠 진행했고, 단계마다 테스트와 타입 검사를, MCP 계층이 있는 단계(0·1·3)에서는 Inspector 결과까지 확인한 뒤 다음으로 넘어갔습니다.

- **0단계 준비.** `bun init`으로 골격을 만들고 SDK와 zod 버전을 고정했습니다. tool 하나(`hello`)짜리 최소 서버, 두 시대로 연결하는 테스트 헬퍼, `HOME`을 바꾼 Inspector 스크립트, 와이어 기록 래퍼 `scripts/tap.sh`를 만들었습니다. 이 실습의 계획서(저장소에는 넣지 않았습니다)에서 "실행해 본 적 없음"으로 남아 있던 SDK 동작 몇 가지(리소스 토글 때 `resources/list_changed`가 오는지, `outputSchema`가 있는 tool의 `isError` 결과가 받아들여지는지 등)를 작은 스크립트로 관측해 뒤 단계의 기대값으로 썼습니다.
- **1단계 원본 따라 만들기(ngg).** 원본 서버를 SDK v2로 다시 썼습니다. 1-1 상태별 tool 켜고 끄기, 1-2 추측마다 `guess` 범위·설명을 바꾸는 동적 스키마와 오류 형식, 1-3 리소스 세 개와 게임 중에만 보이는 `game_state`, 1-4 `.mcp.json`에 `ngg` 등록. 원본의 세션 Map·`server.tool`·`server.resource`+`remove` 같은 v1 방식은 `serveStdio` 팩토리·`registerTool`+`z.object`·`registerResource`+`disable`/`enable`로 바꿨습니다.
- **2단계 숫자야구 순수 로직.** `src/game/baseball.ts`에 비밀 수 생성, 입력 검증, 스트라이크·볼 판정, 게임 진행(`createGame`·`applyGuess`·`giveUp`)을 순수 함수로 두고, 규칙 1~10을 표 기반 단위 테스트로 고정했습니다. 오류는 예외 대신 `{ ok: false, code, message }` 값으로 돌려주고 정답을 메시지에 넣지 않습니다.
- **3단계 MCP 기능 붙이기(numbaseball).** 3-1 tool 세 개와 상태 전이, `guess` 동적 스키마. 3-2 `outputSchema`·`structuredContent`·`isError`. 3-3 리소스 `rules`·`current`·`games/{gameId}` 템플릿. 3-4 prompt `new_game`. 3-5 `start_game`의 form elicitation. 하위 단계마다 따로 검토를 돌렸고, 그 과정에서 동시에 들어온 `start_game` 두 개가 모두 성공하던 결함을 찾아 핸들러 첫 줄의 LOBBY 가드로 고쳤습니다. 마지막에는 명세의 각 줄이 어느 테스트로 덮이는지 대응표를 만들고, 코드를 일부러 망가뜨렸을 때 테스트가 잡는지도 확인했습니다(검증 보고서에만 정리했고 저장소에는 넣지 않았습니다).
- **4단계 Claude Code 연결.** `.mcp.json`에 `numbaseball`을 추가하고 이 README를 썼습니다. Claude Code 2.1.294(Sonnet)로 한 판을 녹화하며 확인했습니다. 인자 없이 시작하면 설정 입력 창(elicitation)이 뜨고, Claude가 `guess`를 되풀이해 끝까지 둡니다([체크리스트](#체크리스트) 아래 관측 참고).

## 알아 두면 좋은 것

이 프로젝트를 만들면서 실제로 관찰한 것들입니다.

- **Inspector CLI는 form에 답하지 못합니다.** elicitation capability를 선언하지 않기 때문입니다. 두 시대의 실패 모양은 [인자 없는 `start_game`이 CLI에서 실패하는 이유](#인자-없는-start_game이-cli에서-실패하는-이유)를 보세요.
- **`isError` 결과와 프로토콜 에러는 다릅니다.** `isError: true`는 정상적인 `tools/call` 응답이라 모델이 본문을 읽고 다시 시도할 수 있습니다(입력 검증 실패, 규칙 위반, form 거절이 여기에 해당). 프로토콜 에러는 JSON-RPC `error` 응답이라 SDK 클라이언트가 예외로 던집니다(꺼진 tool 호출과 꺼진 리소스 읽기의 `-32602 … disabled`, prompt 인자 위반의 `Invalid arguments for prompt …`, 없는 `gameId`의 `… not found`).
- **prompt 인자는 문자열입니다.** `prompts/get`의 `arguments`는 문자열 맵이라 `digits`를 `z.enum(['3', '4'])`로 받습니다. `'03'`은 `'3'`으로 바뀌지 않고 거절됩니다. `prompts/list`에서 선택 인자는 `required: false`로 나갑니다.
- **SDK 클라이언트는 리소스 내용의 `blob` 키를 버립니다.** 텍스트 리소스에 일부러 `blob`을 넣어 보내도 `client.readResource()` 결과에는 없어서, "blob을 쓰지 않는다"는 검사를 클라이언트 결과로는 할 수 없었습니다. 그래서 테스트는 클라이언트 transport의 `onmessage`를 가로채 와이어 원문의 키(`uri`, `mimeType`, `text`)를 봅니다.
- **SDK 2.3.1은 `disable()`한 리소스 템플릿도 `resources/templates/list`에 그대로 내보냅니다.** 검토 중 변이로 관찰한 것이고, 이 서버는 템플릿을 끄지 않으므로 영향은 없습니다.
- **`list_changed`는 `enable()`·`disable()`·`update()` 호출마다 하나씩 나갑니다.** 테스트에서 센 값은 `tools/list_changed`가 `start_game` 뒤 4개(start 끄기, guess·give_up 켜기, guess 스키마 갱신), `give_up` 뒤 누적 7개이고, `resources/list_changed`는 `start_game` 뒤 1개, `give_up` 뒤 누적 2개입니다. modern에서는 클라이언트가 `subscriptions/listen`을 열어야 받습니다.
- **요청은 매번 `await`합니다.** 응답을 기다리지 않고 연달아 보내면 응답 순서가 바뀝니다. 테스트에서 유일한 예외는 form 두 개를 동시에 열어 LOBBY 가드를 확인하는 동시성 테스트입니다.

## 출처와 라이선스

- **따라 만든 원본:** [portal-labs-infrastructure/number-guessing-game-mcp-server](https://github.com/portal-labs-infrastructure/number-guessing-game-mcp-server), 기준 커밋 `45d6900`. 원본은 MIT License이고 저작권 표시는 `Copyright (c) 2025 Portal Labs Infrastructure`입니다.
- `src/ngg/`는 이 원본을 SDK v2로 다시 구현한 것입니다. 원본에서 그대로 가져온 것은 `src/ngg/messages.ts`의 응답 문구뿐이고, 그 파일 머리에 출처와 MIT 표기를 적었습니다. 코드 구조는 옮기지 않았습니다.
- 보조로 참고한 [corey-stidston/mcp-wordle](https://github.com/corey-stidston/mcp-wordle)은 라이선스가 없어 코드를 가져오지 않았고, 테스트 케이스 구성(이김, 짐, 잘못된 입력, 중복 입력)만 참고했습니다.
- **이 저장소의 라이선스는 MIT입니다.** 전문은 [`LICENSE`](LICENSE)에 있고 저작권 표시는 `Copyright (c) 2026 b1ueseoyoung`입니다. 원본에서 가져온 `src/ngg/messages.ts`의 응답 문구는 원본의 MIT 표기(`Copyright (c) 2025 Portal Labs Infrastructure`)를 그 파일 머리에 그대로 유지합니다.

참고 문서: [MCP 2026-07-28 스펙 변경 목록](https://modelcontextprotocol.io/specification/2026-07-28/changelog), [TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk), [Inspector 프로토콜 시대](https://modelcontextprotocol.io/docs/2026-07-28/tools/inspector/protocol-eras.md), [Claude Code MCP 문서](https://code.claude.com/docs/en/mcp.md).

## 알려진 한계

- **상태는 서버 프로세스 메모리에만 있습니다.** 연결(프로세스)마다 게임은 한 번에 하나이고, 기록(`games/{gameId}`)도 그 연결 안에서만 보입니다. 서버를 다시 띄우면 모두 사라집니다.
- **stdio 전송만 지원합니다.** HTTP 전송, 인증, 영속 저장소는 없습니다. SDK의 HTTP 핸들러는 요청마다 서버 팩토리를 새로 불러 메모리 상태가 유지되지 않으므로, 이 구조를 HTTP로 옮기려면 상태 저장 방식을 바꿔야 합니다.
- **Claude Code 쪽 확인은 2026-10-08 Claude Code 2.1.294 한 버전, modern(2026-07-28) 연결에서만 했습니다.** 다른 버전에서는 창 문구나 동작이 다를 수 있고, legacy 연결(`MCP_PROTOCOL_NEGOTIATION=legacy`)과 `alwaysLoad`를 `list_changed`와 함께 쓸 때의 동작은 확인하지 않았습니다.
- **legacy 연결에서 form을 오래 비워 두면 클라이언트 쪽 시간 초과가 먼저 날 수 있습니다.** [막혔을 때](#막혔을-때)의 "form을 오래 비워 두면" 항목을 보세요.
- **ngg 서버에는 동시 `start_game` 가드가 없습니다.** 3단계 검토에서 찾은 "동시에 들어온 `start_game` 두 개가 모두 성공" 결함은 numbaseball에만 고쳤습니다. ngg는 1단계 연습용 그대로입니다.
- **Inspector CLI로는 PLAYING 상태를 볼 수 없습니다.** 호출마다 새 프로세스를 띄우기 때문입니다. [CLI](#cli) 절을 보세요.
