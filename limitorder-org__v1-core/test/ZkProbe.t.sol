// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 YOU LI. Patent pending.
pragma solidity 0.8.38;

import {OloBase} from "./OloBase.sol";
import {OloOps} from "./OloOps.sol";
import {MockERC20} from "./utils/MockERC20.sol";
import {IOloFlashCallback} from "../src/interfaces/IOloFlashCallback.sol";
import {IOloBook} from "../src/interfaces/IOloBook.sol";
import {IOloBookBase} from "../src/interfaces/IOloBookBase.sol";
import {MarketLib} from "../src/types/Market.sol";
import {MarketWord} from "../src/interfaces/MarketWord.sol";

using MarketLib for MarketWord;

/// Decisive probes: (1) the exact memory-struct write-through pattern the multicall ledger uses,
/// (2) short bytes->bytes32 reads, (3) end-to-end attack attempts against the deployed contracts.
/// Any assertion failure here is a real finding.
contract ZkProbe is OloBase {
    // ---------------------------------------------------------- semantics

    struct Flow {
        uint256 key;
        int256 maker;
        int256 credit;
        int256 wallet;
    }
    struct Ledger {
        uint256 n;
        Flow[] entries;
    }

    function _entryOf(Ledger memory ledger, uint256 key) internal pure returns (Flow memory entry) {
        uint256 n = ledger.n;
        for (uint256 i; i < n; ++i) {
            entry = ledger.entries[i];
            if (entry.key == key) return entry;
        }
        entry = ledger.entries[n];
        entry.key = key;
        ledger.n = n + 1;
    }

    function test_semantics_direct_write_through() public pure {
        Ledger memory l;
        l.entries = new Flow[](4);
        _entryOf(l, 5).maker += 7;
        require(l.entries[0].maker == 7, "direct: NOT written through");
        require(l.entries[0].key == 5, "direct: key not stored");
    }

    function test_semantics_local_write_through() public pure {
        Ledger memory l;
        l.entries = new Flow[](4);
        Flow memory entry = _entryOf(l, 5);
        entry.credit += 3;
        entry.wallet -= 2;
        require(l.entries[0].credit == 3 && l.entries[0].wallet == -2, "local: NOT written through");
    }

    function test_semantics_two_entries() public pure {
        Ledger memory l;
        l.entries = new Flow[](4);
        _entryOf(l, 5).maker += 7;
        _entryOf(l, 6).maker += 9;
        _entryOf(l, 5).maker += 1;
        require(l.n == 2, "n");
        require(l.entries[0].maker == 8, "e0");
        require(l.entries[1].maker == 9, "e1");
    }

    function test_semantics_short_bytes32() public pure {
        bytes memory b = hex"020500";
        bytes32 w = bytes32(b);
        require(uint256(w) == 0x020500 << 232, "short bytes not left-aligned");

    }

    // ---------------------------------------------------------- attacks

    function setUp() public {
        _deploy();
    }

    /// Attack 1: flash the contract's whole holding of quote and try to withdraw it all (others'
    /// escrow and account balances) inside the callback. Expected: whole flash reverts; no theft.
    function test_attack_flash_withdraw_others() public {
        _plain(T, true, 1e12); // a bid: quote escrowed
        _plain(T, false, 1e12); // an ask: base escrowed
        _maker(); // 1e24 of each token sitting in its accounts
        uint256 held = quote.balanceOf(address(book));
        assertTrue(held > 0, "setup");

        FlashThief thief = new FlashThief(address(book), address(quote), address(base));
        uint256 thiefBefore = quote.balanceOf(address(thief));
        vm.prank(address(thief));
        try book.flash(address(quote), held, abi.encode(1, uint32(0), 0)) {
            uint256 gained = quote.balanceOf(address(thief)) - thiefBefore;
            emit log_named_uint("THIEF GAINED", gained);
            assertTrue(gained == 0, "ATTACK: flash withdrawal theft");
        } catch (bytes memory reason) {
            assertTrue(keccak256(reason) == keccak256(abi.encodeWithSignature("InsufficientBalance()")), "wrong revert");
        }
        assertEq(quote.balanceOf(address(book)), held, "contract holding changed");
    }

    /// Attack 2: flash quote, buy base from an ask with the credit (account settlement), withdraw
    /// the bought base as REAL tokens (the maker's escrow), and let the flash repay. Expected:
    /// repayment impossible (the credit was spent), whole flash reverts, nothing moves.
    function test_attack_flash_buy_then_withdraw() public {
        address maker = _plain(T, false, 2e12); // ask at P=1
        uint256 heldQ = quote.balanceOf(address(book));
        uint256 heldB = base.balanceOf(address(book));

        FlashThief thief = new FlashThief(address(book), address(quote), address(base));
        // data: mode 2 = buy 4e11 with account settlement, then withdraw 4e11 base
        vm.prank(address(thief));
        try book.flash(address(quote), 1e12, abi.encode(2, posOf[maker], 4e11)) {
            // if this succeeds the thief turned credit into real tokens without repaying
            assertTrue(base.balanceOf(address(thief)) == 0, "ATTACK: flash-turned-escrow theft");
        } catch (bytes memory reason) {
            assertTrue(
                keccak256(reason) == keccak256(abi.encodeWithSignature("InsufficientBalance()")), "wrong revert"
            );
        }
        assertEq(quote.balanceOf(address(book)), heldQ, "quote moved");
        assertEq(base.balanceOf(address(book)), heldB, "base moved");
    }

    /// Attack 3: a list naming the same position twice — the second entry must see the filled
    /// order (no double fill).
    function test_attack_duplicate_positions() public {
        address maker = _plain(T, false, 2e12);
        uint32 pos = posOf[maker];
        bytes memory entries = bytes.concat(OloOps.poolEntry(pos, T), OloOps.poolEntry(pos, T));
        vm.prank(taker);
        (uint256 baseAmount, uint256 quoteAmount) =
            book.take(OloOps.key(c), OloOps.poolList(entries), OloOps.tagW(c, OloOps.takeW(true, 3e12, 0x01)));
        assertEq(baseAmount, 2e12, "double fill!");
        assertEq(quoteAmount, 2e12 + 1e8, "quote+fee"); // fee ceil(2e12*50/1e6) = 1e8
    }

    /// Attack 4: multicall under an OLDER version's C header: CANCEL settles it; PLACE must hit
    /// MarketFrozen (no resting new orders in an old version).
    function test_attack_multicall_old_version_place() public {
        address maker = _plain(T, false, 1e12);
        MarketWord oldC = c;
        _setMarketFee(60); // a new version
        assertTrue(MarketWord.unwrap(oldC) != MarketWord.unwrap(c), "setup");
        bytes memory ops =
            bytes.concat(OloOps.cancel(0, posOf[maker]), OloOps.place(0, T, false, 1e12, 5000));
        vm.prank(maker);
        vm.expectRevert(IOloBookBase.MarketFrozen.selector);
        book.multicall(0, bytes.concat(abi.encodePacked(uint8(1), MarketWord.unwrap(oldC)), ops));
    }

    /// Attack 5: claim-then-cancel double payment attempt on a filled order.
    function test_attack_claim_then_cancel() public {
        address maker = _plain(T, false, 2e12);
        vm.prank(taker);
        book.take(
            OloOps.key(c), OloOps.poolList(OloOps.poolEntry(posOf[maker], T)), OloOps.tagW(c, OloOps.takeW(true, 1e12, 0x01))
        );
        vm.startPrank(maker);
        book.claim(OloOps.key(c), OloOps.tagW(c, OloOps.posW(posOf[maker], 0x02)));
        uint256 q1 = quote.balanceOf(maker);
        uint256 b1 = base.balanceOf(maker);
        book.cancel(OloOps.key(c), OloOps.tagW(c, OloOps.posW(maker == address(0) ? 0 : posOf[maker], 0x02)));
        vm.stopPrank();
        assertEq(quote.balanceOf(maker), q1, "second payment!");
        assertApproxEqAbs(base.balanceOf(maker) - b1, 1e12, 1, "base refund");
    }

    /// Attack 6: batch side-turn with fills outstanding — settle must pay fills on the OLD side
    /// and escrow the new order on the NEW side exactly once.
    function test_attack_batch_side_turn() public {
        address maker = _maker();
        // post a BID of 1e12 at T (wallet-settled: quote escrowed from the wallet)
        uint256[3] memory post = OloOps.batchW(0, true, 0, 0x02, 0, [uint256(T | (1e12 << 32)), 0, 0, 0]);
        vm.prank(maker);
        book.manageBatchSubs(OloOps.key(c), post[0], OloOps.wordsOf(post));
        (uint256 word,) = book.batchOf(c, maker, 0);
        assertTrue(word != 0, "posted");
        // taker SELLs 4e11 base into the bid (fills it partially)
        vm.prank(taker);
        bytes memory groups = abi.encodePacked(bytes20(maker), uint16(0), uint8(1), uint32(T));
        book.take(OloOps.key(c), OloOps.batchList(groups), OloOps.tagW(c, OloOps.takeW(false, 4e11, 0x01)));
        // maker turns sub 0 into an ASK at the same tick and amount (modify, side flipped)
        uint256 q0 = quote.balanceOf(maker);
        uint256 b0 = base.balanceOf(maker);
        uint256[3] memory mod = OloOps.batchW(2, true, 0, 0x02, 1, [uint256(T | (1e12 << 32)), 0, 0, 0]);
        mod = OloOps.withSides(mod, 0); // s0 = 0 (ask)
        vm.prank(maker);
        book.manageBatchSubs(OloOps.key(c), OloOps.tagW(c, mod[0]), OloOps.wordsOf(mod));
        // fills (4e11) paid in base (it was a bid); old open 6e11 refunded as quote; new ask 1e12 escrowed in base
        assertApproxEqAbs(
            int256(base.balanceOf(maker)) - int256(b0), int256(4e11) - int256(1e12), 2, "base: fills in, escrow out"
        );
        assertApproxEqAbs(
            int256(quote.balanceOf(maker)) - int256(q0),
            int256(6e11) + int256(2e7), // refund + the maker part of the fills fee (share 10,000 = 100%)
            2,
            "quote refund of the open bid"
        );
    }

    /// Attack 7: quote-mode buy never exceeds its amount, at a fee of 100%.
    function test_attack_quote_mode_fee_100() public {
        uint32 m2 = book.listMarketQuote(address(base), address(quote), 1_000_000, 6, 1, 0);
        MarketWord c2 = book.configOf(m2);
        address maker = _maker();
        uint32 pos = _pos();
        vm.prank(maker);
        book.place(OloOps.key(c2), OloOps.placeW(false, T, 1e15, pos, 0)); // ask at P=1, account-settled
        vm.prank(taker);
        (uint256 baseAmount, uint256 quoteAmount) = book.take(
            OloOps.key(c2), OloOps.poolList(OloOps.poolEntry(pos, T)), OloOps.tagW(c2, OloOps.takeW(true, 1e12, 0x03))
        );
        assertTrue(quoteAmount <= 1e12, "OVERPAID");
        assertTrue(baseAmount > 0, "filled");
        assertApproxEqAbs(quoteAmount, 2 * baseAmount, 4, "at 100% a buy pays its quote twice");
    }

    /// Attack 8: account-key confusion — an id past the registry's 32 bits is refused; a
    /// withdrawal above the balance is InsufficientBalance (no unsigned wrap).
    function test_attack_account_key_confusion() public {
        address mk = _maker();
        vm.prank(mk);
        vm.expectRevert(IOloBookBase.UnknownToken.selector);
        book.balanceOf(1 << 32, mk);
        vm.prank(mk);
        vm.expectRevert(IOloBookBase.InsufficientBalance.selector);
        book.withdraw(address(quote), type(uint256).max);
    }

    /// Attack 9: fee evasion via a WRONG version tag — filling an order at a lower fee than its
    /// version's. The tag and the slot hash are the same word, so this must be impossible: a
    /// forged tag hashes to empty slots.
    function test_attack_fee_evasion_wrong_tag() public {
        _setMarketFee(5_000); // v2 at 0.5%
        address maker = _plain(T, false, 1e12); // rests in v2 at 5,000 ppm
        // taker tries to fill it claiming the v1 tag (50 ppm)
        MarketWord v1Tag = MarketWord.wrap((50 << 188) | (1 << 208)); // fee 50, version 1
        uint256 params = OloOps.takeW(true, 1e12, 0) | (MarketWord.unwrap(v1Tag) << (206 - 174));
        vm.prank(taker);
        (uint256 baseAmount,) = book.take(OloOps.key(c), OloOps.poolList(OloOps.poolEntry(posOf[maker], T)), params);
        assertEq(baseAmount, 0, "filled via a forged tag!");
    }
}

