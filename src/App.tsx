import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  AudioOutlined,
  CheckCircleOutlined,
  CloseCircleOutlined,
  DeleteOutlined,
  LoadingOutlined,
  SendOutlined,
  SoundOutlined,
  StopOutlined,
} from '@ant-design/icons'
import { App as AntApp, Button, Card, ConfigProvider, Empty, Input, Tag, Tooltip, Typography, theme } from 'antd'
import Markdown from 'markdown-to-jsx'
import { checkHermesConnection, HermesError, isHermesConfigured, streamChatCompletion, type ChatMessage } from './api/hermes'
import JarvisCore, { type JarvisStatus } from './components/JarvisCore'
import { useSpeechRecognition } from './hooks/useSpeechRecognition'
import { useSpeechSynthesis } from './hooks/useSpeechSynthesis'
import './App.css'

interface DisplayMessage extends ChatMessage {
  id: string
  time: string
}

type ConnectionState = 'checking' | 'online' | 'offline' | 'unconfigured'
const systemPrompt = '你是贾维斯，用户的个人 AI 助手。用户叫刘龙飞，也称路飞。'
const storageKey = 'jarvis-messages'
const maxSavedMessages = 200

const timeFormatter = new Intl.DateTimeFormat('zh-CN', {
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
})

function createMessage(role: 'user' | 'assistant', content: string): DisplayMessage {
  return {
    id: crypto.randomUUID(),
    role,
    content,
    time: timeFormatter.format(new Date()),
  }
}

function readSavedMessages(): DisplayMessage[] {
  const saved = localStorage.getItem(storageKey)
  if (!saved) return []
  try {
    const messages = JSON.parse(saved) as DisplayMessage[]
    return Array.isArray(messages) ? messages.slice(-maxSavedMessages) : []
  } catch {
    return []
  }
}

function toHistory(messages: DisplayMessage[]): ChatMessage[] {
  return messages.map(({ role, content }) => ({ role, content }))
}

