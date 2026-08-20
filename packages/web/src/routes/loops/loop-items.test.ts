import { describe, expect, it } from 'vitest'
import { editItem, itemHeadline, itemsFromText, moveItem, removeItem, textFromItems } from './loop-items'

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
