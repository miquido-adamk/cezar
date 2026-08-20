import { QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { createQueryClient } from '@/api/query-client'
import { LoopItemPills } from './loop-item-pills'

vi.mock('@/api/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/api/client')>()),
  getSkills: vi.fn(async () => []),
  getWorkflows: vi.fn(async () => ({ workflows: [] })),
  getSkillsWhenReady: vi.fn(async () => []),
}))

afterEach(cleanup)

function renderPills() {
  return render(
    <QueryClientProvider client={createQueryClient()}>
      <LoopItemPills index={0} item={{ prompt: 'p' }} onChange={vi.fn()} />
    </QueryClientProvider>,
  )
}

describe('every pill says what it controls', () => {
  it('never shows an unlabelled "Loop default"', () => {
    renderPills()
    // The reported complaint verbatim: "all selects are loop default - dont know what it
    // is". A closed <select> shows only its chosen option, so the option TEXT is the label.
    expect(screen.queryByText('Loop default')).toBeNull()
  })

  it('names each control in its selected option', () => {
    renderPills()
    for (const label of ['skill: default', 'agent: default', 'model: default', 'worktree: default', 'autonomy: default']) {
      expect(screen.getByText(label)).toBeTruthy()
    }
  })

  it('gives every control a distinct accessible name', () => {
    renderPills()
    const names = screen
      .getAllByRole('combobox')
      .map((node) => node.getAttribute('aria-label'))
    expect(new Set(names).size).toBe(names.length)
    expect(names).toHaveLength(5)
  })
})