/// A flash borrower that tries to steal.
contract FlashThief is IOloFlashCallback {
    IOloBook public immutable book;
    MockERC20 public immutable quote;
    MockERC20 public immutable base;

    constructor(address b, address q, address ba) {
        book = IOloBook(b);
        quote = MockERC20(q);
        base = MockERC20(ba);
    }

    function oloFlashCallback(address, uint256 amount, bytes calldata data) external override {
        require(msg.sender == address(book), "cb");
        (uint256 mode, uint32 pos, uint256 takeAmount) = abi.decode(data, (uint256, uint32, uint256));
        if (mode == 1) {
            // steal: withdraw the whole credit out as real tokens (others' escrow backs it)
            book.withdraw(address(quote), amount);
            // account now 0: repayment must fail -> whole flash reverts -> no theft
        } else if (mode == 2) {
            // buy base with the credited account (account settlement), then withdraw the base
            bytes memory entries = abi.encodePacked(pos, uint32(34_200_000));
            book.take(
                book.configOf(1),
                abi.encodePacked(uint8(0), uint16(entries.length), entries),
                _takeWord(true, takeAmount, 0)
            );
            book.withdraw(address(base), takeAmount);
        }
    }

    function _takeWord(bool buyBase, uint256 amount, uint8 mode) internal pure returns (uint256) {
        return (buyBase ? 1 : 0) | (amount << 1) | (uint256(mode) << 113);
    }
}
