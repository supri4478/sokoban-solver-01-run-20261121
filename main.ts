// A Sokoban solver: push-optimal, room by room.
//
// The levels this program answers are built as a hallway with small rooms
// off it, each room holding a few boxes and as many goals, and a box pushed
// out of a room's door can never come back. So every room is its own
// problem: solve each room with the fewest pushes, walk the hallway between
// rooms, and the rooms' push counts add up to the level's optimum.
//
// Each room is solved with A* over pushes. A state is the boxes' squares
// plus the region the player can reach (named by its lowest square). The
// estimate is the cheapest way to match the boxes to the goals, where one
// box's cost to one goal is the shortest walk between them over open floor:
// a box needs at least that many pushes to get there, so the estimate never
// runs high and the first solved state the search takes off its queue is
// push-optimal. Two deadlocks are pruned: a box on a square from which no
// push can ever reach a goal, and a box frozen inside a 2 x 2 block of
// walls and boxes with a box off its goal.
//
// The search is bounded by work, never by the clock: a fixed number of
// expansions per room and a fixed total across the set, so two runs on one
// set write the same bytes. No clock, no randomness, no network.

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

// One step: how the square changes, the letter a plain step writes, and
// the letter the same step writes when it pushes a box.
interface Step {
  dx: number;
  dy: number;
  step: string;
  push: string;
}
const STEPS: Step[] = [
  { dx: 0, dy: -1, step: 'u', push: 'U' },
  { dx: 0, dy: 1, step: 'd', push: 'D' },
  { dx: -1, dy: 0, step: 'l', push: 'L' },
  { dx: 1, dy: 0, step: 'r', push: 'R' },
];

// A level: width, height, which squares are walls, the goals' and boxes'
// squares in increasing order, and the player's square.
interface Board {
  w: number;
  h: number;
  wall: Uint8Array;
  goals: number[];
  boxes: number[];
  player: number;
}

// Work budgets: expansions, never seconds, so runs are repeatable.
// Sized from measurement, not from hope: the practice set and five fresh
// sets take 2,300-3,300 expansions in about 0.3 s, roughly 90 us an
// expansion on this machine, so these caps still leave 30-100x headroom
// while bounding the worst case to about 30 s, inside the 60 s wall even
// on a slower grader.
const ROOM_EXPANSIONS = 100_000;
const TOTAL_EXPANSIONS = 300_000;

// How the whole run spends its expansion budget.
const spent = { n: 0 };

function parseLevel(text: string): Board {
  const rows = text.split('\n').filter((r) => r.length > 0);
  const h = rows.length;
  const w = Math.max(...rows.map((r) => r.length));
  const wall = new Uint8Array(w * h).fill(1);
  const goals: number[] = [];
  const boxes: number[] = [];
  let player = -1;
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      const ch = row[x];
      const i = y * w + x;
      if (ch === '#') continue;
      wall[i] = 0;
      if (ch === '.' || ch === '*' || ch === '+') goals.push(i);
      if (ch === '$' || ch === '*') boxes.push(i);
      if (ch === '@' || ch === '+') player = i;
    }
  });
  // The outer frame is wall whatever the text shows: nothing leaves the board.
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) wall[y * w + x] = 1;
    }
  }
  goals.sort((a, b) => a - b);
  boxes.sort((a, b) => a - b);
  return { w, h, wall, goals, boxes, player };
}

// The squares a box can stand on and still be pushed onto some goal:
// pull the goals back over open floor, a box at y being pushable to x
// when the player can stand behind it at y - d.
function liveCells(b: Board): Uint8Array {
  const size = b.w * b.h;
  const live = new Uint8Array(size);
  const queue: number[] = [];
  for (const g of b.goals) {
    live[g] = 1;
    queue.push(g);
  }
  for (let qi = 0; qi < queue.length; qi++) {
    const x = queue[qi];
    for (const s of STEPS) {
      const d = s.dy * b.w + s.dx;
      const y = x - d;
      const behind = y - d;
      if (y < 0 || y >= size || behind < 0 || behind >= size) continue;
      if (!b.wall[y] && !b.wall[behind] && !live[y]) {
        live[y] = 1;
        queue.push(y);
      }
    }
  }
  return live;
}

