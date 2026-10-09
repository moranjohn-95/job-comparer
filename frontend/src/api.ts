export const HEALTH_URL = '/api/health'

const API_URL = '/api'

export type CurrentUser = { id: number; email: string }
export type SavedJob = { id: number; title: string; company_name: string }
export type JobDetails = SavedJob & { description: string }
export type SavedComparison = {
  id: number
  job_id: number
  created_at: string
  cv_outdated: boolean
  result: ComparisonResult
}
export type ComparisonSummary = {
  id: number
  job_id: number
  job_title: string
  company_name: string
  created_at: string
  matched_requirements_count: number
  possible_gaps_count: number
  needs_review_count: number
}
export type ComparisonResult = {
  matched_requirements: Array<{
    requirement: string
    job_evidence: string
    cv_evidence: string
  }>
  possible_gaps: Array<{
    requirement: string
    job_evidence: string
    status: 'not_found_in_cv'
  }>
  needs_review: Array<{
    requirement: string
    reason: string
    job_evidence: string
    cv_evidence?: string | null
  }>
  interpretation: string
}

export class ApiError extends Error {
  status?: number
  code?: string
  email?: string
  retryAfter?: number
  constructor(message: string, status?: number, code?: string, email?: string, retryAfter?: number) {
    super(message)
    this.status = status
    this.code = code
    this.email = email
    this.retryAfter = retryAfter
  }
}

let sessionGeneration = 0
export function resetSessionRequests(): void { sessionGeneration += 1 }

async function apiFetch(
  url: string, options: RequestInit = {}, notifyExpiry = true,
): Promise<Response> {
  const generation = sessionGeneration
  const headers = new Headers(options.headers)
  if (!['GET', 'HEAD', 'OPTIONS'].includes(options.method ?? 'GET')) {
    headers.set('X-CSRF-Protection', '1')
  }
  const response = await fetch(url, {
    ...options, headers, credentials: 'include', cache: 'no-store',
  })
  if (generation !== sessionGeneration || options.signal?.aborted) {
    throw new DOMException('Request no longer belongs to the active session', 'AbortError')
  }
  if (response.status === 401 && notifyExpiry) {
    window.dispatchEvent(new Event('session-expired'))
  }
  if (response.status === 403 && notifyExpiry) {
    const error = await getApiError(response.clone())
    if (generation !== sessionGeneration || options.signal?.aborted) {
      throw new DOMException('Inactive session', 'AbortError')
    }
    if (error.code === 'email_verification_required') {
      window.dispatchEvent(new CustomEvent('verification-required', { detail: error.email }))
    }
  }
  return response
}

async function getApiError(response: Response): Promise<ApiError> {
  const body: unknown = await response.json().catch(() => null)
  const detail = typeof body === 'object' && body !== null && 'detail' in body ? body.detail : null
  const fields = typeof detail === 'object' && detail !== null ? detail as Record<string, unknown> : {}
  const retryAfter = Number(response.headers?.get('Retry-After'))
  return new ApiError(typeof detail === 'string' ? detail
    : typeof fields.message === 'string' ? fields.message
      : 'The request could not be completed. Please try again.', response.status,
    typeof fields.code === 'string' ? fields.code : undefined,
    typeof fields.email === 'string' ? fields.email : undefined,
    Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : undefined)
}

export async function resendVerification(email: string, signal?: AbortSignal): Promise<void> {
  const response = await apiFetch(`${API_URL}/verification/resend`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email }), signal,
  }, false)
  if (!response.ok) throw await getApiError(response)
}

export async function confirmEmail(token: string, password: string, signal?: AbortSignal): Promise<void> {
  const response = await apiFetch(`${API_URL}/verification/confirm`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token, password }), signal,
  }, false)
  if (!response.ok) throw await getApiError(response)
}

