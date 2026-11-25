# OLO v1-core (limitorder-org) — Full Audit Report

Contest: Sherlock-style engagement on `limitorder-org/v1-core` @ `0f7ab6a`
Scope: all 26 files under `src/` and `sentinel/` (2,700 nSLOC). Everything else (`test/`, `docs/`, `lib/`) is context.

---

## 1. What was done (methodology)

1. **Rules & scope first.** Read `context/` fully: judging guidelines, severity set, dedup rules, scope rule,
   the 42-page context doc, and all 212 statements in `statements.json` (extracted levels: decisive vs leans-accepted,
   per dimension: true-finding / scope / known / severity). The `known{decisive}` statements define what is already
   disclosed.
2. **Every in-scope file read completely**, in dependency order: `OloTypes`, `types/Market`, `OloMath`, `PriceGrid`,
   `SafeTransfer`, `Flags`, `OloBookStorage`, `OloBookAssets`, `OloBookOrders`, `OloBookBatches`, `OloBookTakes`,
   `OloBook`, `OloBookExt`, `OloBookBase`, `Owned2Step`, `OloSentinel` + `IOloSentinel`, and all 9 interface files.
3. **Line-by-line adversarial passes** over: all params-bit layouts (verified against documented bit positions),
   the reentrancy/lock model on every external-call path, all `unchecked`-arithmetic bound claims (re-derived
   independently), pool-order lifecycle, batch-slot two-pass walk, take walk (base + quote mode), multicall ledger
   and `_commit` netting, flash credit, listing/admin setters, sentinel op decoding/window/ownership-stretch logic,
   and event-vs-state consistency (indexer rebuildability).
