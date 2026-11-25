// SPEC-vs-CODE differential v2 (clean). Reference = NatSpec semantics; Impl = contract port.
const PPM = 1000000n, BPS = 10000n, PER = 900000n, MB = 100000n, EO = 43n;
const dec = (t) => t / PER, mant = (t) => MB + (t % PER);
const qD = (a, t) => { const d = dec(t), v = a * mant(t); return d >= EO ? v * 10n ** (d - EO) : v / 10n ** (EO - d); };
const qU = (a, t) => { const d = dec(t), v = a * mant(t); if (d >= EO) return v * 10n ** (d - EO); const dv = 10n ** (EO - d), o = v / dv; return v % dv === 0n ? o : o + 1n; };
const fD = (a, t, f) => { const d = dec(t), v = a * mant(t) * BigInt(f); return d >= EO ? v * 10n ** (d - EO) / PPM : v / (PPM * 10n ** (EO - d)); };
const U = 1n << 30n;
const toU = (a) => { let u = a, q = 0n; if (u < U) return [0n, u]; while (u >= U * 10000n) { u /= 10000n; q += 4n; } while (u >= U) { u /= 10n; q++; } return [q, u]; };
const MIN_T = 3600000n, MAX_T = 66599999n;
const makerTick = (t) => t >= MIN_T && t <= MAX_T;

