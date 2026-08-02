import {
  memo,
  startTransition,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent,
} from 'react'
import {
  AudioOutlined,
  CheckCircleOutlined,
  CloseCircleOutlined,
  CopyOutlined,
  DeleteOutlined,
  LoadingOutlined,
  LogoutOutlined,
  PictureOutlined,
  SendOutlined,
} from '@ant-design/icons'
import { App as AntApp, Button, Card, ConfigProvider, Empty, Input, Switch, Tag, Tooltip, Typography, theme } from 'antd'
import {
  defaultSystemPrompt,
  HermesError,
  isHermesConfigured,
  streamChatCompletion,
} from './api/hermes'
import JarvisCore, { type JarvisStatus } from './components/JarvisCore'
import LoginPage from './components/LoginPage'
import {
  buildJarvisAuthHeaders,
  clearJarvisAuth,
  getJarvisToken,
  handleJarvisAuthResponse,
  JARVIS_TOKEN_KEY,
  JARVIS_USERNAME_KEY,
  setUnauthorizedHandler,
} from './auth'
import {
  addMessage,
  clearMessages,
  createStoredMessage,
  getMessages,
  toChatHistory,
  type StoredMessage,
} from './db'
import { useSpeechRecognition } from './hooks/useSpeechRecognition'
import { useSpeechSynthesis } from './hooks/useSpeechSynthesis'
import {
  getMessageImageUrls,
  getMessageText,
  isMessageContent,
  type MessageContent,
} from './types/messages'
import { renderMarkdown } from './utils/markdown'
import './App.css'

type ConnectionState = 'checking' | 'online' | 'offline' | 'unconfigured'
const _a = '/api-server'
const jh = '/p/jarvis/history'
const hermesApiKey = import.meta.env.VITE_HERMES_API_KEY ?? ''
const assistantName = '妮可·罗宾'
const systemPrompt = defaultSystemPrompt
const maxSavedMessages = 200
let sharedHistoryHydrationPromise: Promise<void> | null = null
let sharedServerHydrated = false
const zhMessageClock = new Intl.DateTimeFormat('zh-CN', {
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
})

function resetHistoryHydrationState() {
  sharedHistoryHydrationPromise = null
  sharedServerHydrated = false
}

function historySyncHeaders(): Record<string, string> {
  const headers = buildJarvisAuthHeaders()
  if (hermesApiKey) {
    headers['X-Hermes-Key'] = hermesApiKey
  }
  return headers
}

async function fetchJarvisHistoryGet(limit: number) {
  const response = await fetch(`${jh}?limit=${limit}`, {
    headers: historySyncHeaders(),
  })
  return handleJarvisAuthResponse(response)
}

async function persistChatHistoryLocal(messages: StoredMessage[]) {
  const savedMessages = messages.slice(-maxSavedMessages)
  await clearMessages()
  for (const message of savedMessages) {
    await addMessage(message)
  }
}

async function postChatHistoryToServer(
  messages: StoredMessage[],
  canPost: () => boolean,
) {
  if (!canPost()) return null
  const payload = messages.slice(-maxSavedMessages)
  console.log('[history] POST', payload.length)
  return fetch(jh, {
    method: 'POST',
    headers: historySyncHeaders(),
    body: JSON.stringify({ messages: payload }),
  }).then(handleJarvisAuthResponse)
}

function parseHistoryMessagesPayload(payload: unknown): unknown[] {
  if (Array.isArray(payload)) return payload
  if (!payload || typeof payload !== 'object') return []
  const record = payload as Record<string, unknown>
  const candidates = [record.messages, record.history, record.data, record.items]
  for (const candidate of candidates) {
    if (Array.isArray(candidate)) return candidate
  }
  return []
}

async function loadMessagesFromIndexedDB(): Promise<StoredMessage[]> {
  try {
    return (await getMessages()).slice(-maxSavedMessages)
  } catch {
    return []
  }
}

function fetchJarvisHistoryDelete() {
  return fetch(jh, {
    method: 'DELETE',
    headers: historySyncHeaders(),
  }).then(handleJarvisAuthResponse)
}

function formatMessageDisplayTime(createdAt: string) {
  const parsed = Date.parse(createdAt)
  if (Number.isNaN(parsed)) return '--:--'
  return zhMessageClock.format(new Date(parsed))
}

function resolveHistoryCreatedAt(record: Record<string, unknown>, index: number, total: number): string {
  if (typeof record.createdAt === 'string' && record.createdAt.length > 0) {
    const parsed = Date.parse(record.createdAt)
    if (!Number.isNaN(parsed)) return record.createdAt
  }
  if (typeof record.created_at === 'string' && record.created_at.length > 0) {
    const parsed = Date.parse(record.created_at)
    if (!Number.isNaN(parsed)) return record.created_at
  }
  if (typeof record.updatedAt === 'number' && !Number.isNaN(record.updatedAt)) {
    return new Date(record.updatedAt).toISOString()
  }
  const timeRaw = record.time
  if (typeof timeRaw === 'string' && timeRaw.length > 0) {
    const parsed = Date.parse(timeRaw)
    if (!Number.isNaN(parsed)) return new Date(parsed).toISOString()
  }
  return new Date(Date.now() - (total - index) * 1000).toISOString()
}

