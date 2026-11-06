import express from 'express'
import { createServer } from 'node:http'
import { Server, Socket } from 'socket.io'
import { randomInt } from 'node:crypto'
import { Direction, MODES, Mode, Player, RoomView, oppositeDirection, POINTER_MS, DODGER_MS } from '../shared/game'

type GameRoom = RoomView & {
  public: boolean
  picks: Record<string, Direction>
  turnIndex: number
  turnId: number
  streak: number
  turnTimer?: ReturnType<typeof setTimeout>
  readyTimer?: ReturnType<typeof setTimeout>
  nextTimer?: ReturnType<typeof setTimeout>
  fillTimer?: ReturnType<typeof setTimeout>
}
const app = express()
const httpServer = createServer(app)
const allowedOrigins = (process.env.CLIENT_ORIGIN ?? 'http://localhost:5173,http://localhost:5174')
  .split(',').map(value => value.trim()).filter(Boolean)
const originAllowed = (origin?: string) => !origin || allowedOrigins.includes('*') || allowedOrigins.includes(origin)
app.use((_req, res, next) => { res.setHeader('Access-Control-Allow-Origin', allowedOrigins.includes('*') ? '*' : (allowedOrigins[0] ?? '')); next() })
const io = new Server(httpServer, {
  cors: { origin: (origin, callback) => originAllowed(origin) ? callback(null, true) : callback(new Error('Origin not allowed')), methods: ['GET', 'POST'] },
  transports: ['websocket', 'polling'],
  pingInterval: 25_000,
  pingTimeout: 20_000,
})
const rooms = new Map<string, GameRoom>()
const socketRoom = new Map<string, string>()
const waiting = new Map<Mode, { id: string; name: string }[]>()
const fillMs = 15_000
// Sequential turn timings. Overridable through env so the two-player test can run quickly.
const pointerMs = Number(process.env.POINTER_MS ?? POINTER_MS)
const dodgerMs = Number(process.env.DODGER_MS ?? DODGER_MS)
const readyMs = 3_000
const resultMs = 2_400

const health = (_req: express.Request, res: express.Response) => res.json({ status: 'ok', service: 'point-and-dodge-server', timestamp: new Date().toISOString(), uptime: process.uptime() })
app.get('/health', health)
app.get('/api/health', health)
app.get('/api/modes', (_req, res) => res.json(MODES))
app.get('/', (_req, res) => res.json({ name: 'POINT & DODGE server', status: 'ok' }))

function cleanName(value: unknown) { return typeof value === 'string' ? value.trim().slice(0, 18) || 'Player' : 'Player' }
function validMode(value: unknown): value is Mode { return value === 'basic' || value === 'classic' || value === 'pro' }
function code() { return randomInt(0, 36 ** 5).toString(36).toUpperCase().padStart(5, '0') }
function makePlayer(id: string, name: string): Player { return { id, name, lives: 3, score: 0, connected: true } }
function view(room: GameRoom, recipientId?: string): RoomView {
  const { picks: _picks, turnIndex: _turn, turnId: _tid, streak: _streak, turnTimer: _timer, readyTimer: _ready, nextTimer: _next, fillTimer: _fill, public: isPublic, ...safe } = room
  safe.publicMatch = isPublic
  // During the Pointer phase the aim is private to the Pointer. The Dodger (and any spectator)
  // only sees it once the Pointer has locked in and the Dodger phase has started.
  if (room.phase === 'pointer' && recipientId !== room.pointerId) safe.aimDirection = null
  return safe
}
function publish(room: GameRoom) { for (const player of room.players) io.to(player.id).emit('room:update', view(room, player.id)) }
function attach(room: GameRoom, socket: Socket, name: string) {
  if (room.players.length >= 8) return false
  room.players.push(makePlayer(socket.id, name))
  socket.join(room.code); socketRoom.set(socket.id, room.code)
  socket.emit('room:joined', room.code)
  publish(room)
  return true
}
function newRoom(socket: Socket, name: string, mode: Mode, isPublic: boolean) {
  let roomCode = code()
  while (rooms.has(roomCode)) roomCode = code()
  const room: GameRoom = { code: roomCode, mode, status: 'lobby', players: [makePlayer(socket.id, name)], hostId: socket.id, round: 0, pointerId: null, dodgerId: null, submitted: [], phase: null, phaseEndsAt: null, aimDirection: null, result: null, winnerId: null, countdownEndsAt: null, public: isPublic, picks: {}, turnIndex: 0, turnId: 0, streak: 0 }
  rooms.set(roomCode, room); socket.join(roomCode); socketRoom.set(socket.id, roomCode)
  socket.emit('room:joined', roomCode); publish(room)
  return room
}
function clearTurnTimers(room: GameRoom) {
  if (room.turnTimer) clearTimeout(room.turnTimer)
  if (room.readyTimer) clearTimeout(room.readyTimer)
  room.turnTimer = undefined; room.readyTimer = undefined
}
function startMatch(room: GameRoom) {
  if (room.status !== 'lobby' || room.players.length < 2) return
  if (room.fillTimer) clearTimeout(room.fillTimer)
  room.fillTimer = undefined
  room.status = 'playing'; room.round = 0; room.turnIndex = 0; room.result = null
  beginTurn(room)
}

