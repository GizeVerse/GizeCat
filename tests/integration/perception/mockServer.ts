// Local mock HTTP server on 127.0.0.1 with an ephemeral port. Tests never talk
// to a real provider or to the user's Ollama on :11434.
import http from 'node:http';
import type { AddressInfo } from 'node:net';

export interface RecordedRequest {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: string;
  json: unknown;
}

export type Handler = (req: RecordedRequest, res: http.ServerResponse) => void | Promise<void>;

export interface MockServer {
  url: string;
  port: number;
  requests: RecordedRequest[];
  setHandler(h: Handler): void;
  close(): Promise<void>;
}

export async function startMockServer(initial: Handler): Promise<MockServer> {
  let handler = initial;
  const requests: RecordedRequest[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      let json: unknown;
      try {
        json = body ? JSON.parse(body) : null;
      } catch {
        json = null;
      }
      const rec: RecordedRequest = { method: req.method ?? '', url: req.url ?? '', headers: req.headers, body, json };
      requests.push(rec);
      Promise.resolve(handler(rec, res)).catch(() => {
        if (!res.headersSent) res.writeHead(500);
        res.end();
      });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    requests,
    setHandler: (h) => {
      handler = h;
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

export function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) });
  res.end(text);
}

/** fetch that refuses anything except loopback mock servers (and never :11434). */
export const guardedFetch: typeof fetch = (input, init) => {
  const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  const u = new URL(raw);
  if (u.hostname !== '127.0.0.1' || u.port === '' || u.port === '11434') {
    return Promise.reject(new Error(`test attempted to reach ${u.host}`));
  }
  return fetch(input, init);
};

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
