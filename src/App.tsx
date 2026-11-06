import { useEffect, useMemo, useRef, useState } from 'react'
import { Capacitor } from '@capacitor/core'
import { io, Socket } from 'socket.io-client'
import { MODES, Mode, RoomView } from '../shared/game'
import CameraInput from './CameraInput'

type Notice = { kind: 'success' | 'error'; text: string } | null
const makeName = () => `Player ${Math.floor(100 + Math.random() * 900)}`
const arrows: Record<string, string> = { LEFT: '←', RIGHT: '→', UP: '↑', DOWN: '↓', 'UP-LEFT': '↖', 'UP-RIGHT': '↗', 'DOWN-LEFT': '↙', 'DOWN-RIGHT': '↘' }

export default function App() {
  const [mode, setMode] = useState<Mode>('classic')
  const [name, setName] = useState(makeName)
  const [code, setCode] = useState('')
  const [room, setRoom] = useState<RoomView | null>(null)
  const [notice, setNotice] = useState<Notice>(null)
  const [connected, setConnected] = useState(false)
  const [busy, setBusy] = useState(false)
  const configuredServerUrl = import.meta.env.VITE_GAME_SERVER_URL || import.meta.env.VITE_SOCKET_URL || ''
  const [serverUrl, setServerUrl] = useState(() => configuredServerUrl || window.localStorage.getItem('pnd:server-url') || '')
  const [, setClock] = useState(0)
  const socket = useMemo<Socket>(() => io(configuredServerUrl || window.localStorage.getItem('pnd:server-url') || undefined, { autoConnect: false, transports: ['websocket', 'polling'], reconnection: true }), [])
  const isNative = Capacitor.isNativePlatform()
  const serverConfigured = Boolean(configuredServerUrl || serverUrl.trim())

  useEffect(() => {
    socket.on('connect', () => setConnected(true))
    socket.on('disconnect', () => setConnected(false))
    socket.on('connect_error', () => { setConnected(false); setBusy(false); setNotice({ kind: 'error', text: isNative && !serverConfigured ? 'Set the public HTTPS game-server address below before joining online matches.' : 'Could not reach the game server. Check the server address and internet connection, then try again.' }) })
    socket.on('room:update', setRoom)
    socket.on('room:error', (message: string) => { setNotice({ kind: 'error', text: message }); setBusy(false) })
    socket.on('match:queued', () => { setBusy(true); setNotice({ kind: 'success', text: `Waiting for another ${mode.toUpperCase()} player. Open a second tab or device and choose Quick Play in the same mode.` }) })
    socket.on('match:found', () => { setBusy(false); setNotice(null) })
    socket.on('room:joined', () => { setBusy(false); setNotice(null) })
    return () => { socket.disconnect(); socket.removeAllListeners() }
  }, [socket, isNative, serverConfigured])

  useEffect(() => {
    if (room?.status !== 'playing' || !room.countdownEndsAt || room.countdownEndsAt <= Date.now()) return
    const timer = window.setInterval(() => setClock(Date.now()), 100)
    return () => window.clearInterval(timer)
  }, [room?.status, room?.countdownEndsAt])

  const connect = () => {
    if (isNative && !serverConfigured) {
      setNotice({ kind: 'error', text: 'Add the game server’s public HTTPS address below before joining online matches.' })
      return false
    }
    if (!socket.connected) socket.connect()
    return true
  }
  const prepareCamera = async () => {
    if (!navigator.mediaDevices?.getUserMedia) return true
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false })
      stream.getTracks().forEach(track => track.stop())
      return true
    } catch {
      setNotice({ kind: 'error', text: 'Camera access is needed for the live turn. Allow camera access and try again.' })
      return false
    }
  }
  const quickPlay = () => {
    if (!name.trim()) return setNotice({ kind: 'error', text: 'Add a name to join the game.' })
    void (async () => { if (!(await prepareCamera()) || !connect()) return; setBusy(true); socket.emit('match:join', { name: name.trim(), mode }) })()
  }
  const createRoom = () => {
    if (!name.trim()) return setNotice({ kind: 'error', text: 'Add a name to create a room.' })
    void (async () => { if (!(await prepareCamera()) || !connect()) return; setBusy(true); socket.emit('room:create', { name: name.trim(), mode }) })()
  }
  const joinRoom = () => {
    if (!name.trim()) return setNotice({ kind: 'error', text: 'Add a name before joining.' })
    if (!code.trim()) return setNotice({ kind: 'error', text: 'Enter a room code.' })
    void (async () => { if (!(await prepareCamera()) || !connect()) return; setBusy(true); socket.emit('room:join', { name: name.trim(), code: code.trim().toUpperCase() }) })()
  }
  const leaveRoom = () => { socket.emit('room:leave'); setRoom(null); setNotice(null) }
  const playAgain = () => {
    socket.emit('room:leave')
    setRoom(null)
    setNotice(null)
    window.setTimeout(() => quickPlay(), 150)
  }
  const saveServer = () => {
    const value = serverUrl.trim().replace(/\/+$/, '')
    if (value) {
      try {
        const parsed = new URL(value)
        if (parsed.protocol !== 'https:') throw new Error('https')
      } catch {
        setNotice({ kind: 'error', text: 'Enter the game server’s public HTTPS address, starting with https://.' })
        return
      }
    }
    window.localStorage.setItem('pnd:server-url', value)
    window.location.reload()
  }
  const myRole = room?.pointerId === socket.id ? 'Pointer' : room?.dodgerId === socket.id ? 'Dodger' : null
  const myTurn = Boolean(room?.turnPhase && ((myRole === 'Pointer' && room.turnPhase === 'pointer') || (myRole === 'Dodger' && room.turnPhase === 'dodger')))
  const me = room?.players.find(p => p.id === socket.id)
  const inCountdown = Boolean(room?.countdownEndsAt && room.countdownEndsAt > Date.now())
  const [overlay, setOverlay] = useState<{ tone: 'hit' | 'caught' | 'dodged' | 'neutral'; title: string; detail: string; key: number } | null>(null)
  const [history, setHistory] = useState<string[]>([])
  const shownRound = useRef(0)

  // Show a personal, readable result for every round and buzz the phone when it matters.
  useEffect(() => {
    if (!room?.result || shownRound.current === room.round) return
    shownRound.current = room.round
    const r = room.result
    const role = room.pointerId === socket.id ? 'pointer' : room.dodgerId === socket.id ? 'dodger' : 'spectator'
    const dodgerName = room.players.find(p => p.id === room.dodgerId)?.name ?? 'Dodger'
    const point = `${arrows[r.pointerDirection]} ${r.pointerDirection.replace('-', ' ')}`
    const dodge = `${arrows[r.dodgeDirection]} ${r.dodgeDirection.replace('-', ' ')}`
    const timedOut = socket.id ? (r.timedOut ?? []).includes(socket.id) : false
    let tone: 'hit' | 'caught' | 'dodged' | 'neutral'
    let title: string
    let vibe: number | number[] = 0
    if (role === 'dodger') {
      tone = r.caught ? 'caught' : 'dodged'
      title = r.caught ? 'CAUGHT! −1 LIFE' : 'DODGED! +1 POINT'
      vibe = r.caught ? [400, 120, 400] : 60
    } else if (role === 'pointer') {
      tone = r.caught ? 'hit' : 'neutral'
      title = r.caught ? 'HIT! +2 POINTS' : 'MISSED — THEY DODGED'
      vibe = r.caught ? [80, 50, 80] : 0
    } else {
      tone = 'neutral'
      title = r.caught ? `${dodgerName} WAS CAUGHT` : `${dodgerName} DODGED`
    }
    const detail = `POINT ${point}  ·  DODGE ${dodge}${timedOut ? '  ·  TIME RAN OUT, RANDOM MOVE' : ''}`
    setOverlay({ tone, title, detail, key: Date.now() })
    setHistory(h => [`R${room.round}  ${r.caught ? 'CAUGHT' : 'DODGED'}  ·  ${point} vs ${dodge}`, ...h].slice(0, 6))
    if (vibe && 'vibrate' in navigator) { try { navigator.vibrate(vibe) } catch { /* unsupported */ } }
  }, [room, socket.id])

  useEffect(() => {
    if (!overlay) return
    const timer = window.setTimeout(() => setOverlay(null), 2200)
    return () => window.clearTimeout(timer)
  }, [overlay?.key])

  return <main className="shell">
    <header className="topbar"><a className="brand" href="#home" onClick={e => { e.preventDefault(); if (room) leaveRoom() }}><span className="brand-mark">P<span>&</span>D</span><span className="brand-name">POINT <b>&</b> DODGE</span></a><div className={`top-status ${room?.status === 'playing' ? 'is-live' : ''}`}><span className={`status-dot ${connected ? 'online' : ''}`} />{room ? room.status === 'playing' ? `LIVE · ${room.players.filter(p => p.lives > 0).length} PLAYERS LEFT` : `ROOM · ${room.players.length}/8 PLAYERS` : connected ? 'ONLINE' : 'READY TO PLAY'}<span className="version">v0.1</span></div></header>
    {!room ? <section className="home" id="home">
      {isNative && <div className={`android-preview-note ${serverConfigured ? 'server-configured' : ''}`}><span>{serverConfigured ? 'ONLINE SERVER ADDRESS SAVED' : 'CONNECT ONLINE PLAY'}</span><p>{serverConfigured ? 'The game will connect to this HTTPS server when you join a match.' : 'The camera game is ready. Online rooms need a public server address; enter it here after the server is deployed.'}</p><label htmlFor="server-url">GAME SERVER HTTPS ADDRESS</label><div className="server-url-row"><input id="server-url" value={serverUrl} onChange={event => setServerUrl(event.target.value)} placeholder="https://your-game-server.example" inputMode="url" autoCapitalize="none" autoCorrect="off"/><button onClick={saveServer}>SAVE</button></div></div>}
      <div className="hero"><div className="hero-copy"><div className="eyebrow"><span className="eyebrow-line" /> THE MULTIPLAYER REACTION GAME</div><h1>POINT <span className="amp">&</span><br/><span className="outline">DODGE.</span></h1><p className="tagline">Move a little. Reset your mind.<br/>Predict their move. Dodge the point.</p>
      <label className="name-label" htmlFor="player-name">YOUR PLAYER NAME</label><input id="player-name" className="name-input" maxLength={18} value={name} onChange={e => setName(e.target.value)} placeholder="Enter a name" />
      <div className="entry-mode"><div><strong>CHOOSE MODE BEFORE ENTERING</strong><span>Camera permission starts when you join.</span></div><div className="entry-mode-buttons">{(Object.keys(MODES) as Mode[]).map(key => <button key={key} className={mode === key ? 'selected' : ''} onClick={() => setMode(key)}><b>{MODES[key].label}</b><small>{MODES[key].count} directions</small></button>)}</div></div>
      <div className="action-row"><button className="button primary" disabled={busy} onClick={quickPlay}>{busy ? <><span className="spinner"/> FINDING PLAYERS</> : <>QUICK PLAY <span>↗</span></>}</button><button className="button secondary" disabled={busy} onClick={createRoom}>CREATE ROOM <span>＋</span></button></div>
      <div className="join-row"><input className="code-input" maxLength={6} value={code} onChange={e => setCode(e.target.value.toUpperCase())} placeholder="ROOM CODE" aria-label="Room code"/><button className="join-button" disabled={busy} onClick={joinRoom}>JOIN ROOM <span>→</span></button></div>
      {notice && <div className={`notice ${notice.kind}`}>{notice.text}</div>}
      <div className="camera-tryout"><div><strong>CAMERA RUNS THE TURN</strong><span>Hand point or head dodge is assigned automatically when your role changes.</span></div></div>
      </div><div className="hero-art" aria-label="Two opposing players"><div className="art-grid"/><div className="arena-label">ARENA 01 <span>•</span> READY</div><div className="character character-left"><div className="char-shadow"/><div className="char-head"><i/><i/></div><div className="char-body"/><div className="char-arm"/></div><div className="character character-right"><div className="char-shadow"/><div className="char-head"><i/><i/></div><div className="char-body"/><div className="char-arm"/></div><div className="versus">VS</div><div className="art-caption"><strong>2—8</strong><span>PLAYERS<br/>PER MATCH</span></div><div className="art-tag">READY<br/>SET<br/><b>DODGE!</b></div></div></div>
      <section className="mode-section"><div className="section-heading"><div><div className="eyebrow"><span className="eyebrow-line"/> PICK YOUR PACE</div><h2>CHOOSE YOUR <span>MODE</span></h2></div><p>Same game. Different directions.<br/>Pick your comfort zone.</p></div><div className="mode-grid">{(Object.keys(MODES) as Mode[]).map((key, i) => <button key={key} className={`mode-card ${mode === key ? 'active' : ''}`} onClick={() => setMode(key)}><div className="mode-card-top"><span className="mode-number">0{i+1}</span><span className="mode-check">{mode === key ? '✓' : '↗'}</span></div><div className={`direction-preview ${key}`}>{MODES[key].directions.map(d => <span key={d}>{arrows[d]}</span>)}</div><div className="mode-info"><div><h3>{MODES[key].label}</h3><p>{MODES[key].count} DIRECTIONS</p></div><span className="mode-level">{key === 'basic' ? 'STARTER' : key === 'classic' ? 'STANDARD' : 'ADVANCED'}</span></div></button>)}</div></section>
      <footer><span>© 2026 POINT & DODGE</span><span>CAMERA OPTIONAL · BUTTONS ALWAYS AVAILABLE</span><span>BUILT FOR CHAOS <b>✳</b></span></footer>
    </section> : <section className="lobby">
      <div className="lobby-heading"><div><div className="eyebrow"><span className="eyebrow-line"/>{room.status === 'playing' ? 'MATCH IN PROGRESS' : room.status === 'finished' ? 'MATCH COMPLETE' : 'YOU’RE IN THE ROOM'}</div><h1>{room.status === 'playing' ? 'THE ARENA' : room.status === 'finished' ? (room.winnerId === socket.id ? 'YOU SURVIVED.' : 'ROUND OVER.') : 'LOBBY.'}</h1></div><button className="button secondary small" onClick={leaveRoom}>LEAVE ROOM</button></div>
      <div className="lobby-grid"><div className="panel room-panel"><div className="room-code-label">ROOM CODE</div><button className="room-code" onClick={() => navigator.clipboard?.writeText(room.code)} title="Copy room code">{room.code} <span>⧉</span></button><div className="room-meta"><span>{MODES[room.mode].label} MODE</span><span>•</span><span>{room.players.length}/8 PLAYERS</span></div><div className="player-list">{room.players.map((p, i) => <div key={p.id} className={`player-row ${p.id === socket.id ? 'self' : ''}`}><div className={`player-avatar avatar-${i % 4}`}>{p.name.slice(0,1).toUpperCase()}</div><span className="player-name">{p.name}{p.id === socket.id && <small> YOU</small>}{p.id === room.hostId && <small> HOST</small>}</span><span className="player-lives">{'♥'.repeat(p.lives)}<i>{'♥'.repeat(3-p.lives)}</i></span></div>)}</div>
      {room.status === 'lobby' && room.players.length < 2 && <p className="waiting"><span className="spinner"/> Waiting for at least one more player…</p>}
      {room.status === 'lobby' && room.publicMatch && room.players.length >= 2 && <p className="waiting"><span className="spinner"/> Filling the match. It starts automatically after the 15-second window.</p>}
      {room.status === 'lobby' && !room.publicMatch && room.hostId === socket.id && <button className="button primary full" disabled={room.players.length < 2} onClick={() => socket.emit('room:start')}>START GAME <span>↗</span></button>}
      {room.status === 'lobby' && !room.publicMatch && room.hostId !== socket.id && <p className="waiting">Waiting for the host to start…</p>}
      {room.status === 'playing' && <div className="round-banner"><span>ROUND {room.round}</span>{room.countdownEndsAt && room.countdownEndsAt > Date.now() ? 'GET READY…' : 'MAKE YOUR MOVE'}</div>}
      </div><div className="panel game-panel"><div className="game-top"><span>{room.status === 'lobby' ? 'PLAYER LINEUP' : `ROUND ${room.round}`}</span><span className="live-pill">{room.status === 'playing' ? '● LIVE' : room.status === 'finished' ? '● FINISHED' : '● LOBBY'}</span></div>
      <div className="rank-line" aria-label="Player standings">{[...room.players].sort((a, b) => b.lives - a.lives).map((p, i) => <div className={`rank-player ${p.id === socket.id ? 'is-you' : ''} ${p.lives === 0 ? 'is-out' : ''}`} key={p.id}><span className="rank-number">#{i + 1}</span><span className={`player-avatar avatar-${room.players.indexOf(p) % 4}`}>{p.name.slice(0,1).toUpperCase()}</span><span className="rank-name">{p.name}</span><span className="rank-hearts">{'♥'.repeat(p.lives)}</span></div>)}</div>
      {room.status === 'playing' && me && <div className="my-status"><div><small>YOU</small><strong>{me.name}</strong></div><div className="my-lives" aria-label={`${me.lives} lives left`}>{[0, 1, 2].map(i => <span key={i} className={i < me.lives ? 'on' : 'off'}>♥</span>)}<em>{me.lives}/3 LIVES</em></div><div className="my-score"><small>SCORE</small><strong>{me.score}</strong></div></div>}
      {room.status === 'playing' && <><div className="role-card"><div className="role-icon">{myRole === 'Pointer' ? '☝' : myRole === 'Dodger' ? '↗' : '◉'}</div><div><small>YOUR ROLE THIS ROUND</small><strong>{myRole ?? 'SPECTATING'}</strong><span className="role-help">{myRole === 'Pointer' ? 'You point with your hand. Your opponent must dodge.' : myRole === 'Dodger' ? 'You dodge with your head. Move opposite the pointer.' : 'Watch the live round. Your turn is coming next.'}</span></div></div><div className="opponent">{myRole && <><span>{myRole === 'Pointer' ? 'YOUR DODGER' : 'YOUR POINTER'}</span><strong>{room.players.find(p => p.id === (myRole === 'Pointer' ? room.dodgerId : room.pointerId))?.name}</strong></>}</div>
      {myRole === 'Dodger' && !room.result && <div className="opponent-signal" aria-live="polite"><span className="signal-hand">☝</span><div><b>OPPONENT HAND ACTIVE</b><small>Watch the gesture, then choose your dodge before time runs out. The final direction stays hidden.</small></div></div>}
      {room.result && <div className={`result-card ${room.result.caught ? 'caught' : 'dodged'}`}><strong>{room.result.caught ? '💥 CAUGHT — 1 LIFE LOST' : '🎉 SUCCESSFUL DODGE!'}</strong><span>{room.result.message} · Point {arrows[room.result.pointerDirection]} · Dodge {arrows[room.result.dodgeDirection]}</span></div>}
      {history.length > 0 && <div className="round-log" aria-label="Round history">{history.map((line, i) => <div key={i}>{line}</div>)}</div>}
      {myRole && <CameraInput immersive role={myRole} mode={room.mode} round={room.round} targetDirection={myRole === 'Dodger' && room.turnPhase === 'dodger' ? room.aimDirection : null} active={myTurn && !room.submitted.includes(socket.id!)} locked={room.submitted.includes(socket.id!)} onPreview={direction => { if (myRole === 'Pointer' && myTurn) socket.emit('game:aim', { direction }) }} onSelect={direction => { if (myTurn) socket.emit('game:move', { direction }) }}/>}
      {myRole && <div className="turn-instruction"><b>{myTurn ? (myRole === 'Pointer' ? 'YOUR TURN: POINT' : 'YOUR TURN: DODGE') : 'OPPONENT TURN'}</b><span>{myTurn ? (myRole === 'Pointer' ? 'Aim your hand in one direction, or use a button.' : room.aimDirection ? `Move your head ${arrows[room.aimDirection]} opposite to escape.` : 'Choose the exact opposite direction, or use a button.') : 'Watch the round. Your controls will activate when your phase begins.'}</span><small>Camera is optional — use the direction buttons when your phase is active.</small></div>}
      {myRole && <div className="manual-label">CAMERA AUTO-INPUT · TAP A DIRECTION IF NEEDED</div>}
      {myRole && myTurn && !room.submitted.includes(socket.id!) && <div className="direction-pad" style={{ '--cols': MODES[room.mode].count === 2 ? 2 : 3 } as React.CSSProperties}>{MODES[room.mode].directions.map(d => <button key={d} className="direction-button" disabled={inCountdown} onClick={() => { if (inCountdown) return; if (myRole === 'Pointer') socket.emit('game:aim', { direction: d }); socket.emit('game:move', { direction: d }) }}><span>{arrows[d]}</span><small>{d.replace('-', ' ')}</small></button>)}</div>}
      {myRole && room.submitted.includes(socket.id!) && <p className="waiting"><span className="spinner"/> Locked in. Waiting for the other player…</p>}
      {!myRole && room.status === 'playing' && <p className="waiting">Your turn is coming up. Stay sharp.</p>}</>}
      {room.status === 'lobby' && <div className="how-to"><div className="how-mark">✳</div><h3>HOW TO PLAY</h3><p>Roles rotate automatically. Move your hand or head, or use the buttons. It is a quick body break with friends: the Pointer aims, the Dodger reacts in the exact opposite direction.</p><div className="lives-key">♥ <span>3 LIVES EACH · MOVE, RESET, PLAY AGAIN</span></div></div>}
      {room.status === 'finished' && <div className="how-to"><div className="how-mark">🏆</div><h3>{room.winnerId === socket.id ? 'VICTORY' : `${room.players.find(p => p.id === room.winnerId)?.name ?? 'A player'} WINS`}</h3><p>Last player standing. Start a fresh match with the same mode.</p><button className="button primary full" onClick={playAgain}>PLAY AGAIN</button><button className="button secondary full" onClick={leaveRoom}>BACK TO HOME</button></div>}
      </div></div></section>}
    {overlay && <div key={overlay.key} className={`round-overlay ${overlay.tone}`} role="status" aria-live="assertive"><strong>{overlay.title}</strong><span>{overlay.detail}</span></div>}
    {room?.status === 'playing' && myRole && <div className="arena-status"><span>ROUND {room.round} · {myRole.toUpperCase()}</span><strong>{myTurn ? (myRole === 'Pointer' ? 'POINT NOW' : 'DODGE NOW') : 'OPPONENT TURN'}</strong><span>{room.players.filter(p => p.lives > 0).length} PLAYERS LEFT</span></div>}
  </main>
}