// One turn = Pointer phase -> Dodger phase -> Result. Each phase has its own timer. A timeout
// costs the player responsible for that phase one life. Every timer checks turnId so a stale
// timer from an earlier turn can never act on the current one.
function beginTurn(room: GameRoom) {
  if (room.status !== 'playing') return
  const active = room.players.filter(p => p.lives > 0 && p.connected)
  if (active.length <= 1) {
    clearTurnTimers(room)
    room.status = 'finished'; room.winnerId = active[0]?.id ?? null; room.pointerId = null; room.dodgerId = null
    room.phase = null; room.phaseEndsAt = null; room.countdownEndsAt = null
    publish(room); return
  }
  const pointer = active[room.turnIndex % active.length]
  const dodger = active[(room.turnIndex + 1) % active.length]
  const turnId = ++room.turnId
  room.round += 1; room.pointerId = pointer.id; room.dodgerId = dodger.id
  room.submitted = []; room.picks = {}; room.aimDirection = null; room.result = null
  room.phase = 'pointer'
  room.countdownEndsAt = Date.now() + readyMs
  room.phaseEndsAt = room.countdownEndsAt + pointerMs
  clearTurnTimers(room)
  publish(room)
  room.readyTimer = setTimeout(() => {
    if (room.turnId !== turnId || room.phase !== 'pointer') return
    room.countdownEndsAt = null
    publish(room)
  }, readyMs)
  room.turnTimer = setTimeout(() => pointerTimeout(room, turnId), readyMs + pointerMs)
}
function pointerTimeout(room: GameRoom, turnId: number) {
  if (room.turnId !== turnId || room.phase !== 'pointer') return
  const pointer = room.players.find(p => p.id === room.pointerId)
  const dodger = room.players.find(p => p.id === room.dodgerId)
  if (!pointer || !dodger) return
  // Pointer ran out of time: the Pointer loses a life and the Dodger takes the exchange.
  pointer.lives = Math.max(0, pointer.lives - 1)
  dodger.score += 2; room.streak = 0
  room.result = { pointerDirection: null, dodgeDirection: null, caught: false, message: `${pointer.name} timed out and lost a life.`, timedOut: [pointer.id] }
  finishTurn(room)
}
function startDodgerPhase(room: GameRoom, turnId: number) {
  if (room.turnId !== turnId || room.phase !== 'pointer') return
  // Pointer has locked in: reveal the aim to everyone and open the Dodger phase.
  room.phase = 'dodger'; room.countdownEndsAt = null
  room.phaseEndsAt = Date.now() + dodgerMs
  if (room.turnTimer) clearTimeout(room.turnTimer)
  room.turnTimer = setTimeout(() => dodgerTimeout(room, turnId), dodgerMs)
  publish(room)
}
function dodgerTimeout(room: GameRoom, turnId: number) {
  if (room.turnId !== turnId || room.phase !== 'dodger') return
  const pointer = room.players.find(p => p.id === room.pointerId)
  const dodger = room.players.find(p => p.id === room.dodgerId)
  if (!pointer || !dodger) return
  // Dodger ran out of time: an automatic catch, and the Dodger loses a life.
  dodger.lives = Math.max(0, dodger.lives - 1); pointer.score += 2; room.streak = 0
  room.result = { pointerDirection: room.picks[pointer.id] ?? null, dodgeDirection: null, caught: true, message: `${dodger.name} timed out and was caught!`, timedOut: [dodger.id] }
  finishTurn(room)
}
function resolveDodge(room: GameRoom, direction: Direction) {
  const pointer = room.players.find(p => p.id === room.pointerId)
  const dodger = room.players.find(p => p.id === room.dodgerId)
  const pointDirection = room.pointerId ? room.picks[room.pointerId] : undefined
  if (!pointer || !dodger || !pointDirection) return
  const caught = direction !== oppositeDirection[pointDirection]
  if (caught) { pointer.score += 2; dodger.lives = Math.max(0, dodger.lives - 1); room.streak = 0 }
  else { dodger.score += 1; room.streak += 1; if (room.streak === 3) { dodger.score += 2; room.streak = 0 } }
  room.result = { pointerDirection: pointDirection, dodgeDirection: direction, caught, message: caught ? `${dodger.name} was caught!` : `${dodger.name} dodged it!` }
  finishTurn(room)
}
function finishTurn(room: GameRoom) {
  clearTurnTimers(room)
  room.phase = 'result'; room.phaseEndsAt = null; room.countdownEndsAt = null
  room.submitted = [room.pointerId, room.dodgerId].filter((id): id is string => Boolean(id))
  publish(room)
  if (room.nextTimer) clearTimeout(room.nextTimer)
  room.nextTimer = setTimeout(() => {
    if (room.status !== 'playing') return
    room.turnIndex += 1
    beginTurn(room)
  }, resultMs)
}

