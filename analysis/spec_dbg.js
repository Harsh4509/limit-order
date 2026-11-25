// SPEC-vs-CODE differential for OLO batch slots + pool orders.
// REFERENCE: written from the IOloBook/IOloBookExt NatSpec semantics (independent structure).
// IMPL: faithful port of OloBookBatches._slotWalk/_manageBatch + OloBookOrders ops.
// Fuzz random operation sequences; compare words, cumulative flows, pot, and errors.
const PPM = 1000000n, BPS = 10000n, PER = 900000n, MB = 100000n, EO = 43n;
const dec = (t) => t / PER, mant = (t) => MB + (t % PER);
const qD = (a, t) => { const d = dec(t), v = a * mant(t); return d >= EO ? v * 10n ** (d - EO) : v / 10n ** (EO - d); };
const qU = (a, t) => { const d = dec(t), v = a * mant(t); if (d >= EO) return v * 10n ** (d - EO); const dv = 10n ** (EO - d), o = v / dv; return v % dv === 0n ? o : o + 1n; };
const fD = (a, t, f) => { const d = dec(t), v = a * mant(t) * BigInt(f); return d >= EO ? v * 10n ** (d - EO) / PPM : v / (PPM * 10n ** (EO - d)); };
const U = 1n << 30n;
const toU = (a) => { let u = a, q = 0n; if (u < U) return [0n, u]; while (u >= U * 10000n) { u /= 10000n; q += 4n; } while (u >= U) { u /= 10n; q++; } return [q, u]; };

