import { useEffect, useRef, useState } from 'react'
import { FaceLandmarker, FilesetResolver, HandLandmarker } from '@mediapipe/tasks-vision'
import type { Direction, Mode } from '../shared/game'

type Role = 'Pointer' | 'Dodger'
type Props = { role: Role; mode: Mode; round: number; active: boolean; locked: boolean; demo?: boolean; immersive?: boolean; autoStart?: boolean; targetDirection?: Direction | null; manualDirection?: Direction | null; onPreview?: (direction: Direction | null) => void; onSelect: (direction: Direction) => void; onTracking?: (tracking: boolean) => void }
type Landmark = { x: number; y: number; z?: number }
type Task = FaceLandmarker | HandLandmarker
type CameraState = 'off' | 'loading' | 'calibrating' | 'ready' | 'error'

const words: Record<string, string> = { LEFT: 'LEFT', RIGHT: 'RIGHT', UP: 'UP', DOWN: 'DOWN', 'UP-LEFT': 'UP LEFT', 'UP-RIGHT': 'UP RIGHT', 'DOWN-LEFT': 'DOWN LEFT', 'DOWN-RIGHT': 'DOWN RIGHT' }
const symbols: Record<string, string> = { LEFT: '←', RIGHT: '→', UP: '↑', DOWN: '↓', 'UP-LEFT': '↖', 'UP-RIGHT': '↗', 'DOWN-LEFT': '↙', 'DOWN-RIGHT': '↘' }

function classify(x: number, y: number, mode: Mode, threshold: number): Direction | null {
  let horizontal = Math.abs(x) >= threshold ? (x < 0 ? -1 : 1) : 0
  let vertical = Math.abs(y) >= threshold ? (y < 0 ? -1 : 1) : 0
  if (mode === 'basic') return horizontal ? (horizontal < 0 ? 'LEFT' : 'RIGHT') : null
  if (mode === 'classic' && horizontal && vertical) {
    if (Math.abs(x) > Math.abs(y)) vertical = 0
    else horizontal = 0
  }
  if (!horizontal && !vertical) return null
  if (horizontal < 0 && vertical > 0) return 'DOWN-LEFT'
  if (horizontal > 0 && vertical > 0) return 'DOWN-RIGHT'
  if (horizontal < 0 && vertical < 0) return 'UP-LEFT'
  if (horizontal > 0 && vertical < 0) return 'UP-RIGHT'
  if (horizontal < 0) return 'LEFT'
  if (horizontal > 0) return 'RIGHT'
  return vertical < 0 ? 'UP' : 'DOWN'
}

function taskOptions(model: string, delegate: 'GPU' | 'CPU') {
  return { baseOptions: { modelAssetPath: model, delegate }, runningMode: 'VIDEO' as const, numFaces: 1, numHands: 1, minFaceDetectionConfidence: 0.55, minFacePresenceConfidence: 0.55, minHandDetectionConfidence: 0.55, minHandPresenceConfidence: 0.55 }
}