function removePlayer(id: string) {
  const currentCode = socketRoom.get(id)
  if (!currentCode) return
  socketRoom.delete(id)
  const room = rooms.get(currentCode)
  if (!room) return
  room.players = room.players.filter(p => p.id !== id)
  if (room.players.length === 0) {
    if (room.fillTimer) clearTimeout(room.fillTimer)
    clearTurnTimers(room)
    if (room.nextTimer) clearTimeout(room.nextTimer)
    rooms.delete(room.code); return
  }
  if (room.hostId === id && room.status === 'lobby') room.hostId = room.players[0].id
  if (room.status === 'lobby' && room.players.length < 2) {
    if (room.public && room.fillTimer) clearTimeout(room.fillTimer)
    room.fillTimer = undefined
  } else if (room.status === 'playing') {
    if (room.pointerId === id || room.dodgerId === id) {
      clearTurnTimers(room)
      if (room.nextTimer) clearTimeout(room.nextTimer)
      room.phase = 'result'; room.phaseEndsAt = null
      room.nextTimer = setTimeout(() => { room.turnIndex += 1; beginTurn(room) }, 300)
    } else if (room.players.filter(p => p.lives > 0 && p.connected).length <= 1) {
      room.status = 'finished'; room.winnerId = room.players.find(p => p.lives > 0)?.id ?? null
    }
  }
  publish(room)
}
function getRoom(socket: Socket) { const c = socketRoom.get(socket.id); return c ? rooms.get(c) : undefined }