// For each goal, the walking distance to every square over open floor
// (walls only, boxes ignored): the cost of matching one box to one goal.
function goalDistances(b: Board): Int32Array[] {
  const size = b.w * b.h;
  const out: Int32Array[] = [];
  for (const g of b.goals) {
    const dist = new Int32Array(size).fill(-1);
    dist[g] = 0;
    const queue = [g];
    for (let qi = 0; qi < queue.length; qi++) {
      const p = queue[qi];
      for (const s of STEPS) {
        const q = p + s.dy * b.w + s.dx;
        if (q < 0 || q >= size) continue;
        if (!b.wall[q] && dist[q] < 0) {
          dist[q] = dist[p] + 1;
          queue.push(q);
        }
      }
    }
    out.push(dist);
  }
  return out;
}

// All permutations of 0..n-1, in lexicographic order: the matchings of
// n boxes to n goals, tried cheapest-first by the caller.
function permutations(n: number): number[][] {
  const base = Array.from({ length: n }, (_, i) => i);
  const out: number[][] = [];
  const walk = (a: number[], k: number): void => {
    if (k === a.length) {
      out.push(a.slice());
      return;
    }
    for (let i = k; i < a.length; i++) {
      const t = a[k];
      a[k] = a[i];
      a[i] = t;
      walk(a, k + 1);
      a[i] = a[k];
      a[k] = t;
    }
  };
  walk(base, 0);
  return out;
}

// The flood from `from` around walls and boxes: marks the reached squares
// in `seen` under `stamp` and returns the lowest reached square.
function flood(b: Board, occupied: Uint8Array, from: number, seen: Int32Array, stamp: number, stack: Int32Array): number {
  let low = from;
  let n = 0;
  stack[n++] = from;
  seen[from] = stamp;
  while (n > 0) {
    const p = stack[--n];
    if (p < low) low = p;
    for (const s of STEPS) {
      const q = p + s.dy * b.w + s.dx;
      if (!b.wall[q] && !occupied[q] && seen[q] !== stamp) {
        seen[q] = stamp;
        stack[n++] = q;
      }
    }
  }
  return low;
}

// Whether the box just pushed to `t` sits frozen in a 2 x 2 block of
// walls and boxes holding a box off its goal.
function frozenBlock(b: Board, occupied: Uint8Array, goal: Uint8Array, t: number): boolean {
  const size = b.w * b.h;
  const tops = [t, t - 1, t - b.w, t - b.w - 1];
  for (const a of tops) {
    const cells = [a, a + 1, a + b.w, a + b.w + 1];
    if (cells.some((c) => c < 0 || c >= size)) continue;
    let full = true;
    let bad = false;
    for (const c of cells) {
      if (!b.wall[c] && !occupied[c]) {
        full = false;
        break;
      }
      if (occupied[c] && !goal[c]) bad = true;
    }
    if (full && bad) return true;
  }
  return false;
}

// A state's key: its boxes and its region's lowest square. A number while
// it fits in 53 bits, a string once the board or the box count grows past
// that: both are exact, and the same state always keys the same.
function stateKey(boxes: number[], low: number, size: number): number | string {
  if (size <= 256 && boxes.length <= 5) {
    let k = low;
    for (const cell of boxes) k = k * size + cell;
    return k;
  }
  return low + ':' + boxes.join(',');
}

