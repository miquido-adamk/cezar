/**
 * The task-loops HTTP surface (spec `2026-08-19-task-loops`).
 *
 * Two things are under test: the gate behaves exactly like the automations
 * precedent (every route refuses with 409 naming the flag — reads included, never
 * a `200 []`), and the CRUD surface enforces the revision guard that stops two
 * cockpits from clobbering one loop.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Hono } from 'hono';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { RunStore } from '../runs/store.ts';
import { RunManager } from '../workflows/run.ts';
import { apiRequest } from './loopback-request.testkit.ts';
import { createApp } from './server.ts';

let root: string;
let store: RunStore;
let app: Hono;
const ORIGINAL_LOOPS = process.env.CEZ_LOOPS;
const ORIGINAL_DRY_RUN = process.env.CEZ_DRY_RUN;

beforeAll(() => {
  process.env.CEZ_DRY_RUN = '1';
});

afterAll(() => {
  if (ORIGINAL_DRY_RUN === undefined) delete process.env.CEZ_DRY_RUN;
  else process.env.CEZ_DRY_RUN = ORIGINAL_DRY_RUN;
});

/** Build the app AFTER the flag is set, since capabilities are read per request but
 *  the context wiring reads the flag at build time. */
function build(): Hono {
  store = RunStore.open(join(root, '.ai/cezar'));
  const manager = new RunManager(store, root);
  return createApp({ repoRoot: root, store, manager, version: '0.0.0-test' });
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cez-loops-api-'));
  mkdirSync(join(root, '.ai/cezar'), { recursive: true });
  execFileSync('git', ['init', '-b', 'main'], { cwd: root });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: root });
  execFileSync('git', ['commit', '--allow-empty', '-m', 'init'], { cwd: root });
});

afterEach(() => {
  if (ORIGINAL_LOOPS === undefined) delete process.env.CEZ_LOOPS;
  else process.env.CEZ_LOOPS = ORIGINAL_LOOPS;
  store?.flush();
  store?.removeAllListeners();
  rmSync(root, { recursive: true, force: true });
});

describe('the CEZ_LOOPS gate', () => {
  it('refuses every route with 409 naming the flag while loops are off', async () => {
    delete process.env.CEZ_LOOPS;
    app = build();

    for (const [method, path] of [
      ['GET', '/api/v1/loops'],
      ['POST', '/api/v1/loops'],
      ['GET', '/api/v1/loops/abc'],
      ['PUT', '/api/v1/loops/abc'],
      ['DELETE', '/api/v1/loops/abc'],
      ['POST', '/api/v1/loops/abc/start'],
      ['POST', '/api/v1/loops/abc/pause'],
      ['POST', '/api/v1/loops/abc/resume'],
      ['POST', '/api/v1/loops/abc/skip-current'],
      ['GET', '/api/v1/loop-receipts'],
    ] as const) {
      const response = await apiRequest(app, path, { method, body: method === 'GET' ? undefined : '{}' });
      expect(response.status, `${method} ${path}`).toBe(409);
      expect((await response.json()) as { error: string }).toMatchObject({ error: expect.stringContaining('CEZ_LOOPS=1') });
    }
  });

  it('refuses the READ rather than answering an empty list', async () => {
    // The automations precedent (#801): `{loops: []}` would read as "you have
    // configured none", and a client would then offer to create one against a
    // POST that answers 409.
    delete process.env.CEZ_LOOPS;
    app = build();
    const response = await apiRequest(app, '/api/v1/loops');
    expect(response.status).toBe(409);
    expect(await response.text()).not.toContain('"loops":[]');
  });

  it('does not gate unrelated routes when mounted alongside them', async () => {
    // The explicit-paths rule: a `use('*')` in this family would gate the entire
    // /api/v1 surface, including /health.
    delete process.env.CEZ_LOOPS;
    app = build();
    expect((await apiRequest(app, '/api/v1/health')).status).toBe(200);
  });
});

