// Vercel serverless function — /api/battleship
// Battleship (Морський Бій) спрощений: 6×6, 4 кораблі (1×3, 2×2, 1×1) = 8 cells.
//
// Phases:
//   1. setup  — кожен розставляє свій fleet (manual або random), потім "ready"
//   2. battle — обидва ready → стріляють по черзі. Hit = ще постріл, miss = swap turn.
//              Усі ворожі ship cells hit → winner
//   3. over   — підсумок раунду; "next" → новий раунд (re-setup)
//
// Actions:
//   GET  /api/battleship?room=<roomid>                  → read state (masked per playerId)
//   POST /api/battleship { action, room, playerId, ... }
//     - join         {name}                → assign slot p1 / p2 / observer
//     - randomFleet                        → server-generate fleet for me
//     - placeFleet   {ships: [{cells:[]}]} → submit my fleet (validates)
//     - ready                              → mark me ready (потребує fleet)
//     - unready                            → editing-режим назад
//     - shoot        {idx}                 → fire at opponent
//     - rename       {name}
//     - next                               → новий раунд (clear fleets, phase=setup)
//     - reset                              → full reset (score+round+...)
//     - leave
//
// State (server side):
//   p1, p2: {
//     id, name,
//     ships: [{len, cells:[idx], hits:[bool]}, ...] | null,
//     hitsOnMe: [bool × 36],   // мої cells по яким стріляли
//     ready: bool,
//   } | null
//   shots: { p1: [{idx, hit:bool}], p2: [...] }   // постріли по супернику
//   phase: 'setup' | 'battle' | 'over'
//   turn: 'p1' | 'p2'
//   first: 'p1' | 'p2'
//   round: number
//   score: { p1, p2 }
//   winner: null | 'p1' | 'p2'
//   lastShot: null | { by, idx, hit, sunk }
//   updatedAt
//
// VIEW MASKING:
//   serving p1 → hide p2.ships (тільки .hitsOnMe видно щоб рендерити влучання)
//   serving p2 → hide p1.ships
//   observer  → hide обидва

const STATE_KEY_PREFIX = 'bs:room:';
const DEFAULT_ROOM = 'default';
const STATE_TTL_SEC = 60 * 60 * 24;
const BOARD_W = 6;
const BOARD_H = 6;
const BOARD_SIZE = BOARD_W * BOARD_H; // 36
const FLEET_SPEC = [3, 2, 2, 1]; // lengths

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

function makePlayerSlot() {
  return { id: null, name: '', ships: null, hitsOnMe: Array(BOARD_SIZE).fill(false), ready: false };
}

