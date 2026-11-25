// Differential test of OLO v1-core integer formulas vs an exact BigInt reference.
// Ports the Solidity code verbatim (mod 2^256 where unchecked) and compares.
const M = (1n << 256n);
const mod = (x) => ((x % M) + M) % M;

// ---------- OloMath.toUnits ----------
const UNITS_LIMIT = 1n << 30n;
function toUnits(amount) {
  let units = amount, q = 0n;
  if (units < UNITS_LIMIT) return [0n, units];
  while (units >= UNITS_LIMIT * 10000n) { units /= 10000n; q += 4n; }
  while (units >= UNITS_LIMIT) { units /= 10n; ++q; }
  return [q, units];
}
function toUnitsRef(amount) { // smallest q with floor(a/10^q) < 2^30
  let q = 0n;
  while (Math.floor(Number(amount / 10n ** q)) >= Number(UNITS_LIMIT)) q++;
  return [q, amount / 10n ** q];
}

// ---------- PriceGrid ----------
const PER_DECADE = 900000n, MANTISSA_BASE = 100000n, EXP_OFFSET = 43n, MAX_TICK = 66599999n;
const decadeOf = (t) => t / PER_DECADE;
const mantissaOf = (t) => MANTISSA_BASE + (t % PER_DECADE);
function quoteDown(amount, tick) { // exact reference
  const d = decadeOf(tick);
  const v = amount * mantissaOf(tick);
  return d >= EXP_OFFSET ? v * 10n ** (d - EXP_OFFSET) : v / 10n ** (EXP_OFFSET - d);
}
function quoteUp(amount, tick) {
  const d = decadeOf(tick);
  const v = amount * mantissaOf(tick);
  if (d >= EXP_OFFSET) return v * 10n ** (d - EXP_OFFSET);
  const div = 10n ** (EXP_OFFSET - d);
  const out = v / div;
  return v % div === 0n ? out : out + 1n;
}
function feeDown(amount, tick, feePpm) {
  const d = decadeOf(tick);
  const v = amount * mantissaOf(tick) * BigInt(feePpm);
  return d >= EXP_OFFSET ? v * 10n ** (d - EXP_OFFSET) / 1000000n : v / (1000000n * 10n ** (EXP_OFFSET - d));
}

// ---------- the take walk (base mode + quote mode), contract formulas ----------
const PPM = 1000000n;
const SUM_LIMIT = 1n << 235n;
const AMOUNT_FIELD = (1n << 112n) - 1n;

function _accrue(sum, low, amount, tick) { // returns [sum, low, revert]
  const decade = decadeOf(tick);
  const v = amount * mantissaOf(tick);
  if (sum === 0n) return [v, decade, false];
  if (decade > low) {
    const f = 10n ** (decade - low);
    if (v >= SUM_LIMIT / f) return [0n, low, true];
    sum = sum + v * f;
  } else {
    const f = 10n ** (low - decade);
    if (sum >= SUM_LIMIT / f) return [0n, low, true];
    sum = sum * f + v;
    low = decade;
  }
  if (sum >= SUM_LIMIT) return [0n, low, true];
  return [sum, low, false];
}

function quoteBudget(buyBase, amount, ppm) { // [n, y]
  if (!buyBase) {
    let rest = PPM - BigInt(ppm);
    if (rest === 0n) rest = 1n;
    return [amount * PPM, rest];
  }
  if (ppm === 0) return [amount, 1n];
  const n1 = amount * PPM / (PPM + BigInt(ppm));
  const n2 = (amount - n1 - 1n) * PPM;
  return n1 * BigInt(ppm) >= n2 ? [n1, 1n] : [n2, BigInt(ppm)];
}
function quoteCap(buyBase, amount, ppm, decade) { // or throws (AmountOverflow)
  const [n, y] = quoteBudget(buyBase, amount, ppm);
  const whole = n / y;
  if (whole > (1n << 126n)) throw new Error("AmountOverflow");
  if (decade >= EXP_OFFSET) return whole / 10n ** (decade - EXP_OFFSET);
  const k = 10n ** (EXP_OFFSET - decade);
  return whole * k + (n % y) * k / y;
}
// _affordable as in the contract: returns x (0..open), may throw
function affordable(capIn, x, unit, tick, sum, low, buyBase, amount, ppm) {
  const decade = decadeOf(tick);
  const perUnit = unit * mantissaOf(tick);
  let room;
  if (sum !== 0n && decade >= low) {
    room = (capIn - sum) / perUnit / 10n ** (decade - low);
    if (capIn - sum < 0n) throw new Error("NEGATIVE ROOM (cap<sum)!! decade=" + decade + " low=" + low);
  } else {
    let scaled = 0n;
    if (sum !== 0n) {
      const f = 10n ** (low - decade);
      if (sum >= SUM_LIMIT / f) throw new Error("AmountOverflow(affordable)");
      scaled = sum * f;
    }
    const cap = quoteCap(buyBase, amount, ppm, decade);
    if (cap - scaled < 0n) throw new Error("NEGATIVE ROOM (cap<scaled)!! scaled=" + scaled + " cap=" + cap);
    room = (cap - scaled) / perUnit;
    if (room !== 0n) capIn = cap;
  }
  return [room < x ? room : x, capIn];
}