export async function signIn(email: string, password: string): Promise<void> {
  const response = await apiFetch(`${API_URL}/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) }, false)
  if (!response.ok) throw await getApiError(response)
}

export async function signOut(): Promise<void> {
  const response = await apiFetch(`${API_URL}/logout`, { method: 'POST' }, false)
  if (!response.ok) throw await getApiError(response)
}

export async function signUp(email: string, password: string): Promise<void> {
  const response = await apiFetch(`${API_URL}/signup`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) }, false)
  if (!response.ok) throw await getApiError(response)
}

export async function getCurrentUser(signal?: AbortSignal): Promise<CurrentUser> {
  const response = await apiFetch(`${API_URL}/me`, { signal }, false)
  if (!response.ok) throw await getApiError(response)
  const body: unknown = await response.json()
  if (typeof body !== 'object' || body === null) throw new ApiError('Unable to sign in. Please try again.')
  const user = body as Record<string, unknown>
  if (typeof user.id !== 'number' || typeof user.email !== 'string') throw new ApiError('Unable to sign in. Please try again.')
  return { id: user.id, email: user.email }
}

export async function getSavedCv(
  signal: AbortSignal,
): Promise<string | null> {
  const response = await apiFetch(`${API_URL}/cv`, {
    method: 'GET', signal,
  })
  if (response.status === 404) return null
  if (!response.ok) throw await getApiError(response)
  const body: unknown = await response.json()
  if (
    response.status === 206 || typeof body !== 'object' || body === null ||
    !('text' in body) || typeof body.text !== 'string'
  ) throw new ApiError('The saved CV response was invalid. Please retry.')
  return body.text
}

export async function saveCvText(
  text: string, signal?: AbortSignal,
): Promise<void> {
  const response = await apiFetch(`${API_URL}/cv`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
    signal,
  })
  if (!response.ok) throw await getApiError(response)
}

export async function uploadCv(
  file: File, signal?: AbortSignal,
): Promise<string> {
  const form = new FormData()
  form.append('file', file)
  const response = await apiFetch(`${API_URL}/cv/upload`, {
    method: 'POST',
    body: form,
    signal,
  })
  if (!response.ok) throw await getApiError(response)
  const body: unknown = await response.json()
  if (
    typeof body !== 'object' || body === null ||
    !('text' in body) || typeof body.text !== 'string'
  ) {
    throw new ApiError(
      'The upload response was invalid. Reload My CV to check the saved text.',
    )
  }
  return body.text
}

export async function createJob(
  job: { title: string; company_name: string; description: string },
  signal?: AbortSignal,
): Promise<SavedJob> {
  const response = await apiFetch(`${API_URL}/jobs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(job),
    signal,
  })
  if (!response.ok) throw await getApiError(response)
  const body: unknown = await response.json()
  if (typeof body !== 'object' || body === null) {
    throw new ApiError('The job could not be saved. Please try again.')
  }
  const savedJob = body as Record<string, unknown>
  if (
    typeof savedJob.id !== 'number' ||
    typeof savedJob.title !== 'string' ||
    typeof savedJob.company_name !== 'string'
  ) {
    throw new ApiError('The job could not be saved. Please try again.')
  }
  return {
    id: savedJob.id,
    title: savedJob.title,
    company_name: savedJob.company_name,
  }
}

export async function getJobs(
  signal: AbortSignal,
): Promise<SavedJob[]> {
  const response = await apiFetch(`${API_URL}/jobs`, {
    method: 'GET',
    signal,
  })
  if (!response.ok) throw await getApiError(response)
  const body: unknown = await response.json()
  if (response.status === 206 || !Array.isArray(body)) {
    throw new ApiError('The jobs response was invalid. Please try again.')
  }
  return body.map((value: unknown) => {
    if (typeof value !== 'object' || value === null) {
      throw new ApiError('The jobs response was invalid. Please try again.')
    }
    const job = value as Record<string, unknown>
    if (
      typeof job.id !== 'number' ||
      typeof job.title !== 'string' ||
      typeof job.company_name !== 'string'
    ) {
      throw new ApiError('The jobs response was invalid. Please try again.')
    }
    return { id: job.id, title: job.title, company_name: job.company_name }
  })
}

export async function getJob(
  jobId: number,
  signal: AbortSignal,
): Promise<JobDetails | null> {
  const response = await apiFetch(`${API_URL}/jobs/${jobId}`, {
    method: 'GET',
    signal,
  })
  if (response.status === 404) return null
  if (!response.ok) throw await getApiError(response)
  const body: unknown = await response.json()
  if (typeof body !== 'object' || body === null) {
    throw new ApiError('The job response was invalid. Please try again.')
  }
  const job = body as Record<string, unknown>
  if (
    job.id !== jobId || typeof job.title !== 'string' ||
    typeof job.company_name !== 'string' ||
    typeof job.description !== 'string'
  ) {
    throw new ApiError('The job response was invalid. Please try again.')
  }
  return {
    id: jobId, title: job.title,
    company_name: job.company_name, description: job.description,
  }
}

export async function compareJob(
  jobId: number,
): Promise<{ result: ComparisonResult; comparisonId: number | null }> {
  const response = await apiFetch(`${API_URL}/jobs/${jobId}/compare`, {
    method: 'POST',
  })
  if (!response.ok) throw await getApiError(response)
  const body: unknown = await response.json()
  const savedId = response.headers?.get('X-Comparison-Id')
  const comparisonId = savedId && /^[1-9]\d*$/.test(savedId)
    && Number.isSafeInteger(Number(savedId)) ? Number(savedId) : null
  return { result: parseComparisonResult(body), comparisonId }
}

