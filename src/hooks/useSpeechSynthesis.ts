import { useCallback, useEffect, useRef, useState } from 'react'

export function useSpeechSynthesis() {
  const [isSpeaking, setIsSpeaking] = useState(false)
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const abortControllerRef = useRef<AbortController | null>(null)
  const objectUrlRef = useRef<string | null>(null)
  const requestIdRef = useRef(0)
  const isSupported = typeof window !== 'undefined'
    && typeof window.fetch === 'function'
    && typeof window.Audio === 'function'
    && typeof window.URL.createObjectURL === 'function'

  const releaseObjectUrl = useCallback(() => {
    if (objectUrlRef.current) {
      window.URL.revokeObjectURL(objectUrlRef.current)
      objectUrlRef.current = null
    }
  }, [])

  const stopSpeaking = useCallback(() => {
    if (!isSupported) return
    requestIdRef.current += 1
    abortControllerRef.current?.abort()
    abortControllerRef.current = null
    if (audioRef.current) {
      audioRef.current.pause()
      audioRef.current.removeAttribute('src')
      audioRef.current.load()
      audioRef.current = null
    }
    releaseObjectUrl()
    setIsSpeaking(false)
  }, [isSupported, releaseObjectUrl])

  useEffect(() => stopSpeaking, [stopSpeaking])

  const speak = useCallback(async (text: string) => {
    const content = text.trim()
    if (!isSupported || !content) return
    stopSpeaking()

    const requestId = requestIdRef.current + 1
    requestIdRef.current = requestId
    const abortController = new AbortController()
    abortControllerRef.current = abortController
    setIsSpeaking(true)

    try {
      const response = await fetch(`/tts?text=${encodeURIComponent(content)}`, {
        signal: abortController.signal,
      })
      if (!response.ok) throw new Error('Edge TTS request failed')

      const audioUrl = window.URL.createObjectURL(await response.blob())
      if (requestIdRef.current !== requestId) {
        window.URL.revokeObjectURL(audioUrl)
        return
      }

      objectUrlRef.current = audioUrl
      const audio = new Audio(audioUrl)
      audioRef.current = audio
      audio.onended = () => {
        if (requestIdRef.current !== requestId) return
        audioRef.current = null
        abortControllerRef.current = null
        releaseObjectUrl()
        setIsSpeaking(false)
      }
      audio.onerror = () => {
        if (requestIdRef.current !== requestId) return
        audioRef.current = null
        abortControllerRef.current = null
        releaseObjectUrl()
        setIsSpeaking(false)
      }
      await audio.play()
    } catch {
      if (!abortController.signal.aborted && requestIdRef.current === requestId) {
        abortControllerRef.current = null
        releaseObjectUrl()
        setIsSpeaking(false)
      }
    }
  }, [isSupported, releaseObjectUrl, stopSpeaking])

  return {
    speak,
    stop: stopSpeaking,
    stopSpeaking,
    cancel: stopSpeaking,
    isSpeaking,
    isSupported,
  }
}
