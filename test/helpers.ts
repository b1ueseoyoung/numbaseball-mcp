import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import type { ElicitRequest, ElicitResult } from '@modelcontextprotocol/client';
import type { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';

type Factory = () => McpServer;
type Opts = { onElicit?: (request: ElicitRequest) => ElicitResult | Promise<ElicitResult> };

function makeClient(opts: Opts | undefined, pinModern: boolean) {
  const client = new Client({ name: 't', version: '0' }, {
    ...(pinModern ? { versionNegotiation: { mode: { pin: '2026-07-28' } } } : {}),
    ...(opts?.onElicit ? { capabilities: { elicitation: { form: {} } } } : {}),
  });
  if (opts?.onElicit) client.setRequestHandler('elicitation/create', opts.onElicit);
  return client;
}

// modern(2026-07-28): serveStdio에 in-memory transport를 꽂는다
export async function connectModern(factory: Factory, opts?: Opts) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const handle = serveStdio(factory, { transport: serverTransport });
  const client = makeClient(opts, true);
  await client.connect(clientTransport);
  return {
    client,
    close: async () => {
      await handle.close();
      await client.close();
    },
  };
}

// legacy(2025-11-25): server.connect + 기본 Client
export async function connectLegacy(factory: Factory, opts?: Opts) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = factory();
  await server.connect(serverTransport);
  const client = makeClient(opts, false);
  await client.connect(clientTransport);
  return {
    client,
    close: async () => {
      await server.close();
      await client.close();
    },
  };
}

export const ERAS = [['modern', connectModern], ['legacy', connectLegacy]] as const;

// 알림 수를 세고, min에 닿을 때까지 기다린다(고정 대기 대신, 상한 timeoutMs)
export function createCounter() {
  let value = 0;
  let waiters: Array<() => void> = [];
  return {
    get value() { return value; },
    bump() {
      value++;
      for (const w of [...waiters]) w();
    },
    waitFor(min: number, timeoutMs = 1000) {
      if (value >= min) return Promise.resolve();
      return new Promise<void>((resolve, reject) => {
        const done = () => {
          clearTimeout(timer);
          waiters = waiters.filter(w => w !== check);
        };
        const check = () => {
          if (value >= min) { done(); resolve(); }
        };
        const timer = setTimeout(() => { done(); reject(new Error(`got ${value}, want >= ${min}`)); }, timeoutMs);
        waiters.push(check);
      });
    },
  };
}
