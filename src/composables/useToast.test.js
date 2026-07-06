import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { toast, toasts } from './useToast.js'

beforeEach(() => { toasts.value = []; vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers() })

describe('toast', () => {
  it('pushes a toast with msg + type', () => {
    toast('Сохранено', 'ok')
    expect(toasts.value).toHaveLength(1)
    expect(toasts.value[0]).toMatchObject({ msg: 'Сохранено', type: 'ok' })
    expect(typeof toasts.value[0].id).toBe('number')
  })

  it('defaults type to empty string', () => {
    toast('hi')
    expect(toasts.value[0].type).toBe('')
  })

  it('auto-removes after 3200ms', () => {
    toast('bye')
    expect(toasts.value).toHaveLength(1)
    vi.advanceTimersByTime(3199)
    expect(toasts.value).toHaveLength(1)
    vi.advanceTimersByTime(1)
    expect(toasts.value).toHaveLength(0)
  })

  it('removes each toast independently by id', () => {
    toast('a'); toast('b'); toast('c')
    expect(toasts.value).toHaveLength(3)
    const ids = toasts.value.map(t => t.id)
    expect(new Set(ids).size).toBe(3) // unique ids
    vi.advanceTimersByTime(3200)
    expect(toasts.value).toHaveLength(0)
  })
})
