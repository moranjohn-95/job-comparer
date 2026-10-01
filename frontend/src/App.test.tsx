import { afterEach, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import App from './App'
import { HEALTH_URL } from './api'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

test('shows a connected status for a healthy API response', async () => {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ status: 'ok' }),
  })
  vi.stubGlobal('fetch', fetchMock)

  render(<App />)

  expect(screen.getByRole('heading', { name: 'Job Comparer' })).toBeVisible()
  await screen.findByText('API connected')
  expect(screen.getByRole('status')).toHaveTextContent('API connected')
  expect(fetchMock).toHaveBeenCalledOnce()
  expect(fetchMock).toHaveBeenCalledWith(
    HEALTH_URL,
    expect.objectContaining({ signal: expect.any(AbortSignal) }),
  )
})

test('shows an unavailable status for an unexpected health response', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ status: 'not-ok' }),
  }))

  render(<App />)

  await screen.findByText('API unavailable')
  expect(screen.getByRole('status')).toHaveTextContent('API unavailable')
  expect(screen.getByRole('button', { name: 'Retry connection' })).toBeVisible()
})

test('treats an HTTP error as unavailable without reading its body', async () => {
  const readBody = vi.fn()
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
    ok: false,
    json: readBody,
  }))

  render(<App />)

  await screen.findByText('API unavailable')
  expect(readBody).not.toHaveBeenCalled()
})

test('can retry after a network failure', async () => {
  const fetchMock = vi.fn()
    .mockRejectedValueOnce(new TypeError('Network error'))
    .mockResolvedValueOnce({
      ok: true,
      json: async () => ({ status: 'ok' }),
    })
  vi.stubGlobal('fetch', fetchMock)

  render(<App />)
  await screen.findByText('API unavailable')
  fireEvent.click(screen.getByRole('button', { name: 'Retry connection' }))

  await screen.findByText('API connected')
  expect(screen.getByRole('status')).toHaveTextContent('API connected')
  expect(fetchMock).toHaveBeenCalledTimes(2)
})