4. **Differential testing.** Ported the contract's integer formulas 1:1 and tested them against unlimited-precision
   (BigInt) references — 715k+ checks, **0 mismatches**:
   - `analysis/diff_math.js` (114,011 checks): `toUnits` minimality/bounds, `quoteUp/quoteDown/feeDown`,
     `_quoteBudget`/`_quoteCap`/`_affordable` walk (sum ≤ cap invariant, buy pays ≤ A, sell receives ≤ A, exact
     rounding at `_finishTake`, 2^126 refusal, sum < 2^236 and `sum*feePpm < 2^256` in all decades 4–73).
   - `analysis/diff_settle.js` (9,454 checks): `_cancelOp`, `_claimOp`, `_modifyOp` (incl. kept-order paths) and the
     full `_slotWalk` two-pass settlement (post/replace/modify/cancel/claim, side turns, kept bids, stale bases).
   - `analysis/diff_commit.js` (588,298 checks): `_commit` netting under all settle-flag combos (value conservation,
     no negative accounts except the contract's own InsufficientBalance reverts, pulls-before-pushes) and the
     sentinel state machine (one live op per key, window `[eta, eta+GRACE]`, no double execution, stale-after-
     takeover).
   - Boundary spot-checks: the documented "999,939 ppm" quote-sell budget threshold is exactly correct;
     `BatchLib.lowestSub` lookup table verified for all 16 masks; `OloSlots` preimages verified against the
     documented byte layouts (and pinned by `OloSlotsHash.t.sol`).
5. **Semantics questions settled with evidence** (repo's own passing tests + mutant tables in `docs/ASSEMBLY.md`):
   memory-struct write-back in `_entryOf`/`_commit` (kills mutants S7/S9/S12 if broken), and short calldata word
   reads in `multicall` (`OloLedgerRef` streams end with short ops).

## 2. Verdict

**No new, submittable security issue was found.** Every defect-shaped behavior encountered is explicitly disclosed
in the engagement's statements / context doc §6 ("Known Issues, Accepted Risks & Design Decisions"), which under
judging rule 3.3.1 makes it **Known** (→ Dismissed). The implementation matches its own specification on every path
traced and every property tested.

Honest bottom line: submitting any of the known items (or speculative ones below Info) would count 0 in the Issues
Ratio numerator and hurt payout thresholds (≥2 Accepted issues and ≥20% ratio required). This report therefore
submits **nothing**, and documents why each near-miss is known.

## 3. Near-miss candidates and why each is already known / invalid

| # | Candidate | Where | Status |
|---|---|---|---|
| 1 | Large take denied by a maker repricing to decade 4 (`AmountOverflow` past 2^235) | `OloBookTakes._accrue` | Known — context §6.1 / S73 |
| 2 | Last-look reprice/cancel of named orders; entries skipped | `_worse` | Known — S72 |
| 3 | Dead-position takeover at a list's limit (taker pays up to its limit) | `_fillList` | Known — S76 |
| 4 | Dust bid makes a sell that fills only it revert `SellBelowFee` | `_finishTake` | Known — S77 |
| 5 | Quote-mode sell budget past 2^126 reverts at ≥999,939 ppm | `_quoteCap` | Known — S78 (threshold verified exact) |
| 6 | Fee of 100% allowed (buy pays quote twice; sells revert) | listing cap | Known — S94 |
| 7 | Flash credit beyond OLO's holdings spendable inside OLO, not withdrawable; flash is free; wash volume via self-trade | `OloBookExt.flash` | Known — S86/S87 & §6.1 |
| 8 | Flash callback runs with lock open (any entry reachable); debit is the only repayment | `flash` | Design decision — §6.2 |
| 9 | Emptied batch sub-order keeps stale base; batch claims/cancels never ask a policy; old-encoding bit 3 | `OloBookBatches` | Known — S79–S83, §2.3 |
| 10 | Fee/share change = new version; old versions `MarketFrozen` to re-rests; cold new-version storage | `_setVersion` | Known — S82/S83 |
| 11 | Owner fee steps ≤1%/call; pair floors fed by two keys move up to (n+2)% for listings only; `setMarketFee` ignores floors | `_checkFeeStep` | Known — S89/S91/S92 |
| 12 | Look-alike markets at another fee; listing spam; `MarketExists` never freed | `_list` | Known — S90/S93 |
| 13 | Deployer owns OLO pre-handover; `transferOwnership` op then acceptance has no further delay; pending admin never expires; lost admin unrecoverable; guardian can cancel all other ops | `OloSentinel`/`Owned2Step` | Known — S96–S100 |
| 14 | Ops stale after takeover (`_ownedSince`); ops to OLO revert NotOwner after handover | `OloSentinel` | Known — S101, verified by differential |
| 15 | Proprietary: revoked makers' orders keep filling; policy fixed forever; broken policy = dead market; policy gas on callers | `_admit` | Known — S102–S106 |
| 16 | Non-standard tokens: FOT pulls refused; pushes unchecked; rebasing short; pausable freezes; native-ERC20 chains never deploy | `SafeTransfer`/`_pull` | Known — §3.2 + judging rule 3.5.1 |
| 17 | Sub-wei rounding always in OLO's favor (≤1 wei per settle per order) | `PriceGrid` | Known — S80 |
| 18 | Pot write cost; revenue only at maker settle; account cap 2^128 settles through wallet | `_creditPot`/`_credit` | Known — S84/S85/S81 |
| 19 | `takeThenRest` rest-position squatting reverts whole call `SlotBusy`; unknown-key zero-return; warm-range wrap past 2^32; q-mask 7→5 bits in events; first owner logs no event; empty-pot `collectFees` writes USED; multicall header-only emits Ops; DEPOSIT/WITHDRAW of 0 | various | Known — S74/S75/S112–S117, S98–S100 |
| 20 | Position squatting/probes (gas grief only) | `_placeOp` | Known — S71 |
| 21 | Multicall quote-mode… N/A (takes aren't multicall ops); ledger ≤4 tokens; no per-op events (`Ops` carries them) | `multicall` | Design — §2.1/§2.8 |
| 22 | `PriceGrid.snap(MAX_TICK, spacing>1, up)` rounds past grid | front-end helper, contract never calls | Known — S110 |

## 4. Sub-Info observations (NOT worth submitting; listed for honesty)

- `withdraw(token, 0)` is accepted (no-op + event) while `deposit` of 0 reverts `ZeroSize` — asymmetric but moves nothing.
- `_admit`'s `abi.decode(answer,(uint256))` on a policy answering a non-32-multiple length may panic instead of
  `NotAdmitted` — same refusal outcome, lister-supplied contract, no harm difference.
- `SafeTransfer._check` would panic (not `TransferFailed`) on a token returning 64 bytes for `transfer` — non-standard
  token, invalid per judging rule 3.5.1.
- `_marketOf`/registry: `marketCount` overflow at 2^32 listings is unreachable (each listing burns gas + fee).
- `warmPool` via a listing (`positionsToWarm` u16) or `setMarketFee` (u64) can OOG-revert the caller's own call — self-grief.

## 5. Reproduction

Differential suites are in `analysis/` (`diff_math.js`, `diff_settle.js`, `diff_commit.js`), runnable with `node`.
They port the Solidity formulas verbatim and compare against exact references; final tally:
**711,763 checks, 0 contract-side failures.**
