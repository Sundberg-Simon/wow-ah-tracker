-- WoW AH Tracker - AH sale receipt logger (v1, data layer only)
--
-- Builds Simon's own record of what he's actually sold via the Auction
-- House, read straight from mailbox invoice receipts (GetInboxInvoiceInfo)
-- rather than trusting TSM's internal accounting, which is undocumented and
-- can change under us between TSM updates (see CLAUDE.md "medvetet
-- uppskjutet"). Purely observational: never takes, loots, or deletes mail,
-- and never proactively requests more inbox pages either - Simon still uses
-- TSM's mail window for all of that, and this listener must never interfere
-- with it. Persists to WowAHTrackerSalesDB, a SavedVariables table separate
-- from both the categorizer's DB and data.lua (the sync pipeline's own
-- output, overwritten on every fetch).
--
-- No profit/report UI yet - just the data-collection layer. /waht sales
-- shows a raw count + recent list so we can confirm it's actually working;
-- a real reconciliation/profit command comes later once there's real data
-- to look at.
--
-- Verified against Blizzard's own client source (Gethe/wow-ui-source,
-- live branch, Interface/AddOns/Blizzard_MailFrame/MailFrame.lua) rather
-- than assumed from memory, same approach as the AH-search fix:
--   - GetInboxInvoiceInfo(index) returns invoiceType, itemName, playerName,
--     bid, buyout, deposit, consignment, moneyDelay, etaHour, etaMin,
--     count, commerceAuction. invoiceType is "buyer" (a purchase), "seller"
--     (a completed sale, funds already paid out) or "seller_temp_invoice"
--     (a large sale whose payout is delayed - Blizzard holds very large
--     single payouts; see moneyDelay/etaHour/etaMin). It's nil for any
--     mail that isn't an AH invoice at all - there's no separate "is this
--     an invoice" flag to check first, just call it for every inbox index
--     and look at what comes back.
--   - Calling GetInboxHeaderInfo/GetInboxInvoiceInfo for an arbitrary index
--     is a plain read with no side effects - confirmed from the inbox row-
--     list refresh code (InboxFrame_Update), which calls GetInboxHeaderInfo
--     for every visible row on every update without ever taking, looting,
--     or marking mail read. We deliberately never call GetInboxText, which
--     is only used for the currently *opened* mail's body and isn't needed
--     for any of this.
--   - A "seller" invoice's `bid` is the TOTAL sale price for the whole
--     mail, not a per-unit price, even when count > 1 (confirmed from the
--     UI's own per-unit display math: `multipleSale and (bid / count) or
--     bid`) - the exact per-unit trap CLAUDE.md already documents fixing
--     once for stackable non-commodity items elsewhere in this project.
--     Fields below are named totalSalePrice/pricePerUnit to keep that
--     distinction explicit rather than risk repeating it.
--   - The actual net payout, per Blizzard's own money-frame update in that
--     branch, is bid + deposit - consignment (deposit is refunded on a
--     successful sale, consignment is the AH's cut).
--   - We deliberately only log invoiceType == "seller" (funds already
--     received). "seller_temp_invoice" mail is skipped - it's a "sold,
--     payout pending" notice for a large sale, and a separate "seller"
--     mail arrives once the hold clears; logging the temp one too would
--     double-count that sale once the real one lands.
--
-- Dedup strategy (the hard part - read before changing):
-- MAIL_INBOX_UPDATE fires repeatedly while a sale receipt sits unclaimed in
-- the inbox (new mail arriving, TSM/Simon claiming other mail, periodic
-- resyncs), and there is no stable per-mail ID exposed by the API that
-- survives that - mailbox `index` reshuffles as mail arrives or is
-- removed. Naively keying a "seen" set on mail content (item+price+count+
-- buyer) would misfire the *other* way: the same still-unclaimed mail looks
-- identical on every poll (fine for dedup), but two genuinely separate real
-- sales of the same item at the same price on the same day would then
-- collide on that same key and silently collapse into one record.
--
-- REAL BUG FOUND 2026-09-17 (during the first live mail claim, see git log
-- for the original plain-snapshot-diff version this replaced): both real
-- sales that mail claim got logged twice, with identical timestamps down to
-- the second. A plain "diff against last snapshot, then overwrite the
-- snapshot" approach is correct as long as consecutive MAIL_INBOX_UPDATE
-- events see a *monotonic* view of the inbox (mail only ever appears once
-- and later disappears once) - but the client loads/refreshes the inbox
-- list itself (paging in more of it, or momentarily re-sorting it as a bulk
-- claim works through several mails one at a time), and if a signature
-- that's genuinely still sitting there ever drops out of one intermediate
-- snapshot and reappears in the next, a plain diff sees that reappearance
-- as brand new and logs it again. This is the best-supported explanation
-- given Blizzard's own client code (the inbox list is refreshed
-- incrementally, see MailFrame_RefreshInbox/InboxFrame_Update) and it fits
-- every observed detail (both sales double-logged, not more; identical
-- second-precision timestamps, consistent with two scans within the same
-- MAIL_INBOX_UPDATE burst) - but it was reasoned from source, not caught on
-- a live trace, so /waht salesdebug (below) now keeps a short trace of each
-- scan specifically so a recurrence can be confirmed rather than guessed at
-- again.
--
-- Fix: track each signature's *high-water-mark* count plus when it was
-- last actually seen (WowAHTrackerSalesDB.seenSignatures), instead of a
-- plain last-snapshot value that a signature can vanish from and reappear
-- in. On every scan:
--   - A signature's live count above its recorded high-water-mark -> that
--     many new sales, record that many rows, raise the mark.
--   - A signature seen at or below its mark -> already counted, skip (the
--     mark never drops just because one scan happened not to see it).
--   - A signature not seen at all for more than SIGNATURE_GRACE_SECONDS
--     (currently 60s - comfortably longer than an inbox-load burst, short
--     enough that two unrelated real sales colliding within it should be
--     rare) since it was last actually observed -> forgotten entirely, so
--     a later genuinely new sale with the same signature (a different day,
--     say) is correctly treated as new rather than permanently suppressed.
-- This keeps both original correctness properties: N simultaneous
-- identical-signature sales still log as N rows (0 -> N directly raises the
-- mark by N), and a mail that just sits there through many redundant events
-- is never re-logged (its count never exceeds its own mark).
--
-- KNOWN REMAINING GAP (flagged rather than silently accepted, per Simon's
-- ask, and narrower than before): two genuinely separate real sales with an
-- identical signature (same item, same price, same count, same buyer-or-
-- both-anonymous) that happen within the same SIGNATURE_GRACE_SECONDS
-- window of each other can still collapse into one record, the same way
-- the original diff could - but now bounded to "within ~60 seconds of each
-- other" instead of "any time while either mail happens to still be
-- sitting unclaimed" (which could span the full 30-day mail expiry). Worth
-- remembering if a future reconciliation pass ever finds a real AH sale
-- that isn't in this log.
--
-- Item identification is name-only (GetInboxInvoiceInfo has no itemID/
-- itemLink return at all) - findTrackedItemId() below opportunistically
-- resolves an item id when the sold item's name exactly matches a tracked
-- item, for future reconciliation against data.lua, but that's a name
-- match against a base-id-only list (CLAUDE.md #11/#12), so it can in
-- principle hit the same classic-suffix ambiguity as the categorizer's
-- "+P" button - two differently-suffixed permanent items sharing a base id
-- and a display name would be indistinguishable from name alone. Left nil
-- rather than guessed when there's no exact match.
--
-- NOT YET LIVE-VERIFIED - this cannot be tested synthetically, only by a
-- real AH sale actually landing in the mailbox. Treat as unverified until
-- Simon confirms after a genuine sale (see CLAUDE.md "Obligatoriskt sista
-- steg").

local function printMsg(msg)
	DEFAULT_CHAT_FRAME:AddMessage("|cff33ff99WoW AH Tracker|r: " .. msg)
end

local SIG_SEP = "\30"
local SIGNATURE_GRACE_SECONDS = 60
local TRACE_MAX_ENTRIES = 25

local function EnsureDB()
	WowAHTrackerSalesDB = WowAHTrackerSalesDB or {}
	WowAHTrackerSalesDB.sales = WowAHTrackerSalesDB.sales or {}
	WowAHTrackerSalesDB.seenSignatures = WowAHTrackerSalesDB.seenSignatures or {}
	WowAHTrackerSalesDB.trace = WowAHTrackerSalesDB.trace or {}
	-- Vestigial field from the plain-snapshot-diff version this replaced -
	-- unused now, dropped so a saved-variables dump doesn't look like it's
	-- still in play.
	WowAHTrackerSalesDB.lastSellerSignatures = nil
end

local function findTrackedItemId(itemName)
	if not itemName or not WowAhTrackerData or not WowAhTrackerData.items then
		return nil
	end
	local needle = itemName:lower()
	for itemId, item in pairs(WowAhTrackerData.items) do
		if item.name and item.name:lower() == needle then
			return tonumber(itemId)
		end
	end
	return nil
end

local function buildSignature(invoice)
	return table.concat({
		invoice.itemName or "",
		tostring(invoice.count or 1),
		tostring(invoice.bid or 0),
		tostring(invoice.consignment or 0),
		tostring(invoice.deposit or 0),
		invoice.playerName or "",
	}, SIG_SEP)
end

-- Every currently-open seller invoice in the inbox, as a signature -> count
-- multiset, plus one sample invoice per signature to record from. Pure
-- reads only (see file header) - never touches/opens mail, and only looks
-- at whatever GetInboxNumItems() already reports as loaded; never
-- proactively requests more pages itself.
local function scanSellerInvoices()
	local bag = {}
	local sample = {}
	local numItems = GetInboxNumItems()
	for index = 1, numItems do
		local invoiceType, itemName, playerName, bid, _buyout, deposit, consignment, _moneyDelay, _etaHour, _etaMin, count, commerceAuction =
			GetInboxInvoiceInfo(index)
		if invoiceType == "seller" then
			local invoice = {
				itemName = itemName,
				playerName = playerName,
				bid = bid,
				deposit = deposit,
				consignment = consignment,
				count = count,
				commerceAuction = commerceAuction,
			}
			local sig = buildSignature(invoice)
			bag[sig] = (bag[sig] or 0) + 1
			sample[sig] = invoice
		end
	end
	return bag, sample
end

local function recordSale(invoice)
	local count = invoice.count or 1
	local totalSalePrice = invoice.bid or 0
	table.insert(WowAHTrackerSalesDB.sales, {
		itemName = invoice.itemName,
		itemId = findTrackedItemId(invoice.itemName),
		count = count,
		buyer = invoice.playerName,
		totalSalePrice = totalSalePrice,
		pricePerUnit = count > 0 and (totalSalePrice / count) or totalSalePrice,
		deposit = invoice.deposit,
		consignment = invoice.consignment,
		netReceived = totalSalePrice + (invoice.deposit or 0) - (invoice.consignment or 0),
		commerceAuction = invoice.commerceAuction or false,
		realm = GetRealmName(),
		character = UnitName("player"),
		capturedAt = date("%Y-%m-%dT%H:%M:%S"),
	})
end

-- Forgets any signature not actually seen (a live count for it in this
-- scan) for more than the grace window - see the dedup rationale above.
-- `now < info.lastSeenAt` guards a rollback of GetTime() (a full game
-- client restart, not just /reload - GetTime() is system uptime and
-- doesn't reset on /reload) that would otherwise make the elapsed-time
-- check compute a bogus negative.
local function pruneExpiredSignatures(seen, now)
	for sig, info in pairs(seen) do
		if now < info.lastSeenAt or (now - info.lastSeenAt) > SIGNATURE_GRACE_SECONDS then
			seen[sig] = nil
		end
	end
end

local function appendTrace(now, numItems, currentBag, newlyLogged)
	local sigSummaries = {}
	for sig, count in pairs(currentBag) do
		table.insert(sigSummaries, count > 1 and (sig .. " x" .. count) or sig)
	end
	table.insert(WowAHTrackerSalesDB.trace, {
		at = date("%H:%M:%S"),
		gameTime = now,
		numItems = numItems,
		sellerSignatures = sigSummaries,
		newlyLogged = newlyLogged,
	})
	while #WowAHTrackerSalesDB.trace > TRACE_MAX_ENTRIES do
		table.remove(WowAHTrackerSalesDB.trace, 1)
	end
end

local function scanForNewSales()
	EnsureDB()
	local currentBag, sample = scanSellerInvoices()
	local seen = WowAHTrackerSalesDB.seenSignatures
	local now = GetTime()
	local newlyLogged = 0

	for sig, currentCount in pairs(currentBag) do
		local recorded = seen[sig]
		local recordedCount = recorded and recorded.count or 0
		if currentCount > recordedCount then
			for _ = 1, currentCount - recordedCount do
				recordSale(sample[sig])
				newlyLogged = newlyLogged + 1
			end
		end
		seen[sig] = { count = math.max(currentCount, recordedCount), lastSeenAt = now }
	end

	pruneExpiredSignatures(seen, now)
	appendTrace(now, GetInboxNumItems(), currentBag, newlyLogged)
end

local function copperToGoldString(copper)
	if not copper then
		return "?"
	end
	return string.format("%.2fg", copper / 10000)
end

local function printSales()
	EnsureDB()
	local sales = WowAHTrackerSalesDB.sales
	printMsg(string.format("Captured sales: %d", #sales))
	local from = math.max(1, #sales - 9)
	for i = #sales, from, -1 do
		local sale = sales[i]
		DEFAULT_CHAT_FRAME:AddMessage(
			string.format(
				"  %s | %s x%d | %s | net %s | %s",
				sale.capturedAt or "?",
				sale.itemName or "?",
				sale.count or 1,
				sale.realm or "?",
				copperToGoldString(sale.netReceived),
				sale.buyer and ("sold to " .. sale.buyer) or "anonymous/commodity buyer"
			)
		)
	end
end

local function printTrace()
	EnsureDB()
	local trace = WowAHTrackerSalesDB.trace
	printMsg(string.format("MAIL_INBOX_UPDATE trace (last %d scans):", #trace))
	for _, entry in ipairs(trace) do
		DEFAULT_CHAT_FRAME:AddMessage(
			string.format(
				"  %s (t=%.2f) numItems=%d sellerInvoices=%d newlyLogged=%d",
				entry.at or "?",
				entry.gameTime or 0,
				entry.numItems or 0,
				#(entry.sellerSignatures or {}),
				entry.newlyLogged or 0
			)
		)
		for _, sig in ipairs(entry.sellerSignatures or {}) do
			DEFAULT_CHAT_FRAME:AddMessage("    - " .. sig:gsub(SIG_SEP, " | "))
		end
	end
end

-- Exposed for the /waht sales and /waht salesdebug slash commands in
-- WowAHTracker.lua.
function WowAHTrackerSalesLog_Print()
	printSales()
end

function WowAHTrackerSalesLog_PrintTrace()
	printTrace()
end

local eventFrame = CreateFrame("Frame")
eventFrame:RegisterEvent("ADDON_LOADED")
eventFrame:RegisterEvent("MAIL_INBOX_UPDATE")
eventFrame:SetScript("OnEvent", function(_, event, addonName)
	if event == "ADDON_LOADED" and addonName == "WowAHTracker" then
		EnsureDB()
	elseif event == "MAIL_INBOX_UPDATE" then
		scanForNewSales()
	end
end)