// ---------- SPEC REFERENCE ----------
function newRef() {
  return { live: [0, 0, 0, 0], tick: [0n, 0n, 0n, 0n], q: [0n, 0n, 0n, 0n], open: [0n, 0n, 0n, 0n], side: [0, 0, 0, 0], base: [0n, 0n, 0n, 0n], pot: 0n, qIn: 0n, bIn: 0n, qOut: 0n, bOut: 0n, opFee: 0n };
}
function refPayFills(s, i, c) { // pays fills on the sub's own side; fee accumulates to opFee
  const unit = 10n ** s.q[i];
  const fills = (s.base[i] - s.open[i]) * unit;
  if (fills > 0n) {
    s.opFee += fD(fills, s.tick[i], c.fee);
    if (s.side[i] === 1) s.bIn += fills; else s.qIn += qD(fills, s.tick[i]);
  }
}
function refSettle(s, i, c) { // settle: fills + open refund, emptied, side cleared, base stale
  refPayFills(s, i, c);
  if (s.open[i] > 0n) {
    const amt = s.open[i] * 10n ** s.q[i];
    if (s.side[i] === 1) s.qIn += qD(amt, s.tick[i]); else s.bIn += amt;
  }
  s.live[i] = 0; s.side[i] = 0;
}
function refRest(s, i, tick, amount, side) {
  const [q, units] = toU(amount); const stored = units * 10n ** q;
  s.live[i] = 1; s.tick[i] = tick; s.q[i] = q; s.open[i] = units; s.side[i] = side; s.base[i] = units;
  if (side === 1) s.qOut += qU(stored, tick); else s.bOut += stored;
}
function splitOnce(s, c) { if (s.opFee !== 0n) { const mk = s.opFee * BigInt(c.bps) / BPS; s.pot += s.opFee - mk; s.qIn += mk; s.opFee = 0n; } }
function refOp(s, kind, orders, sides, mask, c) {
  const liveAny = s.live.some(Boolean);
  const isOrder = (o) => o.tick !== 0n || o.amount !== 0n;
  if (kind === 0) { // post
    if (liveAny) return "SlotBusy";
    if (!orders.some(isOrder)) return "ZeroSize";
    for (let i = 0; i < 4; i++) {
      if (!isOrder(orders[i])) continue;
      if (!makerTick(orders[i].tick)) return "TickOutOfRange";
      if (toU(orders[i].amount)[1] === 0n) return "SizeOutOfRange";
    }
    for (let i = 0; i < 4; i++) if (isOrder(orders[i])) refRest(s, i, orders[i].tick, orders[i].amount, sides[i]);
    splitOnce(s, c); return null;
  }
  if (kind === 1) { // replace: settle every live; rest orders as a post (bases of unrested zeroed — dead state)
    if (!orders.some(isOrder)) return "ZeroSize";
    for (let i = 0; i < 4; i++) if (!makerTick(orders[i].tick) && isOrder(orders[i])) return "TickOutOfRange";
    for (let i = 0; i < 4; i++) if (isOrder(orders[i]) && toU(orders[i].amount)[1] === 0n) return "SizeOutOfRange";
    for (let i = 0; i < 4; i++) if (s.live[i]) refSettle(s, i, c);
    for (let i = 0; i < 4; i++) { if (!isOrder(orders[i])) { s.base[i] = 0n; continue; } refRest(s, i, orders[i].tick, orders[i].amount, sides[i]); }
    splitOnce(s, c); return null;
  }
  if (kind === 2) { // modify
    if (mask === 0) return "BadBatch";
    if (!liveAny) return "NoOrder";
    let badSame = false, badTick = false, badSize = false;
    for (let i = 0; i < 4; i++) {
      if (!(mask & (1 << i))) continue;
      const o = orders[i];
      if (!s.live[i] && !isOrder(o)) { badSame = true; continue; } // empty index's zero order
      if (s.live[i] && !isOrder(o)) { badTick = true; continue; } // S157: zero order on a live sub
      if (s.live[i]) {
        const [q2, u2] = toU(o.amount);
        const stored = u2 * 10n ** q2;
        const oldOpen = s.open[i] * 10n ** s.q[i];
        if (o.tick === s.tick[i] && stored === oldOpen && sides[i] === s.side[i] && s.base[i] === s.open[i]) { badSame = true; continue; } // same, no fills
      }
      if (isOrder(o) && !makerTick(o.tick)) { badTick = true; continue; }
      if (isOrder(o) && toU(o.amount)[1] === 0n) { badSize = true; continue; }
    }
    if (badSame) return "NoChange";
    if (badTick) return "TickOutOfRange";
    if (badSize) return "SizeOutOfRange";
    for (let i = 0; i < 4; i++) {
      if (!(mask & (1 << i))) continue;
      const o = orders[i];
      if (s.live[i]) {
        const [q2, u2] = toU(o.amount);
        const stored = u2 * 10n ** q2;
        const oldOpen = s.open[i] * 10n ** s.q[i];
        if (o.tick === s.tick[i] && stored === oldOpen && sides[i] === s.side[i]) {
          // kept (with fills): pays fills, rests on, no escrow moves
          refPayFills(s, i, c);
          s.base[i] = s.open[i];
          continue;
        }
        refSettle(s, i, c);
      }
      if (!isOrder(o)) continue;
      refRest(s, i, o.tick, o.amount, sides[i]);
    }
    splitOnce(s, c); return null;
  }
  if (kind === 3) { // cancel named live
    if (mask === 0) return "BadBatch";
    if (!liveAny) return "NoOrder";
    let any = false;
    for (let i = 0; i < 4; i++) if ((mask & (1 << i)) && s.live[i]) any = true;
    if (!any) return "NoOrder";
    for (let i = 0; i < 4; i++) if ((mask & (1 << i)) && s.live[i]) refSettle(s, i, c);
    splitOnce(s, c); return null;
  }
  if (kind === 4) { // claim
    let any = false;
    for (let i = 0; i < 4; i++) if (s.live[i] && s.base[i] !== s.open[i]) any = true;
    if (!any) return "NothingToClaim";
    for (let i = 0; i < 4; i++) {
      if (!s.live[i] || s.base[i] === s.open[i]) continue;
      refPayFills(s, i, c);
      if (s.open[i] === 0n) { s.live[i] = 0; s.side[i] = 0; } else s.base[i] = s.open[i];
    }
    splitOnce(s, c); return null;
  }
}