function normalizeHistoryMessages(payload: unknown): StoredMessage[] {
  const raw = parseHistoryMessagesPayload(payload)
  const total = raw.length
  const normalized = raw
    .map((item, index) => {
      if (!item || typeof item !== 'object') return null
      const record = item as Record<string, unknown>
      const role = record.role
      const content = record.content
      if (role !== 'user' && role !== 'assistant') return null
      if (!isMessageContent(content)) return null

      const idRaw = record.id
      const id = typeof idRaw === 'string' && idRaw.length > 0 ? idRaw : `server-${index}`

      return {
        id,
        role,
        content,
        createdAt: resolveHistoryCreatedAt(record, index, total),
      }
    })
    .filter((message): message is StoredMessage => message !== null)

  return normalized.slice(-maxSavedMessages)
}
const messageListStickThresholdPx = 80
const initialHistoryFetchLimit = maxSavedMessages
const messageRenderBatchSize = 30
const messagePreviewLength = 200

const textareaTagPattern = /<textarea\b[^>]*>([\s\S]*?)<\/textarea>/gi
const fencedCodePattern = /```[^\n]*\n?[\s\S]*?```/g

type RenderContentPart = { type: 'markdown' | 'textarea'; text: string }

function getFencedCodeRanges(content: string) {
  const ranges: Array<{ start: number; end: number }> = []
  const pattern = new RegExp(fencedCodePattern.source, 'g')
  let match: RegExpExecArray | null

  while ((match = pattern.exec(content)) !== null) {
    ranges.push({ start: match.index, end: match.index + match[0].length })
  }

  return ranges
}

function isInsideFencedCode(index: number, ranges: Array<{ start: number; end: number }>) {
  return ranges.some((range) => index >= range.start && index < range.end)
}

function hasInteractiveTextarea(content: string) {
  const fencedRanges = getFencedCodeRanges(content)
  const pattern = /<textarea\b/gi
  let match: RegExpExecArray | null

  while ((match = pattern.exec(content)) !== null) {
    if (!isInsideFencedCode(match.index, fencedRanges)) return true
  }

  return false
}

function splitTextareaParts(content: string): RenderContentPart[] {
  const fencedRanges = getFencedCodeRanges(content)
  const parts: RenderContentPart[] = []
  let lastIndex = 0
  const pattern = new RegExp(textareaTagPattern.source, 'gi')
  let match: RegExpExecArray | null

  while ((match = pattern.exec(content)) !== null) {
    if (isInsideFencedCode(match.index, fencedRanges)) continue

    if (match.index > lastIndex) {
      parts.push({ type: 'markdown', text: content.slice(lastIndex, match.index) })
    }
    parts.push({ type: 'textarea', text: match[1] ?? '' })
    lastIndex = match.index + match[0].length
  }

  if (lastIndex < content.length) {
    parts.push({ type: 'markdown', text: content.slice(lastIndex) })
  }

  if (parts.length === 0) {
    parts.push({ type: 'markdown', text: content })
  }

  return parts
}

function CopyableTextareaBlock({
  text,
  onCopy,
}: {
  text: string
  onCopy: (text: string) => void
}) {
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  return (
    <span className="markdown-textarea-shell">
      <textarea
        ref={textareaRef}
        readOnly
        className="markdown-textarea"
        value={text}
      />
      <span className="markdown-textarea-copy-anchor">
        <Tooltip title="复制">
          <Button
            type="text"
            size="small"
            shape="circle"
            icon={<CopyOutlined />}
            className="markdown-textarea-copy-button"
            onClick={() => onCopy(textareaRef.current?.value ?? text)}
            aria-label="复制文本框内容"
          />
        </Tooltip>
      </span>
    </span>
  )
}

const MemoCopyableTextareaBlock = memo(CopyableTextareaBlock)

async function copyTextToClipboard(text: string) {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text)
      return
    } catch {
      // fall through to execCommand (e.g. non-secure context on VPS)
    }
  }

  const textarea = document.createElement('textarea')
  textarea.value = text
  textarea.setAttribute('readonly', 'true')
  textarea.style.position = 'fixed'
  textarea.style.left = '-9999px'
  textarea.style.top = '0'
  document.body.appendChild(textarea)
  textarea.select()
  const copied = document.execCommand('copy')
  document.body.removeChild(textarea)
  if (!copied) {
    throw new Error('复制失败')
  }
}

function PlainTextBody({ text }: { text: string }) {
  return (
    <div style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
      {text}
    </div>
  )
}