function parseComparisonResult(body: unknown): ComparisonResult {
  const result = body as Record<string, unknown> | null
  if (
    typeof body !== 'object' ||
    body === null ||
    !Array.isArray(result?.matched_requirements) ||
    !Array.isArray(result.possible_gaps) ||
    typeof result.interpretation !== 'string'
  ) {
    throw new ApiError('The comparison returned an invalid result.')
  }
  const needsReview = result.needs_review === undefined
    ? []
    : result.needs_review
  if (
    !Array.isArray(needsReview) ||
    !needsReview.every((value: unknown) => {
      if (typeof value !== 'object' || value === null) return false
      const item = value as Record<string, unknown>
      return (
        typeof item.requirement === 'string' &&
        typeof item.reason === 'string' &&
        typeof item.job_evidence === 'string' &&
        (item.cv_evidence === undefined ||
          item.cv_evidence === null ||
          typeof item.cv_evidence === 'string')
      )
    })
  ) {
    throw new ApiError('The comparison returned an invalid result.')
  }
  return { ...body as ComparisonResult, needs_review: needsReview }
}

function parseSavedComparison(body: unknown, jobId: number): SavedComparison {
  if (typeof body !== 'object' || body === null) {
    throw new ApiError('The saved comparison response was invalid.')
  }
  const entry = body as Record<string, unknown>
  if (
    typeof entry.id !== 'number' || !Number.isInteger(entry.id) ||
    entry.job_id !== jobId || typeof entry.created_at !== 'string' ||
    !Number.isFinite(Date.parse(entry.created_at)) ||
    typeof entry.cv_outdated !== 'boolean'
  ) {
    throw new ApiError('The saved comparison response was invalid.')
  }
  return {
    id: entry.id, job_id: jobId, created_at: entry.created_at,
    cv_outdated: entry.cv_outdated, result: parseComparisonResult(entry.result),
  }
}

export async function getComparisonSummaries(
  signal: AbortSignal,
): Promise<ComparisonSummary[]> {
  const response = await apiFetch(`${API_URL}/comparisons`, {
    method: 'GET', signal,
  })
  if (!response.ok) throw await getApiError(response)
  const body: unknown = await response.json()
  const invalid = 'The comparison history response was invalid. Please retry.'
  if (response.status === 206 || !Array.isArray(body)) {
    throw new ApiError(invalid)
  }
  return body.map((value: unknown) => {
    if (typeof value !== 'object' || value === null) throw new ApiError(invalid)
    const entry = value as Record<string, unknown>
    if (
      typeof entry.id !== 'number' || !Number.isInteger(entry.id) ||
      typeof entry.job_id !== 'number' || !Number.isInteger(entry.job_id) ||
      typeof entry.job_title !== 'string' ||
      typeof entry.company_name !== 'string' ||
      typeof entry.created_at !== 'string' ||
      !Number.isFinite(Date.parse(entry.created_at)) ||
      !['matched_requirements_count', 'possible_gaps_count', 'needs_review_count']
        .every((field) => typeof entry[field] === 'number'
          && Number.isInteger(entry[field]) && entry[field] >= 0)
    ) throw new ApiError(invalid)
    return entry as ComparisonSummary
  })
}

export async function getSavedComparisons(
  jobId: number, signal: AbortSignal,
): Promise<SavedComparison[]> {
  const response = await apiFetch(`${API_URL}/jobs/${jobId}/comparisons`, {
    method: 'GET', signal,
  })
  if (!response.ok) throw await getApiError(response)
  if (response.status === 206) {
    throw new ApiError('The saved comparison history was incomplete. Please retry.')
  }
  const body: unknown = await response.json()
  if (!Array.isArray(body)) {
    throw new ApiError('The saved comparisons response was invalid.')
  }
  return body.map((entry: unknown) => parseSavedComparison(entry, jobId))
}

export async function getSavedComparison(
  jobId: number, comparisonId: number, signal: AbortSignal,
): Promise<SavedComparison> {
  const response = await apiFetch(
    `${API_URL}/jobs/${jobId}/comparisons/${comparisonId}`,
    { method: 'GET', signal },
  )
  if (!response.ok) throw await getApiError(response)
  const entry = parseSavedComparison(await response.json(), jobId)
  if (entry.id !== comparisonId) {
    throw new ApiError('The saved comparison response was invalid.')
  }
  return entry
}

export async function checkHealth(signal: AbortSignal): Promise<boolean> {
  try {
    const response = await apiFetch(HEALTH_URL, { signal }, false)
    if (!response.ok) return false
    const body: unknown = await response.json()
    return (
      typeof body === 'object' &&
      body !== null &&
      'status' in body &&
      body.status === 'ok'
    )
  } catch {
    return false
  }
}
