import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import * as z from 'zod/v4';
import * as M from './messages.ts';

const MIN = 1;
const MAX = 100;
const MAX_ATTEMPTS = 10;

type State = 'LOBBY' | 'PLAYING';
// message: 이 게임에서 마지막으로 클라이언트에 돌려준 문구(game_state 리소스에 보인다)
type Game = { playerName: string; secret: number; attemptsLeft: number; lo: number; hi: number; message: string };
type HighScore = { playerName: string; attempts: number };

// 규칙 문구는 원본 PDF를 옮기지 않고 새로 썼다(R9)
const RULES = [
  'Number Guessing Game rules',
  '1. Call start_game with your name to begin.',
  `2. The server picks a secret integer from ${MIN} to ${MAX}.`,
  '3. Call guess_number with an integer. The guess parameter description shows the current range and attempts left.',
  '4. After a wrong guess you get "Too low!" or "Too high!" and the range narrows.',
  `5. You have ${MAX_ATTEMPTS} attempts. Guess the number to win; if you run out, the game is over.`,
  '6. Call give_up to end the game and reveal the number.',
].join('\n');

const text = (t: string) => ({ content: [{ type: 'text' as const, text: t }] });

export function buildNggServer(opts: { secret?: number } = {}) {
  const server = new McpServer({ name: 'ngg', version: '0.1.0' });
  let state: State = 'LOBBY';
  let game: Game | undefined;
  const highScores: HighScore[] = []; // 이 연결의 승리 기록만. 원본의 데모 2건은 넣지 않는다.

  const startTool = server.registerTool('start_game',
    { description: 'Start a new number guessing game.', inputSchema: z.object({ playerName: z.string().min(1).max(50) }) },
    async ({ playerName }) => {
      game = { playerName, secret: opts.secret ?? MIN + Math.floor(Math.random() * (MAX - MIN + 1)), attemptsLeft: MAX_ATTEMPTS, lo: MIN, hi: MAX,
        message: M.WELCOME(playerName, MIN, MAX, MAX_ATTEMPTS) };
      updateGuessSchema(game.lo, game.hi, game.attemptsLeft);
      transitionTo('PLAYING');
      return text(game.message);
    });

  const guessTool = server.registerTool('guess_number',
    { description: 'Guess the secret number.', inputSchema: z.object({ guess: z.number().int().min(1).max(100) }) },
    async ({ guess }) => {
      if (!game) return text(M.ERR_NOT_STARTED);
      const g = game;
      g.attemptsLeft--;
      if (guess === g.secret) {
        highScores.push({ playerName: g.playerName, attempts: MAX_ATTEMPTS - g.attemptsLeft });
        transitionTo('LOBBY');
        return text(M.CONGRATS(g.playerName, g.secret, MAX_ATTEMPTS - g.attemptsLeft));
      }
      if (g.attemptsLeft === 0) {
        transitionTo('LOBBY');
        return text(M.GAME_OVER(g.playerName, g.secret));
      }
      if (guess < g.secret) g.lo = Math.max(g.lo, guess + 1); else g.hi = Math.min(g.hi, guess - 1);
      updateGuessSchema(g.lo, g.hi, g.attemptsLeft);
      g.message = guess < g.secret ? M.TOO_LOW(g.attemptsLeft) : M.TOO_HIGH(g.attemptsLeft);
      return text(g.message);
    });
  guessTool.disable();

  // guess 범위와 설명을 바꾼다. update()는 tools/list_changed를 보낸다. v2는 z.object로 직접 감싼다(PLAN.md:354-369).
  function updateGuessSchema(lo: number, hi: number, left: number) {
    guessTool.update({ paramsSchema: z.object({
      guess: z.number().int().min(lo).max(hi).describe(`Your guess (${lo}-${hi}). ${left} attempts left.`) }) });
  }

  const giveUpTool = server.registerTool('give_up',
    { description: 'Give up the current game.', inputSchema: z.object({}) },
    async () => {
      if (!game) return text(M.ERR_NO_ACTIVE_GAME);
      const g = game;
      transitionTo('LOBBY');
      return text(M.GAVE_UP(g.playerName, g.secret));
    });
  giveUpTool.disable();

  // 리소스 3개. URI는 원본(mcp_setup/index.ts:30-33)과 같다. blob은 쓰지 않고 text로만 보낸다.
  server.registerResource('highscores', 'mcp://number-guessing-game/highscores',
    { title: '최고 기록', mimeType: 'application/json' },
    async uri => ({ contents: [{ uri: uri.href, mimeType: 'application/json',
      text: JSON.stringify([...highScores].sort((a, b) => a.attempts - b.attempts).slice(0, 10)) }] }));

  server.registerResource('game_rules', 'mcp://number-guessing-game/rules',
    { title: '게임 규칙', mimeType: 'text/plain' },
    async uri => ({ contents: [{ uri: uri.href, mimeType: 'text/plain', text: RULES }] }));

  // 한 번만 등록하고 transitionTo에서 enable/disable로 토글한다. 비밀 수는 넣지 않는다(PLAN.md:370-391).
  const stateRes = server.registerResource('game_state', 'mcp://number-guessing-game/game_state',
    { title: '게임 상태', mimeType: 'application/json' },
    async uri => {
      const view = game ? { attemptsLeft: game.attemptsLeft, minGuess: game.lo, maxGuess: game.hi, message: game.message } : null;
      return { contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(view) }] };
    });
  stateRes.disable();

  // 상태 전이와 tool·game_state on/off는 여기서만 한다. 동기라서 두 요청이 끼어들 틈이 없다.
  function transitionTo(next: State) {
    if (state === next) return;
    state = next;
    if (next === 'PLAYING') {
      startTool.disable();
      guessTool.enable();
      giveUpTool.enable();
      stateRes.enable();
    } else {
      game = undefined;
      guessTool.disable();
      giveUpTool.disable();
      startTool.enable();
      stateRes.disable();
    }
    console.error(`[ngg] state -> ${next}`);
  }

  return server;
}

if (import.meta.main) {
  serveStdio(() => buildNggServer());
  console.error('ngg ready on stdio'); // 로그는 stderr로만
}