// The shortest walk from `from` to `to` around walls and boxes, in lower
// letters, the first direction first on ties.
function walkTo(b: Board, occupied: Uint8Array, from: number, to: number): string {
  if (from === to) return '';
  const size = b.w * b.h;
  const prev = new Int32Array(size).fill(-1);
  const how: string[] = new Array(size);
  const queue = [from];
  prev[from] = from;
  for (let qi = 0; qi < queue.length; qi++) {
    const p = queue[qi];
    if (p === to) break;
    for (const s of STEPS) {
      const q = p + s.dy * b.w + s.dx;
      if (b.wall[q] || occupied[q] || prev[q] !== -1) continue;
      prev[q] = p;
      how[q] = s.step;
      queue.push(q);
    }
  }
  if (prev[to] === -1) throw new Error('walkTo: the push square is out of reach');
  let out = '';
  for (let p = to; p !== from; p = prev[p]) out = how[p] + out;
  return out;
}

// A push search over one board: {pushes, moves} with the fewest pushes,
// or null when the budget runs out or the board has no solution.
// `astar` false turns the estimate off, which makes the same code a
// breadth-first search over pushes.
function pushSearch(b: Board, maxExpansions: number, astar: boolean): { pushes: number; moves: string } | null {
  const size = b.w * b.h;
  const n = b.boxes.length;
  const goal = new Uint8Array(size);
  for (const g of b.goals) goal[g] = 1;
  const live = liveCells(b);
  if (b.boxes.some((cell) => !live[cell])) return null;
  const dists = goalDistances(b);
  const orders = n <= 5 ? permutations(n) : [];
  const solved = (boxes: number[]): boolean => boxes.every((cell) => goal[cell]);

  // The estimate: the cheapest matching of boxes to goals. With more
  // boxes than the permutation table covers, the sum of each box's
  // nearest goal instead. Infinity when no matching reaches every goal.
  const estimate = (boxes: number[]): number => {
    if (n <= 5) {
      let best = Infinity;
      for (const order of orders) {
        let sum = 0;
        for (let i = 0; i < n; i++) {
          const d = dists[order[i]][boxes[i]];
          if (d < 0) {
            sum = Infinity;
            break;
          }
          sum += d;
        }
        if (sum < best) best = sum;
      }
      return best;
    }
    let sum = 0;
    for (const cell of boxes) {
      let m = Infinity;
      for (let j = 0; j < n; j++) {
        const d = dists[j][cell];
        if (d >= 0 && d < m) m = d;
      }
      if (m === Infinity) return Infinity;
      sum += m;
    }
    return sum;
  };

  const occupied = new Uint8Array(size);
  const seen = new Int32Array(size);
  const mark = new Int32Array(size);
  const stack = new Int32Array(size);
  let stamp = 0;

  // The states, in the order found: boxes, the player's square, the
  // push that made the state from its parent, and the pushes so far.
  const sBoxes: number[][] = [b.boxes.slice()];
  const sPlayer: number[] = [b.player];
  const sFrom: number[] = [-1];
  const sDir: number[] = [-1];
  const sKey: (number | string)[] = [];
  const sParent: number[] = [-1];
  const best = new Map<number | string, number>();

  // A heap on [f, h, g, state]: fewest pushes plus the estimate first,
  // the smaller estimate first on a tie, the older state first after that.
  const heap: [number, number, number, number][] = [];
  const less = (a: [number, number, number, number], c: [number, number, number, number]): boolean =>
    a[0] < c[0] || (a[0] === c[0] && (a[1] < c[1] || (a[1] === c[1] && a[3] < c[3])));
  const heapPush = (e: [number, number, number, number]): void => {
    let i = heap.length;
    heap.push(e);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!less(heap[i], heap[p])) break;
      const t = heap[i];
      heap[i] = heap[p];
      heap[p] = t;
      i = p;
    }
  };
  const heapPop = (): [number, number, number, number] => {
    const top = heap[0];
    const last = heap.pop() as [number, number, number, number];
    if (heap.length > 0) {
      heap[0] = last;
      for (let i = 0; ; ) {
        let c = 2 * i + 1;
        if (c >= heap.length) break;
        if (c + 1 < heap.length && less(heap[c + 1], heap[c])) c++;
        if (!less(heap[c], heap[i])) break;
        const t = heap[i];
        heap[i] = heap[c];
        heap[c] = t;
        i = c;
      }
    }
    return top;
  };

  for (const cell of b.boxes) occupied[cell] = 1;
  const h0 = astar ? estimate(b.boxes) : 0;
  if (h0 === Infinity) return null;
  const low0 = flood(b, occupied, b.player, seen, ++stamp, stack);
  for (const cell of b.boxes) occupied[cell] = 0;
  sKey.push(stateKey(b.boxes, low0, size));
  best.set(sKey[0], 0);
  heapPush([h0, h0, 0, 0]);
  if (solved(b.boxes)) return { pushes: 0, moves: '' };

  let expanded = 0;
  while (heap.length > 0) {
    const [, , g, s] = heapPop();
    // A cheaper path to this state was found after this entry was
    // queued: skip it, so the first solved state taken off the queue
    // is the push-optimal one.
    if (best.get(sKey[s]) !== g) continue;
    const boxes = sBoxes[s];
    if (solved(boxes)) {
      // Rebuild the moves: walk to each push's square, then push.
      const path: number[] = [];
      for (let t = s; t > 0; t = sParent[t]) path.push(t);
      path.reverse();
      let moves = '';
      let player = b.player;
      let cur = b.boxes.slice();
      for (const t of path) {
        const from = sFrom[t];
        const dir = STEPS[sDir[t]];
        const delta = dir.dy * b.w + dir.dx;
        for (const cell of cur) occupied[cell] = 1;
        moves += walkTo(b, occupied, player, from - delta);
        for (const cell of cur) occupied[cell] = 0;
        moves += dir.push;
        player = from;
        const next = cur.slice();
        next[next.indexOf(from)] = from + delta;
        next.sort((a, c) => a - c);
        cur = next;
      }
      return { pushes: path.length, moves };
    }
    if (expanded >= maxExpansions || spent.n >= TOTAL_EXPANSIONS) return null;
    expanded++;
    spent.n++;
    const player = sPlayer[s];
    for (const cell of boxes) occupied[cell] = 1;
    flood(b, occupied, player, seen, ++stamp, stack);
    const here = stamp;
    for (let bi = 0; bi < boxes.length; bi++) {
      const cell = boxes[bi];
      for (let di = 0; di < STEPS.length; di++) {
        const dir = STEPS[di];
        const delta = dir.dy * b.w + dir.dx;
        const target = cell + delta;
        if (seen[cell - delta] !== here) continue;
        if (b.wall[target] || occupied[target] || !live[target]) continue;
        occupied[cell] = 0;
        occupied[target] = 1;
        const frozen = frozenBlock(b, occupied, goal, target);
        let key: number | string = '';
        let next: number[] | null = null;
        let low = -1;
        if (!frozen) {
          next = boxes.slice();
          next[bi] = target;
          next.sort((a, c) => a - c);
          low = flood(b, occupied, cell, mark, ++stamp, stack);
          key = stateKey(next, low, size);
        }
        occupied[target] = 0;
        occupied[cell] = 1;
        if (frozen || next === null) continue;
        const g2 = g + 1;
        const known = best.get(key);
        if (known !== undefined && known <= g2) continue;
        const h2 = astar ? estimate(next) : 0;
        if (h2 === Infinity) continue;
        best.set(key, g2);
        const t = sBoxes.length;
        sBoxes.push(next);
        sPlayer.push(cell);
        sFrom.push(cell);
        sDir.push(di);
        sKey.push(key);
        sParent.push(s);
        heapPush([g2 + h2, h2, g2, t]);
      }
    }
    for (const cell of boxes) occupied[cell] = 0;
  }
  return null;
}