export default function CameraInput({ role, mode, round, active, locked, demo = false, immersive = false, autoStart = false, targetDirection = null, manualDirection = null, onPreview, onSelect, onTracking }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const taskRef = useRef<Task | null>(null)
  const frameRef = useRef<number | null>(null)
  const operationRef = useRef(0)
  const autoStartedRef = useRef(false)
  const inputsRef = useRef({ role, mode, round, active, locked, onPreview, onSelect })
  const [state, setState] = useState<CameraState>('off')
  const [error, setError] = useState('')
  const [hint, setHint] = useState('')
  const [prediction, setPrediction] = useState<Direction | null>(null)
  // Camera is the default input. The privacy avatar is opt-in and never appears
  // while the camera is still loading or before the user chooses it.
  const [avatarEnabled, setAvatarEnabled] = useState(false)

  inputsRef.current = { role, mode, round, active, locked, onPreview, onSelect }

  const stopCamera = () => {
    operationRef.current += 1
    if (frameRef.current !== null) cancelAnimationFrame(frameRef.current)
    frameRef.current = null
    taskRef.current?.close()
    taskRef.current = null
    streamRef.current?.getTracks().forEach(track => track.stop())
    streamRef.current = null
    if (videoRef.current) videoRef.current.srcObject = null
    setState('off')
    setPrediction(null)
    setHint('')
  }

  useEffect(() => () => {
    operationRef.current += 1
    if (frameRef.current !== null) cancelAnimationFrame(frameRef.current)
    taskRef.current?.close()
    streamRef.current?.getTracks().forEach(track => track.stop())
  }, [])

  const startCamera = async () => {
    const operation = ++operationRef.current
    setState('loading'); setError(''); setPrediction(null); setHint('Opening your camera…')
    try {
      if (!navigator.mediaDevices?.getUserMedia) throw new Error('Camera access is unavailable here. Open the game on localhost or HTTPS in a browser that supports camera access.')
      const stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } } })
      if (operationRef.current !== operation) { stream.getTracks().forEach(track => track.stop()); return }
      streamRef.current = stream
      const video = videoRef.current
      if (!video) throw new Error('Camera preview could not be started.')
      video.srcObject = stream
      await video.play()
      setHint('Loading the on-device direction detector…')
      const vision = await FilesetResolver.forVisionTasks('/mediapipe/wasm')
      if (operationRef.current !== operation) return
      const createTask = async (requestedRole: Role, delegate: 'GPU' | 'CPU'): Promise<Task> => {
        const requestedModel = requestedRole === 'Pointer' ? '/models/hand_landmarker.task' : '/models/face_landmarker.task'
        const options = taskOptions(requestedModel, delegate)
        return requestedRole === 'Pointer'
          ? HandLandmarker.createFromOptions(vision, options)
          : FaceLandmarker.createFromOptions(vision, options)
      }
      const createWithFallback = async (requestedRole: Role) => {
        try { return await createTask(requestedRole, 'GPU') } catch { return createTask(requestedRole, 'CPU') }
      }
      const task = await createWithFallback(role)
      if (operationRef.current !== operation) { task.close(); return }
      taskRef.current = task
      setState(role === 'Dodger' ? 'calibrating' : 'ready')
      setHint(role === 'Pointer' ? 'Point your index finger. Your opponent sees your direction once you confirm it.' : 'Hold still briefly. When the point appears, move your head the other way.')

      let lastTime = -1
      let lastFrameAt = 0
      let lastRound = inputsRef.current.round
      let taskRole: Role = role
      let switchingRole = false
      let candidate: Direction | null = null
      let candidateAt = 0
      let previewSent: Direction | null = null
      let sentRound = -1
      let calibrating = role === 'Dodger'
      let neutralX = 0
      let neutralY = 0
      let samplesX: number[] = []
      let samplesY: number[] = []
      const loop = () => {
        frameRef.current = requestAnimationFrame(loop)
        const currentVideo = videoRef.current
        const props = inputsRef.current
        const landmarker = taskRef.current
        if (!currentVideo || !landmarker || currentVideo.readyState < 2) return
        const now = performance.now()
        if (now - lastFrameAt < 85 || currentVideo.currentTime === lastTime) return
        lastFrameAt = now; lastTime = currentVideo.currentTime
        if (props.role !== taskRole) {
          if (!switchingRole) {
            switchingRole = true
            setState('loading'); setHint(`Switching to ${props.role === 'Pointer' ? 'finger' : 'head'} tracking…`)
            void createWithFallback(props.role).then(nextTask => {
              if (operationRef.current !== operation) { nextTask.close(); return }
              taskRef.current?.close(); taskRef.current = nextTask
              taskRole = props.role; calibrating = taskRole === 'Dodger'; previewSent = null
              neutralX = 0; neutralY = 0; samplesX = []; samplesY = []
              setState(calibrating ? 'calibrating' : 'ready')
              setHint(calibrating ? 'Look straight at the camera while it recalibrates.' : 'Show your hand and point your index finger toward a direction.')
            }).catch(cause => {
              if (operationRef.current !== operation) return
              taskRef.current?.close(); taskRef.current = null
              streamRef.current?.getTracks().forEach(track => track.stop()); streamRef.current = null
              if (videoRef.current) videoRef.current.srcObject = null
              setError(cause instanceof Error ? cause.message : 'Camera tracking could not switch roles.')
              setState('error')
            }).finally(() => { switchingRole = false })
          }
          return
        }
        if (props.round !== lastRound) { lastRound = props.round; candidate = null; candidateAt = 0; sentRound = -1; previewSent = null }
        if (props.locked) sentRound = props.round

        let next: Direction | null = null
        if (props.role === 'Pointer' && landmarker instanceof HandLandmarker) {
          const result = landmarker.detectForVideo(currentVideo, now)
          const hand = result.landmarks?.[0] as Landmark[] | undefined
          if (!hand) { setHint('Show one hand in the camera view, with your index finger extended.') }
          else {
            const base = hand[5], tip = hand[8], pip = hand[6]
            const tipReach = Math.hypot(tip.x - base.x, tip.y - base.y)
            const bentReach = Math.hypot(pip.x - base.x, pip.y - base.y)
            if (tipReach < bentReach * 1.06) setHint('Extend your index finger to point toward a direction.')
            else {
              setHint('Hold your pointing direction to lock it in.')
              const dx = -(tip.x - base.x), dy = tip.y - base.y
              const length = Math.hypot(dx, dy)
              if (length > 0.035) next = classify(dx / length, dy / length, props.mode, props.mode === 'basic' ? 0.32 : 0.33)
            }
          }
        } else if (props.role === 'Dodger' && landmarker instanceof FaceLandmarker) {
          const result = landmarker.detectForVideo(currentVideo, now)
          const face = result.faceLandmarks?.[0] as Landmark[] | undefined
          if (!face) { setHint('Move into the frame so the camera can see your face.') }
          else {
            const leftEye = face[33], rightEye = face[263], nose = face[1]
            const eyeDistance = Math.hypot(rightEye.x - leftEye.x, rightEye.y - leftEye.y)
            const eyeX = (leftEye.x + rightEye.x) / 2, eyeY = (leftEye.y + rightEye.y) / 2
            const yaw = (nose.x - eyeX) / eyeDistance
            const pitch = (nose.y - eyeY) / eyeDistance
            if (calibrating && samplesX.length < 18) {
              samplesX.push(yaw); samplesY.push(pitch)
              setHint(`Hold still for calibration… ${Math.min(100, Math.round(samplesX.length / 18 * 100))}%`)
              if (samplesX.length === 18) {
                neutralX = samplesX.reduce((sum, item) => sum + item, 0) / samplesX.length
                neutralY = samplesY.reduce((sum, item) => sum + item, 0) / samplesY.length
                calibrating = false
                setState('ready'); setHint('Turn or tilt your head and hold a direction to dodge.')
              }
            } else {
              if (!calibrating && !hint.startsWith('Turn or tilt')) setHint('Turn or tilt your head and hold a direction to dodge.')
              const dx = -(yaw - neutralX), dy = pitch - neutralY
              next = classify(dx, dy, props.mode, props.mode === 'basic' ? 0.12 : 0.105)
            }
          }
        }

      setPrediction(previous => previous === next ? previous : next)
        if (next !== candidate) { candidate = next; candidateAt = next ? now : 0 }
        if (props.role === 'Pointer') {
          const stableAim = props.active && !props.locked && next && now - candidateAt >= 180 ? next : null
          if (stableAim !== previewSent) { previewSent = stableAim; props.onPreview?.(stableAim) }
        }
        if (next && props.active && !props.locked && sentRound !== props.round && now - candidateAt >= 700) setHint(`${words[next]} detected. Press CONFIRM to submit.`)
      }
      frameRef.current = requestAnimationFrame(loop)
    } catch (cause) {
      if (operationRef.current !== operation) return
      streamRef.current?.getTracks().forEach(track => track.stop()); streamRef.current = null
      if (videoRef.current) videoRef.current.srcObject = null
      const message = cause instanceof Error ? cause.message : 'The camera could not start. Check browser permissions and try again.'
      setError(message); setState('error'); setHint('')
    }
  }

  // Tell the parent whether the camera is tracking, so manual buttons hide while the camera drives input.
  useEffect(() => { onTracking?.(state === 'ready' || state === 'calibrating') }, [state, onTracking])

  useEffect(() => {
    if (!autoStart || autoStartedRef.current) return
    autoStartedRef.current = true
    void startCamera()
  }, [autoStart])

  const busy = state === 'loading'
  return <div className={`camera-card${immersive ? ' camera-immersive' : ''}`}>
    <div className="camera-heading"><div><span className="camera-kicker">CAMERA {state === 'ready' ? 'ACTIVE' : state === 'calibrating' ? 'CALIBRATING' : 'INPUT'}</span><strong>{role === 'Pointer' ? 'Point with your finger' : 'Dodge with your head'}</strong></div><span className={`camera-light ${state === 'ready' ? 'active' : ''}`}/></div>
    <div className={`camera-preview ${state === 'off' || state === 'error' ? 'camera-empty' : ''}`}>
      <video ref={videoRef} muted playsInline aria-label="Live camera preview" className={streamRef.current ? '' : 'video-hidden'}/>
      {(!streamRef.current || state === 'error') && <div className={`camera-placeholder ${avatarEnabled ? `emoji-avatar ${manualDirection ? `move-${manualDirection.toLowerCase()}` : ''}` : 'avatar-hidden'}`}><span className="emoji-person">{avatarEnabled ? '🙂' : 'CAMERA OFF'}</span><small>{avatarEnabled ? (manualDirection ? `MOVING ${words[manualDirection]}` : 'FACE AVATAR · BUTTONS READY') : 'BUTTONS READY'}</small></div>}
      {state !== 'off' && state !== 'error' && <div className="camera-overlay">TRACKING<span>↑ · ← · → · ↓</span></div>}
      {role === 'Dodger' && targetDirection && <div className="camera-target"><span>THE POINT</span><strong>{symbols[targetDirection]}</strong><b>DODGE OPPOSITE</b></div>}
      {prediction && <div className="camera-prediction"><b>{symbols[prediction]}</b> {words[prediction]}</div>}
    </div>
    <div className="camera-controls"><p className={state === 'error' ? 'camera-error' : ''}>{error || hint || (state === 'off' ? role === 'Pointer' ? 'Camera stays off until you turn it on.' : 'Look straight at the camera to calibrate, then move your head.' : '')}</p>
      {state === 'off' || state === 'error' ? <div className="camera-choice"><button className="camera-button" disabled={busy} onClick={startCamera}>{busy ? <><span className="spinner"/> STARTING CAMERA</> : <>USE CAMERA <span>↗</span></>}</button><button className="avatar-toggle" onClick={() => setAvatarEnabled(value => !value)}>{avatarEnabled ? 'HIDE AVATAR' : 'USE AVATAR'}</button></div> : <div className="camera-choice"><button className="camera-button confirm" disabled={!prediction || !active || locked} onClick={() => { if (!prediction) return; onSelect(prediction); setHint(`${words[prediction]} confirmed.`) }}>CONFIRM {prediction ? words[prediction] : 'MOVE'} <span>✓</span></button><button className="camera-button stop" onClick={stopCamera}>TURN CAMERA OFF <span>×</span></button></div>}
    </div>
    <div className="camera-privacy">{demo ? 'CAMERA TRYOUT · NO GAME MOVE WILL BE SENT' : avatarEnabled ? 'FACE AVATAR ON · CAMERA OFF · MANUAL BUTTONS ARE READY.' : 'CAMERA DEFAULT · TURN IT OFF ANY TIME.'}</div>
  </div>
}