// ================= REFERENCE (spec) =================
// State: per sub: live?, tick, q, open, side; base[i]. Simpler: arrays.
function R() {
  return {
    live: [false, false, false, false],
    tick: [0n, 0n, 0n, 0n], q: [0n, 0n, 0n, 0n], open: [0n, 0n, 0n, 0n],
    side: [0, 0, 0, 0], base: [0n, 0n, 0n, 0n],
    pot: 0n, qIn: 0n, bIn: 0n, qOut: 0n, bOut: 0n, // cumulative maker flows (in - out)
  };
}
function refSettle(s, i, c) { // spec: fills paid on its own side + open refunded; sub emptied; side cleared
  const unit = 10n ** s.q[i];
  const fills = (s.base[i] - s.open[i]) * unit;
  if (fills > 0n) {
    const fee = fD(fills, s.tick[i], c.fee);
    const mk = fee * BigInt(c.bps) / BPS; s.pot += fee - mk; s.qIn += mk;
    if (s.side[i] === 1) s.bIn += fills; else s.qIn += qD(fills, s.tick[i]);
  }
  if (s.open[i] > 0n) {
    const amt = s.open[i] * unit;
    if (s.side[i] === 1) s.qIn += qD(amt, s.tick[i]); else s.bIn += amt;
  }
  s.live[i] = false; s.side[i] = 0; // emptied; base stays stale (spec: keeps its old base)
}
function refRest(s, i, tick, amount, side, c) {
  const [q, units] = toU(amount); const stored = units * 10n ** q;
  s.live[i] = true; s.tick[i] = tick; s.q[i] = q; s.open[i] = units; s.side[i] = side; s.base[i] = units;
  if (side === 1) s.qOut += qU(stored, tick); else s.bOut += stored;
}
function refOp(s, kind, orders, sides, mask, c) {
  // orders: [ {tick, amount} x4 ]; returns error or null
  const liveAny = s.live.some(Boolean);
  if (kind === 0) { // post
    if (liveAny) return "SlotBusy";
    let any = false;
    for (let i = 0; i < 4; i++) if (orders[i].tick !== 0n || orders[i].amount !== 0n) any = true;
    if (!any) return "ZeroSize";
    for (let i = 0; i < 4; i++) {
      if (orders[i].tick === 0n && orders[i].amount === 0n) continue;
      if (!makerTick(orders[i].tick)) return "TickOutOfRange";
      const [q, u] = toU(orders[i].amount);
      if (u === 0n) return "SizeOutOfRange";
      refRest(s, i, orders[i].tick, orders[i].amount, sides[i], c);
    }
    return null;
  }
  if (kind === 1) { // replace: settle every live, rest orders as a post (slot = this version's own; may be empty)
    let any = false;
    for (let i = 0; i < 4; i++) if (orders[i].tick !== 0n || orders[i].amount !== 0n) any = true;
    if (!any) return "ZeroSize";
    for (let i = 0; i < 4; i++) if (s.live[i]) refSettle(s, i, c);
    for (let i = 0; i < 4; i++) {
      if (orders[i].tick === 0n && orders[i].amount === 0n) continue;
      if (!makerTick(orders[i].tick)) return "TickOutOfRange";
      const [q, u] = toU(orders[i].amount);
      if (u === 0n) return "SizeOutOfRange";
      refRest(s, i, orders[i].tick, orders[i].amount, sides[i], c);
    }
    return null;
  }
  if (kind === 2) { // modify: settle+rest the named; NoChange rules
    if (mask === 0) return "BadBatch";
    if (!liveAny) return "NoOrder";
    for (let i = 0; i < 4; i++) {
      if (!(mask & (1 << i))) continue;
      const o = orders[i];
      const sameZero = s.live[i] === false && o.tick === 0n && o.amount === 0n; // empty index zero order -> NoChange
      let kept = false;
      if (s.live[i]) {
        const [q2, u2] = toU(o.amount);
        const stored = u2 * 10n ** q2;
        const oldOpen = s.open[i] * 10n ** s.q[i];
        if (o.tick === s.tick[i] && stored === oldOpen && sides[i] === s.side[i] && s.base[i] === s.open[i]) kept = true; // same and no fills
      }
      if (sameZero || kept) return "NoChange";
    }
    for (let i = 0; i < 4; i++) {
      if (!(mask & (1 << i))) continue;
      const o = orders[i];
      // settle it if live (on old side)
      if (s.live[i]) {
        // "kept with fills" also passes through settle+rest with NO net escrow move
        const [q2, u2] = toU(o.amount);
        const stored = u2 * 10n ** q2;
        const oldOpen = s.open[i] * 10n ** s.q[i];
        const sameOrder = o.tick === s.tick[i] && stored === oldOpen && sides[i] === s.side[i];
        if (sameOrder) { // kept with fills: settle (pays fills+refund), rest again; net escrow zero
          const unit = 10n ** s.q[i];
          const fills = (s.base[i] - s.open[i]) * unit;
          if (fills > 0n) {
            const fee = fD(fills, s.tick[i], c.fee);
            const mk = fee * BigInt(c.bps) / BPS; s.pot += fee - mk; s.qIn += mk;
            if (s.side[i] === 1) s.bIn += fills; else s.qIn += qD(fills, s.tick[i]);
          }
          // open refund and re-escrow cancel exactly (spec: "no escrow moves for it") -> nothing
          s.base[i] = s.open[i];
          continue;
        }
        refSettle(s, i, c);
      }
      if (o.tick === 0n && o.amount === 0n) continue; // named but zero order on (now) empty index: rest nothing? (NoChange handled above)
      if (!makerTick(o.tick)) return "TickOutOfRange";
      const [q, u] = toU(o.amount);
      if (u === 0n) return "SizeOutOfRange";
      refRest(s, i, o.tick, o.amount, sides[i], c);
    }
    return null;
  }
  if (kind === 3) { // cancel named live
    if (mask === 0) return "BadBatch";
    if (!liveAny) return "NoOrder";
    let any = false;
    for (let i = 0; i < 4; i++) if ((mask & (1 << i)) && s.live[i]) any = true;
    if (!any) return "NoOrder";
    for (let i = 0; i < 4; i++) if ((mask & (1 << i)) && s.live[i]) refSettle(s, i, c);
    return null;
  }
  if (kind === 4) { // claim every sub's fills; open==0 emptied
    let any = false;
    for (let i = 0; i < 4; i++) if (s.live[i] && s.base[i] !== s.open[i]) any = true;
    if (!any) return "NothingToClaim";
    for (let i = 0; i < 4; i++) {
      if (!s.live[i] || s.base[i] === s.open[i]) continue;
      const unit = 10n ** s.q[i];
      const fills = (s.base[i] - s.open[i]) * unit;
      const fee = fD(fills, s.tick[i], c.fee);
      const mk = fee * BigInt(c.bps) / BPS; s.pot += fee - mk; s.qIn += mk;
      if (s.side[i] === 1) s.bIn += fills; else s.qIn += qD(fills, s.tick[i]);
      if (s.open[i] === 0n) { s.live[i] = false; s.side[i] = 0; } else s.base[i] = s.open[i];
    }
    return null;
  }
}
const MIN_T = 3600000n, MAX_T = 66599999n;
function makerTick(t) { return t >= MIN_T && t <= MAX_T; }

