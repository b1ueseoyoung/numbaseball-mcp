import { afterEach, describe, expect, test } from 'bun:test';
import type { Client } from '@modelcontextprotocol/client';
import { buildNggServer } from '../src/ngg/server.ts';
import * as M from '../src/ngg/messages.ts';
import { createCounter, ERAS } from './helpers.ts';

describe.each(ERAS)('%s', (era, connect) => {
  let close: (() => Promise<void>) | undefined;

  afterEach(async () => {
    await close?.();
    close = undefined;
  });

  async function open() {
    const conn = await connect(() => buildNggServer({ secret: 73 }));
    close = conn.close;
    return conn.client;
  }

  const toolNames = async (client: Client) => (await client.listTools()).tools.map(t => t.name).sort();
  const start = (client: Client) => client.callTool({ name: 'start_game', arguments: { playerName: 'Ann' } });

  test('시작 직후 tools/list는 start_game만', async () => {
    const client = await open();
    expect(await toolNames(client)).toEqual(['start_game']);
  });

  test('Lobby에서 guess_number는 disabled', async () => {
    const client = await open();
    await expect(client.callTool({ name: 'guess_number', arguments: { guess: 50 } })).rejects.toThrow(/disabled/);
  });

  test('start_game 후 tools/list는 guess_number, give_up', async () => {
    const client = await open();
    await start(client);
    expect(await toolNames(client)).toEqual(['give_up', 'guess_number']);
  });

  test('게임 중 start_game은 disabled', async () => {
    const client = await open();
    await start(client);
    await expect(start(client)).rejects.toThrow(/disabled/);
  });

  test('give_up 후 tools/list는 start_game만', async () => {
    const client = await open();
    await start(client);
    await client.callTool({ name: 'give_up', arguments: {} });
    expect(await toolNames(client)).toEqual(['start_game']);
  });

  test('tools/list_changed 알림이 1개 이상 온다', async () => {
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
    await client.callTool({ name: 'give_up', arguments: {} });
    await counter.waitFor(afterStart + 1);
    await client.listTools();
    console.error(`[obs] ${era} tools/list_changed: after start_game=${afterStart}, after give_up=${counter.value}`);
    expect(counter.value).toBeGreaterThanOrEqual(1);
  });

  // 1-2: guess 스키마 동적 변경과 오류 형식 (secret 73)
  const guess = (client: Client, n: number) => client.callTool({ name: 'guess_number', arguments: { guess: n } });
  const firstText = (result: { content: unknown }) => (result.content as Array<{ type: string; text?: string }>)[0]?.text;
  // tool의 description이 아니라 파라미터 guess의 description을 본다
  const guessDescription = async (client: Client) => {
    const tool = (await client.listTools()).tools.find(t => t.name === 'guess_number');
    const props = tool?.inputSchema.properties as Record<string, { description?: string }> | undefined;
    return props?.guess?.description;
  };

  test('start_game 직후 guess 파라미터 설명은 1-100, 10 attempts left', async () => {
    const client = await open();
    await start(client);
    expect(await guessDescription(client)).toBe('Your guess (1-100). 10 attempts left.');
  });

  test('guess 50은 Too low! 9 attempts left.이고 설명이 51-100으로 바뀐다', async () => {
    const client = await open();
    await start(client);
    const result = await guess(client, 50);
    expect(firstText(result)).toBe('Too low! 9 attempts left.');
    expect(firstText(result)).toBe(M.TOO_LOW(9));
    expect(await guessDescription(client)).toBe('Your guess (51-100). 9 attempts left.');
  });

  test('guess 50 뒤 guess 40은 isError', async () => {
    const client = await open();
    await start(client);
    await guess(client, 50);
    expect((await guess(client, 40)).isError).toBe(true);
  });

  test('guess 500은 isError이고 Input validation error로 시작', async () => {
    const client = await open();
    await start(client);
    const result = await guess(client, 500);
    expect(result.isError).toBe(true);
    expect(firstText(result)).toStartWith('Input validation error');
  });

  // 1-3: 리소스 3종과 game_state 토글 (secret 73)
  const URI = 'mcp://number-guessing-game';
  const resourceNames = async (client: Client) => (await client.listResources()).resources.map(r => r.name).sort();
  const read = async (client: Client, path: string) =>
    (await client.readResource({ uri: `${URI}/${path}` })).contents[0] as { mimeType?: string; text: string };

  test('시작 직후 resources/list는 game_rules, highscores', async () => {
    const client = await open();
    expect(await resourceNames(client)).toEqual(['game_rules', 'highscores']);
  });

  test('start_game 후 resources/list에 game_state가 추가된다', async () => {
    const client = await open();
    await start(client);
    expect(await resourceNames(client)).toEqual(['game_rules', 'game_state', 'highscores']);
  });

  test('give_up 후 resources/list에서 game_state가 사라진다', async () => {
    const client = await open();
    await start(client);
    await client.callTool({ name: 'give_up', arguments: {} });
    expect(await resourceNames(client)).toEqual(['game_rules', 'highscores']);
  });

  test('give_up 후 game_state read는 disabled로 reject', async () => {
    const client = await open();
    await start(client);
    await client.callTool({ name: 'give_up', arguments: {} });
    await expect(client.readResource({ uri: `${URI}/game_state` })).rejects.toThrow(/disabled/);
  });

  test('게임 중 game_state는 attemptsLeft/maxGuess/message/minGuess만 담고 비밀 수가 없다', async () => {
    const client = await open();
    await start(client);
    const atStart = await read(client, 'game_state');
    expect(atStart.mimeType).toBe('application/json');
    expect(atStart.text).not.toContain('73');
    expect(Object.keys(JSON.parse(atStart.text)).sort()).toEqual(['attemptsLeft', 'maxGuess', 'message', 'minGuess']);
    expect(JSON.parse(atStart.text).message).toBe(M.WELCOME('Ann', 1, 100, 10));
    await guess(client, 50);
    const after50 = await read(client, 'game_state');
    expect(after50.text).not.toContain('73');
    expect(JSON.parse(after50.text)).toEqual({ attemptsLeft: 9, minGuess: 51, maxGuess: 100, message: M.TOO_LOW(9) });
  });

  test('resources/list_changed는 start_game 뒤 1개, give_up 뒤 2개', async () => {
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
    await client.callTool({ name: 'give_up', arguments: {} });
    await counter.waitFor(2);
    await client.listResources();
    console.error(`[obs] ${era} resources/list_changed: after start_game=${afterStart}, after give_up=${counter.value}`);
    expect(afterStart).toBe(1); // 관측으로 정함: EV/task-7-resource-list-changed.txt
    expect(counter.value).toBe(2); // 관측으로 정함: EV/task-7-resource-list-changed.txt
  });

  test('highscores는 처음에 []이고 1번에 맞히면 { playerName: Ann, attempts: 1 }', async () => {
    const client = await open();
    const before = await read(client, 'highscores');
    expect(before.mimeType).toBe('application/json');
    expect(JSON.parse(before.text)).toEqual([]);
    await start(client);
    await guess(client, 73);
    expect(JSON.parse((await read(client, 'highscores')).text)).toEqual([{ playerName: 'Ann', attempts: 1 }]);
  });

  test('game_rules는 text/plain이고 범위와 시도 수를 담는다', async () => {
    const client = await open();
    const rules = await read(client, 'rules');
    expect(rules.mimeType).toBe('text/plain');
    expect(rules.text).toContain('from 1 to 100');
    expect(rules.text).toContain('You have 10 attempts');
  });
});
