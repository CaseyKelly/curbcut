// Integration tests against a migrated database. Skipped without DATABASE_URL,
// like the schema tests in packages/db.
import { ScanJobPayload } from '@curbcut/core';
import { createDb, explanations, issues, jobs, scans, type Db } from '@curbcut/db';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createScan } from './scan-create';
import { loadScanSignature, loadScanView } from './scan-queries';

describe.skipIf(!process.env.DATABASE_URL)('scan queries', () => {
  let db: Db;
  const createdScans: string[] = [];
  const createdExplanations: string[] = [];
  const by = { githubId: 42, login: 'tester' };

  beforeAll(() => {
    db = createDb();
  });

  afterAll(async () => {
    if (!db) return;
    for (const id of createdScans) {
      await db.delete(jobs).where(sql`${jobs.payload}->>'scanId' = ${id}`);
      await db.delete(scans).where(eq(scans.id, id));
    }
    for (const id of createdExplanations) {
      await db.delete(explanations).where(eq(explanations.id, id));
    }
    await db.$client.end();
  });

  async function newScan(url = 'https://example.com/') {
    const id = await createScan(db, url, by);
    createdScans.push(id);
    return id;
  }

  const issueValues = (scanId: string, over: Partial<typeof issues.$inferInsert> = {}) => ({
    scanId,
    ruleId: 'image-alt',
    groupKey: 'image-alt',
    impact: 'critical' as const,
    help: 'Images must have alternative text',
    helpUrl: 'https://dequeuniversity.com/rules/axe/4.10/image-alt',
    wcag: ['1.1.1'],
    pageUrl: 'https://example.com/',
    selector: 'img',
    html: '<img src="a.png">',
    fingerprint: `fp-${Math.random()}`,
    ...over,
  });

  describe('createScan', () => {
    it('writes the scan, who started it, and a scan job together', async () => {
      const id = await newScan();
      const [scan] = await db.select().from(scans).where(eq(scans.id, id));
      expect(scan).toMatchObject({
        targets: ['https://example.com/'],
        status: 'queued',
        createdByGithubId: 42,
        createdByLogin: 'tester',
        explainStatus: null,
      });
      const queued = await db
        .select()
        .from(jobs)
        .where(sql`${jobs.payload}->>'scanId' = ${id}`);
      expect(queued).toHaveLength(1);
      expect(queued[0]).toMatchObject({ type: 'scan', status: 'queued' });
      expect(ScanJobPayload.parse(queued[0]!.payload)).toEqual({ scanId: id });
    });
  });

  describe('loadScanView', () => {
    it('is null for an unknown or malformed id', async () => {
      expect(await loadScanView(db, '00000000-0000-4000-8000-000000000000')).toBeNull();
      expect(await loadScanView(db, 'not-a-uuid')).toBeNull();
      expect(await loadScanSignature(db, 'not-a-uuid')).toBeNull();
    });

    it('shows a new scan as queued, with no groups', async () => {
      const view = await loadScanView(db, await newScan());
      expect(view).toMatchObject({ stage: 'queued', issueCount: 0, groups: [] });
    });

    it('groups issues and fills in explanations as they are linked', async () => {
      const id = await newScan();
      await db.insert(issues).values([
        issueValues(id, { selector: 'img.a' }),
        issueValues(id, { selector: 'img.b' }),
        issueValues(id, {
          ruleId: 'region',
          groupKey: 'region',
          impact: 'moderate',
          wcag: [],
          selector: 'p',
        }),
      ]);
      await db
        .update(scans)
        .set({ status: 'completed', explainStatus: 'running' })
        .where(eq(scans.id, id));

      let view = await loadScanView(db, id);
      expect(view).toMatchObject({ stage: 'explaining', issueCount: 3 });
      expect(view?.groups.map((g) => [g.ruleId, g.count, g.explanation])).toEqual([
        ['image-alt', 2, null],
        ['region', 1, null],
      ]);

      const body = {
        whatsWrong: 'Images have no text alternative.',
        whoItAffects: 'People who use screen readers.',
        whyItMatters: 'They hear nothing about the image.',
        confidence: 0.9,
      };
      const [explanation] = await db
        .insert(explanations)
        .values({
          cacheKey: `test-${id}`,
          ruleId: 'image-alt',
          body,
          model: 'test',
          promptVersion: 'test',
        })
        .returning({ id: explanations.id });
      createdExplanations.push(explanation!.id);
      await db
        .update(issues)
        .set({ explanationId: explanation!.id })
        .where(sql`${issues.scanId} = ${id} and ${issues.groupKey} = 'image-alt'`);

      view = await loadScanView(db, id);
      expect(view?.groups[0]?.explanation).toEqual(body);
      expect(view?.groups[1]?.explanation).toBeNull();
    });

    it('reads an explanation row that no longer parses as unexplained', async () => {
      const id = await newScan();
      const [bad] = await db
        .insert(explanations)
        .values({
          cacheKey: `test-bad-${id}`,
          ruleId: 'image-alt',
          body: { whatsWrong: 'only this' } as never,
          model: 'test',
          promptVersion: 'test',
        })
        .returning({ id: explanations.id });
      createdExplanations.push(bad!.id);
      await db.insert(issues).values(issueValues(id, { explanationId: bad!.id }));
      await db
        .update(scans)
        .set({ status: 'completed', explainStatus: 'completed' })
        .where(eq(scans.id, id));

      const view = await loadScanView(db, id);
      expect(view?.groups[0]?.explanation).toBeNull();
    });
  });

  describe('loadScanSignature', () => {
    it('changes with the scan status, explain status and error, and with each explained issue', async () => {
      const id = await newScan();
      const seen = new Set<string | null>();
      const note = async () => {
        const signature = await loadScanSignature(db, id);
        expect(signature).not.toBeNull();
        seen.add(signature);
        return signature;
      };
      const first = await note();
      expect(await note()).toBe(first);

      await db.update(scans).set({ status: 'running' }).where(eq(scans.id, id));
      await note();
      await db.update(scans).set({ error: 'timeout' }).where(eq(scans.id, id));
      await note();
      await db
        .update(scans)
        .set({ status: 'completed', explainStatus: 'pending' })
        .where(eq(scans.id, id));
      await note();
      await db.update(scans).set({ explainStatus: 'running' }).where(eq(scans.id, id));
      await note();
      await db.update(scans).set({ explainError: 'note' }).where(eq(scans.id, id));
      await note();

      await db.insert(issues).values(issueValues(id));
      const [explanation] = await db
        .insert(explanations)
        .values({
          cacheKey: `test-sig-${id}`,
          ruleId: 'image-alt',
          body: {
            whatsWrong: 'a',
            whoItAffects: 'b',
            whyItMatters: 'c',
            confidence: 0.5,
          },
          model: 'test',
          promptVersion: 'test',
        })
        .returning({ id: explanations.id });
      createdExplanations.push(explanation!.id);
      await db.update(issues).set({ explanationId: explanation!.id }).where(eq(issues.scanId, id));
      await note();

      // Seven distinct states, so nothing that changes the page goes unnoticed.
      expect(seen.size).toBe(7);
    });
  });
});