// ================= IMPL (code port of _manageBatch/_slotWalk) =================
const SUB_MASK = 0x1fffffffffffffff;
function I() { return { word: { used: true, subs: [null, null, null, null], sides: [0, 0, 0, 0] }, set: [0n, 0n, 0n, 0n], pot: 0n, qIn: 0n, bIn: 0n, qOut: 0n, bOut: 0n }; }
function implOp(st, kind, orders, sides, mask, c) {
  const w = st.word;
  let live = 0; for (let i = 0; i < 4; i++) if (w.subs[i] !== null) live |= 1 << i;
  let acted, settle = 0, rest = 0, same = false, newSides = 0, set = [0n, 0n, 0n, 0n], setLoaded = false;
  let next = { used: true, subs: [null, null, null, null], sides: [0, 0, 0, 0] }, nextSet;
  if (kind <= 1) {
    if (kind === 0 && live !== 0) return "SlotBusy";
    acted = 0;
    for (let i = 0; i < 4; i++) if (orders[i].tick !== 0n || orders[i].amount !== 0n) acted |= 1 << i;
    if (acted === 0) return "ZeroSize";
    settle = live; rest = acted;
    for (let i = 0; i < 4; i++) if (acted & (1 << i)) newSides |= (sides[i] & 1) << i;
    if (live !== 0) { set = st.set.slice(); setLoaded = true; }
    nextSet = set.slice();
  } else {
    set = st.set.slice(); setLoaded = true;
    next = { used: true, subs: w.subs.map((x) => (x ? { ...x } : null)), sides: w.sides.slice() };
    nextSet = set.slice();
    if (kind === 4) {
      acted = 0;
      for (let i = 0; i < 4; i++) { const s = w.subs[i]; if (s !== null && st.set[i] !== s.open) acted |= 1 << i; }
      if (acted === 0) return "NothingToClaim";
      settle = 0; rest = 0;
    } else {
      if (mask === 0) return "BadBatch";
      if (live === 0) return "NoOrder";
      if (kind === 3) { acted = mask & live; if (acted === 0) return "NoOrder"; settle = acted; rest = 0; }
      else { settle = mask & live; rest = mask; same = true; for (let i = 0; i < 4; i++) if (mask & (1 << i)) newSides |= (sides[i] & 1) << i; acted = mask; }
    }
  }
  // NOTE: claim handled below via claimMask
  const claim = kind === 4 ? acted : 0;
  const sums = { qIn: 0n, bIn: 0n, qOut: 0n, bOut: 0n, fee: 0n, bad: 0 };
  // pass 1
  for (let m = settle | claim; m !== 0; m &= m - 1) {
    const i = 31 - Math.clz32(m & -m);
    const old = w.subs[i];
    const tick = BigInt(old.tick), unit = 10n ** BigInt(old.q), open = old.open;
    const bid = w.sides[i] === 1;
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
  // pass 2
  for (let m = rest; m !== 0; m &= m - 1) {
    const i = 31 - Math.clz32(m & -m);
    const o = orders[i];
    const tick = o.tick, amount = o.amount;
    const [q, units] = toU(amount);
    const stored = units * 10n ** q;
    if (same) {
      const old = w.subs[i];
      const oldTick = old === null ? 0n : BigInt(old.tick);
      const oldOpen = old === null ? 0n : old.open * 10n ** BigInt(old.q);
      if (tick === oldTick && stored === oldOpen) {
        if (old === null) sums.bad |= 1;
        else if (((w.sides[i] ^ ((newSides >> i) & 1)) & 1) === 0) {
          if (nextSet[i] === old.open) sums.bad |= 1;
          else if (((newSides >> i) & 1) === 1) sums.qIn += qU(stored, tick) - qD(stored, tick);
        }
      }
    }
    if (!makerTick(tick)) sums.bad |= 2;
    else { const [, u2] = toU(amount); if (u2 === 0n) sums.bad |= 4; }
    if (((newSides >> i) & 1) === 0) sums.bOut += stored; else sums.qOut += qU(stored, tick);
    next.subs[i] = { tick: Number(tick), q: Number(q), open: units };
    nextSet[i] = units;
  }
  if (sums.bad & 1) return "NoChange";
  if (sums.bad & 2) return "TickOutOfRange";
  if (sums.bad & 4) return "SizeOutOfRange";
  // sides
  for (let i = 0; i < 4; i++) if ((settle | rest) & (1 << i)) next.sides[i] = 0;
  for (let i = 0; i < 4; i++) if (rest & (1 << i)) next.sides[i] = (newSides >> i) & 1;
  // commit + flows
  let qIn2 = sums.qIn;
  if (sums.fee !== 0n) { const mk = sums.fee * BigInt(c.bps) / BPS; st.pot += sums.fee - mk; qIn2 += mk; }
  st.qIn += qIn2; st.bIn += sums.bIn; st.qOut += sums.qOut; st.bOut += sums.bOut;
  st.word = next; st.set = nextSet;
  return null;
}

// ================= FUZZ =================
function mulberry32(a) { return function () { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
let fails = 0, n = 0;
const rng = mulberry32(31337);
for (let trial = 0; trial < 40000; trial++) {
  const c = { fee: [0, 1, 3000, 500000, 1000000][Math.floor(rng() * 5)], bps: Math.floor(rng() * 10001) };
  const REF = { s: R(), err: null }, IMPL = { s: I(), err: null };
  let steps = 2 + Math.floor(rng() * 6);
  let mismatch = null;
  while (steps-- > 0) {
    // takes: lower open of a random live sub in BOTH models identically
    const liveIdxR = [], liveIdxI = [];
    for (let i = 0; i < 4; i++) { if (REF.s.live[i]) liveIdxR.push(i); if (IMPL.s.word.subs[i] !== null) liveIdxI.push(i); }
    if (liveIdxR.length && rng() < 0.55) {
      const i = liveIdxR[Math.floor(rng() * liveIdxR.length)];
      const maxOpen = Number(REF.s.open[i]);
      const x = 1n + BigInt(Math.floor(rng() * maxOpen));
      REF.s.open[i] -= x; IMPL.s.word.subs[i].open -= x;
    }
    const orders = [];
    for (let i = 0; i < 4; i++) {
      if (rng() < 0.45) orders.push({ tick: 0n, amount: 0n });
      else {
        const t = rng() < 0.8 ? (3600000n + BigInt(Math.floor(rng() * 63000000))) : BigInt(Math.floor(rng() * 66599999)); // sometimes invalid
        orders.push({ tick: t, amount: BigInt(1 + Math.floor(rng() * 2 ** 28)) });
      }
    }
    const sides = [rng() < 0.5 ? 1 : 0, rng() < 0.5 ? 1 : 0, rng() < 0.5 ? 1 : 0, rng() < 0.5 ? 1 : 0];
    const kind = Math.floor(rng() * 5);
    const mask = 1 + Math.floor(rng() * 15);
if (trial === 23 || trial === 4 || trial === 7)
      console.log("T" + trial, "kind", kind, "mask", mask, "sides", sides.join(""),
        "orders", orders.map((o) => o.tick.toString() + ":" + o.amount.toString()).join(" "),
        "| liveR", REF.s.live.map((l, i) => l ? REF.s.tick[i].toString() + "/" + REF.s.open[i].toString() + "q" + REF.s.q[i].toString() + "D" + REF.s.side[i] + "b" + REF.s.base[i].toString() : ".").join(","),
        "| qIn", REF.s.qIn.toString(), "qOut", REF.s.qOut.toString());
        const eR = refOp(REF.s, kind, orders, sides, mask, c);
    const eI = implOp(IMPL.s, kind, orders, sides, mask, c);
    n++;
    if (eR !== eI) { mismatch = `error mismatch kind=${kind} ref=${eR} impl=${eI} orders=${JSON.stringify(orders.map(o => [o.tick.toString(), o.amount.toString()]))} sides=${sides} mask=${mask}`; break; }
    if (eR === null) {
      // compare states
      for (let i = 0; i < 4; i++) {
        const rl = REF.s.live[i], il = IMPL.s.word.subs[i] !== null;
        if (rl !== il) { mismatch = `live[${i}] ref=${rl} impl=${il}`; break; }
        if (rl) {
          if (REF.s.tick[i] !== BigInt(IMPL.s.word.subs[i].tick) || REF.s.q[i] !== BigInt(IMPL.s.word.subs[i].q) || REF.s.open[i] !== IMPL.s.word.subs[i].open) { mismatch = `sub[${i}] state`; break; }
          if (REF.s.side[i] !== IMPL.s.word.sides[i]) { mismatch = `side[${i}] ref=${REF.s.side[i]} impl=${IMPL.s.word.sides[i]}`; break; }
        }
        if (REF.s.base[i] !== IMPL.s.set[i]) { mismatch = `base[${i}] ref=${REF.s.base[i]} impl=${IMPL.s.set[i]}`; break; }
      }
      if (mismatch) break;
      if (REF.s.pot !== IMPL.s.pot) { mismatch = `pot ref=${REF.s.pot} impl=${IMPL.s.pot}`; break; }
      if (REF.s.qIn !== IMPL.s.qIn || REF.s.bIn !== IMPL.s.bIn || REF.s.qOut !== IMPL.s.qOut || REF.s.bOut !== IMPL.s.bOut) { mismatch = `flows ref=(${REF.s.qIn},${REF.s.bIn},${REF.s.qOut},${REF.s.bOut}) impl=(${IMPL.s.qIn},${IMPL.s.bIn},${IMPL.s.qOut},${IMPL.s.bOut})`; break; }
    } else {
      // error -> both models unchanged? (impl mutates st only at the end; ref may have mutated mid-op!)
      // REF must be rolled back on error to mirror the contract's revert. Track a snapshot:
      // (handled below by comparing that impl unchanged; ref may be dirty -> so on error we RESYNC ref from impl)
      resync(REF.s, IMPL.s);
    }
  }
  if (mismatch) { fails++; console.log("FAIL trial", trial, ":", mismatch); if (fails > 5) break; }
}
// resync: after a shared error, both models must be in the same state; rebuild ref's internals from impl's
function resync(r, i) {
  for (let k = 0; k < 4; k++) {
    const s = i.word.subs[k];
    r.live[k] = s !== null;
    if (s) { r.tick[k] = BigInt(s.tick); r.q[k] = BigInt(s.q); r.open[k] = s.open; r.side[k] = i.word.sides[k]; }
    else { r.tick[k] = 0n; r.q[k] = 0n; r.open[k] = 0n; r.side[k] = 0; }
    r.base[k] = i.set[k];
  }
}
console.log("ops compared:", n, "mismatching trials:", fails);
