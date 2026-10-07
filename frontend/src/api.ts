export const HEALTH_URL = 'http://127.0.0.1:8001/health'

const API_URL = 'http://127.0.0.1:8001'

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

export class ApiError extends Error {}

async function getErrorMessage(response: Response): Promise<string> {
  const body: unknown = await response.json().catch(() => null)
  if (typeof body === 'object' && body !== null && 'detail' in body && typeof body.detail === 'string') return body.detail
  return 'The request could not be completed. Please try again.'
}

export async function signIn(email: string, password: string): Promise<string> {
  const response = await fetch(`${API_URL}/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) })
  if (!response.ok) throw new ApiError(await getErrorMessage(response))
  const body: unknown = await response.json()
  if (typeof body !== 'object' || body === null || !('access_token' in body) || typeof body.access_token !== 'string') throw new ApiError('Unable to sign in. Please try again.')
  return body.access_token
}

export async function signUp(email: string, password: string): Promise<void> {
  const response = await fetch(`${API_URL}/signup`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) })
  if (!response.ok) throw new ApiError(await getErrorMessage(response))
}

export async function getCurrentUser(token: string): Promise<CurrentUser> {
  const response = await fetch(`${API_URL}/me`, { headers: { Authorization: `Bearer ${token}` } })
  if (!response.ok) throw new ApiError(await getErrorMessage(response))
  const body: unknown = await response.json()
  if (typeof body !== 'object' || body === null) throw new ApiError('Unable to sign in. Please try again.')
  const user = body as Record<string, unknown>
  if (typeof user.id !== 'number' || typeof user.email !== 'string') throw new ApiError('Unable to sign in. Please try again.')
  return { id: user.id, email: user.email }
}

function authorization(token: string): HeadersInit {
  return { Authorization: `Bearer ${token}` }
}

export async function getSavedCv(
  token: string, signal: AbortSignal,
): Promise<string | null> {
  const response = await fetch(`${API_URL}/cv`, {
    method: 'GET', headers: authorization(token), signal,
  })
  if (response.status === 404) return null
  if (!response.ok) throw new ApiError(await getErrorMessage(response))
  const body: unknown = await response.json()
  if (
    response.status === 206 || typeof body !== 'object' || body === null ||
    !('text' in body) || typeof body.text !== 'string'
  ) throw new ApiError('The saved CV response was invalid. Please retry.')
  return body.text
}

export async function saveCvText(
  token: string, text: string, signal?: AbortSignal,
): Promise<void> {
  const response = await fetch(`${API_URL}/cv`, {
    method: 'PUT',
    headers: { ...authorization(token), 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
    signal,
  })
  if (!response.ok) throw new ApiError(await getErrorMessage(response))
}

export async function uploadCv(
  token: string, file: File, signal?: AbortSignal,
): Promise<string> {
  const form = new FormData()
  form.append('file', file)
  const response = await fetch(`${API_URL}/cv/upload`, {
    method: 'POST',
    headers: authorization(token),
    body: form,
    signal,
  })
  if (!response.ok) throw new ApiError(await getErrorMessage(response))
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
  token: string,
  job: { title: string; company_name: string; description: string },
  signal?: AbortSignal,
): Promise<SavedJob> {
  const response = await fetch(`${API_URL}/jobs`, {
    method: 'POST',
    headers: { ...authorization(token), 'Content-Type': 'application/json' },
    body: JSON.stringify(job),
    signal,
  })
  if (!response.ok) throw new ApiError(await getErrorMessage(response))
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
  token: string,
  signal: AbortSignal,
): Promise<SavedJob[]> {
  const response = await fetch(`${API_URL}/jobs`, {
    method: 'GET',
    headers: authorization(token),
    signal,
  })
  if (!response.ok) throw new ApiError(await getErrorMessage(response))
  const body: unknown = await response.json()
  if (!Array.isArray(body)) {
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
  token: string,
  jobId: number,
  signal: AbortSignal,
): Promise<JobDetails | null> {
  const response = await fetch(`${API_URL}/jobs/${jobId}`, {
    method: 'GET',
    headers: authorization(token),
    signal,
  })
  if (response.status === 404) return null
  if (!response.ok) throw new ApiError(await getErrorMessage(response))
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
  token: string,
  jobId: number,
): Promise<ComparisonResult> {
  const response = await fetch(`${API_URL}/jobs/${jobId}/compare`, {
    method: 'POST',
    headers: authorization(token),
  })
  if (!response.ok) throw new ApiError(await getErrorMessage(response))
  const body: unknown = await response.json()
  return parseComparisonResult(body)
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
  token: string, signal: AbortSignal,
): Promise<ComparisonSummary[]> {
  const response = await fetch(`${API_URL}/comparisons`, {
    method: 'GET', headers: authorization(token), signal,
  })
  if (!response.ok) throw new ApiError(await getErrorMessage(response))
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
  token: string, jobId: number, signal: AbortSignal,
): Promise<SavedComparison[]> {
  const response = await fetch(`${API_URL}/jobs/${jobId}/comparisons`, {
    method: 'GET', headers: authorization(token), signal,
  })
  if (!response.ok) throw new ApiError(await getErrorMessage(response))
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
  token: string, jobId: number, comparisonId: number, signal: AbortSignal,
): Promise<SavedComparison> {
  const response = await fetch(
    `${API_URL}/jobs/${jobId}/comparisons/${comparisonId}`,
    { method: 'GET', headers: authorization(token), signal },
  )
  if (!response.ok) throw new ApiError(await getErrorMessage(response))
  const entry = parseSavedComparison(await response.json(), jobId)
  if (entry.id !== comparisonId) {
    throw new ApiError('The saved comparison response was invalid.')
  }
  return entry
}

export async function checkHealth(signal: AbortSignal): Promise<boolean> {
  try {
    const response = await fetch(HEALTH_URL, { signal })
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
