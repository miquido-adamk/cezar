import { QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createQueryClient } from '@/api/query-client'
import type { HealthResponse } from '@open-mercato/cezar-api-client'

import { LoopsRoute } from './loops'

/**
 * `/loops/new`'s own landing picker — added because the page had NONE at all, unlike the
 * composer's inline Loop panel (`loop-review.tsx`), so every loop started from here silently
 * got `landing: 'none'` with no way to ask for a PR or a merge. This is deliberately narrow:
 * the item-list editing itself is `loop-items-editor.test.tsx`'s job.
 */

const createLoop = vi.hoisted(() => vi.fn())
const loopAction = vi.hoisted(() => vi.fn())
const getLoops = vi.hoisted(() => vi.fn())
const getHealth = vi.hoisted(() => vi.fn())

vi.mock('@/api/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/api/client')>()),
  createLoop,
  loopAction,
  getLoops,
  getHealth,
  getSkills: vi.fn(async () => []),
  getWorkflows: vi.fn(async () => ({ workflows: [] })),
  getSkillsWhenReady: vi.fn(async () => []),
}))

function health(over: Partial<HealthResponse['capabilities']> = {}): HealthResponse {
  return {
    version: '0.0.0',
    repoRoot: 'demo',
    repo: { root: '/demo', branch: 'main' },
    checks: [],
    defaultRunner: 'claude',
    forge: { kind: 'github', available: true },
    projects: [{ id: 'demo', name: 'demo' }],
    bootProject: 'demo',
    capabilities: {
      localHandoff: true,
      followups: true,
      singleProject: false,
      automations: false,
      loops: true,
      loopAutoMerge: false,
      tokenMetrics: true,
      tokenUsageMetrics: true,
      costMetrics: true,
      ...over,
    },
  } as HealthResponse
}

function renderNew(capabilities: Partial<HealthResponse['capabilities']> = {}) {
  getHealth.mockResolvedValue(health(capabilities))
  const client = createQueryClient()
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/loops/new']}>
        <LoopsRoute mode="new" />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  createLoop.mockReset()
  loopAction.mockReset()
  getLoops.mockReset()
  getHealth.mockReset()
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

const picker = () => screen.getByLabelText('When an item finishes') as HTMLSelectElement

describe('/loops/new — landing picker', () => {
  it('defaults to "none", matching the loop-level default everywhere else', async () => {
    renderNew()
    await waitFor(() => expect(screen.getByLabelText('Name')).not.toBeNull())
    expect(picker().value).toBe('none')
    expect(screen.getByText(/Nothing is pushed for you/)).not.toBeNull()
  })

  it('offers pr and merge, and names the merge behaviour when selected', async () => {
    renderNew({ loopAutoMerge: true })
    await waitFor(() => expect(screen.getByLabelText('Name')).not.toBeNull())
    const options = [...picker().options].map((o) => o.value)
    expect(options).toEqual(['none', 'pr', 'merge'])

    fireEvent.change(picker(), { target: { value: 'merge' } })
    expect(screen.getByText(/cezar merges it once it is genuinely mergeable/)).not.toBeNull()
  })

  it('hides merge and explains why when the dangerous flag is off', async () => {
    renderNew({ loopAutoMerge: false })
    await waitFor(() => expect(screen.getByLabelText('Name')).not.toBeNull())
    expect([...picker().options].map((o) => o.value)).toEqual(['none', 'pr'])
    expect(screen.getByText(/CEZ_LOOP_AUTO_MERGE=1/)).not.toBeNull()
  })

  it('submits the chosen landing, not always "none"', async () => {
    createLoop.mockResolvedValue({ loop: { id: 'loop-1' } })
    loopAction.mockResolvedValue({ loop: { id: 'loop-1' } })
    renderNew({ loopAutoMerge: true })
    await waitFor(() => expect(screen.getByLabelText('Name')).not.toBeNull())

    fireEvent.click(screen.getByRole('button', { name: /Import/ }))
    fireEvent.change(screen.getByLabelText(/Paste items/), { target: { value: 'fix #1' } })
    fireEvent.click(screen.getByRole('button', { name: /Add these/ }))

    fireEvent.change(picker(), { target: { value: 'pr' } })
    fireEvent.click(screen.getByRole('button', { name: 'Review and start' }))
    fireEvent.click(screen.getByRole('button', { name: /Start/ }))

    await waitFor(() => expect(createLoop).toHaveBeenCalled())
    expect(createLoop.mock.calls[0]![0]).toMatchObject({ landing: 'pr' })
  })
})
