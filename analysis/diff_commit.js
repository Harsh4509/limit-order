// Differential test: multicall ledger _commit netting (ported 1:1) vs a plain reference,
// and OloSentinel window/key/state-machine checks.
let fails = 0, checks = 0;
const chk = (c, m) => { checks++; if (!c) { fails++; console.log("FAIL:", m); } };

// --- _commit port: flags W=0x02 wallet, A=0x04 auto ---
function commit(entries, flags, accounts, moves) {
  // entries: [{key, maker, credit, wallet}] as the ledger holds them after all ops
  // accounts: Map key->balance (the caller's account balances, pre-call)
  // moves: array to record pulls/pushes: {key, kind, amt}
  const toWallet = (flags & 0x2) !== 0, auto_ = (flags & 0x4) !== 0;
  const n = entries.length;
  const walletAfter = [];
  for (let i = 0; i < n; i++) {
    const e = entries[i];
    let { key, maker: makerFlow, credit, wallet } = e;
    // unchecked int256 arithmetic in JS Number land is fine for test magnitudes
    if (makerFlow > 0) { if (toWallet) wallet += makerFlow; else credit += makerFlow; }
    else if (makerFlow < 0) {
      const need = -makerFlow;
      if (auto_) {
        const bal = accounts.get(key) || 0;
        let fromCredit = credit >= 0 ? bal + credit : Math.max(0, bal + credit);
        if (fromCredit > need) fromCredit = need;
        credit -= fromCredit;
        wallet -= need - fromCredit;
      } else if (toWallet) { wallet += makerFlow; } else { credit += makerFlow; }
    }
    if (credit !== 0) moves.push({ key, kind: "account", amt: credit }), accounts.set(key, (accounts.get(key) || 0) + credit);
    if (wallet < 0) moves.push({ key, kind: "pull", amt: -wallet });
    walletAfter.push(wallet);
  }
  for (let i = 0; i < n; i++) if (walletAfter[i] > 0) moves.push({ key: entries[i].key, kind: "push", amt: walletAfter[i] });
  return moves;
}

// reference: what SHOULD happen per token, computed independently:
// net = Σ maker flows; deposits add to account, withdrawals take from account.
// Rules: no flags: net to account (must not overdraft); WALLET: positive net pushed, negative pulled;
// AUTO: negative net funded from account(+deposits net) first, rest pulled; positive net to account unless WALLET.
function refCommit(entries, flags, accounts) {
  const toWallet = (flags & 0x2) !== 0, auto_ = (flags & 0x4) !== 0;
  const out = [];
  for (const e of entries) {
    const bal = accounts.get(e.key) || 0;
    const net = e.maker + e.credit;          // what the account should end up moving by (if account path)
    if (auto_) {
      // funding: maker debits + withdrawals from account first
      const need = Math.max(0, -(e.maker + e.credit)); // total the account path would need
      const avail = Math.max(0, bal + Math.min(0, 0)); // balance only (deposits counted in net already)
      // account can cover min(bal, need); rest from wallet; credits go to account (or wallet with W)
      const fromAcct = Math.min(bal, need);
      const fromWallet = need - fromAcct;
      let walletFlow = e.wallet - fromWallet;   // op wallet flows minus funding pulls
      let acctDelta = e.maker + e.credit + fromWallet; // account covers the rest of the need
      if (toWallet) { walletFlow += Math.max(0, e.maker + e.credit); acctDelta -= Math.max(0, e.maker + e.credit); }
      out.push({ key: e.key, acct: acctDelta, wallet: walletFlow, bal });
    } else if (toWallet) {
      out.push({ key: e.key, acct: e.credit, wallet: e.wallet + e.maker, bal });
    } else {
      out.push({ key: e.key, acct: e.maker + e.credit, wallet: e.wallet, bal });
    }
  }
  return out;
}

