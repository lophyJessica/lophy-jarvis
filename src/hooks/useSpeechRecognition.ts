import { useCallback, useEffect, useRef, useState } from 'react'

const ERROR_MESSAGES: Record<string, string> = {
  'audio-capture': '未检测到可用的麦克风',
  'not-allowed': '麦克风权限未授权',
  'service-not-allowed': '浏览器已禁用语音识别服务',
  network: '语音识别网络连接失败',
  'no-speech': '没有检测到语音，请再试一次',
}

export function useSpeechRecognition() {
  const recognitionRef = useRef<SpeechRecognition | null>(null)
  const [interimText, setInterimText] = useState('')
  const [finalText, setFinalText] = useState('')
  const [isListening, setIsListening] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const isSupported = typeof window !== 'undefined' && Boolean(
    window.SpeechRecognition || window.webkitSpeechRecognition,
  )

  useEffect(() => {
    const SpeechRecognitionApi = window.SpeechRecognition || window.webkitSpeechRecognition
    if (!SpeechRecognitionApi) return

    const recognition = new SpeechRecognitionApi()
    recognition.lang = 'zh-CN'
    recognition.continuous = true
    recognition.interimResults = true
    recognition.onstart = () => {
      setError(null)
      setIsListening(true)
    }
    recognition.onend = () => setIsListening(false)
    recognition.onerror = (event) => {
      setError(ERROR_MESSAGES[event.error] ?? `语音识别失败：${event.error}`)
      setIsListening(false)
    }
    recognition.onresult = (event) => {
      let nextInterim = ''
      let nextFinal = ''
      for (let index = event.resultIndex; index < event.results.length; index += 1) {
        const transcript = event.results[index][0]?.transcript ?? ''
        if (event.results[index].isFinal) nextFinal += transcript
        else nextInterim += transcript
      }
      if (nextFinal) setFinalText((current) => current + nextFinal)
      setInterimText(nextInterim)
    }
    recognitionRef.current = recognition

    return () => {
      recognition.abort()
      recognitionRef.current = null
    }
  }, [])

  const start = useCallback(() => {
    if (!recognitionRef.current || isListening) return
    setError(null)
    setInterimText('')
    setFinalText('')
    try {
      recognitionRef.current.start()
    } catch {
      setError('语音识别暂时无法启动')
    }
  }, [isListening])

  const stop = useCallback(() => {
    recognitionRef.current?.stop()
  }, [])

  const toggle = useCallback(() => {
    if (isListening) stop()
    else start()
  }, [isListening, start, stop])

  return { interimText, finalText, isListening, error, isSupported, start, stop, toggle }
}
