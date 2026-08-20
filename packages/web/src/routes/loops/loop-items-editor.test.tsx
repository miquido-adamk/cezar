import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { LoopItemsEditor } from './loop-items-editor'

/**
 * The editor's own behaviour, not the list's (that is `loop-items.test.ts`). What
 * matters here is that `Auto` ACCUMULATES rather than replacing — running it twice, or
 * after hand-writing items, must not silently discard work — and that an undraftable
 * brief refuses instead of inventing one item.
 */

const plan = vi.hoisted(() => vi.fn())
vi.mock('@/api/client', () => ({ planLoopItems: plan }))

function harness(initial: string[] = []) {
  const state = { items: initial }
  const onChange = vi.fn((next: string[]) => {
    state.items = next
    rerender(<LoopItemsEditor items={state.items} onChange={onChange} />)
  })
  const { rerender } = render(<LoopItemsEditor items={state.items} onChange={onChange} />)
  return { state, onChange }
}

const drafted = {
  items: ['fix #1', 'fix #2'],
  rationale: 'two bugs',
  fallback: false,
  context: { issues: 6, pullRequests: 0, forgeAvailable: true },
}

beforeEach(() => {
  plan.mockReset()
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('Auto', () => {
  it('refuses without a brief instead of calling the planner', () => {
    harness()
    fireEvent.click(screen.getByRole('button', { name: /Auto/ }))
    expect(plan).not.toHaveBeenCalled()
    expect(screen.getByText(/Describe the work first/)).toBeTruthy()
  })

  it('appends drafted items to what is already there', async () => {
    plan.mockResolvedValue(drafted)
    const { state } = harness(['hand-written item'])
    fireEvent.change(screen.getByLabelText(/Describe the work/), { target: { value: 'fix all open issues' } })
    fireEvent.click(screen.getByRole('button', { name: /Auto/ }))

    // Accumulating, not replacing: drafting twice — or after typing — must not discard
    // work the user already assembled.
    await waitFor(() => expect(state.items).toEqual(['hand-written item', 'fix #1', 'fix #2']))
    expect(plan).toHaveBeenCalledWith({ brief: 'fix all open issues' })
  })

  it('says so, and adds nothing, when the brief cannot be split', async () => {
    plan.mockResolvedValue({ ...drafted, items: [], fallback: true })
    const { state } = harness()
    fireEvent.change(screen.getByLabelText(/Describe the work/), { target: { value: 'something vague' } })
    fireEvent.click(screen.getByRole('button', { name: /Auto/ }))

    await waitFor(() => expect(screen.getByText(/Couldn't turn that into a list/)).toBeTruthy())
    // The honesty requirement: never a one-item loop that runs the whole brief at once.
    expect(state.items).toEqual([])
  })

  it('reports what the planner filtered against, so it never implies more than it saw', async () => {
    plan.mockResolvedValue({ ...drafted, context: { issues: 0, pullRequests: 0, forgeAvailable: false } })
    harness()
    fireEvent.change(screen.getByLabelText(/Describe the work/), { target: { value: 'x' } })
    fireEvent.click(screen.getByRole('button', { name: /Auto/ }))
    await waitFor(() => expect(screen.getByText(/GitHub was unavailable/)).toBeTruthy())
  })
})

describe('Import', () => {
  it('adds pasted lines, ignoring blanks', () => {
    const { state } = harness(['first'])
    fireEvent.click(screen.getByRole('button', { name: /Import/ }))
    fireEvent.change(screen.getByLabelText(/Paste items/), { target: { value: 'a\n\n  \nb\n' } })
    fireEvent.click(screen.getByRole('button', { name: /Add these/ }))
    expect(state.items).toEqual(['first', 'a', 'b'])
  })

  it('refuses an empty paste rather than adding nothing silently', () => {
    const { state } = harness()
    fireEvent.click(screen.getByRole('button', { name: /Import/ }))
    fireEvent.change(screen.getByLabelText(/Paste items/), { target: { value: '   \n\n' } })
    fireEvent.click(screen.getByRole('button', { name: /Add these/ }))
    expect(screen.getByText(/no items/)).toBeTruthy()
    expect(state.items).toEqual([])
  })
})

describe('Export', () => {
  it('is unavailable with nothing to export', () => {
    harness()
    expect(screen.getByRole('button', { name: /Export/ })).toHaveProperty('disabled', true)
  })

  it('downloads one item per line — the same format Import reads', () => {
    const click = vi.fn()
    const createElement = document.createElement.bind(document)
    vi.spyOn(document, 'createElement').mockImplementation((tag: string) => {
      const node = createElement(tag) as HTMLAnchorElement
      if (tag === 'a') node.click = click
      return node
    })
    const created: string[] = []
    vi.stubGlobal('URL', {
      ...URL,
      createObjectURL: (blob: Blob) => {
        created.push(String(blob.type))
        return 'blob:x'
      },
      revokeObjectURL: () => {},
    })

    harness(['a', 'b'])
    fireEvent.click(screen.getByRole('button', { name: /Export/ }))
    expect(click).toHaveBeenCalled()
    expect(created[0]).toContain('text/plain')
  })
})
