import { MAX_ATTEMPTS } from './rules.ts';

// 숫자야구 순수 로직. MCP와 무관하고 전부 순수 함수다.
export type Digits = 3 | 4;
export type Difficulty = 'easy' | 'normal' | 'hard';
export type GuessErrorCode = 'BAD_LENGTH' | 'NOT_DIGITS' | 'DUPLICATE_DIGIT' | 'ALREADY_GUESSED' | 'GAME_OVER';

// 오류는 예외 대신 값으로 돌려준다. message는 한국어이고 정답을 넣지 않는다.
export interface GuessError {
  ok: false;
  code: GuessErrorCode;
  message: string;
}

const fail = (code: GuessErrorCode, message: string): GuessError => ({ ok: false, code, message });

// 규칙 10: a = [0..9], i = 9..1에 대해 j = floor(rng() * (i + 1))로 a[i]와 a[j]를 바꾸고 앞 N개를 쓴다
export function generateSecret(digits: Digits, rng: () => number = Math.random): string {
  const a = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
  for (let i = 9; i >= 1; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a.slice(0, digits).join('');
}

// 규칙 2·3. 검사 순서 BAD_LENGTH → NOT_DIGITS → DUPLICATE_DIGIT. 공백을 자르지 않는다.
export function validateGuess(guess: string, digits: Digits): { ok: true } | GuessError {
  if (guess.length !== digits) return fail('BAD_LENGTH', `${digits}자리로 입력하세요.`);
  if (!/^[0-9]+$/.test(guess)) return fail('NOT_DIGITS', '0~9 숫자만 입력하세요.');
  if (new Set(guess).size !== digits) return fail('DUPLICATE_DIGIT', '같은 숫자를 두 번 쓸 수 없습니다.');
  return { ok: true };
}

export function score(secret: string, guess: string): { strikes: number; balls: number } {
  let strikes = 0;
  let balls = 0;
  [...guess].forEach((ch, i) => {
    const at = secret.indexOf(ch);
    if (at === i) strikes++;
    else if (at >= 0) balls++;
  });
  return { strikes, balls };
}

export type GameStatus = 'IN_PROGRESS' | 'WON' | 'LOST' | 'GAVE_UP';

export interface Game {
  digits: Digits;
  difficulty: Difficulty;
  maxAttempts: number;
  secret: string;
  attempts: number;
  history: Array<{ guess: string; strikes: number; balls: number }>;
  status: GameStatus;
}

export interface GuessResult {
  guess: string;
  strikes: number;
  balls: number;
  out: boolean;
  attempts: number;
  attemptsLeft: number;
  status: 'IN_PROGRESS' | 'WON' | 'LOST';
  answer: string | null;
}

// 주입한 secret이 규칙 1(N자리·숫자만·중복 없음)에 어긋나면 테스트 설정 오류이므로 throw한다
export function createGame({ digits, difficulty, secret, rng }: { digits: Digits; difficulty: Difficulty; secret?: string; rng?: () => number }): Game {
  if (secret !== undefined) {
    const valid = validateGuess(secret, digits);
    if (!valid.ok) throw new Error(`주입한 secret이 규칙 1에 어긋납니다: ${valid.code}`);
  }
  return {
    digits,
    difficulty,
    maxAttempts: MAX_ATTEMPTS[digits][difficulty],
    secret: secret ?? generateSecret(digits, rng),
    attempts: 0,
    history: [],
    status: 'IN_PROGRESS',
  };
}

// 규칙 5~8. 검사 순서 GAME_OVER → BAD_LENGTH → NOT_DIGITS → DUPLICATE_DIGIT → ALREADY_GUESSED → 판정.
// 오류는 기회를 차감하지 않고, 성공하면 새 Game을 돌려준다(인자는 바꾸지 않는다).
export function applyGuess(game: Game, guess: string): { ok: true; game: Game; result: GuessResult } | GuessError {
  if (game.status !== 'IN_PROGRESS') return fail('GAME_OVER', '이미 끝난 게임입니다.');
  const valid = validateGuess(guess, game.digits);
  if (!valid.ok) return valid;
  if (game.history.some(h => h.guess === guess)) return fail('ALREADY_GUESSED', `이미 추측한 숫자입니다: ${guess}`);
  const { strikes, balls } = score(game.secret, guess);
  const attempts = game.attempts + 1;
  const status = strikes === game.digits ? 'WON' : attempts === game.maxAttempts ? 'LOST' : 'IN_PROGRESS';
  return {
    ok: true,
    game: { ...game, attempts, status, history: [...game.history, { guess, strikes, balls }] },
    result: {
      guess,
      strikes,
      balls,
      out: strikes === 0 && balls === 0,
      attempts,
      attemptsLeft: game.maxAttempts - attempts,
      status,
      answer: status === 'IN_PROGRESS' ? null : game.secret,
    },
  };
}

export function giveUp(game: Game): { ok: true; game: Game; result: { answer: string; attempts: number; status: 'GAVE_UP' } } | GuessError {
  if (game.status !== 'IN_PROGRESS') return fail('GAME_OVER', '이미 끝난 게임입니다.');
  return {
    ok: true,
    game: { ...game, status: 'GAVE_UP' },
    result: { answer: game.secret, attempts: game.attempts, status: 'GAVE_UP' },
  };
}
