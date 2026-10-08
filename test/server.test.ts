import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import type { Client, ElicitRequest, ElicitResult, JSONRPCMessage, MessageExtraInfo } from '@modelcontextprotocol/client';
import { buildServer } from '../src/server.ts';
import { createCounter, ERAS } from './helpers.ts';

describe.each(ERAS)('%s', (era, connect) => {
  let close: (() => Promise<void>) | undefined;

  afterEach(async () => {
    await close?.();
    close = undefined;
  });

  async function open(secretFor: (digits: 3 | 4) => string = d => (d === 3 ? '012' : '0123')) {
    const conn = await connect(() => buildServer({ secretFor }));
    close = conn.close;
    return conn.client;
  }

  test('협상된 시대가 맞다', async () => {
    const client = await open();
    expect(client.getProtocolEra()).toBe(era);
  });

  // 3-1: 상태별 tool on/off와 guess 동적 스키마 (secret 012, start_game은 항상 두 인자 모두)
  const toolNames = async (client: Client) => (await client.listTools()).tools.map(t => t.name).sort();
  const start = (client: Client) => client.callTool({ name: 'start_game', arguments: { digits: 3, difficulty: 'normal' } });
  const guess = (client: Client, g: string) => client.callTool({ name: 'guess', arguments: { guess: g } });
  const giveUp = (client: Client) => client.callTool({ name: 'give_up', arguments: {} });
  const firstText = (result: { content: unknown }) => (result.content as Array<{ type: string; text?: string }>)[0]?.text;
  const guessDescription = async (client: Client) => (await client.listTools()).tools.find(t => t.name === 'guess')?.description;
  const guessParam = async (client: Client) => (await client.listTools()).tools.find(t => t.name === 'guess')?.inputSchema.properties?.guess;

  test('상태별 tools/list: LOBBY는 start_game, 게임 중은 give_up·guess, give_up 뒤 다시 start_game', async () => {
    const client = await open();
    expect(await toolNames(client)).toEqual(['start_game']);
    expect(firstText(await start(client))).toBe('새 게임 g1: 3자리, 난이도 normal, 기회 9번');
    expect(await toolNames(client)).toEqual(['give_up', 'guess']);
    await giveUp(client);
    expect(await toolNames(client)).toEqual(['start_game']);
  });

  test('꺼진 tool 호출은 disabled로 reject: LOBBY의 guess, 게임 중 start_game', async () => {
    const client = await open();
    await expect(guess(client, '345')).rejects.toThrow(/disabled/);
    await start(client);
    await expect(start(client)).rejects.toThrow(/disabled/);
  });

  test('tools/list_changed 알림이 start_game과 give_up 뒤에 각각 1개 이상 온다', async () => {
    const client = await open();
    const counter = createCounter();
    client.setNotificationHandler('notifications/tools/list_changed', () => counter.bump());
    if (era === 'modern') {
      const sub = await client.listen({ toolsListChanged: true });
      const closeConn = close;
      close = async () => { await sub.close(); await closeConn?.(); };
    }
    await start(client);
    await counter.waitFor(1);
    await client.listTools();
    const afterStart = counter.value;
    await giveUp(client);
    await counter.waitFor(afterStart + 1);
    await client.listTools();
    console.error(`[obs] ${era} tools/list_changed: after start_game=${afterStart}, after give_up=${counter.value}`);
    expect(afterStart).toBeGreaterThanOrEqual(1);
    expect(counter.value - afterStart).toBeGreaterThanOrEqual(1);
  });

  test('guess 설명에 자릿수와 남은 기회가 보이고 추측마다 줄어든다', async () => {
    const client = await open();
    await start(client);
    const atStart = await guessDescription(client);
    expect(atStart).toContain('3자리');
    expect(atStart).toContain('남은 기회 9번');
    expect(firstText(await guess(client, '345'))).toBe('345 → 아웃 (남은 기회 8)');
    expect(await guessDescription(client)).toContain('남은 기회 8번');
    expect(firstText(await guess(client, '102'))).toBe('102 → 1S 2B (남은 기회 7)');
    expect(await guessDescription(client)).toContain('남은 기회 7번');
    expect(firstText(await guess(client, '201'))).toBe('201 → 0S 3B (남은 기회 6)');
    expect(await guessDescription(client)).toContain('남은 기회 6번');
  });

  test('guess 설명·중간 결과에 정답 012가 없고, 3자리 guess 파라미터 스키마가 정확하다', async () => {
    const client = await open();
    await start(client);
    expect(await guessDescription(client)).not.toContain('012');
    expect(await guessParam(client)).toEqual({ type: 'string', minLength: 3, maxLength: 3, description: '3자리 숫자 문자열' });
    const first = firstText(await guess(client, '345'));
    expect(first).toBe('345 → 아웃 (남은 기회 8)');
    expect(first).not.toContain('012');
    expect(await guessDescription(client)).not.toContain('012');
    const second = firstText(await guess(client, '102'));
    expect(second).toBe('102 → 1S 2B (남은 기회 7)');
    expect(second).not.toContain('012');
  });

  test('4자리 hard 게임: 시작 문구·guess 설명·스키마가 4자리를 따르고 기회는 8번', async () => {
    const client = await open();
    expect(firstText(await client.callTool({ name: 'start_game', arguments: { digits: 4, difficulty: 'hard' } }))).toBe('새 게임 g1: 4자리, 난이도 hard, 기회 8번');
    const description = await guessDescription(client);
    expect(description).toContain('4자리');
    expect(description).toContain('남은 기회 8번');
    expect(await guessParam(client)).toEqual({ type: 'string', minLength: 4, maxLength: 4, description: '4자리 숫자 문자열' });
    expect(firstText(await guess(client, '0123'))).toBe('정답! 1번 만에 맞혔다');
  });

  test("길이가 틀린 '12'는 SDK 입력 검증 오류", async () => {
    const client = await open();
    await start(client);
    const result = await guess(client, '12');
    expect(result.isError).toBe(true);
    expect(firstText(result)).toStartWith('Input validation error: Invalid arguments for tool guess');
  });

  // todo 30: 5장 start_game 입력(선택 digits 3..4 정수·difficulty enum)과 오류표 'tool 입력이 inputSchema 위반'의 start_game 쪽 빈칸
  test("start_game 입력 위반(digits 5, difficulty 'expert', 문자열 digits '3')은 SDK 입력 검증 오류이고 LOBBY 유지, 다음 정상 시작은 g1", async () => {
    const client = await open();
    for (const args of [{ digits: 5, difficulty: 'normal' }, { digits: 3, difficulty: 'expert' }, { digits: '3', difficulty: 'normal' }]) {
      const result = await client.callTool({ name: 'start_game', arguments: args });
      expect(result.isError).toBe(true);
      expect(firstText(result)).toStartWith('Input validation error: Invalid arguments for tool start_game');
      expect(result.structuredContent).toBeUndefined();
      expect(await toolNames(client)).toEqual(['start_game']);
    }
    expect((await start(client)).structuredContent).toEqual({ gameId: 'g1', digits: 3, difficulty: 'normal', maxAttempts: 9 });
  });

  test('규칙 위반은 isError와 한국어 메시지이고 기회를 쓰지 않는다', async () => {
    const client = await open();
    await start(client);
    const notDigits = await guess(client, '1a2');
    expect(notDigits.isError).toBe(true);
    expect(firstText(notDigits)).toBe('0~9 숫자만 입력하세요.');
    const duplicate = await guess(client, '113');
    expect(duplicate.isError).toBe(true);
    expect(firstText(duplicate)).toBe('같은 숫자를 두 번 쓸 수 없습니다.');
    expect(await guessDescription(client)).toContain('남은 기회 9번');
    await guess(client, '345');
    const repeated = await guess(client, '345');
    expect(repeated.isError).toBe(true);
    expect(firstText(repeated)).toBe('이미 추측한 숫자입니다: 345');
    expect(await guessDescription(client)).toContain('남은 기회 8번');
  });

  test('정답을 맞히면 WON으로 끝나 LOBBY로 돌아가고, 다음 게임은 g2', async () => {
    const client = await open();
    await start(client);
    expect(firstText(await guess(client, '012'))).toBe('정답! 1번 만에 맞혔다');
    expect(await toolNames(client)).toEqual(['start_game']);
    expect(firstText(await start(client))).toBe('새 게임 g2: 3자리, 난이도 normal, 기회 9번');
    expect(firstText(await giveUp(client))).toBe('포기. 정답은 012');
    expect(await toolNames(client)).toEqual(['start_game']);
  });

  test('기회를 다 쓰면 LOST로 끝나고 정답을 알려준다', async () => {
    const client = await open();
    await start(client);
    const wrong = ['345', '346', '347', '348', '349', '356', '357', '358'];
    for (const [i, g] of wrong.entries()) expect(firstText(await guess(client, g))).toBe(`${g} → 아웃 (남은 기회 ${8 - i})`);
    expect(firstText(await guess(client, '359'))).toBe('실패. 정답은 012');
    expect(await toolNames(client)).toEqual(['start_game']);
  });

  test('주입 secret이 규칙 1에 어긋나면 start_game은 isError이고 LOBBY 유지, gameNo를 쓰지 않는다', async () => {
    let calls = 0;
    const client = await open(() => (++calls === 1 ? '98' : '012'));
    const failed = await start(client);
    expect(failed.isError).toBe(true);
    expect(firstText(failed)).toBe('주입한 secret이 규칙 1에 어긋납니다: BAD_LENGTH');
    expect(await toolNames(client)).toEqual(['start_game']);
    expect(firstText(await start(client))).toBe('새 게임 g1: 3자리, 난이도 normal, 기회 9번');
  });

  // 3-2: outputSchema·structuredContent·isError (secret 012, content 문구는 3-1 그대로)
  const outputSchema = async (client: Client, name: string) => (await client.listTools()).tools.find(t => t.name === name)?.outputSchema;

  test('정상 추측의 structuredContent: IN_PROGRESS와 WON(g1), LOST(g2)', async () => {
    const client = await open();
    await start(client);
    const inProgress = await guess(client, '102');
    expect(inProgress.isError).toBeFalsy();
    expect(firstText(inProgress)).toBe('102 → 1S 2B (남은 기회 8)');
    expect(inProgress.structuredContent).toEqual({ gameId: 'g1', guess: '102', strikes: 1, balls: 2, out: false, attempts: 1, attemptsLeft: 8, status: 'IN_PROGRESS', answer: null });
    expect((await guess(client, '345')).structuredContent).toEqual({ gameId: 'g1', guess: '345', strikes: 0, balls: 0, out: true, attempts: 2, attemptsLeft: 7, status: 'IN_PROGRESS', answer: null });
    const won = await guess(client, '012');
    expect(firstText(won)).toBe('정답! 3번 만에 맞혔다');
    expect(won.structuredContent).toEqual({ gameId: 'g1', guess: '012', strikes: 3, balls: 0, out: false, attempts: 3, attemptsLeft: 6, status: 'WON', answer: '012' });
    await start(client);
    for (const g of ['345', '346', '347', '348', '349', '356', '357', '358']) await guess(client, g);
    const lost = await guess(client, '359');
    expect(firstText(lost)).toBe('실패. 정답은 012');
    expect(lost.structuredContent).toEqual({ gameId: 'g2', guess: '359', strikes: 0, balls: 0, out: true, attempts: 9, attemptsLeft: 0, status: 'LOST', answer: '012' });
  });

  // 관측으로 정함: EV/task-7-iserror-outputschema.txt (outputSchema가 있어도 isError 결과는 structuredContent 없이 두 시대 모두 받아들여진다)
  test("'113'·'12a'·반복 추측은 isError이고 structuredContent가 없으며, 다음 추측의 attempts로 기회가 그대로임을 본다", async () => {
    const client = await open();
    await start(client);
    for (const bad of ['113', '12a']) {
      const result = await guess(client, bad);
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toBeUndefined();
    }
    expect((await guess(client, '345')).structuredContent).toMatchObject({ attempts: 1, attemptsLeft: 8 });
    const repeated = await guess(client, '345');
    expect(repeated.isError).toBe(true);
    expect(firstText(repeated)).toBe('이미 추측한 숫자입니다: 345');
    expect(repeated.structuredContent).toBeUndefined();
    expect((await guess(client, '346')).structuredContent).toMatchObject({ attempts: 2, attemptsLeft: 7 });
  });

  test('start_game structuredContent: 난이도 6조합의 maxAttempts 12/9/7/15/11/8과 gameId g1~g6', async () => {
    const client = await open();
    const combos = [[3, 'easy', 12], [3, 'normal', 9], [3, 'hard', 7], [4, 'easy', 15], [4, 'normal', 11], [4, 'hard', 8]] as const;
    for (const [i, [digits, difficulty, maxAttempts]] of combos.entries()) {
      const result = await client.callTool({ name: 'start_game', arguments: { digits, difficulty } });
      expect(result.isError).toBeFalsy();
      expect(firstText(result)).toBe(`새 게임 g${i + 1}: ${digits}자리, 난이도 ${difficulty}, 기회 ${maxAttempts}번`);
      expect(result.structuredContent).toEqual({ gameId: `g${i + 1}`, digits, difficulty, maxAttempts });
      await giveUp(client);
    }
  });

  test('give_up structuredContent: gameId, 정답, 유효 추측 수, GAVE_UP', async () => {
    const client = await open();
    await start(client);
    await guess(client, '345');
    await guess(client, '113'); // 규칙 위반은 attempts에 안 들어간다
    await guess(client, '102');
    const result = await giveUp(client);
    expect(firstText(result)).toBe('포기. 정답은 012');
    expect(result.structuredContent).toEqual({ gameId: 'g1', answer: '012', attempts: 2, status: 'GAVE_UP' });
  });

  test('진행 중 결과(IN_PROGRESS)와 모든 오류 문구에 정답 012가 없다', async () => {
    const client = await open();
    const texts = [firstText(await start(client))];
    for (const g of ['12', '12a', '113', '345', '345', '102', '201']) texts.push(firstText(await guess(client, g)));
    expect(texts).toHaveLength(8);
    for (const t of texts) {
      expect(t).toBeString();
      expect(t).not.toContain('012');
    }
  });

  // todo 30: 비밀 규칙 '로그'와 로그 규칙 'console.error로만'의 빈칸. console.error·console.log를 감시(원래 출력은 유지)해
  // 끝맺음 세 가지(give_up·WON·LOST)를 모두 지나는 동안 찍힌 줄에 정답이 없고 console.log는 한 번도 불리지 않음을 본다
  test('로그는 console.error로만 찍히고 정답 012가 없다: give_up·WON·LOST로 끝나는 세 판 동안 찍힌 줄 전부', async () => {
    const spy = spyOn(console, 'error');
    const logSpy = spyOn(console, 'log');
    try {
      const client = await open();
      await start(client);
      await guess(client, '113');
      await guess(client, '345');
      await giveUp(client);
      await start(client);
      expect(firstText(await guess(client, '012'))).toBe('정답! 1번 만에 맞혔다');
      await start(client);
      let last: string | undefined;
      for (const g of ['345', '346', '347', '348', '349', '356', '357', '358', '359']) last = firstText(await guess(client, g));
      expect(last).toBe('실패. 정답은 012');
      const lines = spy.mock.calls.map(args => args.map(String).join(' '));
      expect(lines.length).toBeGreaterThan(0); // 상태 전이 로그가 적어도 하나는 찍힌다
      for (const line of lines) expect(line).not.toContain('012');
      expect(logSpy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
      logSpy.mockRestore();
    }
  });

  // 관측으로 정함: 두 시대 모두 같은 JSON을 내보내고 $schema 키 위치만 다르다. $schema는 단언하지 않는다.
  test('tools/list에 세 tool의 outputSchema가 보인다(루트 object, required 키, 속성별 JSON, additionalProperties false)', async () => {
    const client = await open();
    const startSchema = await outputSchema(client, 'start_game');
    expect(startSchema?.type).toBe('object');
    expect(startSchema?.required).toEqual(['gameId', 'digits', 'difficulty', 'maxAttempts']);
    expect(startSchema?.properties).toEqual({
      gameId: { type: 'string' },
      digits: { type: 'number' },
      difficulty: { type: 'string', enum: ['easy', 'normal', 'hard'] },
      maxAttempts: { type: 'number' },
    });
    expect(startSchema?.additionalProperties).toBe(false);
    await start(client);
    const guessSchema = await outputSchema(client, 'guess');
    expect(guessSchema?.type).toBe('object');
    expect(guessSchema?.required).toEqual(['gameId', 'guess', 'strikes', 'balls', 'out', 'attempts', 'attemptsLeft', 'status', 'answer']);
    expect(guessSchema?.properties).toEqual({
      gameId: { type: 'string' },
      guess: { type: 'string' },
      strikes: { type: 'number' },
      balls: { type: 'number' },
      out: { type: 'boolean' },
      attempts: { type: 'number' },
      attemptsLeft: { type: 'number' },
      status: { type: 'string', enum: ['IN_PROGRESS', 'WON', 'LOST'] },
      answer: { type: ['string', 'null'] },
    });
    expect(guessSchema?.additionalProperties).toBe(false);
    const giveUpSchema = await outputSchema(client, 'give_up');
    expect(giveUpSchema?.type).toBe('object');
    expect(giveUpSchema?.required).toEqual(['gameId', 'answer', 'attempts', 'status']);
    expect(giveUpSchema?.properties).toEqual({
      gameId: { type: 'string' },
      answer: { type: 'string' },
      attempts: { type: 'number' },
      status: { type: 'string', const: 'GAVE_UP' },
    });
    expect(giveUpSchema?.additionalProperties).toBe(false);
  });

  // todo 30: 5장 start_game 설명·입력 스키마, guess 설명 전문, give_up 입력 z.object({})의 빈칸
  test('tools/list 원문: start_game 설명과 inputSchema(선택 digits 3..4 정수·difficulty enum), guess 설명 전문, give_up의 빈 inputSchema가 5장과 같다', async () => {
    const client = await open();
    const tool = async (name: string) => (await client.listTools()).tools.find(t => t.name === name);
    const startTool = await tool('start_game');
    expect(startTool?.description).toBe('숫자야구 새 게임을 시작한다. digits와 difficulty는 사용자가 직접 말한 경우에만 채운다. 비우면 서버가 사용자에게 묻는다.');
    expect(startTool?.inputSchema.type).toBe('object');
    expect(startTool?.inputSchema.properties).toEqual({ digits: { type: 'integer', minimum: 3, maximum: 4 }, difficulty: { type: 'string', enum: ['easy', 'normal', 'hard'] } });
    expect(startTool?.inputSchema.required).toBeUndefined(); // 둘 다 선택
    await start(client);
    expect(await guessDescription(client)).toBe('3자리 숫자를 추측한다. 0~9, 자리끼리 중복 없음, 0으로 시작 가능. 남은 기회 9번.');
    const giveUpTool = await tool('give_up');
    expect(giveUpTool?.inputSchema.type).toBe('object');
    expect(giveUpTool?.inputSchema.properties).toEqual({});
    expect(giveUpTool?.inputSchema.required).toBeUndefined();
  });

  // 3-3: resources (secret 012). 정답 유출 검사는 current·games만 본다. rules 본문에는 예시 '012'가 있다
  const resourceNames = async (client: Client) => (await client.listResources()).resources.map(r => r.name).sort();
  const read = (client: Client, uri: string) => client.readResource({ uri });
  const firstContents = (result: { contents: unknown }) => (result.contents as Array<{ uri: string; mimeType?: string; text?: string }>)[0];
  // application/json 리소스를 읽어 원문(유출 검사용)과 파싱 결과를 함께 돌려준다
  const readJson = async (client: Client, uri: string) => {
    const c = firstContents(await read(client, uri));
    expect(c?.mimeType).toBe('application/json');
    return { text: c?.text ?? '', json: JSON.parse(c?.text ?? 'null') as Record<string, unknown> };
  };
  const outs = (guesses: string[]) => guesses.map(guess => ({ guess, strikes: 0, balls: 0 }));

  test('numbaseball://rules read: text/markdown이고 규칙 문구가 있다', async () => {
    const client = await open();
    const rules = firstContents(await read(client, 'numbaseball://rules'));
    expect(rules?.uri).toBe('numbaseball://rules');
    expect(rules?.mimeType).toBe('text/markdown');
    expect(rules?.text).toContain('스트라이크');
  });

  // todo 30 독립 검토 보강: 5장 resources 'blob은 쓰지 않음'. SDK 클라이언트는 결과를 파싱하며 blob 키를 버리므로
  // (관측: 변이로 blob을 넣으면 와이어에는 있고 readResource 결과에는 없다) 클라이언트 transport가 받은 원문 메시지를 본다
  test('resources/read 와이어: rules·current·games/g1의 contents는 uri·mimeType·text뿐이고 blob이 없다', async () => {
    const client = await open();
    const transport = client.transport!;
    const wire: JSONRPCMessage[] = [];
    const deliver = transport.onmessage;
    transport.onmessage = (message: JSONRPCMessage, extra?: MessageExtraInfo) => {
      wire.push(message);
      deliver?.(message, extra);
    };
    await read(client, 'numbaseball://rules');
    await start(client);
    await read(client, 'numbaseball://current');
    await read(client, 'numbaseball://games/g1');
    const contents = wire.flatMap(m => ('result' in m && 'contents' in m.result ? [m.result.contents as Array<Record<string, unknown>>] : []));
    expect(contents).toHaveLength(3);
    for (const c of contents) {
      expect(c).toHaveLength(1);
      expect(Object.keys(c[0] ?? {}).sort()).toEqual(['mimeType', 'text', 'uri']);
    }
  });

  // todo 30: resources 표 rules 행 '규칙 1~10과 난이도표'의 빈칸
  test('numbaseball://rules 본문에 번호 규칙 1~10과 난이도표 행(3: 12/9/7, 4: 15/11/8)이 있다', async () => {
    const client = await open();
    const text = firstContents(await read(client, 'numbaseball://rules'))?.text ?? '';
    for (let i = 1; i <= 10; i++) expect(text).toContain(`\n${i}. **`);
    expect(text).toContain('| 3 | 12 | 9 | 7 |');
    expect(text).toContain('| 4 | 15 | 11 | 8 |');
  });

  test('resources/templates/list에 numbaseball://games/{gameId}가 name game으로 있다', async () => {
    const client = await open();
    const templates = (await client.listResourceTemplates()).resourceTemplates.map(t => ({ name: t.name, title: t.title, uriTemplate: t.uriTemplate, mimeType: t.mimeType }));
    expect(templates).toEqual([{ name: 'game', title: '게임 기록', uriTemplate: 'numbaseball://games/{gameId}', mimeType: 'application/json' }]);
  });

  // todo 30: 노출표 'template numbaseball://games/{gameId}'의 PLAYING 칸
  test('resources/templates/list는 게임 중과 give_up 뒤에도 numbaseball://games/{gameId} 하나다', async () => {
    const client = await open();
    const templates = async () => (await client.listResourceTemplates()).resourceTemplates.map(t => t.uriTemplate);
    await start(client);
    expect(await templates()).toEqual(['numbaseball://games/{gameId}']);
    await giveUp(client);
    expect(await templates()).toEqual(['numbaseball://games/{gameId}']);
  });

  test('상태별 resources/list: LOBBY는 rules, 게임 중은 current·game g1·rules, give_up 뒤 game g1·rules', async () => {
    const client = await open();
    expect(await resourceNames(client)).toEqual(['rules']);
    await start(client);
    expect(await resourceNames(client)).toEqual(['current', 'game g1', 'rules']);
    // 관측으로 정함: EV/task-25-test.txt (두 시대 모두 목록 항목에 name·title·uri·mimeType가 온다)
    const entries = (await client.listResources()).resources.map(({ name, title, uri, mimeType }) => ({ name, title, uri, mimeType })).sort((a, b) => a.name.localeCompare(b.name));
    expect(entries).toEqual([
      { name: 'current', title: '현재 게임', uri: 'numbaseball://current', mimeType: 'application/json' },
      { name: 'game g1', title: '게임 기록', uri: 'numbaseball://games/g1', mimeType: 'application/json' },
      { name: 'rules', title: '숫자야구 규칙', uri: 'numbaseball://rules', mimeType: 'text/markdown' },
    ]);
    await giveUp(client);
    expect(await resourceNames(client)).toEqual(['game g1', 'rules']);
  });

  test("진행 중 current·games/g1 read: 추측 '345' 뒤의 보기이고 answer 키와 정답 012가 없다", async () => {
    const client = await open();
    await start(client);
    await guess(client, '345');
    const expected = { gameId: 'g1', digits: 3, difficulty: 'normal', attempts: 1, attemptsLeft: 8, history: [{ guess: '345', strikes: 0, balls: 0 }] };
    const current = await readJson(client, 'numbaseball://current');
    expect(current.json).toEqual(expected);
    expect(current.text).not.toContain('012');
    const g1 = await readJson(client, 'numbaseball://games/g1');
    expect(g1.json).toEqual({ ...expected, status: 'IN_PROGRESS' });
    expect(Object.keys(g1.json)).not.toContain('answer');
    expect(g1.text).not.toContain('012');
  });

  test('give_up 뒤 games/g1은 GAVE_UP과 정답 012, current는 목록에서 사라지고 read는 disabled로 reject', async () => {
    const client = await open();
    await start(client);
    await guess(client, '345');
    await guess(client, '102');
    await giveUp(client);
    expect((await readJson(client, 'numbaseball://games/g1')).json).toEqual({ gameId: 'g1', digits: 3, difficulty: 'normal', attempts: 2, attemptsLeft: 7, history: [{ guess: '345', strikes: 0, balls: 0 }, { guess: '102', strikes: 1, balls: 2 }], status: 'GAVE_UP', answer: '012' });
    expect(await resourceNames(client)).toEqual(['game g1', 'rules']);
    await expect(read(client, 'numbaseball://current')).rejects.toThrow(/disabled/);
  });

  // todo 30: 오류표 '꺼진 tool 호출'·'꺼진 resource read'의 code -32602 빈칸
  test('꺼진 tool·resource의 프로토콜 에러 code: LOBBY의 guess 호출과 current read는 -32602이고 message에 disabled', async () => {
    const client = await open();
    const codeOf = (p: Promise<unknown>) => p.then(() => undefined, (e: unknown) => e as { code?: number; message?: string });
    const tool = await codeOf(guess(client, '345'));
    const resource = await codeOf(read(client, 'numbaseball://current'));
    console.error(`[obs] ${era} disabled tool: code=${tool?.code} message=${tool?.message}; disabled resource: code=${resource?.code} message=${resource?.message}`);
    expect(tool?.code).toBe(-32602);
    expect(tool?.message).toMatch(/disabled/);
    expect(resource?.code).toBe(-32602);
    expect(resource?.message).toMatch(/disabled/);
  });

  test('끝난 게임 기록: WON(g1)과 LOST(g2)의 games/<id>에 status와 answer 012가 있다', async () => {
    const client = await open();
    await start(client);
    await guess(client, '012');
    expect((await readJson(client, 'numbaseball://games/g1')).json).toEqual({ gameId: 'g1', digits: 3, difficulty: 'normal', attempts: 1, attemptsLeft: 8, history: [{ guess: '012', strikes: 3, balls: 0 }], status: 'WON', answer: '012' });
    await start(client);
    // g2 진행 중: current는 g2를 가리키고, 끝난 g1은 answer를 유지하며 진행 중인 g2에는 answer 키가 없다
    expect((await readJson(client, 'numbaseball://current')).json).toMatchObject({ gameId: 'g2', attempts: 0, attemptsLeft: 9 });
    expect((await readJson(client, 'numbaseball://games/g1')).json).toMatchObject({ status: 'WON', answer: '012' });
    expect(Object.keys((await readJson(client, 'numbaseball://games/g2')).json)).not.toContain('answer');
    const wrong = ['345', '346', '347', '348', '349', '356', '357', '358', '359'];
    for (const g of wrong) await guess(client, g);
    expect((await readJson(client, 'numbaseball://games/g2')).json).toEqual({ gameId: 'g2', digits: 3, difficulty: 'normal', attempts: 9, attemptsLeft: 0, history: outs(wrong), status: 'LOST', answer: '012' });
    expect(await resourceNames(client)).toEqual(['game g1', 'game g2', 'rules']);
  });

  // todo 30: 상태 머신 'guess 정답(마지막 기회 포함) → LOBBY(WON)'의 마지막 기회 경로(서버 쪽)
  test('마지막 기회에 정답을 맞혀도 WON(attemptsLeft 0, answer 012)으로 끝나 LOBBY로 돌아가고 games/g1은 WON', async () => {
    const client = await open();
    await start(client);
    for (const g of ['345', '346', '347', '348', '349', '356', '357', '358']) await guess(client, g);
    const won = await guess(client, '012');
    expect(firstText(won)).toBe('정답! 9번 만에 맞혔다');
    expect(won.structuredContent).toEqual({ gameId: 'g1', guess: '012', strikes: 3, balls: 0, out: false, attempts: 9, attemptsLeft: 0, status: 'WON', answer: '012' });
    expect(await toolNames(client)).toEqual(['start_game']);
    expect((await readJson(client, 'numbaseball://games/g1')).json).toMatchObject({ status: 'WON', answer: '012', attempts: 9, attemptsLeft: 0 });
  });

  test('없는 games/g99 read는 reject한다(오류 code는 [obs]로 기록)', async () => {
    const client = await open();
    const error = await read(client, 'numbaseball://games/g99').then(() => undefined, (e: unknown) => e as { code?: number; message?: string; data?: { uri?: string } });
    console.error(`[obs] ${era} games/g99 error code=${error?.code} message=${error?.message}`);
    expect(error).toBeDefined();
    // 관측으로 정함: EV/task-25-test.txt (두 시대 모두 ResourceNotFoundError: code -32602, data.uri)
    expect(error?.code).toBe(-32602);
    expect(error?.message).toMatch(/not found/);
    expect(error?.data?.uri).toBe('numbaseball://games/g99');
  });

  test('연결 격리: A에서 start해도 B의 목록은 rules뿐이고 games/g1은 not found, B의 start는 g1', async () => {
    const a = await connect(() => buildServer({ secretFor: d => (d === 3 ? '012' : '0123') }));
    close = a.close;
    const b = await connect(() => buildServer({ secretFor: d => (d === 3 ? '012' : '0123') }));
    close = async () => { await b.close(); await a.close(); };
    expect(firstText(await start(a.client))).toBe('새 게임 g1: 3자리, 난이도 normal, 기회 9번');
    expect(await resourceNames(b.client)).toEqual(['rules']);
    await expect(read(b.client, 'numbaseball://games/g1')).rejects.toThrow(/not found/);
    expect(firstText(await start(b.client))).toBe('새 게임 g1: 3자리, 난이도 normal, 기회 9번');
  });

  test('resources/list_changed 알림: start_game 뒤 1개, give_up 뒤 2개', async () => {
    const client = await open();
    const counter = createCounter();
    client.setNotificationHandler('notifications/resources/list_changed', () => counter.bump());
    if (era === 'modern') {
      const sub = await client.listen({ resourcesListChanged: true });
      const closeConn = close;
      close = async () => { await sub.close(); await closeConn?.(); };
    }
    await start(client);
    await counter.waitFor(1);
    await client.listResources();
    const afterStart = counter.value;
    await giveUp(client);
    await counter.waitFor(2);
    await client.listResources();
    console.error(`[obs] ${era} resources/list_changed: after start_game=${afterStart}, after give_up=${counter.value}`);
    expect(afterStart).toBe(1); // 관측으로 정함: EV/task-7-resource-list-changed.txt
    expect(counter.value).toBe(2); // 관측으로 정함: EV/task-7-resource-list-changed.txt
  });

  // 3-4: prompt new_game. prompt 인자는 프로토콜상 항상 문자열이다(PLAN 3-4)
  const getPrompt = (client: Client, args: Record<string, string>) => client.getPrompt({ name: 'new_game', arguments: args });
  // user 텍스트 메시지 하나임을 확인하고 본문을 돌려준다
  const promptText = (result: { messages: unknown }) => {
    const messages = result.messages as Array<{ role: string; content: { type: string; text?: string } }>;
    expect(messages).toHaveLength(1);
    expect(messages[0]?.role).toBe('user');
    expect(messages[0]?.content.type).toBe('text');
    return messages[0]?.content.text ?? '';
  };
  const promptTail = '\n2. guess로 한 번에 하나씩 추측해.\n3. 매번 지금까지의 결과로 후보를 어떻게 좁혔는지 근거를 한 줄로 말해.\n4. 게임이 끝날 때까지 계속해.';

  test('prompts/list: new_game의 title·description과 선택 인자 digits·difficulty(required false)', async () => {
    const client = await open();
    const prompts = (await client.listPrompts()).prompts.map(({ name, title, description, arguments: args }) => ({ name, title, description, arguments: args }));
    // 관측으로 정함: EV/task-27-test.txt (두 시대 모두 인자 항목에 name·required만 오고 description은 없다)
    expect(prompts).toEqual([{ name: 'new_game', title: '숫자야구 새 게임', description: '숫자야구 한 판을 시작하고 끝까지 둔다', arguments: [{ name: 'digits', required: false }, { name: 'difficulty', required: false }] }]);
  });

  test("prompts/get 인자 없음: user 메시지 1개, 네 줄 본문과 '인자 없이 호출해'", async () => {
    const client = await open();
    expect(promptText(await getPrompt(client, {}))).toBe(`1. start_game을 호출해 게임을 시작해. 인자 없이 호출해(서버가 나에게 물어본다).${promptTail}`);
  });

  test("prompts/get { digits: '3', difficulty: 'normal' }: 두 인자를 넣으라는 문장", async () => {
    const client = await open();
    expect(promptText(await getPrompt(client, { digits: '3', difficulty: 'normal' }))).toBe(`1. start_game을 호출해 게임을 시작해. digits는 3으로, difficulty는 normal로 넣어.${promptTail}`);
  });

  test('prompts/get 인자 하나(digits만, difficulty만): 나머지는 비워 두라는 문장', async () => {
    const client = await open();
    expect(promptText(await getPrompt(client, { digits: '4' }))).toBe(`1. start_game을 호출해 게임을 시작해. digits는 4로 넣어. 나머지는 비워 둬(서버가 나에게 물어본다).${promptTail}`);
    expect(promptText(await getPrompt(client, { difficulty: 'easy' }))).toBe(`1. start_game을 호출해 게임을 시작해. difficulty는 easy로 넣어. 나머지는 비워 둬(서버가 나에게 물어본다).${promptTail}`);
  });

  test("prompts/get { digits: '5' }·{ difficulty: 'expert' }·{ digits: '03' }는 Invalid arguments for prompt로 reject(-32602)", async () => {
    const client = await open();
    const error = await getPrompt(client, { digits: '5' }).then(() => undefined, (e: unknown) => e as { code?: number; message?: string });
    console.error(`[obs] ${era} prompt digits '5' error code=${error?.code} message=${error?.message}`);
    // 관측으로 정함: EV/task-27-test.txt (두 시대 모두 ProtocolError -32602 'Invalid arguments for prompt new_game: digits: …')
    expect(error?.code).toBe(-32602);
    expect(error?.message).toStartWith('Invalid arguments for prompt new_game: digits');
    await expect(getPrompt(client, { difficulty: 'expert' })).rejects.toThrow(/^Invalid arguments for prompt new_game: difficulty/);
    await expect(getPrompt(client, { digits: '03' })).rejects.toThrow(/^Invalid arguments for prompt new_game: digits/); // 문자열 enum이라 '03'은 '3'으로 강제 변환되지 않는다
  });

  test("prompt 본문에 데모 종료 표식 '정답!'·'실패.'·'포기.'가 없다", async () => {
    const client = await open();
    const argSets: Record<string, string>[] = [{}, { digits: '3', difficulty: 'normal' }, { digits: '4' }, { difficulty: 'easy' }];
    for (const args of argSets) {
      const body = promptText(await getPrompt(client, args));
      for (const marker of ['정답!', '실패.', '포기.']) expect(body).not.toContain(marker);
    }
  });

  test('prompt는 LOBBY·게임 중(PLAYING)·give_up 뒤 모두 같은 본문을 주고 prompts/list에 그대로 있다', async () => {
    const client = await open();
    const inLobby = promptText(await getPrompt(client, {}));
    await start(client);
    expect(await toolNames(client)).toEqual(['give_up', 'guess']);
    expect(promptText(await getPrompt(client, {}))).toBe(inLobby);
    expect((await client.listPrompts()).prompts.map(p => p.name)).toEqual(['new_game']);
    await giveUp(client);
    expect(await toolNames(client)).toEqual(['start_game']); // 게임이 끝나 LOBBY로 돌아왔다
    expect(promptText(await getPrompt(client, {}))).toBe(inLobby);
    expect((await client.listPrompts()).prompts.map(p => p.name)).toEqual(['new_game']);
  });

  // 3-5: start_game elicitation(MRTR). 빠진 인자만 form으로 묻고, 거절·취소·형식 불일치는 다시 묻지 않고 isError로 끝내며 LOBBY를 유지한다(PLAN.md:604-640)
  // onElicit로 답하는 클라이언트를 연다. answer(n)은 n번째(1부터) form 요청에 줄 응답이고, 받은 요청은 requests에 쌓인다
  async function openElicit(answer: (n: number) => ElicitResult | Promise<ElicitResult>) {
    const requests: ElicitRequest[] = [];
    const conn = await connect(() => buildServer({ secretFor: d => (d === 3 ? '012' : '0123') }), { onElicit: req => { requests.push(req); return answer(requests.length); } });
    close = conn.close;
    return { client: conn.client, requests };
  }
  const startWith = (client: Client, args: Record<string, unknown>) => client.callTool({ name: 'start_game', arguments: args });
  const accept = (content: NonNullable<ElicitResult['content']>): ElicitResult => ({ action: 'accept', content });
  // form 요청의 params(message·requestedSchema). 요청이 없거나 URL 모드면 실패한다
  const form = (req: ElicitRequest | undefined) => {
    if (!req || !('requestedSchema' in req.params)) throw new Error('form elicitation 요청이 없다');
    return req.params;
  };
  const formKeys = (req: ElicitRequest | undefined) => Object.keys(form(req).requestedSchema.properties).sort();

  test('3-5 인자 없는 start_game: form이 digits·difficulty를 모두 필수로 묻고 "자릿수와 난이도를 고르세요", accept하면 g1 3자리 normal', async () => {
    const { client, requests } = await openElicit(() => accept({ digits: 3, difficulty: 'normal' }));
    const result = await startWith(client, {});
    expect(requests).toHaveLength(1);
    const f = form(requests[0]);
    console.error(`[obs] ${era} settings form: ${JSON.stringify(f)}`);
    expect(f.message).toBe('자릿수와 난이도를 고르세요');
    expect(formKeys(requests[0])).toEqual(['difficulty', 'digits']);
    expect([...(f.requestedSchema.required ?? [])].sort()).toEqual(['difficulty', 'digits']);
    // 관측으로 정함: EV/task-29-test.txt (두 시대 모두 같은 wire 스키마: integer 3..4와 enum)
    expect(f.requestedSchema.properties).toEqual({ digits: { type: 'integer', minimum: 3, maximum: 4 }, difficulty: { type: 'string', enum: ['easy', 'normal', 'hard'] } });
    expect(result.isError).toBeFalsy();
    expect(firstText(result)).toBe('새 게임 g1: 3자리, 난이도 normal, 기회 9번');
    expect(result.structuredContent).toEqual({ gameId: 'g1', digits: 3, difficulty: 'normal', maxAttempts: 9 });
    expect(await toolNames(client)).toEqual(['give_up', 'guess']);
  });

  test('3-5 { digits: 3 }만 주면 form은 difficulty만 묻고 "난이도를 고르세요", accept hard → g1 3자리 hard(기회 7)', async () => {
    const { client, requests } = await openElicit(() => accept({ difficulty: 'hard' }));
    const result = await startWith(client, { digits: 3 });
    expect(requests).toHaveLength(1);
    expect(form(requests[0]).message).toBe('난이도를 고르세요');
    expect(formKeys(requests[0])).toEqual(['difficulty']);
    expect(form(requests[0]).requestedSchema.required).toEqual(['difficulty']);
    expect(result.structuredContent).toEqual({ gameId: 'g1', digits: 3, difficulty: 'hard', maxAttempts: 7 });
  });

  test('3-5 { difficulty: hard }만 주면 form은 digits만 묻고 "자릿수를 고르세요", accept 4 → g1 4자리 hard(기회 8)', async () => {
    const { client, requests } = await openElicit(() => accept({ digits: 4 }));
    const result = await startWith(client, { difficulty: 'hard' });
    expect(requests).toHaveLength(1);
    expect(form(requests[0]).message).toBe('자릿수를 고르세요');
    expect(formKeys(requests[0])).toEqual(['digits']);
    expect(form(requests[0]).requestedSchema.required).toEqual(['digits']);
    expect(result.structuredContent).toEqual({ gameId: 'g1', digits: 4, difficulty: 'hard', maxAttempts: 8 });
  });

  test('3-5 인자가 우선: { digits: 4 }에 form이 digits 3·difficulty easy를 보내도 4자리 easy(기회 15)로 시작한다', async () => {
    const { client, requests } = await openElicit(() => accept({ digits: 3, difficulty: 'easy' }));
    const result = await startWith(client, { digits: 4 });
    expect(requests).toHaveLength(1);
    expect(firstText(result)).toBe('새 게임 g1: 4자리, 난이도 easy, 기회 15번');
    expect(result.structuredContent).toEqual({ gameId: 'g1', digits: 4, difficulty: 'easy', maxAttempts: 15 });
  });

  test('3-5 두 인자를 다 주면 묻지 않는다(onElicit 0회)', async () => {
    const { client, requests } = await openElicit(() => ({ action: 'decline' }));
    const result = await startWith(client, { digits: 3, difficulty: 'normal' });
    expect(requests).toHaveLength(0);
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual({ gameId: 'g1', digits: 3, difficulty: 'normal', maxAttempts: 9 });
  });

  for (const action of ['decline', 'cancel'] as const) {
    test(`3-5 ${action}: isError '게임을 시작하지 않았다(설정 입력을 취소했다).', structuredContent 없음, tools/list는 그대로 [start_game]`, async () => {
      const { client, requests } = await openElicit(() => ({ action }));
      const result = await startWith(client, {});
      expect(requests).toHaveLength(1);
      expect(result.isError).toBe(true);
      expect(result.content).toEqual([{ type: 'text', text: '게임을 시작하지 않았다(설정 입력을 취소했다).' }]);
      expect(result.structuredContent).toBeUndefined();
      expect(await toolNames(client)).toEqual(['start_game']);
    });
  }

  test('3-5 decline한 뒤 다시 start_game을 accept하면 gameId는 g1(거절은 gameNo를 쓰지 않는다)', async () => {
    const { client, requests } = await openElicit(n => (n === 1 ? { action: 'decline' } : accept({ digits: 3, difficulty: 'normal' })));
    expect((await startWith(client, {})).isError).toBe(true);
    const result = await startWith(client, {});
    expect(requests).toHaveLength(2);
    expect(firstText(result)).toBe('새 게임 g1: 3자리, 난이도 normal, 기회 9번');
    expect(result.structuredContent).toEqual({ gameId: 'g1', digits: 3, difficulty: 'normal', maxAttempts: 9 });
  });

  test('3-5 형식 불일치 accept(digits 5·expert·문자열 digits·빈 content·content 없음): 각각 한 번만 묻고 isError, LOBBY 유지, 그 뒤 정상 accept는 g1', async () => {
    const bad: ElicitResult[] = [accept({ digits: 5, difficulty: 'normal' }), accept({ digits: 3, difficulty: 'expert' }), accept({ digits: '3', difficulty: 'normal' }), accept({}), { action: 'accept' }];
    const { client, requests } = await openElicit(n => bad[n - 1] ?? accept({ digits: 3, difficulty: 'normal' }));
    for (const [i] of bad.entries()) {
      const result = await startWith(client, {});
      expect(requests).toHaveLength(i + 1); // 다시 묻지 않는다
      expect(result.isError).toBe(true);
      expect(firstText(result)).toBe('설정 값이 형식에 맞지 않아 게임을 시작하지 않았다.');
      expect(result.structuredContent).toBeUndefined();
      expect(await toolNames(client)).toEqual(['start_game']);
    }
    const started = await startWith(client, {});
    expect(requests).toHaveLength(bad.length + 1);
    expect(started.structuredContent).toEqual({ gameId: 'g1', digits: 3, difficulty: 'normal', maxAttempts: 9 });
  });

  test('3-5 두 start_game의 form이 동시에 열려 둘 다 accept해도 게임은 하나(g1)이고, give_up 뒤 다음 게임은 g2', async () => {
    // form 요청 두 개가 모두 도착한 뒤에야 둘 다 accept로 답한다(타이머·폴링 없이 도착 수로만 깨운다)
    const pending: Array<(r: ElicitResult) => void> = [];
    const { client, requests } = await openElicit(n => new Promise<ElicitResult>(resolve => {
      pending.push(resolve);
      if (n === 2) for (const r of pending) r(accept({ digits: 3, difficulty: 'normal' }));
    }));
    // PLAN.md:226(요청은 매번 await)의 유일한 예외: form 두 개가 동시에 열리려면 await 없이 연달아 보내야 한다.
    // 어느 호출이 이기든, 응답이 어떤 순서로 오든 아래 불변식은 같다.
    const results = await Promise.allSettled([startWith(client, {}), startWith(client, {})]);
    expect(requests).toHaveLength(2);
    const fulfilled = results.flatMap(r => (r.status === 'fulfilled' ? [r.value] : []));
    const rejected = results.flatMap(r => (r.status === 'rejected' ? [r.reason] : []));
    const started = fulfilled.filter(r => !r.isError);
    const [refused] = fulfilled.filter(r => r.isError);
    expect(started).toHaveLength(1);
    expect(started[0]?.structuredContent).toEqual({ gameId: 'g1', digits: 3, difficulty: 'normal', maxAttempts: 9 });
    expect((refused ? 1 : 0) + rejected.length).toBe(1);
    if (refused) {
      // LOBBY 가드가 핸들러 안에서 막았다
      expect(firstText(refused)).toBe('이미 진행 중인 게임이 있습니다.');
      console.error(`[obs] ${era} 3-5 double start refused via guard`);
    } else {
      // SDK가 꺼진 tool이라며 핸들러 전에 거절했다
      expect(() => { throw rejected[0]; }).toThrow(/disabled/);
      console.error(`[obs] ${era} 3-5 double start refused via disabled`);
    }
    expect((await client.listResources()).resources.map(r => r.uri).sort()).toEqual(['numbaseball://current', 'numbaseball://games/g1', 'numbaseball://rules']); // 게임은 하나뿐
    expect(firstText(await giveUp(client))).toBe('포기. 정답은 012');
    expect((await startWith(client, { digits: 3, difficulty: 'normal' })).structuredContent).toEqual({ gameId: 'g2', digits: 3, difficulty: 'normal', maxAttempts: 9 }); // gameNo가 새지 않았다
  });
});
