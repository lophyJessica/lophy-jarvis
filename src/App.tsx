import {
  Children,
  isValidElement,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent,
  type ReactNode,
  type TextareaHTMLAttributes,
} from 'react'
import {
  AudioOutlined,
  CheckCircleOutlined,
  CloseCircleOutlined,
  CopyOutlined,
  DeleteOutlined,
  LoadingOutlined,
  PictureOutlined,
  SendOutlined,
} from '@ant-design/icons'
import { App as AntApp, Button, Card, ConfigProvider, Empty, Input, Switch, Tag, Tooltip, Typography, theme } from 'antd'
import Markdown from 'markdown-to-jsx'
import {
  checkHermesConnection,
  clearServerHistory,
  defaultSystemPrompt,
  fetchHistory,
  HermesError,
  isHermesConfigured,
  pushHistory,
  streamChatCompletion,
} from './api/hermes'
import JarvisCore, { type JarvisStatus } from './components/JarvisCore'
import {
  addMessage,
  clearMessages,
  createStoredMessage,
  syncFromServer,
  syncToServer,
  toChatHistory,
  type StoredMessage,
} from './db'
import { useSpeechRecognition } from './hooks/useSpeechRecognition'
import { useSpeechSynthesis } from './hooks/useSpeechSynthesis'
import './App.css'

type ConnectionState = 'checking' | 'online' | 'offline' | 'unconfigured'
const assistantName = '妮可·罗宾'
const systemPrompt = defaultSystemPrompt
const maxSavedMessages = 200
const messageListStickThresholdPx = 80

const textareaTagPattern = /<textarea\b[^>]*>([\s\S]*?)<\/textarea>/gi
const fencedTextareaPattern = /```(?:html)?\s*\n([\s\S]*?<textarea\b[\s\S]*?<\/textarea>[\s\S]*?)\n```/gi

function unwrapFencedTextareas(content: string) {
  return content.replace(fencedTextareaPattern, (_match, inner: string) => inner.trim())
}

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

type MessageContentPart = { type: 'markdown' | 'textarea'; text: string }

function reactNodeToText(node: ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(reactNodeToText).join('')
  if (isValidElement<{ children?: ReactNode }>(node)) return reactNodeToText(node.props.children)
  return Children.toArray(node).map(reactNodeToText).join('')
}

type CopyableTextareaProps = TextareaHTMLAttributes<HTMLTextAreaElement> & {
  children?: ReactNode
  onCopyContent?: (text: string) => void
}

function CopyableTextarea({
  children,
  className,
  defaultValue,
  value,
  onCopyContent,
  ...props
}: CopyableTextareaProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const childText = reactNodeToText(children)
  const fallbackValue = value ?? defaultValue ?? childText

  return (
    <span className="markdown-textarea-shell">
      <textarea
        {...props}
        ref={textareaRef}
        className={['markdown-textarea', className].filter(Boolean).join(' ')}
        value={value}
        defaultValue={value === undefined ? defaultValue ?? childText : undefined}
      />
      <span className="markdown-textarea-copy-anchor">
        <Tooltip title="复制">
          <Button
            type="text"
            size="small"
            shape="circle"
            icon={<CopyOutlined />}
            className="markdown-textarea-copy-button"
            onClick={() => onCopyContent?.(textareaRef.current?.value ?? String(fallbackValue))}
            aria-label="复制文本框内容"
          />
        </Tooltip>
      </span>
    </span>
  )
}

function splitTextareaParts(content: string): MessageContentPart[] {
  const normalized = unwrapFencedTextareas(content)
  const parts: MessageContentPart[] = []
  let lastIndex = 0
  const pattern = new RegExp(textareaTagPattern.source, 'gi')
  let match: RegExpExecArray | null

  while ((match = pattern.exec(normalized)) !== null) {
    if (match.index > lastIndex) {
      parts.push({ type: 'markdown', text: normalized.slice(lastIndex, match.index) })
    }
    parts.push({ type: 'textarea', text: match[1] ?? '' })
    lastIndex = match.index + match[0].length
  }

  if (lastIndex < normalized.length) {
    parts.push({ type: 'markdown', text: normalized.slice(lastIndex) })
  }

  if (parts.length === 0) {
    parts.push({ type: 'markdown', text: normalized })
  }

  return parts
}

function CopyableTextareaBlock({
  text,
  onCopyContent,
}: {
  text: string
  onCopyContent?: (text: string) => void
}) {
  return (
    <CopyableTextarea
      readOnly
      defaultValue={text}
      onCopyContent={onCopyContent}
    />
  )
}

function MarkdownContent({
  text,
  onCopyContent,
}: {
  text: string
  onCopyContent: (text: string) => void
}) {
  if (!text.trim()) return null

  return (
    <Markdown
      options={{
        overrides: {
          textarea: {
            component: CopyableTextarea,
            props: { onCopyContent },
          },
        },
      }}
    >
      {text}
    </Markdown>
  )
}

function renderMessageContent(content: string, onCopyContent: (text: string) => void) {
  return splitTextareaParts(content).map((part, index) => {
    if (part.type === 'textarea') {
      return (
        <CopyableTextareaBlock
          key={`textarea-${index}`}
          text={part.text}
          onCopyContent={onCopyContent}
        />
      )
    }
    if (!part.text.trim()) return null
    return (
      <MarkdownContent
        key={`markdown-${index}`}
        text={part.text}
        onCopyContent={onCopyContent}
      />
    )
  })
}

