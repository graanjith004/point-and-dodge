export const MODES = {
  basic: { label: 'Basic', count: 2, directions: ['LEFT', 'RIGHT'] },
  classic: { label: 'Classic', count: 4, directions: ['UP', 'RIGHT', 'DOWN', 'LEFT'] },
  pro: { label: 'Pro', count: 8, directions: ['UP', 'UP-RIGHT', 'RIGHT', 'DOWN-RIGHT', 'DOWN', 'DOWN-LEFT', 'LEFT', 'UP-LEFT'] },
} as const

export type Mode = keyof typeof MODES
export type Direction = typeof MODES[Mode]['directions'][number]
export type Player = { id: string; name: string; lives: number; score: number; connected: boolean }
export type RoomView = {
  code: string; mode: Mode; status: 'lobby' | 'playing' | 'finished'; players: Player[]; hostId: string; publicMatch?: boolean
  round: number; pointerId: string | null; dodgerId: string | null; submitted: string[]
  aimDirection: Direction | null
  result: { pointerDirection: string; dodgeDirection: string; caught: boolean; message: string } | null
  winnerId: string | null; countdownEndsAt: number | null
}

export const modeLabel = (mode: Mode) => MODES[mode].label

export const oppositeDirection: Record<Direction, Direction> = {
  LEFT: 'RIGHT', RIGHT: 'LEFT', UP: 'DOWN', DOWN: 'UP',
  'UP-LEFT': 'DOWN-RIGHT', 'DOWN-RIGHT': 'UP-LEFT',
  'UP-RIGHT': 'DOWN-LEFT', 'DOWN-LEFT': 'UP-RIGHT',
}