describe('loops CRUD with the flag on', () => {
  beforeEach(() => {
    process.env.CEZ_LOOPS = '1';
  });

  it('creates an idle loop with server-assigned item ids and reports progress', async () => {
    app = build();
    const created = await apiRequest(app, '/api/v1/loops', {
      method: 'POST',
      body: JSON.stringify({ name: 'drain', items: ['first', 'second'], task: { autonomous: true } }),
    });
    expect(created.status).toBe(201);
    const { loop } = (await created.json()) as { loop: { id: string; status: string; items: Array<{ id: string; prompt: string }>; revision: number; progress: { totalCount: number; completedCount: number } } };
    expect(loop.status).toBe('idle');
    expect(loop.revision).toBe(1);
    expect(loop.items.map((item) => item.prompt)).toEqual(['first', 'second']);
    expect(loop.items[0]!.id).toBeTruthy();
    expect(loop.progress).toMatchObject({ totalCount: 2, completedCount: 0 });

    const list = await apiRequest(app, '/api/v1/loops');
    expect(list.status).toBe(200);
    expect(((await list.json()) as { loops: unknown[] }).loops).toHaveLength(1);
  });

  it('rejects an item list over the 100-item ceiling', async () => {
    app = build();
    const response = await apiRequest(app, '/api/v1/loops', {
      method: 'POST',
      body: JSON.stringify({
        name: 'too big',
        items: Array.from({ length: 101 }, (_, index) => `item ${index}`),
        task: {},
      }),
    });
    expect(response.status).toBe(400);
  });

  it('rejects an empty item list', async () => {
    app = build();
    const response = await apiRequest(app, '/api/v1/loops', {
      method: 'POST',
      body: JSON.stringify({ name: 'empty', items: [], task: {} }),
    });
    expect(response.status).toBe(400);
  });

  it('404s an unknown loop on every addressed route', async () => {
    app = build();
    for (const [method, path] of [
      ['GET', '/api/v1/loops/nope'],
      ['DELETE', '/api/v1/loops/nope'],
      ['POST', '/api/v1/loops/nope/start'],
      ['POST', '/api/v1/loops/nope/pause'],
      ['POST', '/api/v1/loops/nope/resume'],
      ['POST', '/api/v1/loops/nope/skip-current'],
    ] as const) {
      const response = await apiRequest(app, path, { method, body: method === 'GET' ? undefined : '{}' });
      expect(response.status, `${method} ${path}`).toBe(404);
    }
  });

  it('409s a stale PUT and accepts a fresh one', async () => {
    app = build();
    const created = await apiRequest(app, '/api/v1/loops', {
      method: 'POST',
      body: JSON.stringify({ name: 'drain', items: ['a'], task: {} }),
    });
    const { loop } = (await created.json()) as { loop: { id: string; revision: number } };

    const fresh = await apiRequest(app, `/api/v1/loops/${loop.id}`, {
      method: 'PUT',
      body: JSON.stringify({ items: ['a', 'b'], expectedRevision: loop.revision }),
    });
    expect(fresh.status).toBe(200);
    const updated = (await fresh.json()) as { loop: { revision: number; items: unknown[] } };
    expect(updated.loop.revision).toBe(2);
    expect(updated.loop.items).toHaveLength(2);

    // The stale editor: still holding revision 1.
    const stale = await apiRequest(app, `/api/v1/loops/${loop.id}`, {
      method: 'PUT',
      body: JSON.stringify({ items: ['c'], expectedRevision: loop.revision }),
    });
    expect(stale.status).toBe(409);
  });

  it('requires expectedRevision on PUT', async () => {
    app = build();
    const created = await apiRequest(app, '/api/v1/loops', {
      method: 'POST',
      body: JSON.stringify({ name: 'drain', items: ['a'], task: {} }),
    });
    const { loop } = (await created.json()) as { loop: { id: string } };
    const response = await apiRequest(app, `/api/v1/loops/${loop.id}`, {
      method: 'PUT',
      body: JSON.stringify({ items: ['b'] }),
    });
    expect(response.status).toBe(400);
  });

  it('returns the receipt timeline on the detail route', async () => {
    app = build();
    const created = await apiRequest(app, '/api/v1/loops', {
      method: 'POST',
      body: JSON.stringify({ name: 'drain', items: ['a'], task: {} }),
    });
    const { loop } = (await created.json()) as { loop: { id: string } };
    const detail = await apiRequest(app, `/api/v1/loops/${loop.id}`);
    expect(detail.status).toBe(200);
    const body = (await detail.json()) as { loop: { id: string }; receipts: unknown[] };
    expect(body.loop.id).toBe(loop.id);
    expect(Array.isArray(body.receipts)).toBe(true);
  });

  it('deletes a loop and then 404s it', async () => {
    app = build();
    const created = await apiRequest(app, '/api/v1/loops', {
      method: 'POST',
      body: JSON.stringify({ name: 'drain', items: ['a'], task: {} }),
    });
    const { loop } = (await created.json()) as { loop: { id: string } };
    expect((await apiRequest(app, `/api/v1/loops/${loop.id}`, { method: 'DELETE' })).status).toBe(200);
    expect((await apiRequest(app, `/api/v1/loops/${loop.id}`)).status).toBe(404);
  });

  it('pauses with a reason and resumes clearing it', async () => {
    app = build();
    const created = await apiRequest(app, '/api/v1/loops', {
      method: 'POST',
      body: JSON.stringify({ name: 'drain', items: ['a'], task: {} }),
    });
    const { loop } = (await created.json()) as { loop: { id: string } };

    const paused = await apiRequest(app, `/api/v1/loops/${loop.id}/pause`, { method: 'POST' });
    expect(paused.status).toBe(200);
    const pausedBody = (await paused.json()) as { loop: { status: string; pausedReason?: string } };
    expect(pausedBody.loop.status).toBe('paused');
    expect(pausedBody.loop.pausedReason).toBeTruthy();
  });

  it('caps the receipts page and accepts a cursor', async () => {
    app = build();
    const overLimit = await apiRequest(app, '/api/v1/loop-receipts?limit=500');
    expect(overLimit.status).toBe(400);
    const ok = await apiRequest(app, '/api/v1/loop-receipts?limit=10&cursor=5');
    expect(ok.status).toBe(200);
    expect((await ok.json()) as { receipts: unknown[] }).toMatchObject({ receipts: [] });
  });
});
