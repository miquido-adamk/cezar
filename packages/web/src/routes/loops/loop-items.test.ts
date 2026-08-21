import { describe, expect, it } from 'vitest'
import {
  draftItemsFromPlan,
  draftItemsFromText,
  editItem,
  itemHeadline,
  itemsFromText,
  moveItem,
  removeItem,
  extractItemSource,
  patchDraftItem,
  splitBriefSkill,
  submittableItems,
  textFromDraftItems,
  textFromItems,
  withDefaultSource,
} from './loop-items'

/**
 * A loop's item ORDER is load-bearing — with landing `merge`, item N+1 starts from a
 * base containing N — so reordering is a real edit. These pin that no operation can
 * silently drop, duplicate or corrupt the list, including from a drag that lands
 * outside it.
 */

describe('itemsFromText', () => {
  it('drops blank lines so a trailing newline never becomes an empty task', () => {
    expect(itemsFromText('a\n\n  \nb\n')).toEqual(['a', 'b'])
  })

  it('round-trips through textFromItems', () => {
    const items = ['fix #1', 'fix #2']
    expect(itemsFromText(textFromItems(items))).toEqual(items)
  })
})

describe('moveItem', () => {
  it('reorders without losing or duplicating anything', () => {
    expect(moveItem(['a', 'b', 'c'], 0, 2)).toEqual(['b', 'c', 'a'])
    expect(moveItem(['a', 'b', 'c'], 2, 0)).toEqual(['c', 'a', 'b'])
  })

  it('is a no-op for a drag that lands on itself or outside the list', () => {
    // A drag released over nothing must not corrupt the order.
    expect(moveItem(['a', 'b'], 1, 1)).toEqual(['a', 'b'])
    expect(moveItem(['a', 'b'], -1, 0)).toEqual(['a', 'b'])
    expect(moveItem(['a', 'b'], 0, 5)).toEqual(['a', 'b'])
  })

  it('never mutates its input', () => {
    const original = ['a', 'b', 'c']
    moveItem(original, 0, 2)
    expect(original).toEqual(['a', 'b', 'c'])
  })
})

describe('removeItem', () => {
  it('removes exactly one row, by index rather than by value', () => {
    // Two items may carry identical prompts; removing by value would drop both.
    expect(removeItem(['same', 'same', 'other'], 0)).toEqual(['same', 'other'])
  })

  it('ignores an out-of-range index', () => {
    expect(removeItem(['a'], 3)).toEqual(['a'])
  })
})

describe('editItem', () => {
  it('replaces one item and leaves its neighbours alone', () => {
    expect(editItem(['a', 'b'], 1, 'B')).toEqual(['a', 'B'])
  })

  it('keeps a row that was emptied, rather than deleting it mid-typing', () => {
    // Deleting on empty would yank the row out from under the caret.
    expect(editItem(['a', 'b'], 0, '')).toEqual(['', 'b'])
  })
})

describe('itemHeadline', () => {
  it('takes the first line, since items are often long prompts', () => {
    expect(itemHeadline('Fix #165 in the repo\nthen run the tests')).toBe('Fix #165 in the repo')
  })

  it('truncates with an ellipsis rather than overflowing the row', () => {
    const headline = itemHeadline('x'.repeat(200), 20)
    expect(headline).toHaveLength(20)
    expect(headline.endsWith('…')).toBe(true)
  })
})

describe('splitBriefSkill', () => {
  it('separates a leading slash-skill from the work description', () => {
    // The reported failure: the planner received "/om-auto-fix-issue all open issues"
    // and was asked to split a command name into work items.
    expect(splitBriefSkill('/om-auto-fix-issue all open issues')).toEqual({
      skill: 'om-auto-fix-issue',
      brief: 'all open issues',
    })
  })

  it('leaves ordinary text alone', () => {
    expect(splitBriefSkill('fix all open issues one by one')).toEqual({
      brief: 'fix all open issues one by one',
    })
  })

  it('handles a slash-skill with no description after it', () => {
    expect(splitBriefSkill('/om-prepare-issue')).toEqual({ skill: 'om-prepare-issue', brief: '' })
  })

  it('does not treat a path or a mid-sentence slash as a skill', () => {
    expect(splitBriefSkill('update src/api/client.ts')).toEqual({ brief: 'update src/api/client.ts' })
    expect(splitBriefSkill('  fix /etc bug')).toEqual({ brief: 'fix /etc bug' })
  })
})

