export const HEALTH_URL = 'http://127.0.0.1:8001/health'

const API_URL = 'http://127.0.0.1:8001'

export type CurrentUser = { id: number; email: string }
export type SavedJob = { id: number; title: string; company_name: string }
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

export async function saveCvText(token: string, text: string): Promise<void> {
  const response = await fetch(`${API_URL}/cv`, {
    method: 'PUT',
    headers: { ...authorization(token), 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
  })
  if (!response.ok) throw new ApiError(await getErrorMessage(response))
}

export async function uploadCv(token: string, file: File): Promise<void> {
  const form = new FormData()
  form.append('file', file)
  const response = await fetch(`${API_URL}/cv/upload`, {
    method: 'POST',
    headers: authorization(token),
    body: form,
  })
  if (!response.ok) throw new ApiError(await getErrorMessage(response))
}

export async function createJob(
  token: string,
  job: { title: string; company_name: string; description: string },
): Promise<SavedJob> {
  const response = await fetch(`${API_URL}/jobs`, {
    method: 'POST',
    headers: { ...authorization(token), 'Content-Type': 'application/json' },
    body: JSON.stringify(job),
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
