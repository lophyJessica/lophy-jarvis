export type ChatRole = 'user' | 'assistant' | 'system'

export interface ChatMessage {
  role: ChatRole
  content: string
}

const apiUrl = '/api-server'
const apiKey = import.meta.env.VITE_HERMES_API_KEY ?? ''
const defaultSystemPrompt = '你是贾维斯，用户的个人 AI 助手。用户叫刘龙飞，也称路飞。'

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
        throw new HermesError('贾维斯暂时不可用，请稍后再试', 'unavailable')
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