io.on('connection', socket => {
  socket.on('room:create', (data: { name?: unknown; mode?: unknown }) => {
    if (getRoom(socket)) removePlayer(socket.id)
    newRoom(socket, cleanName(data?.name), validMode(data?.mode) ? data.mode : 'classic', false)
  })
  socket.on('room:join', (data: { name?: unknown; code?: unknown }) => {
    if (getRoom(socket)) removePlayer(socket.id)
    const room = typeof data?.code === 'string' ? rooms.get(data.code.toUpperCase()) : undefined
    if (!room || room.status !== 'lobby' || room.players.length >= 8) { socket.emit('room:error', 'That room is unavailable. Check the code or create a new room.'); return }
    attach(room, socket, cleanName(data.name))
  })
  socket.on('match:join', (data: { name?: unknown; mode?: unknown }) => {
    if (getRoom(socket)) removePlayer(socket.id)
    const mode = validMode(data?.mode) ? data.mode : 'classic'
    const playerName = cleanName(data?.name)
    const room = [...rooms.values()].find(r => r.public && r.mode === mode && r.status === 'lobby' && r.players.length < 8 && r.fillTimer)
    if (room) {
      attach(room, socket, playerName); socket.emit('match:found', room.code); return
    }
    const queue = waiting.get(mode) ?? []
    const otherIndex = queue.findIndex(p => p.id !== socket.id)
    if (otherIndex < 0) {
      queue.push({ id: socket.id, name: playerName }); waiting.set(mode, queue); socket.emit('match:queued'); return
    }
    const first = queue.splice(otherIndex, 1)[0]
    const firstSocket = io.sockets.sockets.get(first.id)
    if (!firstSocket) { queue.push({ id: socket.id, name: playerName }); socket.emit('match:queued'); return }
    waiting.set(mode, queue)
    const match = newRoom(firstSocket, first.name, mode, true)
    attach(match, socket, playerName)
    match.fillTimer = setTimeout(() => startMatch(match), fillMs)
    match.countdownEndsAt = Date.now() + fillMs
    publish(match)
    firstSocket.emit('match:found', match.code); socket.emit('match:found', match.code)
  })
  socket.on('room:start', () => {
    const room = getRoom(socket)
    if (!room || room.public || room.status !== 'lobby') return
    if (room.hostId !== socket.id) { socket.emit('room:error', 'Only the room host can start this match.'); return }
    if (room.players.length < 2) { socket.emit('room:error', 'You need at least 2 players to start.'); return }
    startMatch(room)
  })
  // Pointer locks a direction in the Pointer phase -> Dodger phase begins with the aim revealed.
  // Dodger moves in the Dodger phase -> result is resolved.
  socket.on('game:move', (data: { direction?: unknown }) => {
    const room = getRoom(socket)
    if (!room || room.status !== 'playing' || !room.pointerId || !room.dodgerId) return
    const allowed = MODES[room.mode].directions as readonly string[]
    if (typeof data?.direction !== 'string' || !allowed.includes(data.direction)) { socket.emit('room:error', 'That direction is not available in this mode.'); return }
    if (Date.now() < (room.countdownEndsAt ?? 0)) { socket.emit('room:error', 'Wait for the countdown to finish.'); return }
    const direction = data.direction as Direction
    const turnId = room.turnId
    if (room.phase === 'pointer' && socket.id === room.pointerId) {
      if (room.picks[socket.id]) return
      room.picks[socket.id] = direction; room.aimDirection = direction
      room.submitted = [socket.id]
      startDodgerPhase(room, turnId)
    } else if (room.phase === 'dodger' && socket.id === room.dodgerId) {
      if (room.picks[socket.id]) return
      room.picks[socket.id] = direction; room.submitted = [room.pointerId, socket.id]
      resolveDodge(room, direction)
    } else {
      socket.emit('room:error', room.phase === 'dodger' ? 'Wait for the Dodger to move.' : 'It is not your turn.')
    }
  })
  // Live aim preview from the Pointer (camera or button). Private until the Dodger phase.
  socket.on('game:aim', (data: { direction?: unknown }) => {
    const room = getRoom(socket)
    if (!room || room.status !== 'playing' || room.phase !== 'pointer' || room.pointerId !== socket.id || room.picks[socket.id] || Date.now() < (room.countdownEndsAt ?? 0)) return
    const allowed = MODES[room.mode].directions as readonly string[]
    const direction = data?.direction
    if (direction !== null && (typeof direction !== 'string' || !allowed.includes(direction))) return
    room.aimDirection = direction as Direction | null
    publish(room)
  })
  socket.on('room:leave', () => removePlayer(socket.id))
  socket.on('disconnect', () => {
    for (const [mode, queue] of waiting) waiting.set(mode, queue.filter(p => p.id !== socket.id))
    removePlayer(socket.id)
  })
})

const port = Number(process.env.PORT ?? 3001)
const shutdown = () => { for (const room of rooms.values()) { if (room.fillTimer) clearTimeout(room.fillTimer); clearTurnTimers(room); if (room.nextTimer) clearTimeout(room.nextTimer) }; httpServer.close(() => process.exit(0)) }
process.once('SIGTERM', shutdown)
process.once('SIGINT', shutdown)
httpServer.listen(port, () => console.log(`POINT & DODGE server listening on port ${port}`))
