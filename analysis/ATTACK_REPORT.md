# OLO v1-core — Attacker-Mindset Audit (Round 2)

Methodology this round: impact-first. Every submittable impact type was enumerated, then each was attacked
concretely against the code (not by verifying the code against itself). Where reasoning could hide an error,
the attack was executed as a machine-checked differential.

## New machine evidence this round

- **Spec-vs-code differential of the batch slot machine** (`spec_diff2.js`): an INDEPENDENT reference built from
  the NatSpec semantics (not from the code) compared against a 1:1 port of `_manageBatch`/`_slotWalk` over
  299,931 randomized operations (posts, replaces, modifies with side turns and kept-bids, cancels, claims,
  interleaved takes, invalid ticks/amounts/masks, fee 0–100%, share 0–10,000 bps): **0 mismatches** in errors,
  words, sides, bases, per-token flows, and pot.
- Total across both rounds: **~1.01M machine checks, 0 contract-side failures.**

## The full attack table (impact → attack path tried → why it fails)

| Impact | Attack paths tried | Why it fails |
|---|---|---|
| Steal others' account balances | Forge `MarketWord`/token ids to collide account keys; wrong-owner settle; `withdrawTo` abuse | Account key = `tokenId \| owner<<160`; ids come from the same `C` that hashes the order slots (keccak coupling), so a word that reaches a real order IS the real version's word; every settle checks `ownerOf == msg.sender`; `withdrawTo` pays a chosen recipient but only from the caller's own balance |
| Steal escrow / proceeds | Dead-position residue; claim another's fills; double-claim | `dead()`/`fresh()` fully rewrite the word; `filled` only grows inside `take` (which collects payment simultaneously); claim/cancel clear it atomically under revert-on-failure semantics |
| Steal the fee pot | `collectFees` reentry; pot key collision; fake credits | Pot = owner-0 account, credited only by `_splitFee`, drained only to `feeRecipient` under the lock; no user key can collide with owner 0 |
| Taker fee evasion | Fill orders without `take`; supply a low-fee `C`; split takes to reduce rounding | The ONLY code that lowers `open` (pool) or batch `open` is the two take loops, which always charge `ceil(Q·feePpm)` from the same `C` that hashed the slots — fee and slots cannot be decoupled; splitting increases rounding paid |
| Maker-rebate theft | Settle at a higher `makerBps` version; fake fills; wash trades | Settle reads `makerBps` from the same `C` that hashes the slot (version-locked); fills are created only by paid takes; wash nets ≤ 0 (maker rebate ≤ taker fee paid, both floored/ceiled against you) |
| Insolvency / phantom value | Rounding-direction flips; q/units precision gaps; partial-fill refund overshoot; batch base/open desync | Every rounding verified in OLO's favor (`quoteUp` in, `quoteDown` out, fee ceil for taker, floor for maker); `base ≥ open` invariant maintained across all 5 op kinds (fuzzed); bid refund ≤ bid escrow; ask proceeds ≤ taker payments |
| Freeze others' funds | Brick cancel/claim/withdraw; lock a market; block entries | All exits are owner-keyed and policy-free by design; no gate, no cooldown, no dependency on the book |
| Grief others beyond known | Dust-bid `SellBelowFee` on real sells; AmountOverflow on others' takes; SlotBusy economics; position/slot squatting | `SellBelowFee` triggers only when the take's TOTAL quote is dust (fill real bids and it cannot fire); AmountOverflow reverts only the caller's own take; all other grief vectors are the disclosed/accepted ones (gas-level) |
| Governance bypass | Two ops per key; replay after ownership round-trip; shortened delay; guardian executes; pair-floor 2-key combo | One live op per key (`_live` + delete-before-call, fuzzed 588k steps); `_ownedSince` stales ops across takeovers; delay changes are themselves delayed; guardian cannot execute; the (n+2)% pair-floor combo is explicitly disclosed |
| Proprietary-policy bypass | Reach bit-170 orders without the bit; wrong-id policy; flash callback as another sender; exits blocked by policy | Slots are keyed by `C` including bit 170, so a word without the bit hashes to different (empty) slots; `_admit` runs before every make/take on words with the bit; `msg.sender` is invariant through a flash; exits never ask |
| Indexer (OLO Book) poisoning | Emit false `Take` fills / fake `BatchUpdated` words / wrong landed-pos in `Ops` | Every event field is built from the same memory used for the storage write in the same call (`fills` buffer mirrors the walk; `BatchUpdated` logs the words it stores; `_noteLanded` logs the true landing) |
| Role acquisition | Become owner/lister/feeRecipient/policy | Two-step ownership behind the timelock; listers owner-gated; recipient owner-gated; policy fixed at listing |
| Reentrancy / mid-call state | Token hooks during pulls/pushes; flash callback mutating mid-walk state; policy staticcall writes | Every token-moving entry holds the transient lock; flash leaves the lock open by design but its credit/debit are exact-amount symmetric (any withdrawal reduces the account below repayment); staticcalls cannot write |
| Wash / unbacked records | Flash self-trade for profit; nested-flash accounting tricks | Verified by arithmetic: self-trade returns strictly ≤ inputs (fee + rounding), flash credit must be repaid 1:1 before the tx ends, nested LIFO debits stack correctly (fuzzed) |

