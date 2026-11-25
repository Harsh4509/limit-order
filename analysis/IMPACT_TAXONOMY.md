# OLO v1-core — Complete Impact Taxonomy (attacker mindset)

Value map: user funds enter via `_pull` (deposits, escrow funding, taker payments, listing fee) and live as
(1) accounts (`_accounts[owner|tokenId]`), (2) order escrow (pool words, batch slots), (3) the fee pot
(owner-0 accounts), (4) stray native. Funds exit via `_push`/`transferNative` (withdrawals, refunds, proceeds,
pot collection). Every submittable impact must break one of the arrows below.

| # | Impact type | Concrete shape in OLO |
|---|---|---|
| I1 | Direct theft | Get `_push`/`_push`-equivalent payout > what you're owed: wrong account key, order-owner bypass, pot drain, taker settlement inversion |
| I2 | Insolvency / phantom value | Make Σ(accounts+pots+order payouts) > OLO's token holdings AND capture the gap via withdraw |
| I3 | Fee evasion | Fill orders without paying ceil(Q·feePpm); or pay at a lower fee than the order's version |
| I4 | Fee-share theft | Maker rebate for fills not earned; rebate at inflated makerBps; pot share diverted |
| I5 | Rounding extraction at scale | Repeatable net-positive rounding loop (all documented roundings are ≤1 wei in OLO's favor — find one that isn't, or a way to scale one) |
| I6 | Freeze/DoS of others' funds | Brick cancel/claim/withdraw/deposit for a victim; permanent lock with no rescue |
| I7 | Asymmetric griefing | Attacker cost X, victim loss >> X, beyond disclosed squatting / last-look / SlotBusy / dead-position |
| I8 | Governance bypass | Move fee/floor/share faster than 1%/delay; execute op early/without schedule; replay after ownership round-trip; guardian/admin power grab |
| I9 | Policy bypass (proprietary) | Make/take without admission; or block an exit via policy |
| I10 | OLO-Book (indexer) poisoning | Events that misreport state so third-party list builders/solvers cause victim loss |
| I11 | Role acquisition | Become owner/lister/feeRecipient/policy without permission |
| I12 | Cross-version/market/side confusion | Settle or fill in wrong version, wrong token accounts, wrong side; amount/q/units mixups |
| I13 | Reentrancy / mid-call state | Any callback observing/mutating state it shouldn't (token hooks are locked; flash is open BY DESIGN — the question is whether any entry is unsafe with the lock open) |
| I14 | Wash/unbacked records | Fabricate volume/fills that credit value without real counterpart (beyond documented flash wash trade) |

## Attack execution order (each traced to code, with verdicts in the final report)

- A: I1 custody theft (key collisions, owner checks, dead-word residue, ext storage confusion)
- B: I3+I4 fee evasion & share theft (fee coupling via slot hash, alternate fill paths, wash)
- C: I2+I5 insolvency & rounding (conservation per settle path; q/units precision edges)
- D: spec-vs-code differential on the batch walk + pool ops (NatSpec as reference — catches code↔doc divergence, the "known top-level issue hiding a deeper one")
- E: I6+I7 DoS/griefing beyond known
- F: I8 sentinel/rate limits
- G: I9 policy bypass + flash×policy
- H: I10 event integrity; I11 roles; I12-I14 cross mechanisms
