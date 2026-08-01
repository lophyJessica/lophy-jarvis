import { useEffect, useRef } from 'react'

export type JarvisStatus = 'idle' | 'listening' | 'thinking' | 'speaking'

interface JarvisCoreProps {
  status: JarvisStatus
}

interface DustParticle {
  x: number
  y: number
  velocityX: number
  velocityY: number
  size: number
  alpha: number
}

interface WaveParticle {
  angle: number
  distance: number
  speed: number
  size: number
  life: number
}

const RINGS = [
  { count: 64, radius: 0.27, speed: 0.00013, direction: 1, tilt: 0.88 },
  { count: 72, radius: 0.38, speed: 0.00009, direction: -1, tilt: 0.72 },
]
const DUST_COUNT = 36
const MAX_WAVE_PARTICLES = 20

const targetParameters: Record<JarvisStatus, { energy: number; speed: number; attraction: number }> = {
  idle: { energy: 0.18, speed: 0.65, attraction: 0 },
  listening: { energy: 1, speed: 1.8, attraction: 0.9 },
  thinking: { energy: 0.62, speed: 1.25, attraction: 0.55 },
  speaking: { energy: 0.86, speed: 1.45, attraction: 0.7 },
}

function createDustParticles(width: number, height: number): DustParticle[] {
  return Array.from({ length: DUST_COUNT }, () => ({
    x: Math.random() * width,
    y: Math.random() * height,
    velocityX: (Math.random() - 0.5) * 0.14,
    velocityY: (Math.random() - 0.5) * 0.14,
    size: 0.6 + Math.random() * 1.4,
    alpha: 0.15 + Math.random() * 0.38,
  }))
}

