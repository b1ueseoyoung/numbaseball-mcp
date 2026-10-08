import { describe, expect, test } from 'bun:test';
import { applyGuess, createGame, generateSecret, giveUp, score, validateGuess } from '../src/game/baseball.ts';
import type { Difficulty, Digits, Game, GameStatus, GuessErrorCode } from '../src/game/baseball.ts';
import { MAX_ATTEMPTS } from '../src/game/rules.ts';

// 시드 PRNG(mulberry32). 재현 가능한 비밀 수 생성 검사용으로 테스트 안에만 둔다.
function mulberry32(seed: number): () => number {
  let a = seed | 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), a | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// PLAN.md 2단계 판정표: [비밀, 추측, S, B]
const scoreTable: Array<[string, string, number, number]> = [
  ['123', '123', 3, 0],
  ['123', '312', 0, 3],
  ['123', '145', 1, 0],
  ['123', '456', 0, 0],
  ['123', '132', 1, 2],
  ['012', '120', 0, 3],
  ['012', '210', 1, 2],
  ['0123', '3210', 0, 4],
  ['0123', '0132', 2, 2],
  ['0123', '0123', 4, 0], // 4자리 WON: strikes === N(4)이지 3이 아니다
  ['0123', '0124', 3, 0], // 4자리 3S는 아직 IN_PROGRESS
];

describe('판정', () => {
  test.each(scoreTable)('비밀 %s에 추측 %s → %iS %iB', (secret, guess, strikes, balls) => {
    expect(score(secret, guess)).toEqual({ strikes, balls });
  });
});

describe('입력 검증(3자리)', () => {
  const table: Array<[string, GuessErrorCode, string]> = [
    ['12', 'BAD_LENGTH', '3자리로 입력하세요.'],
    ['1234', 'BAD_LENGTH', '3자리로 입력하세요.'],
    ['1a', 'BAD_LENGTH', '3자리로 입력하세요.'], // 길이 검사가 숫자 검사보다 먼저
    ['12a', 'NOT_DIGITS', '0~9 숫자만 입력하세요.'],
    ['-12', 'NOT_DIGITS', '0~9 숫자만 입력하세요.'],
    [' 12', 'NOT_DIGITS', '0~9 숫자만 입력하세요.'], // 앞 공백을 자르지 않는다
    ['１２３', 'NOT_DIGITS', '0~9 숫자만 입력하세요.'], // 전각 숫자
    ['11a', 'NOT_DIGITS', '0~9 숫자만 입력하세요.'], // 숫자 검사가 중복 검사보다 먼저
    ['113', 'DUPLICATE_DIGIT', '같은 숫자를 두 번 쓸 수 없습니다.'],
    ['121', 'DUPLICATE_DIGIT', '같은 숫자를 두 번 쓸 수 없습니다.'], // 떨어진 자리의 중복도 거부
  ];
  test.each(table)('%p → %s', (guess, code, message) => {
    expect(validateGuess(guess, 3)).toEqual({ ok: false, code, message });
  });

  test('규칙에 맞는 추측은 ok', () => {
    expect(validateGuess('012', 3)).toEqual({ ok: true });
    expect(validateGuess('0123', 4)).toEqual({ ok: true });
  });

  test('BAD_LENGTH 메시지는 게임 자릿수를 따른다', () => {
    expect(validateGuess('123', 4)).toEqual({ ok: false, code: 'BAD_LENGTH', message: '4자리로 입력하세요.' });
  });
});