const MarkdownHtml = memo(function MarkdownHtml({
  content,
  className,
  onCopy,
}: {
  content: string
  className?: string
  onCopy?: (text: string) => void
}) {
  const html = useMemo(() => renderMarkdown(content), [content])
  const containerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const root = containerRef.current
    if (!root) return

    const handleClick = (event: MouseEvent) => {
      const button = (event.target as HTMLElement).closest<HTMLButtonElement>('.code-copy-btn')
      if (!button || !root.contains(button)) return
      const payload = button.getAttribute('data-copy')
      if (!payload) return
      event.preventDefault()

      void (async () => {
        try {
          const text = decodeURIComponent(payload)
          if (onCopy) {
            await onCopy(text)
            return
          }
          await copyTextToClipboard(text)
        } catch {
          return
        }
        const previousLabel = button.textContent
        button.textContent = '已复制'
        window.setTimeout(() => {
          button.textContent = previousLabel ?? '复制'
        }, 1500)
      })()
    }

    root.addEventListener('click', handleClick)
    return () => root.removeEventListener('click', handleClick)
  }, [html, onCopy])

  return (
    <div
      ref={containerRef}
      className={className}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  )
})

const MessageRichContent = memo(function MessageRichContent({
  content,
  onCopy,
}: {
  content: string
  onCopy: (text: string) => void
}) {
  const parts = useMemo(() => splitTextareaParts(content), [content])

  return (
    <>
      {parts.map((part, index) => {
        if (part.type === 'textarea') {
          return (
            <MemoCopyableTextareaBlock
              key={`textarea-${index}`}
              text={part.text}
              onCopy={onCopy}
            />
          )
        }
        if (!part.text.trim()) return null
        return (
          <MarkdownHtml
            key={`markdown-${index}`}
            content={part.text}
            onCopy={onCopy}
          />
        )
      })}
    </>
  )
})

function MessageBody({
  content,
  className,
  onCopy,
}: {
  content: string
  className?: string
  onCopy: (text: string) => void
}) {
  const hasTextarea = hasInteractiveTextarea(content)

  if (hasTextarea) {
    return (
      <div className={className}>
        <MessageRichContent content={content} onCopy={onCopy} />
      </div>
    )
  }

  return (
    <MarkdownHtml
      content={content}
      className={className}
      onCopy={onCopy}
    />
  )
}

const MemoMessageBubbleContent = memo(function MessageBubbleContent({
  messageId,
  content,
  expanded,
  onToggleExpand,
  onCopy,
}: {
  messageId: string
  content: MessageContent
  expanded: boolean
  onToggleExpand: (id: string) => void
  onCopy: (text: string) => void
}) {
  const textContent = getMessageText(content)
  const imageUrls = getMessageImageUrls(content)
  const isLong = textContent.length > messagePreviewLength

  const imagePreview = imageUrls.length > 0 && (
    <div className="message-image-grid">
      {imageUrls.map((src, index) => (
        <img
          key={`${src.slice(0, 48)}-${index}`}
          src={src}
          alt={`消息图片 ${index + 1}`}
          className="message-image-thumbnail"
        />
      ))}
    </div>
  )

  if (isLong && !expanded) {
    return (
      <>
        <PlainTextBody text={`${textContent.slice(0, messagePreviewLength)}…`} />
        {imagePreview}
        <Button
          type="link"
          size="small"
          onClick={() => onToggleExpand(messageId)}
          style={{ padding: 0, height: 'auto' }}
        >
          展开全文
        </Button>
      </>
    )
  }

  return (
    <>
      {textContent && (
        <MessageBody
          content={textContent}
          className={isLong ? 'expand-content message-markdown' : 'message-markdown'}
          onCopy={onCopy}
        />
      )}
      {imagePreview}
      {isLong && (
        <Button
          type="link"
          size="small"
          onClick={() => onToggleExpand(messageId)}
          style={{ padding: 0, height: 'auto' }}
        >
          收起
        </Button>
      )}
    </>
  )
})

const MemoStreamingMessageContent = memo(function StreamingMessageContent({
  content,
  onCopy,
}: {
  content: string
  onCopy: (text: string) => void
}) {
  return (
    <MessageBody
      content={content}
      className="expand-content message-markdown"
      onCopy={onCopy}
    />
  )
})

const MemoChatMessageRow = memo(function ChatMessageRow({
  chatMessage,
  assistantLabel,
  expanded,
  onToggleExpand,
  onCopyContent,
}: {
  chatMessage: StoredMessage
  assistantLabel: string
  expanded: boolean
  onToggleExpand: (id: string) => void
  onCopyContent: (text: string) => void
}) {
  return (
    <article className={`message-row ${chatMessage.role}`}>
      <div className="message-meta">
        <span>{chatMessage.role === 'user' ? '你' : assistantLabel}</span>
        <time>{formatMessageDisplayTime(chatMessage.createdAt)}</time>
        <Tooltip title="复制消息">
          <Button
            type="text"
            size="small"
            shape="circle"
            icon={<CopyOutlined />}
            className="message-copy-button"
            onClick={() => onCopyContent(getMessageText(chatMessage.content))}
            aria-label="复制消息"
          />
        </Tooltip>
      </div>
      <div className="message-bubble message-content">
        <MemoMessageBubbleContent
          messageId={chatMessage.id}
          content={chatMessage.content}
          expanded={expanded}
          onToggleExpand={onToggleExpand}
          onCopy={onCopyContent}
        />
      </div>
    </article>
  )
})