function emptyState() {
  return {
    p1: null,
    p2: null,
    shots: { p1: [], p2: [] },
    phase: 'setup',
    turn: 'p1',
    first: 'p1',
    round: 1,
    score: { p1: 0, p2: 0 },
    winner: null,
    lastShot: null,
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

// — fleet validation —
function validateFleet(ships) {
  if (!Array.isArray(ships)) return 'ships must be array';
  const lens = ships.map(s => s.cells?.length || 0).sort((a, b) => b - a);
  const expected = [...FLEET_SPEC].sort((a, b) => b - a);
  if (JSON.stringify(lens) !== JSON.stringify(expected)) return 'wrong ship lengths';
  const all = new Set();
  for (const s of ships) {
    if (!Array.isArray(s.cells) || s.cells.length === 0) return 'invalid ship';
    for (const idx of s.cells) {
      if (!Number.isInteger(idx) || idx < 0 || idx >= BOARD_SIZE) return 'out of bounds';
      if (all.has(idx)) return 'overlap';
      all.add(idx);
    }
    if (s.cells.length > 1) {
      const cells = [...s.cells].sort((a, b) => a - b);
      const row0 = Math.floor(cells[0] / BOARD_W);
      const col0 = cells[0] % BOARD_W;
      const isHorizontal = cells.every(c => Math.floor(c / BOARD_W) === row0) &&
                           cells.every((c, i) => i === 0 || c === cells[i - 1] + 1);
      const isVertical = cells.every(c => c % BOARD_W === col0) &&
                         cells.every((c, i) => i === 0 || c === cells[i - 1] + BOARD_W);
      if (!isHorizontal && !isVertical) return 'ship not straight';
    }
  }
  return null;
}

// — random fleet generation —
function randomFleet() {
  for (let attempt = 0; attempt < 200; attempt++) {
    const occupied = new Set();
    const ships = [];
    let ok = true;
    for (const len of FLEET_SPEC) {
      let placed = false;
      for (let t = 0; t < 100; t++) {
        const horizontal = Math.random() < 0.5;
        const maxRow = horizontal ? BOARD_H : BOARD_H - len + 1;
        const maxCol = horizontal ? BOARD_W - len + 1 : BOARD_W;
        const row = Math.floor(Math.random() * maxRow);
        const col = Math.floor(Math.random() * maxCol);
        const cells = [];
        let conflict = false;
        for (let i = 0; i < len; i++) {
          const idx = horizontal ? row * BOARD_W + col + i : (row + i) * BOARD_W + col;
          if (occupied.has(idx)) { conflict = true; break; }
          cells.push(idx);
        }
        if (!conflict) {
          cells.forEach(c => occupied.add(c));
          ships.push({ len, cells, hits: cells.map(() => false) });
          placed = true;
          break;
        }
      }
      if (!placed) { ok = false; break; }
    }
    if (ok) return ships;
  }
  return null;
}

function normalizeShips(ships) {
  // Привести user-data до server-format (hits=false)
  return ships.map(s => ({
    len: s.cells.length,
    cells: [...s.cells],
    hits: s.cells.map(() => false),
  }));
}

function allShipsSunk(player) {
  if (!player.ships) return false;
  return player.ships.every(s => s.hits.every(h => h));
}

function checkSunkAtCell(player, idx) {
  // Якщо cell ідx у ship і ВСІ cells цього ship hit — повертаємо цей ship; інакше null
  for (const s of player.ships || []) {
    const pos = s.cells.indexOf(idx);
    if (pos >= 0) {
      return s.hits.every(h => h) ? s : null;
    }
  }
  return null;
}

// — view masking —
function viewFor(state, playerId) {
  const out = JSON.parse(JSON.stringify(state));
  const isP1 = out.p1?.id === playerId;
  const isP2 = out.p2?.id === playerId;
  if (isP1) {
    if (out.p2) out.p2.ships = null; // hide opponent
  } else if (isP2) {
    if (out.p1) out.p1.ships = null;
  } else {
    if (out.p1) out.p1.ships = null;
    if (out.p2) out.p2.ships = null;
  }
  return out;
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
    // playerId can come from query for GET, from body for POST
    const queryPid = (url.searchParams.get('playerId') || '').slice(0, 64);

    if (req.method === 'GET') {
      const state = await readState(room);
      return res.status(200).json({ ok: true, state: viewFor(state, queryPid) });
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
      let slot;
      if (state.p1?.id === playerId) { state.p1.name = name; slot = 'p1'; }
      else if (state.p2?.id === playerId) { state.p2.name = name; slot = 'p2'; }
      else if (!state.p1) {
        state.p1 = { ...makePlayerSlot(), id: playerId, name };
        slot = 'p1';
      } else if (!state.p2) {
        state.p2 = { ...makePlayerSlot(), id: playerId, name };
        slot = 'p2';
      } else {
        return res.status(200).json({ ok: true, state: viewFor(state, playerId), slot: 'observer' });
      }
      state = await writeState(room, state);
      return res.status(200).json({ ok: true, state: viewFor(state, playerId), slot });
    }

    // — player-only actions нижче —
    let slot = null;
    if (state.p1?.id === playerId) slot = 'p1';
    else if (state.p2?.id === playerId) slot = 'p2';
    else return res.status(403).json({ ok: false, error: 'not in this room' });

    if (action === 'randomFleet') {
      if (state.phase !== 'setup') return res.status(409).json({ ok: false, error: 'not setup phase' });
      if (state[slot].ready) return res.status(409).json({ ok: false, error: 'already ready' });
      const ships = randomFleet();
      if (!ships) return res.status(500).json({ ok: false, error: 'failed to place' });
      state[slot].ships = ships;
      state = await writeState(room, state);
      return res.status(200).json({ ok: true, state: viewFor(state, playerId), slot });
    }

    if (action === 'placeFleet') {
      if (state.phase !== 'setup') return res.status(409).json({ ok: false, error: 'not setup phase' });
      if (state[slot].ready) return res.status(409).json({ ok: false, error: 'already ready' });
      const err = validateFleet(body.ships);
      if (err) return res.status(400).json({ ok: false, error: err });
      state[slot].ships = normalizeShips(body.ships);
      state = await writeState(room, state);
      return res.status(200).json({ ok: true, state: viewFor(state, playerId), slot });
    }

    if (action === 'ready') {
      if (state.phase !== 'setup') return res.status(409).json({ ok: false, error: 'not setup phase' });
      if (!state[slot].ships) return res.status(409).json({ ok: false, error: 'place fleet first' });
      state[slot].ready = true;
      // Якщо обидва ready — phase=battle
      if (state.p1?.ready && state.p2?.ready) {
        state.phase = 'battle';
        state.turn = state.first;
      }
      state = await writeState(room, state);
      return res.status(200).json({ ok: true, state: viewFor(state, playerId), slot });
    }

    if (action === 'unready') {
      if (state.phase !== 'setup') return res.status(409).json({ ok: false, error: 'not setup phase' });
      state[slot].ready = false;
      state = await writeState(room, state);
      return res.status(200).json({ ok: true, state: viewFor(state, playerId), slot });
    }

    if (action === 'shoot') {
      if (state.phase !== 'battle') return res.status(409).json({ ok: false, error: 'not battle phase' });
      if (state.turn !== slot) return res.status(409).json({ ok: false, error: 'not your turn' });
      const idx = Number.isInteger(body.idx) ? body.idx : -1;
      if (idx < 0 || idx >= BOARD_SIZE) return res.status(400).json({ ok: false, error: 'idx out of range' });
      // Не стріляй у вже-стрілене
      if (state.shots[slot].some(s => s.idx === idx)) {
        return res.status(409).json({ ok: false, error: 'already shot there' });
      }
      const oppSlot = slot === 'p1' ? 'p2' : 'p1';
      const opp = state[oppSlot];
      let hit = false;
      let sunkShip = null;
      // Знаходимо ship at idx
      for (const s of opp.ships || []) {
        const pos = s.cells.indexOf(idx);
        if (pos >= 0) {
          hit = true;
          s.hits[pos] = true;
          if (s.hits.every(h => h)) sunkShip = s;
          break;
        }
      }
      // Mark hit на ворожому tracking
      opp.hitsOnMe[idx] = hit;
      state.shots[slot].push({ idx, hit });
      state.lastShot = { by: slot, idx, hit, sunk: !!sunkShip };
      // Win check
      if (allShipsSunk(opp)) {
        state.winner = slot;
        state.phase = 'over';
        state.score[slot]++;
      } else if (!hit) {
        // Miss → swap turn (hit → той же гравець стріляє ще раз)
        state.turn = oppSlot;
      }
      state = await writeState(room, state);
      return res.status(200).json({ ok: true, state: viewFor(state, playerId), slot, hit, sunk: !!sunkShip });
    }

    if (action === 'rename') {
      state[slot].name = sanitizeName(body.name);
      state = await writeState(room, state);
      return res.status(200).json({ ok: true, state: viewFor(state, playerId), slot });
    }

    if (action === 'next') {
      // Новий раунд: clear fleets, hits, shots, alternate first
      const keep = { p1: state.p1, p2: state.p2 };
      for (const k of ['p1', 'p2']) {
        if (keep[k]) {
          keep[k].ships = null;
          keep[k].hitsOnMe = Array(BOARD_SIZE).fill(false);
          keep[k].ready = false;
        }
      }
      state.shots = { p1: [], p2: [] };
      state.phase = 'setup';
      state.round++;
      state.first = state.first === 'p1' ? 'p2' : 'p1';
      state.turn = state.first;
      state.winner = null;
      state.lastShot = null;
      state = await writeState(room, state);
      return res.status(200).json({ ok: true, state: viewFor(state, playerId), slot });
    }

    if (action === 'reset') {
      const p1 = state.p1, p2 = state.p2;
      state = emptyState();
      if (p1) state.p1 = { ...makePlayerSlot(), id: p1.id, name: p1.name };
      if (p2) state.p2 = { ...makePlayerSlot(), id: p2.id, name: p2.name };
      state = await writeState(room, state);
      return res.status(200).json({ ok: true, state: viewFor(state, playerId), slot });
    }

    if (action === 'leave') {
      if (state.p1?.id === playerId) state.p1 = null;
      else if (state.p2?.id === playerId) state.p2 = null;
      if (!state.p1 && !state.p2) state = emptyState();
      state = await writeState(room, state);
      return res.status(200).json({ ok: true, state: viewFor(state, playerId), slot });
    }

    return res.status(400).json({ ok: false, error: 'unknown action' });
  } catch (err) {
    console.error('battleship error:', err);
    return res.status(500).json({ ok: false, error: err.message });
  }
};