describe('per-item source', () => {
  it('sets a source on one row only', () => {
    const items = draftItemsFromText('a\nb')
    const next = patchDraftItem(items, 1, { source: { kind: 'skill', ref: 'om-auto-fix-issue' } })
    expect(next[0]!.source).toBeUndefined()
    expect(next[1]!.source).toEqual({ kind: 'skill', ref: 'om-auto-fix-issue' })
  })

  it('can clear a source back to the loop template', () => {
    const withSource = patchDraftItem(draftItemsFromText('a'), 0, {
      source: { kind: 'workflow', ref: 'quick-task' },
    })
    const cleared = patchDraftItem(withSource, 0, { source: undefined })
    // Absent must be reachable again, or "use the loop's template" becomes a one-way door.
    expect('source' in cleared[0]!).toBe(false)
  })

  it('keeps the source when only the prompt is edited', () => {
    const items = patchDraftItem(draftItemsFromText('a'), 0, { source: { kind: 'skill', ref: 'om-fix' } })
    const edited = patchDraftItem(items, 0, { prompt: 'a much longer prompt' })
    expect(edited[0]!.source).toEqual({ kind: 'skill', ref: 'om-fix' })
  })

  it('drops blank rows but keeps sources on the rest when submitting', () => {
    const items = [
      { prompt: '  ' },
      { prompt: ' fix #1 ', source: { kind: 'skill' as const, ref: 'om-fix' } },
    ]
    expect(submittableItems(items)).toEqual([{ prompt: 'fix #1', source: { kind: 'skill', ref: 'om-fix' } }])
  })
})

describe('extractItemSource', () => {
  it('lifts a leading /skill out of the prompt and into the item', () => {
    // What the planner actually drafts, and what a person types out of composer habit.
    expect(extractItemSource({ prompt: '/om-auto-fix-issue fix issue #165' })).toEqual({
      prompt: 'fix issue #165',
      source: { kind: 'skill', ref: 'om-auto-fix-issue' },
    })
  })

  it('leaves a prompt with no leading skill untouched', () => {
    const item = { prompt: 'fix issue #165' }
    expect(extractItemSource(item)).toBe(item)
  })

  it('never overwrites a source the user set on the row', () => {
    const item = { prompt: '/om-fix do it', source: { kind: 'workflow' as const, ref: 'quick-task' } }
    // The row's own choice wins; typing a slash later must not silently override it.
    expect(extractItemSource(item)).toBe(item)
  })

  it('keeps the text when the prompt is only a skill, rather than emptying the row', () => {
    expect(extractItemSource({ prompt: '/om-prepare-issue' })).toEqual({
      prompt: '/om-prepare-issue',
      source: { kind: 'skill', ref: 'om-prepare-issue' },
    })
  })
})

describe('withDefaultSource', () => {
  it("applies the brief's skill to items that named none", () => {
    const items = [{ prompt: 'a' }, { prompt: 'b', source: { kind: 'skill' as const, ref: 'other' } }]
    const next = withDefaultSource(items, { kind: 'skill', ref: 'om-auto-fix-issue' })
    expect(next[0]!.source).toEqual({ kind: 'skill', ref: 'om-auto-fix-issue' })
    // An item that already chose stays as it chose.
    expect(next[1]!.source).toEqual({ kind: 'skill', ref: 'other' })
  })

  it('is a no-op with no default', () => {
    expect(withDefaultSource([{ prompt: 'a' }], undefined)).toEqual([{ prompt: 'a' }])
  })
})

describe('Export/Import round trip with skills', () => {
  it('writes a skill back as the /skill prefix Import can read', () => {
    const items = [
      { prompt: 'fix #165', source: { kind: 'skill' as const, ref: 'om-auto-fix-issue' } },
      { prompt: 'plain item' },
    ]
    const text = textFromDraftItems(items)
    expect(text).toBe('/om-auto-fix-issue fix #165\nplain item')

    // The round trip: exported, re-imported, same items — skills intact.
    const reimported = draftItemsFromText(text).map(extractItemSource)
    expect(reimported).toEqual(items)
  })

  it('exports a workflow item without its override, since /-syntax cannot carry one', () => {
    const text = textFromDraftItems([
      { prompt: 'ship it', source: { kind: 'workflow', ref: 'quick-task' } },
    ])
    // The line survives; the override does not, which is stated rather than silent.
    expect(text).toBe('ship it')
  })
})

describe('draftItemsFromPlan', () => {
  it('maps planner objects to rows, keeping each chosen skill', () => {
    expect(
      draftItemsFromPlan([
        { prompt: 'fix #165', skill: 'om-auto-fix-issue' },
        { prompt: 'tidy the README' },
      ]),
    ).toEqual([
      { prompt: 'fix #165', source: { kind: 'skill', ref: 'om-auto-fix-issue' } },
      { prompt: 'tidy the README' },
    ])
  })

  it('never stringifies an item — the reported "[object Object]" row', () => {
    // Joining planner objects into text rendered them as the literal string
    // "[object Object]" AND discarded the skill the planner had just chosen.
    const rows = draftItemsFromPlan([{ prompt: 'real prompt', skill: 'om-fix' }])
    expect(rows[0]!.prompt).toBe('real prompt')
    expect(rows[0]!.prompt).not.toContain('[object')
  })

  it('drops blank prompts rather than creating an empty task', () => {
    expect(draftItemsFromPlan([{ prompt: '   ' }, { prompt: 'ok' }])).toEqual([{ prompt: 'ok' }])
  })
})