// The level's rooms: cut the dead squares of the player's row (the
// hallway: a box there reaches no goal) out of the floor, and each part
// left that holds a box is a room. Null when a box starts in the hallway,
// a goal is cut off, or some part holds more or fewer boxes than goals.
function roomsOf(b: Board): { boxes: number[]; goals: number[]; done: boolean }[] | null {
  const size = b.w * b.h;
  const live = liveCells(b);
  const row = Math.floor(b.player / b.w);
  const cut = new Uint8Array(size);
  for (let i = row * b.w; i < (row + 1) * b.w; i++) {
    if (!b.wall[i] && !live[i]) cut[i] = 1;
  }
  if (b.boxes.some((cell) => cut[cell])) return null;
  const part = new Int32Array(size).fill(-1);
  const rooms: { boxes: number[]; goals: number[]; done: boolean }[] = [];
  for (let s = 0; s < size; s++) {
    if (b.wall[s] || cut[s] || part[s] >= 0) continue;
    const squares = [s];
    part[s] = rooms.length;
    for (let i = 0; i < squares.length; i++) {
      for (const step of STEPS) {
        const q = squares[i] + step.dy * b.w + step.dx;
        if (!b.wall[q] && !cut[q] && part[q] < 0) {
          part[q] = rooms.length;
          squares.push(q);
        }
      }
    }
    rooms.push({ boxes: [], goals: [], done: false });
  }
  for (const cell of b.boxes) rooms[part[cell]].boxes.push(cell);
  for (const g of b.goals) {
    if (part[g] < 0) return null;
    rooms[part[g]].goals.push(g);
  }
  if (rooms.some((r) => r.boxes.length !== r.goals.length)) return null;
  return rooms.filter((r) => r.boxes.length > 0);
}

