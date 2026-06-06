// Vercel serverless function — /api/tictactoe
// Tic-Tac-Toe network game state у Upstash Redis.
//
// Actions:
//   GET  /api/tictactoe?room=<roomid>                  → read state
//   POST /api/tictactoe { action, room, playerId, ... } → mutate
//     - action: "join"   {name}        → assign slot p1(X) / p2(O) / observer
//     - action: "move"   {idx}         → poставити X/O на клітинку 0-8 (тільки на своєму ході)
//     - action: "rename" {name}        → update my name
//     - action: "next"                 → reset board, round++, swap first
//     - action: "reset"                → reset усе (score + round + board)
//     - action: "leave"                → звільнити slot
//
// State shape:
//   {
//     p1: { id, name } or null      — X
//     p2: { id, name } or null      — O
//     board: [9 × (null|'X'|'O')],
//     turn: 'p1' | 'p2',
//     first: 'p1' | 'p2',           — хто починав цей раунд (чергується)
//     round: number,
//     score: { p1, p2, tie },
//     winner: null | 'p1' | 'p2' | 'tie',
//     winLine: [a,b,c] | null,
//     updatedAt: ISO,
//   }

const STATE_KEY_PREFIX = 'ttt:room:';
const DEFAULT_ROOM = 'default';
const STATE_TTL_SEC = 60 * 60 * 24; // 24h

const WIN_LINES = [
  [0, 1, 2], [3, 4, 5], [6, 7, 8], // rows
  [0, 3, 6], [1, 4, 7], [2, 5, 8], // cols
  [0, 4, 8], [2, 4, 6],            // diags
];

function kvCfg() {
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) throw new Error('Upstash Redis env vars not set');
  return { url: url.replace(/\/+$/, ''), token };
}

async function redisCmd(cmd) {
  const { url, token } = kvCfg();
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(cmd),
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`KV ${cmd[0]} failed: ${res.status} ${t.slice(0, 200)}`);
  }
  return res.json();
}

function emptyState() {
  return {
    p1: null,
    p2: null,
    board: Array(9).fill(null),
    turn: 'p1',
    first: 'p1',
    round: 1,
    score: { p1: 0, p2: 0, tie: 0 },
    winner: null,
    winLine: null,
    updatedAt: new Date().toISOString(),
  };
}

async function readState(room) {
  const key = STATE_KEY_PREFIX + room;
  const { result } = await redisCmd(['GET', key]);
  if (!result) return emptyState();
  try { return JSON.parse(result); } catch { return emptyState(); }
}

async function writeState(room, state) {
  state.updatedAt = new Date().toISOString();
  const key = STATE_KEY_PREFIX + room;
  await redisCmd(['SET', key, JSON.stringify(state), 'EX', STATE_TTL_SEC]);
  return state;
}