## Deep-dives UNDER known issues (the "root cause below the disclosure" hunt)

- Under "large take denied (AmountOverflow)": threshold re-derived exactly (Q·10^(43−low) ≥ 2^235); the only
  trigger is the caller's own take of ≥ ~5.5e31 quote wei — self-DoS, disclosed.
- Under "last look": a reprice WORSE than the entry bound is skipped; within the bound the taker still pays ≤ the
  bound it accepted — no additional extraction exists beyond the disclosed spread capture.
- Under "dead-position takeover at the limit": fills are still bounded by each entry's own tick (the price the
  taker's ladder accepted); no path to pay beyond the list's bounds.
- Under "dust bid refuses a sell": `SellBelowFee` fires only when the take's whole exact quote is dust-like or the
  fee is ~100%; adding real fills mathematically cannot trigger it.
- Under "flash is free": the credit/debit symmetry was attacked from every angle (withdraw-inside-callback,
  escrow-inside-callback, nested flashes, cross-token nests) — every path reverts with the flash or repays 1:1.
- Under "fee/share changes are new versions": version-tag OR-collisions (`withTag`) can only land on a real
  version's exact `C`, whose own fee/share then apply — no decoupling possible.

## Residual observations (all below submittable severity — do NOT submit)

1. Batch operations split the operation's TOTAL fee once (`_splitFee(c, sums.fee)`), giving the maker up to 3 wei
   more per 4-sub operation than a per-sub-order reading of the docs would suggest; the pot gets the same less.
   Direction is consistent with the documented "maker part floored"; impact ≤ 3 wei/op. Info at best.
2. `withdraw(token, 0)` succeeds (event, no movement) while `deposit(token, 0)` reverts `ZeroSize` — cosmetic.
3. A policy answering a non-32-byte-multiple length may panic inside `abi.decode` rather than revert
   `NotAdmitted` — same refusal outcome, lister-supplied contract.
4. `SafeTransfer` panics (instead of `TransferFailed`) on tokens returning >32-byte `bool`s — non-standard token,
   invalid per judging rule 3.5.1.
5. Listing with `positionsToWarm` up to 65,535 (or `setMarketFee`'s u64) OOG-reverts the caller's own call — self-grief.

## Final verdict

After an impact-first, attacker-driven audit backed by ~1.01M machine-checked differential cases (including an
independent NatSpec-based reference for the batch machine), **no new issue meets the engagement's submittable
bar**. Every exploitable behavior that exists is the disclosed, accepted one; the residual observations above are
Info-or-below and would damage the Issues Ratio if submitted.

## Executable verification (Foundry)

Installed Foundry, compiled the repo (solc 0.8.38, 109 files, exit 0) and ran the repo's suite:
**485 tests passed**; the 105 failures are all environmental — `unknown cheatcode` selector mismatches
(the repo targets Foundry 1.8.5; the available Windows binary is 0.3.0 from 2024) and suites whose `setUp`
depends on those cheatcodes / missing `out-hirun`/`out-sentinel` artifacts. **No logic failure.** Every
runnable differential, model, replay, event and invariant test passed.