// ---------- IMPL (contract port) ----------
function newImpl() { return { subs: [null, null, null, null], sides: [0, 0, 0, 0], set: [0n, 0n, 0n, 0n], pot: 0n, qIn: 0n, bIn: 0n, qOut: 0n, bOut: 0n }; }
function implOp(st, kind, orders, sides, mask, c) {
  const w = { subs: st.subs.map((x) => (x ? { ...x } : null)), sides: st.sides.slice() };
  let live = 0; for (let i = 0; i < 4; i++) if (st.subs[i] !== null) live |= 1 << i;
  let acted, settle = 0, rest = 0, same = false, newSides = 0;
  let set = [0n, 0n, 0n, 0n];
  let next = { subs: [null, null, null, null], sides: [0, 0, 0, 0] }, nextSet;
  const isOrder = (o) => o.tick !== 0n || o.amount !== 0n;
  if (kind <= 1) {
    if (kind === 0 && live !== 0) return "SlotBusy";
    acted = 0;
    for (let i = 0; i < 4; i++) if (isOrder(orders[i])) acted |= 1 << i;
    if (acted === 0) return "ZeroSize";
    settle = live; rest = acted;
    for (let i = 0; i < 4; i++) if (acted & (1 << i)) newSides |= (sides[i] & 1) << i;
    if (live !== 0) set = st.set.slice();
    nextSet = set.slice();
  } else {
    set = st.set.slice();
    next = { subs: w.subs.map((x) => (x ? { ...x } : null)), sides: w.sides.slice() };
    nextSet = set.slice();
    if (kind === 4) {
      acted = 0;
      for (let i = 0; i < 4; i++) { const s = st.subs[i]; if (s !== null && st.set[i] !== s.open) acted |= 1 << i; }
      if (acted === 0) return "NothingToClaim";
    } else {
      if (mask === 0) return "BadBatch";
      if (live === 0) return "NoOrder";
      if (kind === 3) { acted = mask & live; if (acted === 0) return "NoOrder"; settle = acted; }
      else { settle = mask & live; rest = mask; same = true; for (let i = 0; i < 4; i++) if (mask & (1 << i)) newSides |= (sides[i] & 1) << i; acted = mask; }
    }
  }
  const claim = kind === 4 ? acted : 0;
  const sums = { qIn: 0n, bIn: 0n, qOut: 0n, bOut: 0n, fee: 0n, bad: 0 };
  for (let m = settle | claim; m !== 0; m &= m - 1) {
    const i = 31 - Math.clz32(m & -m);
    const old = st.subs[i];
    const tick = BigInt(old.tick), unit = 10n ** BigInt(old.q), open = old.open;
    const bid = st.sides[i] === 1;
    const fills = (set[i] - open) * unit;
    if (fills !== 0n) {
      sums.fee += fD(fills, tick, c.fee);
      if (!bid) sums.qIn += qD(fills, tick); else sums.bIn += fills;
    }
    if ((settle >> i) & 1) {
      if (open !== 0n) { const oa = open * unit; if (!bid) sums.bIn += oa; else sums.qIn += qD(oa, tick); }
      next.subs[i] = null;
    } else if (open === 0n) { next.subs[i] = null; next.sides[i] = 0; }
    else nextSet[i] = open;
  }
  for (let m = rest; m !== 0; m &= m - 1) {
    const i = 31 - Math.clz32(m & -m);
    const o = orders[i];
    const [q, units] = toU(o.amount);
    const stored = units * 10n ** q;
    if (same) {
      const old = st.subs[i];
      const oldTick = old === null ? 0n : BigInt(old.tick);
      const oldOpen = old === null ? 0n : old.open * 10n ** BigInt(old.q);
      if (o.tick === oldTick && stored === oldOpen) {
        if (old === null) sums.bad |= 1;
        else if (((st.sides[i] ^ ((newSides >> i) & 1)) & 1) === 0) {
          if (nextSet[i] === old.open) sums.bad |= 1;
          else if (((newSides >> i) & 1) === 1) sums.qIn += qU(stored, o.tick) - qD(stored, o.tick);
        }
      }
    }
    if (!makerTick(o.tick)) sums.bad |= 2;
    else if (toU(o.amount)[1] === 0n) sums.bad |= 4;
    if (((newSides >> i) & 1) === 0) sums.bOut += stored; else sums.qOut += qU(stored, o.tick);
    next.subs[i] = { tick: Number(o.tick), q: Number(q), open: units };
    nextSet[i] = units;
  }
  if (sums.bad & 1) return "NoChange";
  if (sums.bad & 2) return "TickOutOfRange";
  if (sums.bad & 4) return "SizeOutOfRange";
  for (let i = 0; i < 4; i++) if ((settle | rest) & (1 << i)) next.sides[i] = 0;
  for (let i = 0; i < 4; i++) if (rest & (1 << i)) next.sides[i] = (newSides >> i) & 1;
  let qIn2 = sums.qIn;
  if (sums.fee !== 0n) { const mk = sums.fee * BigInt(c.bps) / BPS; st.pot += sums.fee - mk; qIn2 += mk; }
  st.qIn += qIn2; st.bIn += sums.bIn; st.qOut += sums.qOut; st.bOut += sums.bOut;
  st.subs = next.subs; st.sides = next.sides; st.set = nextSet;
  return null;
}

