// A local HTTP proxy that every browser request in a scan goes through (#5).
// It resolves each host once with `resolvePublic` and connects to that exact
// address, so a redirect, an iframe, a fetch, or a DNS record that changes
// after the first check can't reach a private address.
import { createServer, request, type IncomingHttpHeaders } from 'node:http';
import { connect, type AddressInfo, type Socket } from 'node:net';
import { resolvePublic, type GuardOptions } from './guard';
import { UnsafeUrlError } from '../errors';

/** Set on the proxy's own 403, so the scanner can tell a blocked page from a real one. */
export const BLOCKED_HEADER = 'x-curbcut-blocked';

/** How long an origin gets to accept a connection; the page timeout covers the rest. */
const CONNECT_TIMEOUT_MS = 15_000;

export interface GuardProxy {
  /** For Playwright's `proxy.server`. */
  url: string;
  /** Hosts refused so far, for the scanner's error message. */
  blocked: string[];
  close(): Promise<void>;
}

/** Headers meant for the proxy, not the origin. */
function forwardHeaders(headers: IncomingHttpHeaders): IncomingHttpHeaders {
  const rest = { ...headers };
  delete rest['proxy-connection'];
  delete rest['proxy-authorization'];
  return rest;
}

export async function startGuardProxy(options: GuardOptions = {}): Promise<GuardProxy> {
  const blocked: string[] = [];
  // Tunnels outlive their requests, so track every socket to close them all.
  const sockets = new Set<Socket>();
  const track = (s: Socket) => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
  };
  const refuse = (host: string, err: unknown) => {
    if (err instanceof UnsafeUrlError) blocked.push(host);
    return err instanceof UnsafeUrlError;
  };

  const server = createServer((req, res) => {
    // A proxied plain-http request carries an absolute URL.
    let target: URL;
    try {
      target = new URL(req.url ?? '');
      if (target.protocol !== 'http:') throw new Error('not http');
    } catch {
      res.writeHead(400).end();
      return;
    }
    resolvePublic(target.hostname, options).then(
      ({ address }) => {
        // The browser may have given up while the name was resolving.
        if (res.destroyed) return;
        const upstream = request(
          {
            host: address,
            port: target.port || 80,
            method: req.method,
            path: target.pathname + target.search,
            headers: forwardHeaders(req.headers),
            // No pooling: a connection lives as long as the request, and the proxy can close.
            agent: false,
          },
          (upstreamRes) => {
            res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
            upstreamRes.pipe(res);
            // pipe() won't end `res` if the origin drops mid-body; without this the
            // browser waits on a truncated resource until the page times out.
            upstreamRes.on('close', () => {
              if (!upstreamRes.complete) res.destroy();
            });
          },
        );
        upstream.on('socket', (s) => {
          track(s);
          s.setTimeout(CONNECT_TIMEOUT_MS, () => upstream.destroy());
          s.once('connect', () => s.setTimeout(0));
        });
        upstream.on('error', () => res.destroy());
        // An origin that never answers mustn't outlive the browser's request.
        res.on('close', () => upstream.destroy());
        req.pipe(upstream);
      },
      (err: unknown) => {
        const status = refuse(target.hostname, err) ? 403 : 502;
        res.writeHead(status, { [BLOCKED_HEADER]: status === 403 ? '1' : '0' }).end();
      },
    );
  });

  // https and websockets tunnel through CONNECT. TLS stays end to end; the
  // proxy only picks the address.
  server.on('connect', (req, socket, head) => {
    let target: URL;
    try {
      // https:, so an explicit :80 survives; an http: URL would drop it as the default.
      target = new URL(`https://${req.url ?? ''}`);
    } catch {
      socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
      return;
    }
    socket.on('error', () => socket.destroy());
    resolvePublic(target.hostname, options).then(
      ({ address }) => {
        if (socket.destroyed) return;
        let established = false;
        const upstream = connect({
          host: address,
          port: Number(target.port || 443),
          timeout: CONNECT_TIMEOUT_MS,
        });
        track(upstream);
        upstream.on('timeout', () => upstream.destroy(new Error('connect timed out')));
        upstream.once('connect', () => {
          established = true;
          upstream.setTimeout(0);
          socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
          upstream.write(head);
          upstream.pipe(socket).pipe(upstream);
        });
        // Once the tunnel is up it carries TLS, so an error can only close it.
        upstream.on('error', () =>
          established ? socket.destroy() : socket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n'),
        );
        socket.on('close', () => upstream.destroy());
      },
      (err: unknown) => {
        const status = refuse(target.hostname, err) ? '403 Forbidden' : '502 Bad Gateway';
        socket.end(`HTTP/1.1 ${status}\r\n\r\n`);
      },
    );
  });

  server.on('connection', track);

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    blocked,
    close: () =>
      new Promise((resolve) => {
        server.close(() => resolve());
        for (const s of sockets) s.destroy();
      }),
  };
}