describe('비밀 수 생성', () => {
  // [rng 고정값, 자릿수, 기대]. 0.99면 교환이 한 번도 없고, 0이면 매번 a[0]과 바꾼다.
  const fixed: Array<[number, Digits, string]> = [
    [0.99, 3, '012'],
    [0.99, 4, '0123'],
    [0, 3, '123'],
    [0, 4, '1234'],
  ];
  test.each(fixed)('rng가 늘 %f이면 %i자리 → %s', (value, digits, expected) => {
    expect(generateSecret(digits, () => value)).toBe(expected);
  });

  test.each([3, 4] as const)('mulberry32 시드 0~999, %i자리: 모두 규칙 1을 지키고 하나 이상 0으로 시작', digits => {
    let startsWithZero = 0;
    for (let seed = 0; seed < 1000; seed++) {
      const secret = generateSecret(digits, mulberry32(seed));
      expect(secret).toHaveLength(digits);
      expect(secret).toMatch(/^[0-9]+$/);
      expect(new Set(secret).size).toBe(digits);
      if (secret.startsWith('0')) startsWithZero++;
    }
    expect(startsWithZero).toBeGreaterThan(0);
  });

  test('기본 rng(Math.random)로도 규칙 1을 지킨다', () => {
    expect(validateGuess(generateSecret(3), 3)).toEqual({ ok: true });
    expect(validateGuess(generateSecret(4), 4)).toEqual({ ok: true });
  });
});

function guessOk(game: Game, guess: string) {
  const r = applyGuess(game, guess);
  if (!r.ok) throw new Error(`${guess}: ${r.code}`);
  return r;
}

function quitOk(game: Game) {
  const r = giveUp(game);
  if (!r.ok) throw new Error(r.code);
  return r;
}

const play = (game: Game, guesses: readonly string[]) => guesses.reduce((g, guess) => guessOk(g, guess).game, game);

const hard123 = () => createGame({ digits: 3, difficulty: 'hard', secret: '123' });
// 비밀 123과 다른 유효 추측 7개 = 3자리 hard의 최대 기회
const WRONG = ['456', '789', '045', '067', '089', '046', '047'] as const;
const GAME_OVER = { ok: false, code: 'GAME_OVER', message: '이미 끝난 게임입니다.' } as const;

describe('난이도표', () => {
  const combos: Array<[Digits, Difficulty, number]> = [
    [3, 'easy', 12],
    [3, 'normal', 9],
    [3, 'hard', 7],
    [4, 'easy', 15],
    [4, 'normal', 11],
    [4, 'hard', 8],
  ];
  test.each(combos)('%i자리 %s → maxAttempts %i', (digits, difficulty, maxAttempts) => {
    expect(createGame({ digits, difficulty })).toMatchObject({ digits, difficulty, maxAttempts, attempts: 0, history: [], status: 'IN_PROGRESS' });
    expect(MAX_ATTEMPTS[digits][difficulty]).toBe(maxAttempts);
  });
});

describe('createGame', () => {
  test.each(['113', '12', '1a3'])('규칙 1에 어긋나는 주입 secret %p는 throw', secret => {
    // 메시지는 오류 코드로 끝난다: 주입한 secret을 메시지에 담지 않는다
    expect(() => createGame({ digits: 3, difficulty: 'easy', secret })).toThrow(/규칙 1에 어긋납니다: (BAD_LENGTH|NOT_DIGITS|DUPLICATE_DIGIT)$/);
  });

  test('주입한 secret과 rng를 그대로 쓴다', () => {
    expect(createGame({ digits: 3, difficulty: 'easy', secret: '012' }).secret).toBe('012');
    expect(createGame({ digits: 4, difficulty: 'easy', rng: () => 0.99 }).secret).toBe('0123');
  });
});

