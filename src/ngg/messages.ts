// 출처: https://github.com/portal-labs-infrastructure/number-guessing-game-mcp-server (커밋 45d6900)
// MIT License, Copyright (c) 2025 Portal Labs Infrastructure
// 응답 문구만 원문 그대로 옮김. 코드 구조는 옮기지 않았다.

// lobby.state.ts:56
export const WELCOME = (playerName: string, min: number, max: number, attempts: number) =>
  `Welcome, ${playerName}! Guess ${min}-${max}. ${attempts} attempts.`;
// playing.state.ts:90
export const TOO_LOW = (attemptsLeft: number) => `Too low! ${attemptsLeft} attempts left.`;
export const TOO_HIGH = (attemptsLeft: number) => `Too high! ${attemptsLeft} attempts left.`;
// playing.state.ts:70
export const CONGRATS = (playerName: string, secret: number, attemptsTaken: number) =>
  `🎉 Congrats, ${playerName}! Guessed ${secret} in ${attemptsTaken} attempts! 🎉`;
// playing.state.ts:79
export const GAME_OVER = (playerName: string, secret: number) =>
  `Game Over, ${playerName}. Number was ${secret}.`;
// playing.state.ts:114
export const GAVE_UP = (playerName: string, secret: number) =>
  `Game over. ${playerName} gave up. Number was ${secret}.`;

// lobby.state.ts:72
export const ERR_NOT_STARTED = "Error: Game has not started yet. Use 'start_game'.";
// lobby.state.ts:80
export const ERR_NO_ACTIVE_GAME = 'Error: No active game to give up.';
// playing.state.ts:44
export const ERR_ALREADY_PLAYING = "Error: Game is already in progress. Use 'make_guess' or 'give_up'.";
// playing.state.ts:57
export const ERR_NO_GAME_IN_PROGRESS = 'Error: No game in progress. Returning to lobby.';
// playing.state.ts:111
export const ERR_NO_GAME_TO_GIVE_UP = 'Error: No game to give up.';
