// Two-player end-to-end check for the sequential Pointer -> Dodger turn engine.
// Usage: node scripts/two-player-turns.mjs [serverUrl]
// Default serverUrl is http://localhost:3001. Run the server with short timers for a quick pass:
//   POINTER_MS=2000 DODGER_MS=2000 PORT=3001 npx tsx server/index.ts
import { io } from 'socket.io-client'

const URL = process.argv[2] ?? 'http://localhost:3001'
const opts = { transports: ['websocket', 'polling'], reconnection: false, timeout: 30000 }
const sleep = ms => new Promise(r => setTimeout(r, ms))
const results = []
const check = (name, ok, detail = '') => { results.push({ name, ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`) }

const host = io(URL, opts), guest = io(URL, opts)
let hostView = null, guestView = null
const errors = { host: [], guest: [] }
// The server calls the phase `turnPhase`; alias it to `phase` for the checks below.
host.on('room:update', v => { v.phase = v.turnPhase; hostView = v })
guest.on('room:update', v => { v.phase = v.turnPhase; guestView = v })
host.on('room:error', m => errors.host.push(m))
guest.on('room:error', m => errors.guest.push(m))

const sock = who => (who === 'host' ? host : guest)
const viewOf = who => (who === 'host' ? hostView : guestView)
const waitFor = async (pred, ms = 20000) => {
  const start = Date.now()
  while (Date.now() - start < ms) { if (pred()) return true; await sleep(50) }
  return false
}

await Promise.all([new Promise(r => host.once('connect', r)), new Promise(r => guest.once('connect', r))])
const hostId = host.id, guestId = guest.id
const idOf = who => (who === 'host' ? hostId : guestId)

host.emit('room:create', { name: 'TestHost', mode: 'basic' })
await waitFor(() => hostView?.code)
const code = hostView.code
guest.emit('room:join', { name: 'TestGuest', code })
await waitFor(() => guestView?.players?.length === 2)
check('room created and guest joined', hostView?.players?.length === 2, `code ${code}`)

host.emit('room:start')
await waitFor(() => hostView?.status === 'playing' && hostView?.phase === 'pointer')
check('match starts in pointer phase', hostView?.phase === 'pointer', `round ${hostView?.round}`)
check('pointer phase has a timer deadline', typeof hostView?.phaseEndsAt === 'number' && hostView.phaseEndsAt > Date.now())

// Who is pointer/dodger for a given turn is read from the server, never assumed.
const roles = () => {
  const v = hostView
  const pointer = v.pointerId === hostId ? 'host' : 'guest'
  return { pointer, dodger: pointer === 'host' ? 'guest' : 'host' }
}
const livesOf = (who, v = hostView) => v.players.find(p => p.id === idOf(who))?.lives
const scoreOf = (who, v = hostView) => v.players.find(p => p.id === idOf(who))?.score

async function waitPointerPhase() {
  await waitFor(() => hostView?.phase === 'pointer' && Date.now() >= (hostView.countdownEndsAt ?? 0))
}

async function playTurn(label, action) {
  await waitPointerPhase()
  const { pointer, dodger } = roles()
  const before = { p: livesOf(pointer), d: livesOf(dodger), ps: scoreOf(pointer), ds: scoreOf(dodger) }
  const pointerSock = sock(pointer), dodgerSock = sock(dodger)

  if (action === 'dodge-opposite' || action === 'dodge-same' || action === 'dodge-timeout') {
    pointerSock.emit('game:aim', { direction: 'LEFT' })
    await sleep(300)
    check(`${label}: dodger cannot see pointer aim during pointer phase`, viewOf(dodger)?.aimDirection == null, `dodger sees ${viewOf(dodger)?.aimDirection}`)
    check(`${label}: pointer sees own aim`, viewOf(pointer)?.aimDirection === 'LEFT')

    // Out-of-phase move from the dodger must be rejected.
    const errBefore = errors[dodger].length
    dodgerSock.emit('game:move', { direction: 'RIGHT' })
    await sleep(300)
    check(`${label}: dodger move rejected during pointer phase`, errors[dodger].length > errBefore, errors[dodger].at(-1) ?? 'no error emitted')
    check(`${label}: still in pointer phase after rejected dodge`, hostView?.phase === 'pointer')

    pointerSock.emit('game:move', { direction: 'LEFT' })
    await waitFor(() => hostView?.phase === 'dodger')
    await sleep(200)
    check(`${label}: pointer lock moves to dodger phase`, hostView?.phase === 'dodger')
    check(`${label}: dodger phase has its own timer deadline`, typeof hostView?.phaseEndsAt === 'number' && hostView.phaseEndsAt > Date.now())
    check(`${label}: dodger now sees the locked pointer direction`, viewOf(dodger)?.aimDirection === 'LEFT', `got ${viewOf(dodger)?.aimDirection}`)

    if (action === 'dodge-timeout') {
      await waitFor(() => hostView?.phase === 'result')
      check(`${label}: dodger timeout is resolved as a catch`, hostView?.result?.caught === true && hostView?.result?.timedOut?.includes(idOf(dodger)))
      check(`${label}: dodger loses a life on timeout`, livesOf(dodger) === before.d - 1, `${before.d} -> ${livesOf(dodger)}`)
      check(`${label}: pointer gains points on dodger timeout`, scoreOf(pointer) === before.ps + 2)
    } else {
      dodgerSock.emit('game:move', { direction: action === 'dodge-opposite' ? 'RIGHT' : 'LEFT' })
      await waitFor(() => hostView?.phase === 'result')
      const r = hostView?.result
      if (action === 'dodge-opposite') {
        check(`${label}: exact-opposite dodge is not caught`, r?.caught === false, `caught=${r?.caught}`)
        check(`${label}: dodger scores +1 for a clean dodge`, scoreOf(dodger) === before.ds + 1)
        check(`${label}: dodger keeps lives on a clean dodge`, livesOf(dodger) === before.d)
      } else {
        check(`${label}: same-direction dodge is caught`, r?.caught === true, `caught=${r?.caught}`)
        check(`${label}: dodger loses a life when caught`, livesOf(dodger) === before.d - 1, `${before.d} -> ${livesOf(dodger)}`)
      }
      check(`${label}: result reveals both directions`, r?.pointerDirection === 'LEFT' && r?.dodgeDirection, `point=${r?.pointerDirection} dodge=${r?.dodgeDirection}`)
    }
  } else if (action === 'pointer-timeout') {
    await sleep(300)
    check(`${label}: dodger sees no aim while pointer is idle`, viewOf(dodger)?.aimDirection == null)
    await waitFor(() => hostView?.phase === 'result')
    check(`${label}: pointer timeout recorded for pointer`, hostView?.result?.timedOut?.includes(idOf(pointer)) === true)
    check(`${label}: pointer loses a life on timeout`, livesOf(pointer) === before.p - 1, `${before.p} -> ${livesOf(pointer)}`)
    check(`${label}: dodger gains a point on pointer timeout`, scoreOf(dodger) === before.ds + 1, `${before.ds} -> ${scoreOf(dodger)}`)
    check(`${label}: dodger lives unchanged on pointer timeout`, livesOf(dodger) === before.d)
    const nextRound = hostView.round + 1
    const continued = await waitFor(() => hostView?.phase === 'pointer' && hostView?.round === nextRound, 15000)
    check(`${label}: game continues to the next turn after pointer timeout`, continued, `round now ${hostView?.round}`)
  }
  // Wait for the result phase to end before the next turn starts.
  await waitFor(() => hostView?.phase === 'pointer' && hostView?.round > 0 && hostView?.result === null, 20000)
}

// Turn 1: clean opposite dodge.
await playTurn('turn 1 (opposite dodge)', 'dodge-opposite')
// Turn 2: same-direction dodge is caught.
await playTurn('turn 2 (same-direction)', 'dodge-same')
// Turn 3: dodger times out.
await playTurn('turn 3 (dodger timeout)', 'dodge-timeout')
// Turn 4: pointer times out.
await playTurn('turn 4 (pointer timeout)', 'pointer-timeout')

const failed = results.filter(r => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
host.close(); guest.close()
process.exit(failed.length ? 1 : 0)
