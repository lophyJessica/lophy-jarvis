import type { SyncMessage } from '../db'

export type ChatRole = 'user' | 'assistant' | 'system'

export interface ChatMessage {
  role: ChatRole
  content: string
}

const apiUrl = '/api-server'
const apiKey = import.meta.env.VITE_HERMES_API_KEY ?? ''
export const defaultSystemPrompt =
  '你是妮可·罗宾，用户的考古学家 AI 伙伴。用户叫刘龙飞，也称路飞。请用沉稳、博学、略带神秘的语气回答，必要时引用历史与文献。'

export const isHermesConfigured = Boolean(apiUrl && apiKey)

function requestHeaders() {
  return {
    'Content-Type': 'application/json',
    'X-Hermes-Key': apiKey,
  }
}

export class HermesError extends Error {
  constructor(message: string, readonly kind: 'timeout' | 'network' | 'unavailable' | 'configuration') {
    super(message)
    this.name = 'HermesError'
  }
}

export async function checkHermesConnection() {
  if (!isHermesConfigured) return false
  const controller = new AbortController()
  const timeoutId = window.setTimeout(() => controller.abort(), 8_000)
  try {
    const response = await fetch(`${apiUrl}/v1/models`, {
      headers: requestHeaders(),
      signal: controller.signal,
    })
    return response.ok
  } catch {
    return false
  } finally {
    window.clearTimeout(timeoutId)
  }
}

function normalizeHistoryRecord(raw: unknown, index: number): SyncMessage | null {
  if (!raw || typeof raw !== 'object') return null
  const record = raw as Record<string, unknown>
  const role = record.role
  const content = record.content
  if (role !== 'user' && role !== 'assistant') return null
  if (typeof content !== 'string') return null

  const createdAtRaw = record.createdAt ?? record.created_at ?? record.time
  const createdAt = typeof createdAtRaw === 'string' || typeof createdAtRaw === 'number'
    ? String(createdAtRaw)
    : new Date().toISOString()

  const idRaw = record.id
  const id = typeof idRaw === 'string' && idRaw.length > 0
    ? idRaw
    : `history-${index}-${createdAt}-${content.slice(0, 32)}`

  return {
    id,
    role,
    content,
    createdAt,
  }
}

function parseHistoryPayload(payload: unknown): SyncMessage[] {
  if (Array.isArray(payload)) {
    return payload
      .map((item, index) => normalizeHistoryRecord(item, index))
      .filter((item): item is SyncMessage => item !== null)
  }

  if (!payload || typeof payload !== 'object') return []

  const record = payload as Record<string, unknown>
  const candidates = [
    record.messages,
    record.history,
    record.data,
    record.items,
  ]

  for (const candidate of candidates) {
    if (!Array.isArray(candidate)) continue
    return candidate
      .map((item, index) => normalizeHistoryRecord(item, index))
      .filter((item): item is SyncMessage => item !== null)
  }

  return []
}

export async function fetchHistory(): Promise<SyncMessage[]> {
  if (!isHermesConfigured) return []
  const response = await fetch(`${apiUrl}/history`, {
    headers: requestHeaders(),
  })
  if (!response.ok) {
    throw new HermesError(`历史记录拉取失败（${response.status}）`, 'network')
  }
  const payload = await response.json() as unknown
  const messages = parseHistoryPayload(payload)
  return messages.sort((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt))
}

export async function pushHistory(messages: SyncMessage[]) {
  if (!isHermesConfigured) return
  await fetch(`${apiUrl}/history`, {
    method: 'POST',
    headers: requestHeaders(),
    body: JSON.stringify({ messages }),
  })
}

export async function clearServerHistory() {
  if (!isHermesConfigured) return
  await fetch(`${apiUrl}/history`, {
    method: 'DELETE',
    headers: requestHeaders(),
  })
}

export async function streamChatCompletion(
  messages: ChatMessage[],
  onDelta: (text: string) => void,
  externalSignal?: AbortSignal,
  systemPrompt = defaultSystemPrompt,
  history: ChatMessage[] = [],
) {
  if (!isHermesConfigured) {
    throw new HermesError('请先配置 Hermes API 地址和认证信息', 'configuration')
  }

  const controller = new AbortController()
  let timedOut = false
  let timeoutId = 0
  const resetTimeout = () => {
    window.clearTimeout(timeoutId)
    timeoutId = window.setTimeout(() => {
      timedOut = true
      controller.abort()
    }, 30_000)
  }
  const abortFromExternal = () => controller.abort()
  externalSignal?.addEventListener('abort', abortFromExternal, { once: true })
  resetTimeout()

  try {
    const requestMessages: ChatMessage[] = [
      { role: 'system', content: systemPrompt },
      ...history,
      ...messages,
    ]

    const response = await fetch(`${apiUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: requestHeaders(),
      body: JSON.stringify({
        model: 'hermes-agent',
        messages: requestMessages,
        stream: true,
      }),
      signal: controller.signal,
    })

    if (!response.ok) {
      if (response.status >= 500) {
        throw new HermesError('妮可·罗宾暂时不可用，请稍后再试', 'unavailable')
      }
      throw new HermesError(`Hermes 请求失败（${response.status}）`, 'network')
    }

    const contentType = response.headers.get('content-type') ?? ''
    if (!response.body || contentType.includes('application/json')) {
      const payload = await response.json() as { choices?: Array<{ message?: { content?: string } }> }
      const content = payload.choices?.[0]?.message?.content ?? ''
      if (content) onDelta(content)
      return content
    }

    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let completeText = ''
    let finished = false

    while (!finished) {
      const { value, done } = await reader.read()
      if (done) break
      resetTimeout()
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''

      for (const line of lines) {
        const normalized = line.trim()
        if (!normalized.startsWith('data:')) continue
        const data = normalized.slice(5).trim()
        if (data === '[DONE]') {
          finished = true
          break
        }
        try {
          const payload = JSON.parse(data) as {
            choices?: Array<{ delta?: { content?: string }; message?: { content?: string } }>
          }
          const delta = payload.choices?.[0]?.delta?.content
            ?? payload.choices?.[0]?.message?.content
            ?? ''
          if (delta) {
            completeText += delta
            onDelta(delta)
          }
        } catch {
          continue
        }
      }
    }
    return completeText
  } catch (error) {
    if (error instanceof HermesError) throw error
    if (timedOut) throw new HermesError('请求超时，请重试', 'timeout')
    if (externalSignal?.aborted) throw error
    throw new HermesError('网络连接失败，请检查 Hermes 服务配置', 'network')
  } finally {
    window.clearTimeout(timeoutId)
    externalSignal?.removeEventListener('abort', abortFromExternal)
  }
}
