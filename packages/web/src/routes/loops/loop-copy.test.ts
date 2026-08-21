import { describe, expect, it } from 'vitest'
import type { LoopReceipt } from '@open-mercato/cezar-api-client'

import {
  LOOP_ITEM_STATUS_LABEL,
  LOOP_STATUS_LABEL,
  loopItemCount,
  loopItemLine,
  loopItemViewOf,
  loopItemsOverCap,
  loopPausedBanner,
  loopProgressLine,
  loopStartConfirm,
} from './loop-copy'

/**
 * The spec specifies loop copy as an interaction contract — literal strings, not
 * descriptions — so these assert the strings themselves. The valuable half is
 * `loopItemViewOf` + `loopItemLine`: every non-Done state must name its cause,
 * because a loop that stopped without saying why is exactly the failure the
 * receipts exist to prevent.
 */

const receipt = (over: Partial<LoopReceipt>): LoopReceipt => ({
  seq: 1,
  receiptId: 'r1',
  receiptKey: 'loop-1:1:item-a',
  loopId: 'loop-1',
  revision: 1,
  itemId: 'item-a',
  itemIndex: 0,
  trigger: 'loop',
  status: 'completed',
  observedAt: '2026-08-19T10:00:00.000Z',
  updatedAt: '2026-08-19T10:00:00.000Z',
  ...over,
})

const rel = () => '4 min ago'

describe('status and progress copy', () => {
  it('labels every definition status', () => {
    expect(LOOP_STATUS_LABEL).toEqual({ idle: 'Idle', running: 'Running', paused: 'Paused', completed: 'Completed' })
  })

  it('omits the skipped clause when nothing was skipped', () => {
    expect(loopProgressLine({ completedCount: 4, skippedCount: 0, totalCount: 12 })).toBe('4 of 12 done')
  })

  it('adds the skipped clause when something was', () => {
    expect(loopProgressLine({ completedCount: 4, skippedCount: 1, totalCount: 12 })).toBe('4 of 12 done · 1 skipped')
  })

  it('singularises one item', () => {
    expect(loopItemCount(1)).toBe('1 item')
    expect(loopItemCount(12)).toBe('12 items')
  })

  it('names how many items to remove when over the cap', () => {
    expect(loopItemsOverCap(3)).toBe('Loops are limited to 100 items. Remove 3 to continue.')
  })
})

describe('start confirmation', () => {
  it('states the scale and that nothing is merged, and never says a bare "Start"', () => {
    const copy = loopStartConfirm(12)
    expect(copy.heading).toBe('Start this loop?')
    expect(copy.confirm).toBe('Start 12 items')
    expect(copy.body.join(' ')).toContain('one at a time')
    expect(copy.body.join(' ')).toContain('its own worktree and branch')
    // The honesty requirement: the confirmation must not imply the loop lands anything.
    expect(copy.body.join(' ')).toContain('Nothing is merged')
  })
})

describe('loopItemViewOf', () => {
  it('reads a reserved receipt as running only while it is the awaited item', () => {
    expect(loopItemViewOf(receipt({ status: 'reserved' }), true)).toEqual({
      kind: 'running',
      startedAt: '2026-08-19T10:00:00.000Z',
    })
    // Reserved but not awaited means the run exists and is waiting for a slot.
    expect(loopItemViewOf(receipt({ status: 'reserved' }), false)).toEqual({ kind: 'queued' })
  })

  it('treats a missing receipt as not-yet-reached rather than an error', () => {
    expect(loopItemViewOf(undefined, false)).toEqual({ kind: 'pending' })
  })

  it('carries the reason through for every state that has one', () => {
    expect(loopItemViewOf(receipt({ status: 'skipped', reason: 'you cancelled this task' }), false)).toEqual({
      kind: 'skipped',
      reason: 'you cancelled this task',
    })
    expect(loopItemViewOf(receipt({ status: 'launch-error', reason: 'unknown workflow: nope' }), false)).toEqual({
      kind: 'launch-error',
      reason: 'unknown workflow: nope',
    })
  })

  it('maps a detached project onto skipped with its cause, not a tenth visual state', () => {
    const view = loopItemViewOf(receipt({ status: 'project-detached' }), false)
    expect(view.kind).toBe('skipped')
    expect(loopItemLine(view, rel)).toContain('the project was removed')
  })

  it('covers every receipt status the contract can produce', () => {
    const statuses: LoopReceipt['status'][] = [
      'reserved',
      'completed',
      'skipped',
      'launch-error',
      'stalled',
      'vanished',
      'never-started',
      'project-detached',
    ]
    // A new receipt status must not fall through to `undefined` and render a blank row.
    for (const status of statuses) {
      const view = loopItemViewOf(receipt({ status }), false)
      expect(LOOP_ITEM_STATUS_LABEL[view.kind]).toBeTruthy()
      expect(loopItemLine(view, rel)).not.toBe('')
    }
  })
})

describe('loopItemLine', () => {
  it('explains every stopped state without a tooltip', () => {
    expect(loopItemLine({ kind: 'pending' }, rel)).toBe('Not started yet')
    expect(loopItemLine({ kind: 'queued' }, rel)).toBe('Waiting for a free slot')
    expect(loopItemLine({ kind: 'running', startedAt: 'x' }, rel)).toBe('Running · started 4 min ago')
    expect(loopItemLine({ kind: 'done', branch: 'cez/ab12cd34' }, rel)).toBe('Done · branch cez/ab12cd34')
    expect(loopItemLine({ kind: 'vanished' }, rel)).toContain("history was pruned")
    expect(loopItemLine({ kind: 'never-started' }, rel)).toBe('Never started · no free agent account for 30 minutes')
  })

  it('never renders an empty launch-error reason', () => {
    expect(loopItemLine({ kind: 'launch-error' }, rel)).toBe("Couldn't start · the task could not be created")
  })
})

describe('loopPausedBanner', () => {
  it('names the cause and points at the next item it is holding back', () => {
    const banner = loopPausedBanner({ itemNumber: 5, reason: 'has been monitoring for over an hour' })
    expect(banner.heading).toBe('Paused — item 5: has been monitoring for over an hour')
    expect(banner.body).toContain("won't start item 6")
    expect(banner.resume).toBe('Resume loop')
    expect(banner.skip).toBe('Skip item 5')
    expect(banner.open).toBe('Open item 5')
  })

  it('degrades to a plain heading when no reason was recorded', () => {
    expect(loopPausedBanner({ itemNumber: 2 }).heading).toBe('Paused at item 2.')
  })
})
