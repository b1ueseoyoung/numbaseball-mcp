import type { Difficulty, Digits } from './baseball.ts';

export const MAX_ATTEMPTS: Record<Digits, Record<Difficulty, number>> = {
  3: { easy: 12, normal: 9, hard: 7 },
  4: { easy: 15, normal: 11, hard: 8 },
};

export const RULES_MARKDOWN = `# 숫자야구 규칙

1. **비밀 수:** 자릿수 N은 3 또는 4입니다. 각 자리는 0~9이고 모두 서로 다릅니다. 0으로 시작해도 됩니다(예: \`012\`).
2. **추측 형식:** 추측은 문자열로 받습니다. 정확히 \`[0-9]\` N글자여야 합니다. 공백, 부호, 전각 숫자는 거부하고, 앞뒤 공백도 자르지 않고 거부합니다.
3. **추측 중복:** 추측도 모든 자리가 서로 달라야 합니다. \`113\`은 거부합니다.
4. **판정:** 같은 자리에 같은 숫자가 있으면 스트라이크(S), 숫자는 있지만 자리가 다르면 볼(B)입니다. S와 B가 모두 0이면 아웃입니다.
5. **검사 순서(고정):** \`GAME_OVER → BAD_LENGTH → NOT_DIGITS → DUPLICATE_DIGIT → ALREADY_GUESSED → 판정\`
6. **승패:** 판정 뒤 스트라이크가 N개면 WON입니다. 마지막 기회여도 WON입니다. 그렇지 않고 유효 추측 수가 최대 기회에 이르면 LOST입니다.
7. **기회 차감:** 5번 순서의 오류(GAME_OVER 제외)는 기회를 차감하지 않습니다. 유효 추측 수(attempts)는 이번 추측을 포함합니다.
8. **끝난 게임:** WON, LOST, GAVE_UP인 게임에 추측하거나 포기하면 GAME_OVER입니다.
9. **최대 기회:**

| 자릿수 | easy | normal | hard |
|---|---|---|---|
| 3 | ${MAX_ATTEMPTS[3].easy} | ${MAX_ATTEMPTS[3].normal} | ${MAX_ATTEMPTS[3].hard} |
| 4 | ${MAX_ATTEMPTS[4].easy} | ${MAX_ATTEMPTS[4].normal} | ${MAX_ATTEMPTS[4].hard} |

10. **비밀 수 생성:** rng는 [0,1) 값을 돌려줍니다. a = [0..9]에서 i = 9..1에 대해 j = floor(rng() × (i+1))로 a[i]와 a[j]를 바꾼 뒤 앞 N개를 씁니다.
`;
