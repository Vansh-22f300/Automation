import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * Captured request observed by the upstream mock.
 */
export interface CapturedRequest {
  method: string;
  url: string;
  headers: IncomingHttpHeaders;
  body: string;
}

/**
 * Programmable mock for the Fastify upstream.
 *
 * Each test file spawns one upstream server in `beforeAll`, configures a
 * handler via `setHandler`, and tears it down in `afterAll`. The test then
 * points `NUXT_BACKEND_URL` at this server's address.
 */
export interface UpstreamMock {
  readonly url: () => string;
  readonly port: () => number;
  readonly hits: () => readonly CapturedRequest[];
  readonly clearHits: () => void;
  readonly setHandler: (handler: UpstreamHandler) => void;
  readonly close: () => Promise<void>;
}

export type UpstreamHandler = (req: CapturedRequest) => UpstreamReply;

export interface UpstreamReply {
  status: number;
  headers?: Record<string, string>;
  body?: string;
  /** If set, the server delays `delayMs` before responding. */
  delayMs?: number;
}

const DEFAULT_REPLY: UpstreamReply = { status: 200, body: '{}' };

function defaultHandler(_req: CapturedRequest): UpstreamReply {
  return DEFAULT_REPLY;
}

export async function startUpstreamMock(): Promise<UpstreamMock> {
  const captured: CapturedRequest[] = [];
  let handler: UpstreamHandler = defaultHandler;

  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      const headers: IncomingHttpHeaders = { ...req.headers };
      const capturedReq: CapturedRequest = {
        method: req.method ?? 'GET',
        url: req.url ?? '/',
        headers,
        body,
      };
      captured.push(capturedReq);

      let reply: UpstreamReply;
      try {
        reply = handler(capturedReq) ?? DEFAULT_REPLY;
      } catch (err) {
        reply = {
          status: 500,
          body: JSON.stringify({ error: { code: 'mock_throw', message: 'mock handler threw' } }),
        };
      }

      const send = (): void => {
        const headers: Record<string, string> = {
          'content-type': 'application/json',
          ...(reply.headers ?? {}),
        };
        res.writeHead(reply.status, headers);
        if (req.method === 'HEAD') {
          res.end();
          return;
        }
        res.end(reply.body ?? '{}');
      };

      if (reply.delayMs && reply.delayMs > 0) {
        setTimeout(send, reply.delayMs);
      } else {
        send();
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });

  const port = (server.address() as AddressInfo).port;

  return {
    url: () => `http://127.0.0.1:${port}`,
    port: () => port,
    hits: () => captured,
    clearHits: () => {
      captured.length = 0;
    },
    setHandler: (next) => {
      handler = next;
    },
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}