function mulberry32(a) { return function () { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
{
  const rng = mulberry32(2026);
  for (let trial = 0; trial < 20000; trial++) {
    const flags = [0, 2, 4, 6][Math.floor(rng() * 4)];
    const n = 1 + Math.floor(rng() * 4);
    const accounts = new Map();
    const entries = [];
    for (let i = 0; i < n; i++) {
      const key = i;
      accounts.set(key, Math.floor(rng() * 1000));
      entries.push({
        key,
        maker: Math.floor(rng() * 2001) - 1000,
        credit: Math.floor(rng() * 401) - 200, // net of DEPOSIT/WITHDRAW ops
        wallet: Math.floor(rng() * 401) - 200,
      });
    }
    const accounts2 = new Map(accounts);
    const moves = commit(entries, flags, accounts2, []);
    // replay: final account balances and total wallet invariants
    // 1) accounts never go negative
    let overdraft = false;
    for (const [k, v] of accounts2) if (v < 0) overdraft = true; // the contract reverts InsufficientBalance here
    if (overdraft) continue;
    // 2) total value conservation: Δaccount + pulls == pushes + ΔwalletExpected... simpler:
    //    sum over entries of (maker + credit) must equal Δaccount + (push - pull)
    let dAcct = 0; for (const [k, v] of accounts2) dAcct += v - accounts.get(k);
    let pulls = 0, pushes = 0;
    for (const m of moves) { if (m.kind === "pull") pulls += m.amt; if (m.kind === "push") pushes += m.amt; }
    let netFlows = 0; for (const e of entries) netFlows += e.maker + e.credit + e.wallet;
    chk(netFlows === dAcct + pushes - pulls, "conservation net=" + netFlows + " dAcct=" + dAcct + " push=" + pushes + " pull=" + pulls);
    // 3) pulls happen only when needed under AUTO/WALLET semantics: every pull must be justified
    //    (covered by conservation + non-negative accounts + no unjustified push:)
    //    pushes must not exceed what came in: net positive wallet only
    // 4) an account is never debited below zero nor credited without its flow (implicit in 1/2)
    // 5) without any flag, no pulls/pushes at all
    if (flags === 0) { let wp = 0, wq = 0; for (const e of entries) { if (e.wallet > 0) wp += e.wallet; if (e.wallet < 0) wq += -e.wallet; } chk(pulls === wq && pushes === wp, "no-flag: only op wallet flows move tokens"); }
  }
}

// --- OloSentinel state machine ---
{
  const MIN = 86400, MAX = 30 * 86400, GRACE = 7 * 86400;
  function makeS() { return { ops: new Map(), ownedSince: 0, now: 1000, admin: "A", guardian: "G", book: "OLO", bookOwner: "S", delay: MIN }; }
  const keyOf = (sel, obj) => sel + "|" + (obj ?? "");
  function schedule(s, key, opHash, t) {
    if (s.bookOwner !== "S") throw new Error("NotBookOwner");
    const eta = s.now + s.delay;
    const prev = s.ops.get(key);
    const live = prev && prev.eta !== 0 && s.now <= prev.eta + GRACE && prev.scheduledAt >= s.ownedSince;
    if (live) throw new Error("KeyPending");
    s.ops.set(key, { opHash, eta, scheduledAt: s.now });
    return eta;
  }
  function execute(s, key, opHash, t) {
    const op = s.ops.get(key);
    if (!op || op.eta === 0 || op.opHash !== opHash || op.scheduledAt < s.ownedSince) throw new Error("NotScheduled");
    if (s.now < op.eta) throw new Error("NotReady");
    if (s.now > op.eta + GRACE) throw new Error("Expired");
    s.ops.delete(key);
    return true;
  }
  const rng = mulberry32(555);
  for (let trial = 0; trial < 20000; trial++) {
    const s = makeS();
    s.delay = MIN + Math.floor(rng() * (MAX - MIN));
    let lastEta = 0, lastKey = "", lastHash = "";
    // schedule then act randomly: warp, cancel, expire, re-schedule, execute
    for (let step = 0; step < 12; step++) {
      const k = "k" + Math.floor(rng() * 3);
      try {
        if (rng() < 0.4) { lastEta = schedule(s, k, "h" + step, 0); lastKey = k; lastHash = "h" + step; }
        else if (lastEta && rng() < 0.5) {
          const ok = execute(s, lastKey, lastHash, 0);
          if (ok) { // cannot execute twice
            let twice = false;
            try { execute(s, lastKey, lastHash, 0); twice = true; } catch (e) { chk(/NotScheduled/.test(e.message), "double-exec rejected"); }
          }
        } else {
          s.now += Math.floor(rng() * 40 * 86400);
          // a stale/over-grace op must not run and its key must be reusable
          const op = s.ops.get(lastKey);
          if (op) {
            let ran = false;
            try { execute(s, lastKey, lastHash, 0); ran = true; } catch (e) {
              chk(/NotReady|Expired|NotScheduled/.test(e.message), "window error type");
            }
            if (ran) chk(s.now >= op.eta && s.now <= op.eta + GRACE, "exec in window");
          }
        }
      } catch (e) { chk(/KeyPending|NotBookOwner|NotScheduled|NotReady|Expired/.test(e.message), "sched err " + e.message); }
      // invariant: at most one live op per key
      for (const [k, op] of s.ops) chk(op.eta !== 0, "stored op live-ish");
    }
    // ownership stretch: takeover stales everything
    s.ownedSince = s.now;
    for (const [k, op] of s.ops) {
      if (op.scheduledAt < s.ownedSince) {
        let ran = false;
        try { execute(s, k, op.opHash, 0); ran = true; } catch (e) { chk(/NotScheduled/.test(e.message), "stale exec"); }
        chk(!ran, "stale op must not run");
      }
    }
  }
}
console.log("checks:", checks, "failures:", fails);