describe('게임 진행', () => {
  test.each(scoreTable)('첫 추측: 비밀 %s에 추측 %s → %iS %iB의 out·status·answer', (secret, guess, strikes, balls) => {
    const digits = secret.length === 4 ? 4 : 3;
    const won = strikes === digits;
    const r = guessOk(createGame({ digits, difficulty: 'easy', secret }), guess);
    expect(r.result).toEqual({
      guess,
      strikes,
      balls,
      out: strikes === 0 && balls === 0,
      attempts: 1,
      attemptsLeft: MAX_ATTEMPTS[digits].easy - 1,
      status: won ? 'WON' : 'IN_PROGRESS',
      answer: won ? secret : null,
    });
    expect(r.game).toMatchObject({ attempts: 1, status: won ? 'WON' : 'IN_PROGRESS', history: [{ guess, strikes, balls }] });
  });

  test('잘못된 추측과 ALREADY_GUESSED는 기회를 차감하지 않는다', () => {
    const g0 = hard123();
    expect(applyGuess(g0, '12')).toMatchObject({ ok: false, code: 'BAD_LENGTH' });
    expect(applyGuess(g0, '12a')).toMatchObject({ ok: false, code: 'NOT_DIGITS' });
    expect(applyGuess(g0, '113')).toMatchObject({ ok: false, code: 'DUPLICATE_DIGIT' });
    const r1 = guessOk(g0, '456');
    expect(r1.result).toMatchObject({ attempts: 1, attemptsLeft: 6, out: true, status: 'IN_PROGRESS', answer: null });
    expect(applyGuess(r1.game, '456')).toEqual({ ok: false, code: 'ALREADY_GUESSED', message: '이미 추측한 숫자입니다: 456' });
    expect(r1.game.attempts).toBe(1);
    expect(guessOk(r1.game, '789').result).toMatchObject({ attempts: 2, attemptsLeft: 5 });
  });

  test('마지막 기회에 정답을 맞히면 WON', () => {
    const g = play(hard123(), WRONG.slice(0, 6));
    expect(g).toMatchObject({ attempts: 6, status: 'IN_PROGRESS' });
    const r = guessOk(g, '123');
    expect(r.result).toEqual({ guess: '123', strikes: 3, balls: 0, out: false, attempts: 7, attemptsLeft: 0, status: 'WON', answer: '123' });
    expect(r.game.status).toBe('WON');
  });

  test('마지막 기회에 틀리면 LOST가 되고 정답이 공개된다', () => {
    const sixth = guessOk(play(hard123(), WRONG.slice(0, 5)), WRONG[5]);
    expect(sixth.result).toMatchObject({ attempts: 6, attemptsLeft: 1, status: 'IN_PROGRESS', answer: null });
    const last = guessOk(sixth.game, WRONG[6]);
    expect(last.result).toMatchObject({ attempts: 7, attemptsLeft: 0, status: 'LOST', answer: '123' });
    expect(last.game.status).toBe('LOST');
  });

  const finished: Array<[GameStatus, () => Game]> = [
    ['WON', () => guessOk(hard123(), '123').game],
    ['LOST', () => play(hard123(), WRONG)],
    ['GAVE_UP', () => quitOk(hard123()).game],
  ];
  test.each(finished)('끝난 게임(%s)에 추측 12a·12·456과 포기는 모두 GAME_OVER', (status, make) => {
    const g = make();
    expect(g.status).toBe(status);
    expect(applyGuess(g, '12a')).toEqual(GAME_OVER);
    expect(applyGuess(g, '12')).toEqual(GAME_OVER);
    expect(applyGuess(g, '456')).toEqual(GAME_OVER);
    expect(giveUp(g)).toEqual(GAME_OVER);
  });

  test('포기하면 GAVE_UP이고 정답·attempts를 돌려주며, 그 뒤 포기하면 GAME_OVER', () => {
    const r = quitOk(guessOk(hard123(), '456').game);
    expect(r.result).toEqual({ answer: '123', attempts: 1, status: 'GAVE_UP' });
    expect(r.game.status).toBe('GAVE_UP');
    expect(giveUp(r.game)).toEqual(GAME_OVER);
  });
});

describe('불변성', () => {
  test('applyGuess와 giveUp은 인자 game을 바꾸지 않고 새 Game을 돌려준다', () => {
    const g = hard123();
    const snapshot = structuredClone(g);
    const r = guessOk(g, '456');
    expect(r.game).not.toBe(g);
    expect(r.game.history).not.toBe(g.history);
    expect(g).toEqual(snapshot);
    const q = quitOk(r.game);
    expect(q.game).not.toBe(r.game);
    expect(r.game.status).toBe('IN_PROGRESS');
    expect(g).toEqual(snapshot);
  });
});
