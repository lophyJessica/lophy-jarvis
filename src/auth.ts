export const JARVIS_TOKEN_KEY = 'jarvis-token'
export const JARVIS_USERNAME_KEY = 'jarvis-username'
export const JARVIS_AUTH_LOGIN_URL = '/p/jarvis/auth/login'

let unauthorizedHandler: (() => void) | null = null

export function setUnauthorizedHandler(handler: (() => void) | null) {
  unauthorizedHandler = handler
}

export function notifyUnauthorized() {
  unauthorizedHandler?.()
}

export function getJarvisToken() {
  return localStorage.getItem(JARVIS_TOKEN_KEY)
}

export function clearJarvisAuth() {
  localStorage.removeItem(JARVIS_TOKEN_KEY)
  localStorage.removeItem(JARVIS_USERNAME_KEY)
}

export function buildJarvisAuthHeaders(extra?: Record<string, string>) {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...extra,
  }
  const token = getJarvisToken()
  if (token) {
    headers.Authorization = `Bearer ${token}`
  }
  return headers
}

export function handleJarvisAuthResponse(response: Response) {
  if (response.status === 401) {
    notifyUnauthorized()
  }
  return response
}