function sanitizeName(n) {
  return String(n || '').slice(0, 16).replace(/[<>"'&`]/g, '').trim() || 'Гравець';
}

function checkWinner(board) {
  for (const line of WIN_LINES) {
    const [a, b, c] = line;
    if (board[a] && board[a] === board[b] && board[a] === board[c]) {
      return { mark: board[a], line };
    }
  }
  if (board.every(x => x !== null)) return { mark: 'tie', line: null };
  return null;
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 'no-store');

  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const room = (url.searchParams.get('room') || DEFAULT_ROOM).slice(0, 40);

    if (req.method === 'GET') {
      const state = await readState(room);
      return res.status(200).json({ ok: true, state });
    }

    if (req.method !== 'POST') {
      return res.status(405).json({ ok: false, error: 'Method not allowed' });
    }

    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const action = body.action;
    const playerId = String(body.playerId || '').slice(0, 64);
    if (!playerId) return res.status(400).json({ ok: false, error: 'playerId required' });

    let state = await readState(room);

    if (action === 'join') {
      const name = sanitizeName(body.name);
      if (state.p1?.id === playerId) state.p1.name = name;
      else if (state.p2?.id === playerId) state.p2.name = name;
      else if (!state.p1) state.p1 = { id: playerId, name };
      else if (!state.p2) state.p2 = { id: playerId, name };
      else {
        return res.status(200).json({ ok: true, state, slot: 'observer' });
      }
      state = await writeState(room, state);
      const slot = state.p1?.id === playerId ? 'p1' : 'p2';
      return res.status(200).json({ ok: true, state, slot });
    }

    if (action === 'move') {
      const idx = Number.isInteger(body.idx) ? body.idx : -1;
      if (idx < 0 || idx > 8) {
        return res.status(400).json({ ok: false, error: 'idx must be 0..8' });
      }
      let slot = null;
      if (state.p1?.id === playerId) slot = 'p1';
      else if (state.p2?.id === playerId) slot = 'p2';
      else return res.status(403).json({ ok: false, error: 'not in this room' });

      // Need both players + no winner yet + cell empty + your turn
      if (!state.p1 || !state.p2) return res.status(409).json({ ok: false, error: 'wait for second player', state });
      if (state.winner) return res.status(409).json({ ok: false, error: 'round already over', state });
      if (state.turn !== slot) return res.status(409).json({ ok: false, error: 'not your turn', state });
      if (state.board[idx] !== null) return res.status(409).json({ ok: false, error: 'cell taken', state });

      const mark = slot === 'p1' ? 'X' : 'O';
      state.board[idx] = mark;

      const result = checkWinner(state.board);
      if (result) {
        if (result.mark === 'tie') {
          state.winner = 'tie';
          state.winLine = null;
          state.score.tie++;
        } else {
          state.winner = result.mark === 'X' ? 'p1' : 'p2';
          state.winLine = result.line;
          state.score[state.winner]++;
        }
      } else {
        state.turn = slot === 'p1' ? 'p2' : 'p1';
      }
      state = await writeState(room, state);
      return res.status(200).json({ ok: true, state, slot });
    }

    if (action === 'rename') {
      const name = sanitizeName(body.name);
      if (state.p1?.id === playerId) state.p1.name = name;
      else if (state.p2?.id === playerId) state.p2.name = name;
      else return res.status(403).json({ ok: false, error: 'not in this room' });
      state = await writeState(room, state);
      return res.status(200).json({ ok: true, state });
    }

    if (action === 'next') {
      if (state.p1?.id !== playerId && state.p2?.id !== playerId) {
        return res.status(403).json({ ok: false, error: 'not in this room' });
      }
      state.board = Array(9).fill(null);
      state.winner = null;
      state.winLine = null;
      state.round++;
      // Чергуємо хто починає (fairness)
      state.first = state.first === 'p1' ? 'p2' : 'p1';
      state.turn = state.first;
      state = await writeState(room, state);
      return res.status(200).json({ ok: true, state });
    }

    if (action === 'reset') {
      if (state.p1?.id !== playerId && state.p2?.id !== playerId) {
        return res.status(403).json({ ok: false, error: 'not in this room' });
      }
      state.board = Array(9).fill(null);
      state.turn = 'p1';
      state.first = 'p1';
      state.round = 1;
      state.score = { p1: 0, p2: 0, tie: 0 };
      state.winner = null;
      state.winLine = null;
      state = await writeState(room, state);
      return res.status(200).json({ ok: true, state });
    }

    if (action === 'leave') {
      if (state.p1?.id === playerId) state.p1 = null;
      else if (state.p2?.id === playerId) state.p2 = null;
      if (!state.p1 && !state.p2) state = emptyState();
      state = await writeState(room, state);
      return res.status(200).json({ ok: true, state });
    }

    return res.status(400).json({ ok: false, error: 'unknown action' });
  } catch (err) {
    console.error('tictactoe error:', err);
    return res.status(500).json({ ok: false, error: err.message });
  }
};
