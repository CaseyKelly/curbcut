// Job runner: claims jobs from Postgres and runs scans (#5), and later agent runs.
import { hostname } from 'node:os';
import { createDb } from '@curbcut/db';
import { startHealthServer } from './health';
import { scanJob } from './jobs/scan';
import { createQueue } from './queue';
import { Scanner } from './scanner/scanner';
import { createWorker } from './worker';

// Local development only: lets the scanner reach localhost, e.g. the sample
// site. Refused in production so it can't switch off the SSRF guard there.
const allowPrivate = process.env.ALLOW_PRIVATE_SCAN_TARGETS === 'true';
if (allowPrivate && process.env.NODE_ENV === 'production') {
  throw new Error('ALLOW_PRIVATE_SCAN_TARGETS is not allowed in production');
}

const db = createDb();
const scanner = new Scanner(allowPrivate ? { isBlockedAddress: () => false } : {});
const worker = createWorker({
  // On Fly the hostname is the machine id.
  queue: createQueue(db, { workerId: `${hostname()}:${process.pid}` }),
  handlers: { scan: scanJob(db, scanner) },
});
const health = await startHealthServer(Number(process.env.PORT ?? 8080), worker.healthy);

// Fly sends SIGINT then waits `kill_timeout` before killing. Abort the job in
// hand and put it back in the queue, so another machine picks it up at once.
const stop = new AbortController();
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    console.log(`${signal}: releasing the current job, then stopping`);
    stop.abort();
  });
}

console.log(`worker started${allowPrivate ? ' (private scan targets allowed)' : ''}`);
try {
  await worker.run(stop.signal);
} finally {
  health.close();
  await scanner.close();
  await db.$client.end();
}