// ---------- FUZZ ----------
function mulberry32(a) { return function () { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const rng = mulberry32(7777);
let fails = 0, ops = 0;
for (let trial = 0; trial < 60000; trial++) {
  const c = { fee: [0, 1, 3000, 500000, 1000000][Math.floor(rng() * 5)], bps: Math.floor(rng() * 10001) };
  const ref = newRef(), imp = newImpl();
  let steps = 2 + Math.floor(rng() * 7);
  let mismatch = null;
  while (steps-- > 0) {
    const liveIdx = [];
    for (let i = 0; i < 4; i++) if (ref.live[i]) liveIdx.push(i);
    if (liveIdx.length && rng() < 0.55) {
      const i = liveIdx[Math.floor(rng() * liveIdx.length)];
      const x = 1n + BigInt(Math.floor(rng() * Number(ref.open[i])));
      ref.open[i] -= x; imp.subs[i].open -= x;
    }
    const orders = [];
    for (let i = 0; i < 4; i++) {
      if (rng() < 0.45) orders.push({ tick: 0n, amount: 0n });
      else {
        const t = rng() < 0.85 ? (MIN_T + BigInt(Math.floor(rng() * Number(MAX_T - MIN_T)))) : BigInt(Math.floor(rng() * 66599999));
        orders.push({ tick: t, amount: BigInt(1 + Math.floor(rng() * 2 ** 28)) });
      }
    }
    const sides = [rng() < 0.5 ? 1 : 0, rng() < 0.5 ? 1 : 0, rng() < 0.5 ? 1 : 0, rng() < 0.5 ? 1 : 0];
    const kind = Math.floor(rng() * 5);
    const mask = 1 + Math.floor(rng() * 15);
    const snapR = JSON.stringify(ref, (k, v) => (typeof v === "bigint" ? v.toString() + "n" : v));
    const snapI = JSON.stringify(imp, (k, v) => (typeof v === "bigint" ? v.toString() + "n" : v));
    const eR = refOp(ref, kind, orders, sides, mask, c);
    const eI = implOp(imp, kind, orders, sides, mask, c);
    ops++;
    const restore = (st, snap) => { const o = JSON.parse(snap); for (const k in o) { const v = o[k]; st[k] = Array.isArray(v) ? v.map((x) => (typeof x === "string" && x.endsWith("n") ? BigInt(x.slice(0, -1)) : typeof x === "object" && x !== null ? Object.fromEntries(Object.entries(x).map(([kk, vv]) => [kk, typeof vv === "string" && vv.endsWith("n") ? BigInt(vv.slice(0, -1)) : vv])) : x)) : typeof v === "string" && v.endsWith("n") ? BigInt(v.slice(0, -1)) : v; } };
    if (eR !== eI) { mismatch = `error kind=${kind} mask=${mask} sides=${sides.join("")} ref=${eR} impl=${eI} orders=${orders.map((o) => o.tick.toString() + ":" + o.amount.toString()).join(" ")}`; break; }
    if (eR !== null) { restore(ref, snapR); restore(imp, snapI); continue; }
    for (let i = 0; i < 4; i++) {
      const rl = ref.live[i] === 1, il = imp.subs[i] !== null;
      if (rl !== il) { mismatch = `live[${i}] kind=${kind} ref=${rl} impl=${il}`; break; }
      if (rl) {
        if (ref.tick[i] !== BigInt(imp.subs[i].tick) || ref.q[i] !== BigInt(imp.subs[i].q) || ref.open[i] !== imp.subs[i].open) { mismatch = `sub[${i}] kind=${kind}`; break; }
        if (ref.side[i] !== imp.sides[i]) { mismatch = `side[${i}] kind=${kind} ref=${ref.side[i]} impl=${imp.sides[i]}`; break; }
        if (ref.base[i] !== imp.set[i]) { mismatch = `base[${i}] kind=${kind} ref=${ref.base[i]} impl=${imp.set[i]}`; break; }
      }
    }
    if (!mismatch && (ref.pot !== imp.pot || ref.qIn !== imp.qIn || ref.bIn !== imp.bIn || ref.qOut !== imp.qOut || ref.bOut !== imp.bOut)) {
      mismatch = `flows kind=${kind} ref=(${ref.qIn},${ref.bIn},${ref.qOut},${ref.bOut},pot ${ref.pot}) impl=(${imp.qIn},${imp.bIn},${imp.qOut},${imp.bOut},pot ${imp.pot})`;
    }
    if (mismatch) break;
  }
  if (mismatch) { fails++; console.log("FAIL trial", trial, mismatch); if (fails > 6) break; }
}
console.log("ops compared:", ops, "mismatching trials:", fails);