function buildMessageContent(text: string, images: string[]): MessageContent {
  const trimmed = text.trim()
  if (images.length === 0) return trimmed

  return [
    { type: 'text', text: trimmed || '请查看图片' },
    ...images.map((url) => ({ type: 'image_url' as const, image_url: { url } })),
  ]
}

function readFileAsDataUrl(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(file)
  })
}

function loadImage(dataUrl: string) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image()
    image.onload = () => resolve(image)
    image.onerror = () => reject(new Error('图片读取失败'))
    image.src = dataUrl
  })
}

async function readImageFile(file: File) {
  const sourceDataUrl = await readFileAsDataUrl(file)
  const image = await loadImage(sourceDataUrl)
  const maxWidth = 800
  const targetWidth = Math.min(image.naturalWidth, maxWidth)
  const targetHeight = Math.round(image.naturalHeight * (targetWidth / image.naturalWidth))
  const canvas = document.createElement('canvas')
  canvas.width = targetWidth
  canvas.height = targetHeight
  const context = canvas.getContext('2d')
  if (!context) throw new Error('图片压缩失败')
  context.drawImage(image, 0, 0, targetWidth, targetHeight)
  return canvas.toDataURL('image/jpeg', 0.6)
}

function ConsoleApp({
  username,
  onLogout,
}: {
  username: string
  onLogout: () => void | Promise<void>
}) {
  const { message: messageApi } = AntApp.useApp()
  const [messages, setMessages] = useState<StoredMessage[]>([])
  const [messagesReady, setMessagesReady] = useState(false)
  const [input, setInput] = useState('')
  const [pendingImages, setPendingImages] = useState<string[]>([])
  const [isThinking, setIsThinking] = useState(false)
  const [streamingText, setStreamingText] = useState('')
  const [speechEnabled, setSpeechEnabled] = useState(true)
  const [connectionState, setConnectionState] = useState<ConnectionState>(
    isHermesConfigured ? 'checking' : 'unconfigured',
  )
  const mockTextareaMode = new URLSearchParams(window.location.search).has('mock-textarea')
  const testImageMode = new URLSearchParams(window.location.search).has('test-image')
  const messageListRef = useRef<HTMLElement>(null)
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const stickToBottomRef = useRef(true)
  const loadingOlderMessagesRef = useRef(false)
  const previousMessageCountRef = useRef(0)
  const [visibleMessageCount, setVisibleMessageCount] = useState(messageRenderBatchSize)
  const [expandedMessageIds, setExpandedMessageIds] = useState<Set<string>>(() => new Set())
  const activeRequestRef = useRef<AbortController | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const lastTranscriptRef = useRef('')
  const isHydratingRef = useRef(true)
  const serverHydratedRef = useRef(false)
  const hydrationPromiseRef = useRef<Promise<void> | null>(null)
  const {
    interimText,
    finalText,
    isListening,
    error: recognitionError,
    isSupported: recognitionSupported,
    toggle: toggleListening,
    stop: stopListening,
  } = useSpeechRecognition()
  const {
    speak,
    stopSpeaking,
    isSpeaking,
    isSupported: synthesisSupported,
  } = useSpeechSynthesis()

  const applyConversationMessages = useCallback((nextMessages: StoredMessage[]) => {
    setMessages(nextMessages)
  }, [])

  const scrollToLatestMessages = useCallback(() => {
    requestAnimationFrame(() => {
      const list = messageListRef.current
      if (list) {
        list.scrollTop = list.scrollHeight
      }
      messagesEndRef.current?.scrollIntoView({ behavior: 'auto', block: 'end' })
    })
  }, [])

  const visibleMessages = useMemo(() => {
    if (messages.length <= visibleMessageCount) return messages
    return messages.slice(messages.length - visibleMessageCount)
  }, [messages, visibleMessageCount])

  const hasOlderMessages = visibleMessageCount < messages.length

  const toggleMessageExpanded = useCallback((messageId: string) => {
    startTransition(() => {
      setExpandedMessageIds((current) => {
        const next = new Set(current)
        if (next.has(messageId)) next.delete(messageId)
        else next.add(messageId)
        return next
      })
    })
  }, [])

  useEffect(() => {
    const previous = previousMessageCountRef.current
    if (messages.length === 0) {
      setVisibleMessageCount(messageRenderBatchSize)
    } else if (previous === 0) {
      setVisibleMessageCount(messages.length)
    } else if (messages.length > previous) {
      setVisibleMessageCount(messages.length)
    }
    previousMessageCountRef.current = messages.length
  }, [messages.length])

  const status: JarvisStatus = isListening
    ? 'listening'
    : isThinking
      ? 'thinking'
      : isSpeaking
        ? 'speaking'
        : 'idle'

  const copyMessage = useCallback(async (text: string) => {
    const content = text.trim()
    if (!content) return
    try {
      await copyTextToClipboard(content)
      void messageApi.success('已复制')
    } catch {
      void messageApi.error('复制失败')
    }
  }, [messageApi])

  const handleMessageListScroll = useCallback(() => {
    const list = messageListRef.current
    if (!list) return
    const distanceFromBottom = list.scrollHeight - list.scrollTop - list.clientHeight
    stickToBottomRef.current = distanceFromBottom <= messageListStickThresholdPx

    const shouldLoadOlder = visibleMessageCount < messages.length
      && list.scrollTop <= 48
      && !loadingOlderMessagesRef.current
    if (!shouldLoadOlder) return

    loadingOlderMessagesRef.current = true
    const previousHeight = list.scrollHeight
    setVisibleMessageCount((count) => Math.min(messages.length, count + messageRenderBatchSize))
    requestAnimationFrame(() => {
      const listEl = messageListRef.current
      if (listEl) {
        const heightDelta = listEl.scrollHeight - previousHeight
        listEl.scrollTop += heightDelta
      }
      loadingOlderMessagesRef.current = false
    })
  }, [messages.length, visibleMessageCount])

  const persistMessages = useCallback(async (nextMessages: StoredMessage[]) => {
    await persistChatHistoryLocal(nextMessages)
  }, [])

  const canPostHistoryToServer = useCallback(() => {
    return !isHydratingRef.current && serverHydratedRef.current
  }, [])

  const uploadChatHistoryAfterRound = useCallback(async (nextMessages: StoredMessage[]) => {
    if (!canPostHistoryToServer()) return

    try {
      await persistChatHistoryLocal(nextMessages)
    } catch (error) {
      console.error('本地缓存写入失败', error)
    }

    try {
      const response = await postChatHistoryToServer(nextMessages, canPostHistoryToServer)
      if (!response) return
      if (!response.ok) {
        throw new Error(`历史同步失败（${response.status}）`)
      }
    } catch (error) {
      console.error('云端历史同步失败', error)
      void messageApi.warning('云端同步失败，当前记录暂存在本地')
    }
  }, [canPostHistoryToServer, messageApi])

  useEffect(() => {
    const reapplyMessagesAfterHydration = async () => {
      if (sharedServerHydrated) {
        try {
          const response = await fetchJarvisHistoryGet(initialHistoryFetchLimit)
          if (response.ok) {
            const serverMessages = normalizeHistoryMessages(await response.json())
            console.log('[history] server GET', serverMessages.length)
            applyConversationMessages(serverMessages)
            await persistChatHistoryLocal(serverMessages)
            console.log('[history] messages set from server', serverMessages.length)
            scrollToLatestMessages()
            return
          }
        } catch (error) {
          console.error('历史记录恢复失败', error)
        }
      }
      const localMessages = await loadMessagesFromIndexedDB()
      console.log('[history] local fallback', localMessages.length)
      applyConversationMessages(localMessages)
      scrollToLatestMessages()
    }

    if (sharedHistoryHydrationPromise) {
      hydrationPromiseRef.current = sharedHistoryHydrationPromise
      void (async () => {
        await sharedHistoryHydrationPromise
        serverHydratedRef.current = sharedServerHydrated
        isHydratingRef.current = false
        await reapplyMessagesAfterHydration()
        setMessagesReady(true)
        scrollToLatestMessages()
      })()
      return
    }

    isHydratingRef.current = true
    serverHydratedRef.current = false
    sharedServerHydrated = false

    const hydrate = async () => {
      try {
        const response = await fetchJarvisHistoryGet(initialHistoryFetchLimit)
        if (!response.ok) {
          throw new Error(`历史记录拉取失败（${response.status}）`)
        }
        const payload = await response.json() as unknown
        const serverMessages = normalizeHistoryMessages(payload)
        console.log('[history] server GET', serverMessages.length)
        applyConversationMessages(serverMessages)
        await persistChatHistoryLocal(serverMessages)
        console.log('[history] messages set from server', serverMessages.length)
        serverHydratedRef.current = true
        sharedServerHydrated = true
        scrollToLatestMessages()
      } catch (error) {
        console.error('历史记录拉取失败', error)
        const localMessages = await loadMessagesFromIndexedDB()
        console.log('[history] local fallback', localMessages.length)
        applyConversationMessages(localMessages)
        scrollToLatestMessages()
        serverHydratedRef.current = true
        sharedServerHydrated = true
      } finally {
        isHydratingRef.current = false
        setMessagesReady(true)
      }
    }

    sharedHistoryHydrationPromise = hydrate()
    hydrationPromiseRef.current = sharedHistoryHydrationPromise
    void sharedHistoryHydrationPromise
  }, [applyConversationMessages, scrollToLatestMessages])

  useEffect(() => {
    if (!mockTextareaMode || !messagesReady) return
    applyConversationMessages([
      createStoredMessage('assistant', '<textarea>test</textarea>'),
    ])
  }, [applyConversationMessages, messagesReady, mockTextareaMode])

  useEffect(() => {
    let active = true
    if (!isHermesConfigured) {
      setConnectionState('unconfigured')
      return () => {
        active = false
      }
    }

    const controller = new AbortController()
    const timeoutId = window.setTimeout(() => controller.abort(), 8_000)
    fetch(`${_a}/v1/models`, {
      headers: historySyncHeaders(),
      signal: controller.signal,
    })
      .then((response) => {
        if (active) setConnectionState(response.ok ? 'online' : 'offline')
      })
      .catch(() => {
        if (active) setConnectionState('offline')
      })
      .finally(() => {
        window.clearTimeout(timeoutId)
      })

    return () => {
      active = false
      controller.abort()
      window.clearTimeout(timeoutId)
    }
  }, [])

  useEffect(() => {
    const combinedTranscript = `${finalText}${interimText}`
    if (!combinedTranscript || combinedTranscript === lastTranscriptRef.current) return
    lastTranscriptRef.current = combinedTranscript
    setInput(combinedTranscript)
  }, [finalText, interimText])

  useEffect(() => {
    if (recognitionError) void messageApi.warning(recognitionError)
  }, [messageApi, recognitionError])

  useEffect(() => {
    if (!stickToBottomRef.current) return
    const list = messageListRef.current
    if (!list) return
    requestAnimationFrame(() => {
      list.scrollTop = list.scrollHeight
    })
  }, [messages, streamingText])

  useEffect(() => () => {
    activeRequestRef.current?.abort()
    stopSpeaking()
  }, [stopSpeaking])

  const appendImages = useCallback(async (files: FileList | File[]) => {
    const imageFiles = Array.from(files).filter((file) => file.type.startsWith('image/'))
    if (imageFiles.length === 0) return
    const dataUrls = await Promise.all(imageFiles.map(readImageFile))
    setPendingImages((current) => [...current, ...dataUrls].slice(-6))
  }, [])

  useEffect(() => {
    if (!testImageMode) return
    const canvas = document.createElement('canvas')
    canvas.width = 100
    canvas.height = 100
    const context = canvas.getContext('2d')
    if (!context) return
    context.fillStyle = '#ff0000'
    context.fillRect(0, 0, canvas.width, canvas.height)
    canvas.toBlob((blob) => {
      if (!blob) return
      void appendImages([new File([blob], 'multimodal-red-square.png', { type: 'image/png' })])
    }, 'image/png')
  }, [appendImages, testImageMode])

  const handleComposerPaste = useCallback((event: ClipboardEvent<HTMLTextAreaElement>) => {
    const items = event.clipboardData?.items
    if (!items) return
    const imageFiles = Array.from(items)
      .filter((item) => item.type.startsWith('image/'))
      .map((item) => item.getAsFile())
      .filter((file): file is File => Boolean(file))
    if (imageFiles.length === 0) return
    event.preventDefault()
    void appendImages(imageFiles)
  }, [appendImages])

  const sendMessage = useCallback(async () => {
    const content = buildMessageContent(input, pendingImages)
    if ((typeof content === 'string' && !content) || isThinking) return
    if (!isHermesConfigured) {
      void messageApi.info('请先在 .env.local 中配置 Hermes API 地址和认证信息')
      return
    }

    stickToBottomRef.current = true
    stopListening()
    stopSpeaking()
    setInput('')
    setPendingImages([])
    lastTranscriptRef.current = ''
    const currentMessages = messages
    const userMessage = createStoredMessage('user', content)
    const afterUserMessages = [...currentMessages, userMessage]
    let messagesToPersist = afterUserMessages
    let shouldUploadHistory = false
    applyConversationMessages(afterUserMessages)
    setIsThinking(true)
    setStreamingText('')
    const requestController = new AbortController()
    activeRequestRef.current = requestController
    let responseText = ''
    const chatContext = toChatHistory(currentMessages)

    try {
      responseText = await streamChatCompletion(
        [{ role: userMessage.role, content: userMessage.content }],
        (delta) => {
          responseText += delta
          setStreamingText(responseText)
        },
        requestController.signal,
        systemPrompt,
        chatContext,
      )
      if (!responseText.trim()) throw new HermesError('Hermes 返回了空回复', 'network')
      const assistantMessage = createStoredMessage('assistant', responseText)
      const nextMessages = [...afterUserMessages, assistantMessage]
      messagesToPersist = nextMessages
      applyConversationMessages(nextMessages)
      setStreamingText('')
      setConnectionState('online')
      if (speechEnabled && synthesisSupported) {
        speak(responseText.replace(/[#*_`>]/g, '').replaceAll('[', '').replaceAll(']', ''))
      }
      shouldUploadHistory = !mockTextareaMode && !testImageMode
    } catch (error) {
      if (requestController.signal.aborted) {
        void persistMessages(afterUserMessages)
        return
      }
      if (error instanceof HermesError && error.kind === 'unauthorized') {
        return
      }
      const fallback = error instanceof HermesError ? error.message : `${assistantName}暂时不可用，请稍后再试`
      setStreamingText('')
      setConnectionState('offline')
      messagesToPersist = [...afterUserMessages, createStoredMessage('assistant', fallback)]
      applyConversationMessages(messagesToPersist)
      void messageApi.error(fallback)
      shouldUploadHistory = !mockTextareaMode && !testImageMode
    } finally {
      setIsThinking(false)
      activeRequestRef.current = null
    }

    if (shouldUploadHistory) {
      await persistMessages(messagesToPersist)
      await uploadChatHistoryAfterRound(messagesToPersist)
    }
  }, [
    input,
    isThinking,
    messageApi,
    messages,
    mockTextareaMode,
    pendingImages,
    persistMessages,
    applyConversationMessages,
    uploadChatHistoryAfterRound,
    speak,
    speechEnabled,
    stopListening,
    stopSpeaking,
    synthesisSupported,
    testImageMode,
  ])

  const clearConversation = useCallback(async () => {
    applyConversationMessages([])
    setStreamingText('')
    await clearMessages()
    serverHydratedRef.current = true
    sharedServerHydrated = true
    try {
      const response = await fetchJarvisHistoryDelete()
      if (!response.ok) {
        throw new Error(`历史清除失败（${response.status}）`)
      }
    } catch (error) {
      console.error('云端历史清除失败', error)
    }
  }, [applyConversationMessages])

  const visibleStatusText = useMemo(() => {
    if (status === 'listening') return interimText || finalText || '正在聆听…'
    if (status === 'thinking') return streamingText || '正在思考'
    if (status === 'speaking') {
      const latestContent = messages.at(-1)?.content
      return latestContent ? getMessageText(latestContent) || '正在回复' : '正在回复'
    }
    return `${assistantName}待命中`
  }, [finalText, interimText, messages, status, streamingText])

  const connectionTag = {
    checking: { color: 'processing', icon: <LoadingOutlined />, text: '连接检测中' },
    online: { color: 'success', icon: <CheckCircleOutlined />, text: 'Hermes 在线' },
    offline: { color: 'error', icon: <CloseCircleOutlined />, text: 'Hermes 离线' },
    unconfigured: { color: 'default', icon: <CloseCircleOutlined />, text: '等待配置' },
  }[connectionState]

  return (
    <main className="jarvis-shell">
      <section className="core-panel">
        <div className="brand-lockup">
          <span className="brand-mark" />
          <div>
            <Typography.Title level={4}>NICOLE ROBIN</Typography.Title>
            <Typography.Text>妮可·罗宾 · 考古学家 AI 控制台</Typography.Text>
          </div>
        </div>
        <div className={`status-readout status-${status}`}>
          <span className="status-dot" />
          <span className="status-label">{visibleStatusText}</span>
          {status === 'thinking' && <span className="thinking-dots"><i /><i /><i /></span>}
        </div>
        <JarvisCore status={status} />
        <div className="core-footer">
          <Tag icon={connectionTag.icon} color={connectionTag.color}>{connectionTag.text}</Tag>
          <span>CORE / {status.toUpperCase()}</span>
        </div>
      </section>

      <Card className="conversation-panel" variant="borderless">
        <header className="conversation-header">
          <div>
            <Typography.Title level={4}>对话终端</Typography.Title>
            <Typography.Text type="secondary">消息由 Hermes Agent 处理</Typography.Text>
          </div>
          <div className="conversation-actions">
            <Tooltip title={`退出登录（${username}）`}>
              <Button
                type="text"
                shape="circle"
                icon={<LogoutOutlined />}
                onClick={() => void onLogout()}
                aria-label="退出登录"
              />
            </Tooltip>
            <Tooltip title="清除对话">
              <Button
                type="text"
                shape="circle"
                icon={<DeleteOutlined />}
                onClick={clearConversation}
                disabled={messages.length === 0 && !streamingText}
              />
            </Tooltip>
            <Tooltip title={synthesisSupported ? '语音播报开关' : '浏览器不支持语音合成'}>
              <Switch
                className="speech-toggle"
                checked={speechEnabled}
                onChange={setSpeechEnabled}
                disabled={!synthesisSupported}
                checkedChildren="播报"
                unCheckedChildren="静音"
              />
            </Tooltip>
          </div>
        </header>

        <section
          ref={messageListRef}
          className="message-list"
          aria-live="polite"
          onScroll={handleMessageListScroll}
        >
          {!messagesReady ? (
            <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', minHeight: 120 }}>
              <LoadingOutlined spin style={{ fontSize: 22, color: '#93c5fd' }} />
            </div>
          ) : messages.length === 0 && !streamingText ? (
            <Empty
              image={Empty.PRESENTED_IMAGE_SIMPLE}
              description={isHermesConfigured ? `向${assistantName}发送第一条指令` : '配置 Hermes 后开始对话'}
            />
          ) : (
            <>
              {hasOlderMessages && (
                <div style={{ marginBottom: 12, color: 'rgba(148, 163, 184, 0.72)', fontSize: 12, textAlign: 'center' }}>
                  向上或向下滚动以加载更早消息（已显示 {visibleMessages.length}/{messages.length}）
                </div>
              )}
              {visibleMessages.map((chatMessage) => (
                <MemoChatMessageRow
                  key={chatMessage.id}
                  chatMessage={chatMessage}
                  assistantLabel={assistantName}
                  expanded={expandedMessageIds.has(chatMessage.id)}
                  onToggleExpand={toggleMessageExpanded}
                  onCopyContent={copyMessage}
                />
              ))}
              <div ref={messagesEndRef} aria-hidden="true" />
            </>
          )}
          {streamingText && (
            <article className="message-row assistant streaming">
              <div className="message-meta">
                <span>{assistantName}</span>
                <time>实时回复</time>
              </div>
              <div className="message-bubble message-content">
                <MemoStreamingMessageContent content={streamingText} onCopy={copyMessage} />
                <span className="stream-caret" />
              </div>
            </article>
          )}
        </section>

        <footer className="composer">
          {(isListening || interimText) && (
            <div className="live-transcript"><span />{interimText || finalText || '正在聆听…'}</div>
          )}
          {pendingImages.length > 0 && (
            <div className="composer-image-preview">
              {pendingImages.map((src, index) => (
                <div key={`${src.slice(0, 32)}-${index}`} className="composer-image-chip">
                  <img src={src} alt={`待发送图片 ${index + 1}`} />
                  <Button
                    type="text"
                    size="small"
                    shape="circle"
                    icon={<CloseCircleOutlined />}
                    onClick={() => setPendingImages((current) => current.filter((_, itemIndex) => itemIndex !== index))}
                    aria-label="移除图片"
                  />
                </div>
              ))}
            </div>
          )}
          <input
            ref={fileInputRef}
            className="composer-file-input"
            type="file"
            accept="image/*"
            multiple
            onChange={(event) => {
              if (event.target.files) void appendImages(event.target.files)
              event.target.value = ''
            }}
          />
          <Input.TextArea
            className="composer-input"
            value={input}
            onChange={(event) => setInput(event.target.value)}
            onPaste={handleComposerPaste}
            onPressEnter={(event) => {
              if (!event.shiftKey) {
                event.preventDefault()
                void sendMessage()
              }
            }}
            autoSize={{ minRows: 1, maxRows: 5 }}
            placeholder={isListening ? '正在听你说…' : '输入指令，Shift + Enter 换行，可粘贴图片'}
            disabled={isThinking}
          />
          <div className="composer-actions">
            <Tooltip title="上传图片">
              <Button
                shape="circle"
                icon={<PictureOutlined />}
                onClick={() => fileInputRef.current?.click()}
                disabled={isThinking}
                aria-label="上传图片"
              />
            </Tooltip>
            <Tooltip title={recognitionSupported ? (isListening ? '停止聆听' : '开始语音输入') : '当前浏览器不支持语音识别'}>
              <Button
                className={isListening ? 'microphone-active' : ''}
                shape="circle"
                icon={<AudioOutlined />}
                onClick={toggleListening}
                disabled={!recognitionSupported || isThinking}
                aria-label="切换语音识别"
              />
            </Tooltip>
            <Button
              type="primary"
              shape="circle"
              icon={<SendOutlined />}
              onClick={() => void sendMessage()}
              loading={isThinking}
              disabled={!input.trim() && pendingImages.length === 0}
              aria-label="发送消息"
            />
          </div>
        </footer>
      </Card>
    </main>
  )
}

export default function App() {
  return (
    <ConfigProvider
      theme={{
        algorithm: theme.darkAlgorithm,
        token: {
          colorPrimary: '#2563eb',
          colorBgBase: '#0a0e27',
          colorBgContainer: '#10172f',
          borderRadius: 14,
          fontSize: 14,
        },
      }}
    >
      <AntApp>
        <AppShell />
      </AntApp>
    </ConfigProvider>
  )
}

function AppShell() {
  const { message: messageApi } = AntApp.useApp()
  const [authToken, setAuthToken] = useState(() => getJarvisToken())
  const [username, setUsername] = useState(() => localStorage.getItem(JARVIS_USERNAME_KEY) ?? '')
  const testImageMode = new URLSearchParams(window.location.search).has('test-image')

  const performLogout = useCallback(async (showExpiredMessage = false) => {
    clearJarvisAuth()
    resetHistoryHydrationState()
    try {
      await clearMessages()
    } catch (error) {
      console.error('清空本地缓存失败', error)
    }
    setAuthToken(null)
    setUsername('')
    if (showExpiredMessage) {
      void messageApi.warning('登录已过期，请重新登录')
    }
  }, [messageApi])

  useEffect(() => {
    setUnauthorizedHandler(() => {
      void performLogout(true)
    })
    return () => setUnauthorizedHandler(null)
  }, [performLogout])

  const handleLoginSuccess = useCallback(async (token: string, loggedInUsername: string) => {
    resetHistoryHydrationState()
    try {
      await clearMessages()
    } catch (error) {
      console.error('清空本地缓存失败', error)
    }
    localStorage.setItem(JARVIS_TOKEN_KEY, token)
    localStorage.setItem(JARVIS_USERNAME_KEY, loggedInUsername)
    setAuthToken(token)
    setUsername(loggedInUsername)
  }, [])

  if (!authToken && !testImageMode) {
    return <LoginPage onSuccess={handleLoginSuccess} />
  }

  return (
    <ConsoleApp
      username={username || localStorage.getItem(JARVIS_USERNAME_KEY) || '用户'}
      onLogout={() => performLogout(false)}
    />
  )
}
