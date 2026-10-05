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

test('shows a selected PDF filename locally', () => {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({ ok: true, json: async () => ({ status: 'ok' }) }),
  )
  render(<App />)

  const file = new File(['cv'], 'ada-lovelace.pdf', { type: 'application/pdf' })
  fireEvent.change(screen.getByLabelText('Choose a file'), {
    target: { files: [file] },
  })

  expect(screen.getByRole('status')).toHaveTextContent(
    'Selected: ada-lovelace.pdf',
  )
})

test('rejects an invalid CV file locally', () => {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({ ok: true, json: async () => ({ status: 'ok' }) }),
  )
  render(<App />)

  const file = new File(['cv'], 'notes.txt', { type: 'text/plain' })
  fireEvent.change(screen.getByLabelText('Choose a file'), {
    target: { files: [file] },
  })

  expect(screen.getByRole('alert')).toHaveTextContent(
    'Choose a PDF or DOCX file.',
  )
})

test('shows locally pasted CV text state', () => {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({ ok: true, json: async () => ({ status: 'ok' }) }),
  )
  render(<App />)

  fireEvent.change(screen.getByLabelText('Paste your CV text'), {
    target: { value: 'Experienced software engineer.' },
  })

  expect(screen.getByRole('status')).toHaveTextContent(
    'CV text added locally.',
  )
})

test('keeps an entered job description in the local draft', () => {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({ ok: true, json: async () => ({ status: 'ok' }) }),
  )
  render(<App />)

  fireEvent.change(screen.getByLabelText('Job description'), {
    target: { value: 'Build reliable APIs and work with product teams.' },
  })

  expect(screen.getByLabelText('Job description')).toHaveValue(
    'Build reliable APIs and work with product teams.',
  )
})

test('requires a CV and job description before opening signup', () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ status: 'ok' }) }))
  render(<App />)

  fireEvent.click(screen.getByRole('button', { name: 'Save' }))

  expect(screen.getByRole('alert')).toHaveTextContent('Add a valid CV file or paste your CV text.')
  expect(screen.getAllByRole('alert').at(-1)).toHaveTextContent('Add a job description.')
  expect(screen.queryByRole('heading', { name: 'Sign up' })).not.toBeInTheDocument()
})

test('asks which CV to use and preserves the draft through signup and login', () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ status: 'ok' }) }))
  render(<App />)

  const file = new File(['cv'], 'ada-lovelace.pdf', { type: 'application/pdf' })
  fireEvent.change(screen.getByLabelText('Choose a file'), { target: { files: [file] } })
  fireEvent.change(screen.getByLabelText('Paste your CV text'), { target: { value: 'Ada CV' } })
  fireEvent.change(screen.getByLabelText('Job description'), { target: { value: 'Build software.' } })
  fireEvent.click(screen.getByRole('button', { name: 'Save' }))
  expect(screen.getByRole('alert')).toHaveTextContent('Choose whether to use the uploaded file or pasted CV text.')

  fireEvent.click(screen.getByLabelText('Use the pasted CV text'))
  fireEvent.click(screen.getByRole('button', { name: 'Save' }))
  expect(screen.getByText('Create an account to save your CV and job description.')).toBeVisible()
  fireEvent.click(screen.getByRole('button', { name: 'Log in' }))
  fireEvent.click(screen.getByRole('button', { name: 'Back to home' }))
  expect(screen.getByLabelText('Paste your CV text')).toHaveValue('Ada CV')
  expect(screen.getByLabelText('Job description')).toHaveValue('Build software.')
  expect(screen.getByLabelText('Use the pasted CV text')).toBeChecked()
  expect(screen.getByText('Selected: ada-lovelace.pdf')).toBeVisible()
})

test('opens signup from the home hero and can return to login', () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ status: 'ok' }) }))
  render(<App />)
  fireEvent.click(screen.getByRole('button', { name: 'Sign up to compare' }))
  fireEvent.click(screen.getByRole('button', { name: 'Log in' }))
  expect(screen.getByLabelText('Email address')).toBeVisible()
})

test('shows signup validation and duplicate-email errors', async () => {
  const fetchMock = vi.fn((input: RequestInfo | URL) => {
    if (String(input).endsWith('/health')) return Promise.resolve({ ok: true, json: async () => ({ status: 'ok' }) })
    return Promise.resolve({ ok: false, json: async () => ({ detail: 'Email is already registered' }) })
  })
  vi.stubGlobal('fetch', fetchMock)
  render(<App />)
  fireEvent.click(screen.getByRole('button', { name: 'Sign up to compare' }))
  fireEvent.change(screen.getByLabelText('Email address'), { target: { value: 'ada@example.com' } })
  fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'short' } })
  fireEvent.change(screen.getByLabelText('Confirm password'), { target: { value: 'short' } })
  fireEvent.click(screen.getByRole('button', { name: 'Create account' }))
  expect(await screen.findByRole('alert')).toHaveTextContent('Password must have at least 12 characters.')
  fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'long-enough-password' } })
  fireEvent.change(screen.getByLabelText('Confirm password'), { target: { value: 'long-enough-password' } })
  fireEvent.click(screen.getByRole('button', { name: 'Create account' }))
  expect(await screen.findByRole('alert')).toHaveTextContent('Email is already registered')
})

test('returns to login after successful signup', async () => {
  vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => Promise.resolve({ ok: true, json: async () => String(input).endsWith('/health') ? { status: 'ok' } : { id: 1, email: 'ada@example.com' } })))
  render(<App />)
  fireEvent.click(screen.getByRole('button', { name: 'Sign up to compare' }))
  fireEvent.change(screen.getByLabelText('Email address'), { target: { value: 'ada@example.com' } })
  fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'long-enough-password' } })
  fireEvent.change(screen.getByLabelText('Confirm password'), { target: { value: 'long-enough-password' } })
  fireEvent.click(screen.getByRole('button', { name: 'Create account' }))
  expect(await screen.findByRole('heading', { name: 'Log in' })).toBeVisible()
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
