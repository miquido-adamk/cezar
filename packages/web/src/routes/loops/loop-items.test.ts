import { describe, expect, it } from 'vitest'
import {
  draftItemsFromText,
  editItem,
  itemHeadline,
  itemsFromText,
  moveItem,
  removeItem,
  patchDraftItem,
  splitBriefSkill,
  submittableItems,
  textFromItems,
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