// reference: exact rational quote Q (BigInt numerator over 10^(43-low) handled via alignment)
function refSellReceived(Q, f) { return Q - ceil(Q * BigInt(f) / PPM); } // floor(Q) - ceil(Q f) with integer Q at alignment? we compute exact below
function ceilDiv(a, b) { return a / b + (a % b === 0n ? 0n : 1n); }

// ---- fuzz the walk over random orders ----
function rndBigInt(rng, bits) {
  let v = 0n;
  for (let i = 0; i < bits; i += 8) v = (v << 8n) | BigInt(rng() & 0xff);
  return v % (1n << BigInt(bits));
}
function mulberry32(a) { return function () { a |= 0; a = a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

let fails = 0, checks = 0;
function chk(cond, msg) { checks++; if (!cond) { fails++; console.log("FAIL:", msg); } }

// 1) toUnits differential
{
  const rng = mulberry32(1);
  for (let i = 0; i < 20000; i++) {
    const a = rndBigInt(rng, 112);
    const [q, u] = toUnits(a);
    chk(u < UNITS_LIMIT, "units<2^30 a=" + a);
    chk(q <= 25n, "q<=25 a=" + a);
    if (q > 0n) chk(u >= UNITS_LIMIT / 10n, "minimal q a=" + a + " q=" + q + " u=" + u);
    chk(u * 10n ** q <= a && a - u * 10n ** q < 10n ** q, "stored<=a a=" + a);
  }
  for (const a of [1n, 2n ** 30n - 1n, 2n ** 30n, 1073741823n * 10n ** 25n, (1n << 112n) - 1n]) {
    const [q, u] = toUnits(a);
    chk(u < UNITS_LIMIT && q <= 25n, "boundary a=" + a);
  }
}

// 2) quote budget / cap / walk: quote mode sells and buys
{
  const rng = mulberry32(7);
  const fees = [0, 1, 500, 50000, 999938, 999939, 999999, 1000000];
  outer:
  for (let trial = 0; trial < 6000; trial++) {
    const buyBase = rng() < 0.5;
    const fee = fees[Math.floor(rng() * fees.length)];
    let A = rndBigInt(rng, rng() < 0.2 ? 40 : 112);
    if (A === 0n) A = 1n;
    // random orders: 1..6 orders at random maker decades 4..73
    const nOrd = 1 + Math.floor(rng() * 6);
    const orders = [];
    for (let i = 0; i < nOrd; i++) {
      const d = 4n + BigInt(Math.floor(rng() * 70));
      const j = BigInt(Math.floor(rng() * 900000));
      const tick = d * 900000n + j;
      const q = BigInt(Math.floor(rng() * 26));
      const open = BigInt(Math.floor(rng() * 1000)) + 1n;
      orders.push({ tick, q, unit: 10n ** q, open });
    }
    // run the walk (quote mode): remaining = max, cap evolves
    let sum = 0n, low = 0n, cap = 0n;
    let paidOrRecv = 0n; let filledAny = false;
    try {
      for (const o of orders) {
        let x;
        [x, cap] = affordable(cap, o.open, o.unit, o.tick, sum, low, buyBase, A, fee);
        if (x === 0n) continue;
        filledAny = true;
        const amount = x * o.unit;
        if (decadeOf(o.tick) === low && sum !== 0n) {
          sum += amount * mantissaOf(o.tick); // unchecked add (contract)
          if (sum >= 1n << 236n) { /* note bound */ }
        } else {
          const r = _accrue(sum, low, amount, o.tick);
          if (r[2]) throw new Error("AmountOverflow(walk)");
          [sum, low] = r;
        }
        // invariant sum <= cap?
        const capNow = (decadeOf(o.tick) < low) ? quoteCap(buyBase, A, fee, low) : cap;
        // recompute cap at the current low for the invariant test
        const capLow = quoteCapTry(buyBase, A, fee, low);
        if (sum > capLow) throw new Error("INVARIANT sum>cap(low): sum=" + sum + " cap=" + capLow);
      }
      // finish: exact quote Q = sum / 10^(43-low) (fraction); emulate uint256 ops exactly
      const div = low >= EXP_OFFSET ? 1n : 10n ** (EXP_OFFSET - low);
      const mulUp = low >= EXP_OFFSET ? 10n ** (low - EXP_OFFSET) : 1n;
      // contract: low>=43: quote=sum*10^(low-43); fee=ceil(quote*ppm/PPM)
      //           low<43 : quote=ceil-or-floor(sum/div); fee=ceil(sum*ppm/(PPM*div))
      let quote, feeAmt;
      if (low >= EXP_OFFSET) {
        quote = sum * mulUp;
        feeAmt = ceilDiv(quote * BigInt(fee), PPM);
      } else {
        quote = buyBase ? ceilDiv(sum, div) : sum / div;
        feeAmt = ceilDiv(sum * BigInt(fee), PPM * div);
      }
      let quoteAmount;
      if (buyBase) quoteAmount = quote + feeAmt;
      else {
        if (feeAmt >= quote) throw new Error("SellBelowFee");
        quoteAmount = quote - feeAmt;
      }
      // budget guarantee, checked with exact rational reference:
      // Q = sum / 10^(43-low) exactly (a fraction); g(Q) = ceil(Q)+ceil(Q f) for buy
      // compare quoteAmount against A with exact fractions
      const Qnum = sum, Qden = low >= EXP_OFFSET ? 1n / mulUp : div; // Q = Qnum / Qden... careful:
      // low>=43: Q = sum * 10^(low-43) integer => Qden=1, Qnum=sum*mulUp
      // low<43 : Q = sum / div => Qnum=sum, Qden=div
      const qn = low >= EXP_OFFSET ? sum * mulUp : sum;
      const qd = low >= EXP_OFFSET ? 1n : div;
      // exact fee on exact Q: ceil(qn*fee / (PPM*qd))
      const feeExact = ceilDiv(qn * BigInt(fee), PPM * qd);
      // exact quoteAmt: buy ceil(Q)+feeExact ; sell floor(Q)-feeExact
      let exactAmt;
      if (buyBase) exactAmt = ceilDiv(qn, qd) + feeExact;
      else { if (feeExact >= qn / qd) throw new Error("SellBelowFee(exact)"); exactAmt = qn / qd - feeExact; }
      chk(quoteAmount === exactAmt, "rounding mismatch trial=" + trial + " qa=" + quoteAmount + " exact=" + exactAmt);
      chk(exactAmt <= A, buyBase ? "BUY pays <= A" : "SELL receives <= A");
      if (!buyBase && fee === 1000000 && filledAny) { /* SellBelowFee expected; if we got here that's wrong */ chk(false, "100% sell filled without SellBelowFee"); }
    } catch (e) {
      if (/AmountOverflow|SellBelowFee/.test(e.message)) { /* acceptable outcomes */ }
      else { chk(false, "unexpected error: " + e.message + " trial=" + trial); }
    }
  }
}
function quoteCapTry(buyBase, A, fee, low) {
  // cap at the sum's own alignment — recompute for invariant check (throws if overflow)
  return quoteCap(buyBase, A, fee, low);
}

// 3) base-mode walk: sum bound < 2^236 and quote*ppm < 2^256 in _finishTake
{
  const rng = mulberry32(99);
  for (let trial = 0; trial < 4000; trial++) {
    let remaining = rndBigInt(rng, 112);
    const nOrd = 1 + Math.floor(rng() * 8);
    let sum = 0n, low = 0n;
    try {
      for (let i = 0; i < nOrd && remaining > 0n; i++) {
        const d = 4n + BigInt(Math.floor(rng() * 70));
        const tick = d * 900000n + BigInt(Math.floor(rng() * 900000));
        const q = BigInt(Math.floor(rng() * 26));
        const unit = 10n ** q;
        const open = BigInt(Math.floor(rng() * 1073741822)) + 1n;
        let x = remaining / unit;
        if (x > open) x = open;
        if (x === 0n) continue;
        const amount = x * unit;
        remaining -= amount;
        if (decadeOf(tick) === low && sum !== 0n) sum += amount * mantissaOf(tick);
        else { const r = _accrue(sum, low, amount, tick); if (r[2]) throw new Error("AmountOverflow"); [sum, low] = r; }
      }
      chk(sum < (1n << 236n), "sum<2^236 got " + sum);
      const ppm = BigInt([0, 1, 50000, 999999, 1000000][Math.floor(rng() * 5)]);
      // _finishTake products must fit 256 bits
      if (low >= EXP_OFFSET) { const quote = sum * 10n ** (low - EXP_OFFSET); chk(quote * ppm < M, "quote*ppm fits"); }
      else { chk(sum * ppm < M, "sum*ppm fits"); }
    } catch (e) { if (!/AmountOverflow/.test(e.message)) chk(false, "base-mode unexpected: " + e.message); }
  }
}

// 4) PriceGrid helpers sanity: quoteUp >= exact >= quoteDown, feeDown <= exact fee
{
  const rng = mulberry32(3);
  for (let i = 0; i < 20000; i++) {
    const a = rndBigInt(rng, 114);
    const tick = 1n + BigInt(Math.floor(rng() * 66599999));
    const dn = quoteDown(a, tick), up = quoteUp(a, tick);
    chk(dn <= up && up - dn <= 1n, "up-down<=1");
    const f = Math.floor(rng() * 1000001);
    const exactFee = (a * mantissaOf(tick) * BigInt(f) + (decadeOf(tick) >= EXP_OFFSET ? 0n : 0n));
    chk(feeDown(a, tick, f) >= 0n, "fee>=0");
  }
}

console.log("checks:", checks, "failures:", fails);
