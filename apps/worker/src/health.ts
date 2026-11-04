// `GET /healthz` for Fly's machine check (#5): 200 while the worker loop is
// reaching the database, 503 once it has stopped. Nothing else is served.
import { createServer, type Server } from 'node:http';

export function startHealthServer(port: number, healthy: () => boolean): Promise<Server> {
  const server = createServer((req, res) => {
    if (req.method !== 'GET' || req.url !== '/healthz') {
      res.writeHead(404).end();
      return;
    }
    const ok = healthy();
    res
      .writeHead(ok ? 200 : 503, { 'content-type': 'application/json' })
      .end(JSON.stringify({ ok }));
  });
  return new Promise((resolve) => server.listen(port, () => resolve(server)));
}