export default function JarvisCore({ status }: JarvisCoreProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const statusRef = useRef(status)

  useEffect(() => {
    statusRef.current = status
  }, [status])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const visibleContext = canvas.getContext('2d', { alpha: true })
    const bufferCanvas = document.createElement('canvas')
    const context = bufferCanvas.getContext('2d', { alpha: true })
    if (!visibleContext || !context) return

    let width = 1
    let height = 1
    let dpr = 1
    let animationFrame = 0
    let previousTime = performance.now()
    const ringRotation = [0, Math.PI / 3]
    let dustParticles: DustParticle[] = []
    let waveParticles: WaveParticle[] = []
    let energy = targetParameters[statusRef.current].energy
    let speed = targetParameters[statusRef.current].speed
    let attraction = targetParameters[statusRef.current].attraction
    let lastEmission = 0
    let frameCount = 0
    let fpsWindowStart = previousTime

    const resize = () => {
      const bounds = canvas.getBoundingClientRect()
      width = Math.max(1, bounds.width)
      height = Math.max(1, bounds.height)
      dpr = Math.min(window.devicePixelRatio || 1, 2)
      canvas.width = Math.floor(width * dpr)
      canvas.height = Math.floor(height * dpr)
      bufferCanvas.width = canvas.width
      bufferCanvas.height = canvas.height
      visibleContext.setTransform(dpr, 0, 0, dpr, 0, 0)
      context.setTransform(dpr, 0, 0, dpr, 0, 0)
      dustParticles = createDustParticles(width, height)
    }

    const observer = new ResizeObserver(resize)
    observer.observe(canvas)
    resize()

    const drawDust = (centerX: number, centerY: number, delta: number) => {
      for (const particle of dustParticles) {
        if (attraction > 0.05) {
          const offsetX = centerX - particle.x
          const offsetY = centerY - particle.y
          const distance = Math.max(80, Math.hypot(offsetX, offsetY))
          particle.velocityX += (offsetX / distance) * attraction * 0.0018 * delta
          particle.velocityY += (offsetY / distance) * attraction * 0.0018 * delta
        }
        particle.velocityX *= 0.992
        particle.velocityY *= 0.992
        particle.x += particle.velocityX * delta
        particle.y += particle.velocityY * delta

        if (particle.x < -10) particle.x = width + 10
        if (particle.x > width + 10) particle.x = -10
        if (particle.y < -10) particle.y = height + 10
        if (particle.y > height + 10) particle.y = -10

        context.beginPath()
        context.fillStyle = `rgba(91, 156, 255, ${particle.alpha * (0.7 + energy * 0.3)})`
        context.arc(particle.x, particle.y, particle.size, 0, Math.PI * 2)
        context.fill()
      }
    }

    const drawRing = (
      centerX: number,
      centerY: number,
      baseSize: number,
      ringIndex: number,
      time: number,
      delta: number,
    ) => {
      const ring = RINGS[ringIndex]
      ringRotation[ringIndex] += ring.speed * ring.direction * speed * delta
      const breath = 1 + Math.sin(time * 0.0017 + ringIndex) * (0.018 + energy * 0.025)
      const radius = baseSize * ring.radius * breath
      const points: Array<{ x: number; y: number }> = []
      const gradient = context.createRadialGradient(centerX, centerY, radius * 0.15, centerX, centerY, radius * 1.2)
      gradient.addColorStop(0, 'rgba(37, 99, 235, 0)')
      gradient.addColorStop(0.65, `rgba(37, 99, 235, ${0.18 + energy * 0.14})`)
      gradient.addColorStop(1, 'rgba(37, 99, 235, 0)')

      for (let index = 0; index < ring.count; index += 1) {
        const angle = (index / ring.count) * Math.PI * 2 + ringRotation[ringIndex]
        const noise = Math.sin(index * 1.71 + time * 0.001) * (1.2 + energy * 1.8)
        points.push({
          x: centerX + Math.cos(angle) * (radius + noise),
          y: centerY + Math.sin(angle) * (radius + noise) * ring.tilt,
        })
      }

      context.beginPath()
      context.strokeStyle = gradient
      context.lineWidth = 0.65
      for (let index = 0; index < points.length; index += 1) {
        const point = points[index]
        const next = points[(index + 1) % points.length]
        context.moveTo(point.x, point.y)
        context.lineTo(next.x, next.y)
      }
      context.stroke()

      points.forEach((point, index) => {
        const pulse = 0.55 + Math.sin(time * 0.003 + index * 0.42) * 0.3
        context.beginPath()
        context.fillStyle = `rgba(76, 151, 255, ${Math.max(0.16, pulse)})`
        context.shadowBlur = 4 + energy * 5
        context.shadowColor = '#2563eb'
        context.arc(point.x, point.y, 1 + energy * 0.42, 0, Math.PI * 2)
        context.fill()
      })
      context.shadowBlur = 0
    }

    const emitWave = (time: number) => {
      if (statusRef.current !== 'speaking' || time - lastEmission < 90) return
      lastEmission = time
      if (waveParticles.length < MAX_WAVE_PARTICLES) {
        waveParticles.push({
          angle: Math.random() * Math.PI * 2,
          distance: 22,
          speed: 0.025 + Math.random() * 0.025,
          size: 0.8 + Math.random() * 1.5,
          life: 1,
        })
      }
    }

    const drawWaveParticles = (centerX: number, centerY: number, delta: number) => {
      waveParticles = waveParticles.filter((particle) => {
        particle.distance += particle.speed * delta * 18
        particle.life -= delta * 0.00065
        if (particle.life <= 0) return false
        context.beginPath()
        context.fillStyle = `rgba(96, 165, 250, ${particle.life * 0.85})`
        context.arc(
          centerX + Math.cos(particle.angle) * particle.distance,
          centerY + Math.sin(particle.angle) * particle.distance,
          particle.size * particle.life,
          0,
          Math.PI * 2,
        )
        context.fill()
        return true
      })
    }

    const drawCore = (centerX: number, centerY: number, baseSize: number, time: number) => {
      const coreRadius = Math.max(18, baseSize * 0.052)
      const pulse = 1 + Math.sin(time * 0.0028) * (0.07 + energy * 0.055)
      const glowRadius = coreRadius * (3 + energy * 1.1) * pulse
      const glow = context.createRadialGradient(centerX, centerY, 0, centerX, centerY, glowRadius)
      glow.addColorStop(0, `rgba(191, 219, 254, ${0.92 + energy * 0.08})`)
      glow.addColorStop(0.18, `rgba(59, 130, 246, ${0.74 + energy * 0.16})`)
      glow.addColorStop(0.48, `rgba(37, 99, 235, ${0.2 + energy * 0.2})`)
      glow.addColorStop(1, 'rgba(37, 99, 235, 0)')
      context.fillStyle = glow
      context.beginPath()
      context.arc(centerX, centerY, glowRadius, 0, Math.PI * 2)
      context.fill()

      context.beginPath()
      context.fillStyle = '#dbeafe'
      context.shadowBlur = 18 + energy * 20
      context.shadowColor = '#60a5fa'
      context.arc(centerX, centerY, coreRadius * pulse, 0, Math.PI * 2)
      context.fill()
      context.shadowBlur = 0

      if (statusRef.current === 'speaking') {
        const rippleRadius = coreRadius * (1.5 + ((time * 0.0012) % 1) * 3.2)
        context.beginPath()
        context.strokeStyle = `rgba(96, 165, 250, ${1 - ((time * 0.0012) % 1)})`
        context.lineWidth = 1.2
        context.arc(centerX, centerY, rippleRadius, 0, Math.PI * 2)
        context.stroke()
      }
    }

    const draw = (time: number) => {
      const delta = Math.min(32, time - previousTime)
      previousTime = time
      frameCount += 1
      if (time - fpsWindowStart >= 1_000) {
        canvas.dataset.fps = Math.round((frameCount * 1_000) / (time - fpsWindowStart)).toString()
        frameCount = 0
        fpsWindowStart = time
      }
      const target = targetParameters[statusRef.current]
      const smoothing = 1 - Math.pow(0.001, delta / 1000)
      energy += (target.energy - energy) * smoothing
      speed += (target.speed - speed) * smoothing
      attraction += (target.attraction - attraction) * smoothing

      context.clearRect(0, 0, width, height)
      const centerX = width / 2
      const centerY = height / 2
      const baseSize = Math.min(width, height)
      drawDust(centerX, centerY, delta)
      RINGS.forEach((_, ringIndex) => drawRing(centerX, centerY, baseSize, ringIndex, time, delta))
      emitWave(time)
      drawWaveParticles(centerX, centerY, delta)
      drawCore(centerX, centerY, baseSize, time)

      visibleContext.clearRect(0, 0, width, height)
      visibleContext.drawImage(bufferCanvas, 0, 0, width, height)
      animationFrame = requestAnimationFrame(draw)
    }

    animationFrame = requestAnimationFrame(draw)
    return () => {
      cancelAnimationFrame(animationFrame)
      observer.disconnect()
    }
  }, [])

  return <canvas ref={canvasRef} className="jarvis-core" aria-label={`Jarvis ${status} animation`} />
}
