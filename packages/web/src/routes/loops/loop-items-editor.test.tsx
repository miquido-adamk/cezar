import { QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createQueryClient } from '@/api/query-client'

import { LoopItemsEditor } from './loop-items-editor'
import type { DraftItem } from './loop-items'

/**
 * The editor's own behaviour, not the list's (that is `loop-items.test.ts`). What
 * matters here is that `Auto` ACCUMULATES rather than replacing — running it twice, or
 * after hand-writing items, must not silently discard work — and that an undraftable
 * brief refuses instead of inventing one item.
 */

const plan = vi.hoisted(() => vi.fn())
// Spread the REAL module: the query layer imports `ApiError`, `getSkills` and
// `getWorkflows` from here, and replacing the whole module broke the row picker.
vi.mock('@/api/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/api/client')>()),
  planLoopItems: plan,
  // The per-row picker's catalogues: empty is enough — these tests are about items,
  // and a real fetch would be a network call.
  getSkills: vi.fn(async () => []),
  getWorkflows: vi.fn(async () => ({ workflows: [] })),
  getSkillsWhenReady: vi.fn(async () => []),
}))

function harness(initialPrompts: string[] = []) {
  const state = { items: initialPrompts.map((prompt) => ({ prompt })) as DraftItem[] }
  // The per-row skill/workflow picker reads cached queries, so the editor needs a client.
  const client = createQueryClient()
  const tree = (items: DraftItem[], onChange: (next: DraftItem[]) => void) => (
    <QueryClientProvider client={client}>
      <LoopItemsEditor items={items} onChange={onChange} />
    </QueryClientProvider>
  )
  const onChange = vi.fn((next: DraftItem[]) => {
    state.items = next
    rerender(tree(state.items, onChange))
  })
  const { rerender } = render(tree(state.items, onChange))
  return { state, onChange }
}

const drafted = {
  // The planner returns objects now, choosing a skill per item.
  items: [{ prompt: 'fix #1' }, { prompt: 'fix #2' }],
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
    await waitFor(() => expect(state.items.map((i) => i.prompt)).toEqual(['hand-written item', 'fix #1', 'fix #2']))
    // The hand-written item rides along as context, so the planner does not re-propose it.
    expect(plan).toHaveBeenCalledWith({
      brief: 'fix all open issues',
      existingItems: ['hand-written item'],
    })
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
    expect(state.items.map((i) => i.prompt)).toEqual(['first', 'a', 'b'])
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

describe('running Auto twice', () => {
  it('tells the planner what is already listed, so it proposes different work', async () => {
    plan.mockResolvedValue({ ...drafted, items: [{ prompt: 'fix #3' }] })
    const { state } = harness(['fix #1 crash on save'])
    fireEvent.change(screen.getByLabelText(/Describe the work/), { target: { value: 'fix all open issues' } })
    fireEvent.click(screen.getByRole('button', { name: /Auto/ }))

    // The reported duplicate bug: without this the planner re-drafted the same issues in
    // different words, which no string de-duplication on this side could have caught.
    await waitFor(() =>
      expect(plan).toHaveBeenCalledWith({
        brief: 'fix all open issues',
        existingItems: ['fix #1 crash on save'],
      }),
    )
    await waitFor(() => expect(state.items.map((i) => i.prompt)).toEqual(['fix #1 crash on save', 'fix #3']))
  })

  it('reports "nothing new" rather than a drafting failure when the list is already full', async () => {
    plan.mockResolvedValue({ ...drafted, items: [], fallback: true })
    const { state } = harness(['fix #1'])
    fireEvent.change(screen.getByLabelText(/Describe the work/), { target: { value: 'fix all open issues' } })
    fireEvent.click(screen.getByRole('button', { name: /Auto/ }))

    // "Couldn't turn that into a list" would be wrong here — the brief WAS understood,
    // there is simply nothing left to add.
    await waitFor(() => expect(screen.getByText(/Nothing new to add/)).toBeTruthy())
    expect(state.items.map((i) => i.prompt)).toEqual(['fix #1'])
  })

  it('omits existingItems entirely when the list is empty', async () => {
    plan.mockResolvedValue(drafted)
    harness()
    fireEvent.change(screen.getByLabelText(/Describe the work/), { target: { value: 'go' } })
    fireEvent.click(screen.getByRole('button', { name: /Auto/ }))
    await waitFor(() => expect(plan).toHaveBeenCalledWith({ brief: 'go' }))
  })
})

describe('planner-chosen skills', () => {
  it('fills each row\'s skill pill from the planner rather than the prompt text', async () => {
    plan.mockResolvedValue({
      ...drafted,
      items: [
        { prompt: 'fix issue #165', skill: 'om-auto-fix-issue' },
        { prompt: 'write the spec', skill: 'om-spec-writing' },
        { prompt: 'tidy the README' },
      ],
    })
    const { state } = harness()
    fireEvent.change(screen.getByLabelText(/Describe the work/), { target: { value: 'drain the backlog' } })
    fireEvent.click(screen.getByRole('button', { name: /Auto/ }))

    await waitFor(() => expect(state.items).toHaveLength(3))
    // Per item, not one setting for all — and the prompt keeps no slash prefix to parse.
    expect(state.items[0]!.source).toEqual({ kind: 'skill', ref: 'om-auto-fix-issue' })
    expect(state.items[1]!.source).toEqual({ kind: 'skill', ref: 'om-spec-writing' })
    // An item the planner gave no skill inherits the loop's template.
    expect(state.items[2]!.source).toBeUndefined()
    expect(state.items[0]!.prompt).toBe('fix issue #165')
  })
})