function ConsoleApp() {
  const { message: messageApi } = AntApp.useApp()
  const [messages, setMessages] = useState<DisplayMessage[]>(() => readSavedMessages())
  const [input, setInput] = useState('')
  const [history, setHistory] = useState<ChatMessage[]>(() => toHistory(readSavedMessages()))
  const [isThinking, setIsThinking] = useState(false)
  const [streamingText, setStreamingText] = useState('')
  const [connectionState, setConnectionState] = useState<ConnectionState>(
    isHermesConfigured ? 'checking' : 'unconfigured',
  )
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const activeRequestRef = useRef<AbortController | null>(null)
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
    cancel: cancelSpeech,
    isSpeaking,
    isSupported: synthesisSupported,
  } = useSpeechSynthesis()

  const status: JarvisStatus = isListening
    ? 'listening'
    : isThinking
      ? 'thinking'
      : isSpeaking
        ? 'speaking'
        : 'idle'

  useEffect(() => {
    if (!isHermesConfigured) return
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
    const savedMessages = messages.slice(-maxSavedMessages)
    if (savedMessages.length !== messages.length) {
      setMessages(savedMessages)
      return
    }
    if (savedMessages.length === 0) {
      localStorage.removeItem(storageKey)
      return
    }
    localStorage.setItem(storageKey, JSON.stringify(savedMessages))
  }, [messages])

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, streamingText])

  useEffect(() => () => {
    activeRequestRef.current?.abort()
    cancelSpeech()
  }, [cancelSpeech])

  const sendMessage = useCallback(async () => {
    const content = input.trim()
    if (!content || isThinking) return
    if (!isHermesConfigured) {
      void messageApi.info('请先在 .env.local 中配置 Hermes API 地址和认证信息')
      return
    }

    stopListening()
    cancelSpeech()
    setInput('')
    lastTranscriptRef.current = ''
    const userMessage = createMessage('user', content)
    const nextMessages = [...messages, userMessage]
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
      const assistantMessage = createMessage('assistant', responseText)
      setMessages((current) => [...current, assistantMessage])
      setHistory((current) => [
        ...current.slice(-(maxSavedMessages - 2)),
        { role: userMessage.role, content: userMessage.content },
        { role: assistantMessage.role, content: assistantMessage.content },
      ])
      setStreamingText('')
      setConnectionState('online')
      if (synthesisSupported) {
        speak(responseText.replace(/[#*_`>]/g, '').replaceAll('[', '').replaceAll(']', ''))
      }
    } catch (error) {
      if (requestController.signal.aborted) return
      const fallback = error instanceof HermesError ? error.message : '贾维斯暂时不可用，请稍后再试'
      setStreamingText('')
      setConnectionState('offline')
      setMessages((current) => [...current, createMessage('assistant', fallback)])
      void messageApi.error(fallback)
    } finally {
      setIsThinking(false)
      activeRequestRef.current = null
    }
  }, [cancelSpeech, history, input, isThinking, messageApi, messages, speak, stopListening, synthesisSupported])

  const clearConversation = useCallback(() => {
    setMessages([])
    setHistory([])
    localStorage.removeItem(storageKey)
  }, [])

  const visibleStatusText = useMemo(() => {
    if (status === 'listening') return interimText || finalText || '正在聆听…'
    if (status === 'thinking') return streamingText || '正在思考'
    if (status === 'speaking') return messages.at(-1)?.content || '正在回复'
    return '贾维斯待命中'
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
            <Typography.Title level={4}>JARVIS</Typography.Title>
            <Typography.Text>全景 AI 助手控制台</Typography.Text>
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
            <Tooltip title={isSpeaking ? '停止播报' : synthesisSupported ? '语音播报已启用' : '浏览器不支持语音合成'}>
              <Button
                type="text"
                shape="circle"
                icon={isSpeaking ? <StopOutlined /> : <SoundOutlined />}
                onClick={isSpeaking ? cancelSpeech : undefined}
                disabled={!synthesisSupported}
              />
            </Tooltip>
          </div>
        </header>

        <section className="message-list" aria-live="polite">
          {messages.length === 0 && !streamingText ? (
            <Empty
              image={Empty.PRESENTED_IMAGE_SIMPLE}
              description={isHermesConfigured ? '向贾维斯发送第一条指令' : '配置 Hermes 后开始对话'}
            />
          ) : (
            messages.map((chatMessage) => (
              <article key={chatMessage.id} className={`message-row ${chatMessage.role}`}>
                <div className="message-meta">
                  <span>{chatMessage.role === 'user' ? '你' : 'JARVIS'}</span>
                  <time>{chatMessage.time}</time>
                </div>
                <div className="message-bubble">
                  <Markdown>{chatMessage.content}</Markdown>
                </div>
              </article>
            ))
          )}
          {streamingText && (
            <article className="message-row assistant streaming">
              <div className="message-meta"><span>JARVIS</span><time>实时回复</time></div>
              <div className="message-bubble"><Markdown>{streamingText}</Markdown><span className="stream-caret" /></div>
            </article>
          )}
          <div ref={messagesEndRef} />
        </section>

        <footer className="composer">
          {(isListening || interimText) && (
            <div className="live-transcript"><span />{interimText || finalText || '正在聆听…'}</div>
          )}
          <Input.TextArea
            value={input}
            onChange={(event) => setInput(event.target.value)}
            onPressEnter={(event) => {
              if (!event.shiftKey) {
                event.preventDefault()
                void sendMessage()
              }
            }}
            autoSize={{ minRows: 1, maxRows: 5 }}
            placeholder={isListening ? '正在听你说…' : '输入指令，Shift + Enter 换行'}
            disabled={isThinking}
          />
          <div className="composer-actions">
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
              disabled={!input.trim()}
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
