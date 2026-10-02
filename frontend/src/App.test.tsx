import { afterEach, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import App from './App'

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

  expect(screen.getByText('Compare your saved CV with job descriptions.')).toBeVisible()
  await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce())
  expect(fetchMock).toHaveBeenCalledWith(
    'http://127.0.0.1:8001/health',
    expect.objectContaining({ signal: expect.any(AbortSignal) }),
  )
})

test('shows an unavailable status for an unexpected health response', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ status: 'not-ok' }),
  }))

  render(<App />)

  expect(await screen.findByRole('button', { name: 'Retry connection' })).toBeVisible()
  expect(screen.getByText(
    'Start the FastAPI server at http://127.0.0.1:8001, then try again.',
  )).toBeVisible()
})

test('treats an HTTP error as unavailable without reading its body', async () => {
  const readBody = vi.fn()
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
    ok: false,
    json: readBody,
  }))

  render(<App />)

  await screen.findByRole('button', { name: 'Retry connection' })
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
  await screen.findByRole('button', { name: 'Retry connection' })
  fireEvent.click(screen.getByRole('button', { name: 'Retry connection' }))
  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
})

test('opens the login view from the public home navigation', () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ status: 'ok' }) }))
  render(<App />)
  fireEvent.click(screen.getByRole('button', { name: 'Log in' }))
  expect(screen.getByRole('heading', { name: 'Log in' })).toBeVisible()
})

test('shows an error when login credentials are rejected', async () => {
  vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
    if (String(input).endsWith('/health')) return Promise.resolve({ ok: true, json: async () => ({ status: 'ok' }) })
    return Promise.resolve({ ok: false, json: async () => ({ detail: 'Invalid email or password' }) })
  }))
  render(<App />)
  fireEvent.click(screen.getByRole('button', { name: 'Log in' }))
  fireEvent.change(screen.getByLabelText('Email address'), { target: { value: 'ada@example.com' } })
  fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'incorrect' } })
  fireEvent.click(screen.getByRole('button', { name: 'Log in' }))
  expect(await screen.findByRole('alert')).toHaveTextContent('Invalid email or password')
})

test('returns to the dashboard with the account email after login', async () => {
  const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).endsWith('/health')) return Promise.resolve({ ok: true, json: async () => ({ status: 'ok' }) })
    if (String(input).endsWith('/login')) return Promise.resolve({ ok: true, json: async () => ({ access_token: 'token-123' }) })
    expect(init).toMatchObject({ headers: { Authorization: 'Bearer token-123' } })
    return Promise.resolve({ ok: true, json: async () => ({ id: 1, email: 'ada@example.com' }) })
  })
  vi.stubGlobal('fetch', fetchMock)
  render(<App />)
  fireEvent.click(screen.getByRole('button', { name: 'Log in' }))
  fireEvent.change(screen.getByLabelText('Email address'), { target: { value: 'ada@example.com' } })
  fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'password' } })
  fireEvent.click(screen.getByRole('button', { name: 'Log in' }))
  expect(await screen.findByText('ada@example.com')).toBeVisible()
  expect(screen.getByRole('button', { name: 'Log out' })).toBeVisible()
})

test('logs out and restores the sidebar login action', async () => {
  vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
    if (String(input).endsWith('/health')) return Promise.resolve({ ok: true, json: async () => ({ status: 'ok' }) })
    if (String(input).endsWith('/login')) return Promise.resolve({ ok: true, json: async () => ({ access_token: 'token-123' }) })
    return Promise.resolve({ ok: true, json: async () => ({ id: 1, email: 'ada@example.com' }) })
  }))
  render(<App />)
  fireEvent.click(screen.getByRole('button', { name: 'Log in' }))
  fireEvent.change(screen.getByLabelText('Email address'), { target: { value: 'ada@example.com' } })
  fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'password' } })
  fireEvent.click(screen.getByRole('button', { name: 'Log in' }))
  fireEvent.click(await screen.findByRole('button', { name: 'Log out' }))
  expect(screen.getByRole('button', { name: 'Log in' })).toBeVisible()
  expect(screen.queryByText('ada@example.com')).not.toBeInTheDocument()
})
