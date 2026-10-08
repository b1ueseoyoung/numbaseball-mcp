import { McpServer, ResourceNotFoundError, ResourceTemplate, acceptedContent, inputRequired, inputResponse } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import * as z from 'zod/v4';
import { applyGuess, createGame, giveUp } from './game/baseball.ts';
import type { Digits, Game } from './game/baseball.ts';
import { RULES_MARKDOWN } from './game/rules.ts';

type State = 'LOBBY' | 'PLAYING';
type Playing = { id: string; game: Game };

const text = (t: string) => ({ content: [{ type: 'text' as const, text: t }] });
// 성공: 사람이 읽는 한국어 한 줄(content)과 outputSchema에 맞는 structuredContent를 함께 보낸다
const ok = (t: string, structuredContent: Record<string, unknown>) => ({ ...text(t), structuredContent });
// 규칙 위반·가드: structuredContent 없이 isError만. SDK는 isError 결과의 출력 검증을 건너뛴다(관측으로 정함: EV/task-7-iserror-outputschema.txt)
const fail = (t: string) => ({ ...text(t), isError: true });

// secretFor·rng는 테스트 주입용. secretFor가 digits와 맞지 않는 값을 주면 createGame이 throw한다.
export function buildServer(opts: { secretFor?: (digits: Digits, gameNo: number) => string; rng?: () => number } = {}) {
  const server = new McpServer({ name: 'numbaseball', version: '0.1.0' });
  let state: State = 'LOBBY';
  let playing: Playing | undefined; // PLAYING일 때만 있다
  let gameNo = 0; // 이 연결에서 성공한 start_game 수
  const games = new Map<string, Game>(); // gameId -> 최신 Game. 3-3 리소스가 읽는다

  // 3-5 form 필드. start_game은 빠진 필드만 pick해서 묻는다. .regex()·.refine()은 elicitation 스키마로 바꿀 수 없다(PLAN.md:614)
  const settingsFields = z.object({ digits: z.number().int().min(3).max(4), difficulty: z.enum(['easy', 'normal', 'hard']) });
  const startTool = server.registerTool('start_game',
    { description: '숫자야구 새 게임을 시작한다. digits와 difficulty는 사용자가 직접 말한 경우에만 채운다. 비우면 서버가 사용자에게 묻는다.',
      inputSchema: z.object({ digits: z.number().int().min(3).max(4).optional(), difficulty: z.enum(['easy', 'normal', 'hard']).optional() }),
      outputSchema: z.object({ gameId: z.string(), digits: z.number(), difficulty: z.enum(['easy', 'normal', 'hard']), maxAttempts: z.number() }) },
    async ({ digits, difficulty }, ctx) => {
      // SDK는 enabled 검사 뒤 입력 검증을 await하므로 동시에 온 start_game 두 개가 모두 여기까지 올 수 있다. 핸들러에 await가 없어 이 검사와 전이는 원자적이다.
      if (state !== 'LOBBY') return fail('이미 진행 중인 게임이 있습니다.');
      // 3-5 MRTR: 빠진 인자가 있으면 그 필드만 담은 settingsSchema로 form을 묻는다(첫 호출, 상태 변화 없음). 같은 핸들러가 답과 함께 다시 불리면 그때만 시작한다.
      // 거절·취소와 형식 불일치(acceptedContent가 undefined)는 다시 묻지 않고 isError로 끝낸다(LOBBY 유지). 둘 다 있으면 묻지 않는다.
      const asked = digits === undefined || difficulty === undefined;
      const settingsSchema = settingsFields.pick({ ...(digits === undefined ? { digits: true as const } : {}), ...(difficulty === undefined ? { difficulty: true as const } : {}) });
      const view = inputResponse(ctx.mcpReq.inputResponses, 'settings');
      if (asked && view.kind === 'missing') {
        const message = digits === undefined && difficulty === undefined ? '자릿수와 난이도를 고르세요' : digits === undefined ? '자릿수를 고르세요' : '난이도를 고르세요';
        return inputRequired({ inputRequests: { settings: inputRequired.elicit({ message, requestedSchema: settingsSchema }) } });
      }
      if (asked && view.kind === 'elicit' && view.action !== 'accept') return fail('게임을 시작하지 않았다(설정 입력을 취소했다).');
      // 인자가 우선이고 form은 빠진 필드만 채운다(settingsSchema의 정적 타입은 두 필드를 다 가지지만 실제 값에는 빠진 필드만 있다)
      const form = asked ? acceptedContent(ctx.mcpReq.inputResponses, 'settings', settingsSchema) : { digits, difficulty };
      if (form === undefined) return fail('설정 값이 형식에 맞지 않아 게임을 시작하지 않았다.');
      const d = (digits ?? form.digits) as Digits; // inputSchema·settingsSchema가 3..4 정수로 제한한다
      const level = difficulty ?? form.difficulty;
      const no = gameNo + 1;
      const game = createGame({ digits: d, difficulty: level, secret: opts.secretFor?.(d, no), rng: opts.rng });
      gameNo = no;
      const p = { id: `g${no}`, game };
      record(p, game);
      transitionTo('PLAYING', p);
      return ok(`새 게임 ${p.id}: ${d}자리, 난이도 ${level}, 기회 ${game.maxAttempts}번`, { gameId: p.id, digits: d, difficulty: level, maxAttempts: game.maxAttempts });
    });

  const guessTool = server.registerTool('guess',
    { description: '숫자를 추측한다. 게임을 시작하면 자릿수와 남은 기회가 설명에 보인다.', inputSchema: z.object({ guess: z.string() }),
      outputSchema: z.object({ gameId: z.string(), guess: z.string(), strikes: z.number(), balls: z.number(), out: z.boolean(), attempts: z.number(), attemptsLeft: z.number(), status: z.enum(['IN_PROGRESS', 'WON', 'LOST']), answer: z.string().nullable() }) },
    async ({ guess }) => {
      const p = playing;
      if (!p) return fail('진행 중인 게임이 없습니다.'); // guess는 PLAYING에서만 켜져 있다
      const r = applyGuess(p.game, guess);
      if (!r.ok) return fail(r.message); // 규칙 위반: 기회와 상태는 그대로
      record(p, r.game);
      const { strikes, balls, out, attempts, attemptsLeft, status, answer } = r.result;
      const sc = { gameId: p.id, ...r.result }; // GuessResult는 outputSchema와 같은 모양이고 answer는 WON·LOST일 때만 값이 있다
      if (status === 'WON') { transitionTo('LOBBY'); return ok(`정답! ${attempts}번 만에 맞혔다`, sc); }
      if (status === 'LOST') { transitionTo('LOBBY'); return ok(`실패. 정답은 ${answer}`, sc); }
      return ok(out ? `${guess} → 아웃 (남은 기회 ${attemptsLeft})` : `${guess} → ${strikes}S ${balls}B (남은 기회 ${attemptsLeft})`, sc);
    });
  guessTool.disable();

  const giveUpTool = server.registerTool('give_up',
    { description: '진행 중인 게임을 포기하고 정답을 본다.', inputSchema: z.object({}),
      outputSchema: z.object({ gameId: z.string(), answer: z.string(), attempts: z.number(), status: z.literal('GAVE_UP') }) },
    async () => {
      const p = playing;
      if (!p) return fail('진행 중인 게임이 없습니다.');
      const r = giveUp(p.game);
      if (!r.ok) return fail(r.message);
      record(p, r.game);
      transitionTo('LOBBY');
      return ok(`포기. 정답은 ${r.result.answer}`, { gameId: p.id, ...r.result });
    });
  giveUpTool.disable();

  // 리소스. Game은 secret을 담고 있으므로 통째로 직렬화하지 않고 정답 없는 보기(view)를 따로 만든다
  const view = (id: string, g: Game) => ({ gameId: id, digits: g.digits, difficulty: g.difficulty, attempts: g.attempts, attemptsLeft: g.maxAttempts - g.attempts, history: g.history });
  const json = (uri: URL, value: unknown) => ({ contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(value) }] });

  server.registerResource('rules', 'numbaseball://rules', { title: '숫자야구 규칙', mimeType: 'text/markdown' },
    async uri => ({ contents: [{ uri: uri.href, mimeType: 'text/markdown', text: RULES_MARKDOWN }] }));

  // 한 번 등록하고 PLAYING에서만 켠다(transitionTo). 꺼져 있으면 SDK가 먼저 거절한다
  const currentResource = server.registerResource('current', 'numbaseball://current', { title: '현재 게임', mimeType: 'application/json' },
    async uri => {
      const p = playing;
      if (!p) throw new ResourceNotFoundError(uri.href);
      return json(uri, view(p.id, p.game));
    });
  currentResource.disable();

  // 이 연결의 게임 기록. 끝난 게임(WON·LOST·GAVE_UP)만 answer를 넣는다
  server.registerResource('game', new ResourceTemplate('numbaseball://games/{gameId}', {
      list: async () => ({ resources: [...games.keys()].map(id => ({ uri: `numbaseball://games/${id}`, name: `game ${id}` })) }),
    }), { title: '게임 기록', mimeType: 'application/json' },
    async (uri, { gameId }) => {
      const id = Array.isArray(gameId) ? gameId[0] : gameId;
      const g = id ? games.get(id) : undefined;
      if (!id || !g) throw new ResourceNotFoundError(uri.href);
      return json(uri, { ...view(id, g), status: g.status, ...(g.status === 'IN_PROGRESS' ? {} : { answer: g.secret }) });
    });

  // prompt. 인자는 프로토콜상 항상 문자열이라 z.enum(['3', '4'])로 받고 숫자 변환은 문장 안에서만 한다(PLAN 3-4). 어느 상태에서나 쓸 수 있다
  server.registerPrompt('new_game',
    { title: '숫자야구 새 게임', description: '숫자야구 한 판을 시작하고 끝까지 둔다',
      argsSchema: z.object({ digits: z.enum(['3', '4']).optional(), difficulty: z.enum(['easy', 'normal', 'hard']).optional() }) },
    ({ digits, difficulty }) => {
      const phrases: string[] = [];
      if (digits) phrases.push(`digits는 ${digits}${digits === '3' ? '으로' : '로'}`); // 3(삼)은 받침이 있어 '으로', 4(사)는 '로'
      if (difficulty) phrases.push(`difficulty는 ${difficulty}로`);
      const argSentence = phrases.length === 2 ? `${phrases.join(', ')} 넣어.`
        : phrases.length === 1 ? `${phrases[0]} 넣어. 나머지는 비워 둬(서버가 나에게 물어본다).`
        : '인자 없이 호출해(서버가 나에게 물어본다).';
      const instructions = [
        `1. start_game을 호출해 게임을 시작해. ${argSentence}`,
        '2. guess로 한 번에 하나씩 추측해.',
        '3. 매번 지금까지의 결과로 후보를 어떻게 좁혔는지 근거를 한 줄로 말해.',
        '4. 게임이 끝날 때까지 계속해.',
      ].join('\n');
      return { messages: [{ role: 'user' as const, content: { type: 'text' as const, text: instructions } }] };
    });

  // 최신 Game을 기록하고, 진행 중이면 guess 설명·스키마를 맞춘다. update()는 tools/list_changed를 보낸다. 정답·힌트는 넣지 않는다.
  function record(p: Playing, game: Game) {
    p.game = game;
    games.set(p.id, game);
    if (game.status !== 'IN_PROGRESS') return;
    const n = game.digits;
    guessTool.update({
      description: `${n}자리 숫자를 추측한다. 0~9, 자리끼리 중복 없음, 0으로 시작 가능. 남은 기회 ${game.maxAttempts - game.attempts}번.`,
      paramsSchema: z.object({ guess: z.string().length(n).describe(`${n}자리 숫자 문자열`) }),
    });
  }

  // 상태 전이와 tool·current 리소스 on/off는 여기서만 한다. 동기라서 두 요청이 끼어들 틈이 없다.
  function transitionTo(next: State, started?: Playing) {
    if (state === next) return;
    state = next;
    playing = started;
    if (next === 'PLAYING') {
      startTool.disable();
      guessTool.enable();
      giveUpTool.enable();
      currentResource.enable();
    } else {
      guessTool.disable();
      giveUpTool.disable();
      startTool.enable();
      currentResource.disable();
    }
    console.error(`[numbaseball] state -> ${next}`);
  }

  return server;
}

if (import.meta.main) {
  serveStdio(() => buildServer());
  console.error('numbaseball ready on stdio'); // 로그는 stderr로만
}
