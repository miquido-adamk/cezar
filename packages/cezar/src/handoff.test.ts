import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { HANDOFF_INSTRUCTIONS, seedHandoffFile } from './handoff.ts';
import { todoSchema } from './todos.ts';

/**
 * HANDOFF_INSTRUCTIONS is the only thing that tells an agent what to append to todos.json,
 * so a field can be added to todoSchema and still never be written by anyone. `runnable`
 * shipped exactly that way. This pins the contract instead of the prose: every agent-writable
 * schema field has to appear in the instructions.
 */
describe('HANDOFF_INSTRUCTIONS', () => {
  /** The server assigns these on read/start — an agent never writes them. */
  const SERVER_MANAGED = new Set(['id', 'startedTaskId']);

  it('documents every agent-writable field of todoSchema', () => {
    const undocumented = Object.keys(todoSchema.shape)
      .filter((field) => !SERVER_MANAGED.has(field))
      .filter((field) => !HANDOFF_INSTRUCTIONS.includes(`"${field}"`));

    expect(undocumented).toEqual([]);
  });

  it('tells the agent which way to set runnable, so notes are acknowledged and not run', () => {
    expect(HANDOFF_INSTRUCTIONS).toContain('"runnable": false');
    expect(HANDOFF_INSTRUCTIONS).toContain('"runnable": true');
    expect(HANDOFF_INSTRUCTIONS).toContain('Acknowledge');
  });
});

describe('seedHandoffFile', () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'cez-handoff-'));
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  const SEED = { id: 'run-1', title: 'fix #101', workflow: 'quick-task', task: 'fix #101' };

  it('writes no Loop context section for an ordinary run', () => {
    seedHandoffFile(dataDir, SEED);
    const text = readFileSync(`${dataDir}/runs/run-1.handoff.md`, 'utf8');
    expect(text).not.toContain('## Loop context');
  });

  it('places the Loop context section between the Goal and the Progress log', () => {
    seedHandoffFile(dataDir, { ...SEED, loopContext: 'Loop **Drain the backlog** — item 1 of 3' });
    const text = readFileSync(`${dataDir}/runs/run-1.handoff.md`, 'utf8');
    expect(text).toContain('## Loop context\n\nLoop **Drain the backlog** — item 1 of 3');
    expect(text.indexOf('## Goal')).toBeLessThan(text.indexOf('## Loop context'));
    expect(text.indexOf('## Loop context')).toBeLessThan(text.indexOf('## Progress log'));
  });
});
