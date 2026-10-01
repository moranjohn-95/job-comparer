export const HEALTH_URL = 'http://127.0.0.1:8001/health'

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