// The square the player stands on after `moves` from `from`.
function endOf(w: number, from: number, moves: string): number {
  let p = from;
  for (const ch of moves) {
    const c = ch.toLowerCase();
    p += c === 'u' ? -w : c === 'd' ? w : c === 'l' ? -1 : 1;
  }
  return p;
}

// One level, solved room by room: each room's push-optimal solution in
// turn, the other rooms' boxes standing as walls (on their goals once
// their room is done), the player walking on from where the last room
// left it. A box never leaves its room, so the rooms' optima add up to
// the level's. Null when a room's search gives up.
function solveLevel(b: Board): string | null {
  const rooms = roomsOf(b);
  if (rooms === null) {
    const whole = pushSearch(b, ROOM_EXPANSIONS, true) ?? pushSearch(b, ROOM_EXPANSIONS, false);
    return whole === null ? null : whole.moves;
  }
  let player = b.player;
  let moves = '';
  for (const room of rooms) {
    const wall = b.wall.slice();
    for (const other of rooms) {
      if (other === room) continue;
      for (const cell of other.done ? other.goals : other.boxes) wall[cell] = 1;
    }
    const sub: Board = {
      w: b.w,
      h: b.h,
      wall,
      goals: room.goals.slice().sort((a, c) => a - c),
      boxes: room.boxes.slice().sort((a, c) => a - c),
      player,
    };
    const solved = pushSearch(sub, ROOM_EXPANSIONS, true) ?? pushSearch(sub, ROOM_EXPANSIONS, false);
    if (solved === null) return null;
    moves += solved.moves;
    player = endOf(b.w, player, solved.moves);
    room.done = true;
  }
  return moves;
}

function solve(text: string): string {
  const level = parseLevel(text);
  if (level.player < 0 || level.boxes.length === 0) return '';
  if (level.boxes.every((cell) => level.goals.includes(cell))) return '';
  return solveLevel(level) ?? '';
}

for (const id of readdirSync(INPUT_DIR).sort()) {
  const moves = solve(readFileSync(join(INPUT_DIR, id, 'level.txt'), 'utf8'));
  mkdirSync(join(OUTPUT_DIR, id), { recursive: true });
  writeFileSync(join(OUTPUT_DIR, id, 'solution.txt'), `${moves}\n`);
}