function buildMessageContent(text: string, images: string[]) {
  const trimmed = text.trim()
  const imageMarkdown = images.map((src, index) => `![图片 ${index + 1}](${src})`).join('\n\n')
  if (!trimmed) return imageMarkdown
  if (!imageMarkdown) return trimmed
  return `${trimmed}\n\n${imageMarkdown}`
}

function readImageFile(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(file)
  })
}

function ConsoleApp() {
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
  const messageListRef = useRef<HTMLElement>(null)
  const stickToBottomRef = useRef(true)
  const activeRequestRef = useRef<AbortController | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const lastTranscriptRef = useRef('')
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

  const history = useMemo(() => toChatHistory(messages), [messages])

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
  }, [])

  const persistMessages = useCallback(async (nextMessages: StoredMessage[]) => {
    const savedMessages = nextMessages.slice(-maxSavedMessages)
    await clearMessages()
    for (const message of savedMessages) {
      await addMessage(message)
    }
    void syncToServer(savedMessages, pushHistory)
  }, [])

  useEffect(() => {
    let active = true
    void (async () => {
      const mergedMessages = await syncFromServer(fetchHistory, maxSavedMessages)
      if (!active) return
      setMessages(mergedMessages)
      setMessagesReady(true)
    })()
    return () => {
      active = false
    }
  }, [])

  useEffect(() => {
    if (!mockTextareaMode || !messagesReady) return
    setMessages([
      createStoredMessage('assistant', '<textarea>test</textarea>'),
    ])
  }, [messagesReady, mockTextareaMode])

  useEffect(() => {
    let active = true
    checkHermesConnection().then((online) => {
      if (active) setConnectionState(online ? 'online' : 'offline')
    })
    return () => {
      active = false
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
    if (!content || isThinking) return
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
    const userMessage = createStoredMessage('user', content)
    const nextMessages = [...messages, userMessage]
    let messagesToPersist = nextMessages
    setMessages(nextMessages)
    setIsThinking(true)
    setStreamingText('')
    const requestController = new AbortController()
    activeRequestRef.current = requestController
    let responseText = ''

    try {
      responseText = await streamChatCompletion(
        [{ role: userMessage.role, content: userMessage.content }],
        (delta) => {
          responseText += delta
          setStreamingText(responseText)
        },
        requestController.signal,
        systemPrompt,
        history,
      )
      if (!responseText.trim()) throw new HermesError('Hermes 返回了空回复', 'network')
      const assistantMessage = createStoredMessage('assistant', responseText)
      messagesToPersist = [...nextMessages, assistantMessage]
      setMessages(messagesToPersist)
      setStreamingText('')
      setConnectionState('online')
      if (speechEnabled && synthesisSupported) {
        speak(responseText.replace(/[#*_`>]/g, '').replaceAll('[', '').replaceAll(']', ''))
      }
    } catch (error) {
      if (requestController.signal.aborted) {
        void persistMessages(nextMessages)
        return
      }
      const fallback = error instanceof HermesError ? error.message : `${assistantName}暂时不可用，请稍后再试`
      setStreamingText('')
      setConnectionState('offline')
      messagesToPersist = [...nextMessages, createStoredMessage('assistant', fallback)]
      setMessages(messagesToPersist)
      void messageApi.error(fallback)
    } finally {
      setIsThinking(false)
      activeRequestRef.current = null
    }

    if (!mockTextareaMode) {
      void persistMessages(messagesToPersist)
    }
  }, [
    history,
    input,
    isThinking,
    messageApi,
    messages,
    mockTextareaMode,
    pendingImages,
    persistMessages,
    speak,
    speechEnabled,
    stopListening,
    stopSpeaking,
    synthesisSupported,
  ])

  const clearConversation = useCallback(() => {
    setMessages([])
    setStreamingText('')
    void clearMessages()
    void clearServerHistory()
  }, [])

  const visibleStatusText = useMemo(() => {
    if (status === 'listening') return interimText || finalText || '正在聆听…'
    if (status === 'thinking') return streamingText || '正在思考'
    if (status === 'speaking') return messages.at(-1)?.content || '正在回复'
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
            messages.map((chatMessage) => (
              <article key={chatMessage.id} className={`message-row ${chatMessage.role}`}>
                <div className="message-meta">
                  <span>{chatMessage.role === 'user' ? '你' : assistantName}</span>
                  <time>{chatMessage.time}</time>
                  <Tooltip title="复制消息">
                    <Button
                      type="text"
                      size="small"
                      shape="circle"
                      icon={<CopyOutlined />}
                      className="message-copy-button"
                      onClick={() => copyMessage(chatMessage.content)}
                      aria-label="复制消息"
                    />
                  </Tooltip>
                </div>
                <div className="message-bubble message-content">
                  {renderMessageContent(chatMessage.content, copyMessage)}
                </div>
              </article>
            ))
          )}
          {streamingText && (
            <article className="message-row assistant streaming">
              <div className="message-meta">
                <span>{assistantName}</span>
                <time>实时回复</time>
              </div>
              <div className="message-bubble message-content">
                {renderMessageContent(streamingText, copyMessage)}
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
        <ConsoleApp />
      </AntApp>
    </ConfigProvider>
  )
}
