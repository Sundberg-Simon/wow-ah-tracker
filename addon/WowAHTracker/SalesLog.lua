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
-- the second. CONFIRMED root cause, from inspecting Simon's actual
-- duplicated saved-variables rows directly (not just reasoned from source):
-- every field in each duplicate pair was byte-identical except `buyer` -
-- "" in the first occurrence, the real buyer name ("Vallik") in the
-- second. GetInboxInvoiceInfo's playerName evidently resolves
-- asynchronously for a buyer the client doesn't already have cached (blank
-- on an early read, populated once the name arrives), and the old
-- signature included playerName - so that one field changing mid-flight,
-- for the exact same still-present mail, produced two different signature
-- strings and both were logged as "new". A first-pass fix (a high-water-
-- mark instead of a plain snapshot diff, still below) was applied first on
-- a different, plausible-but-unconfirmed theory (the inbox list loading/
-- refreshing incrementally, per Blizzard's MailFrame_RefreshInbox/
-- InboxFrame_Update) - that mechanism may or may not also be real, but it
-- does NOT explain the buyer-name evidence on its own, and does not by
-- itself prevent this failure mode (a signature's own content changing
-- isn't the same bug as an unchanged signature flickering out and back
-- in). Fixed for real by dropping playerName from the signature entirely
-- (see buildSignature below) - buyer is still stored on each sale record
-- for display, just not used to tell mails apart. Both mitigations are
-- kept since they guard against two different real risks; /waht
-- salesdebug's trace (below) stays in place in case a further recurrence
-- points at yet another mechanism.
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
--     since it was last actually observed -> forgotten entirely, so a
--     later genuinely new sale with the same signature (weeks later, say)
--     is correctly treated as new rather than permanently suppressed.
-- This keeps both original correctness properties: N simultaneous
-- identical-signature sales still log as N rows (0 -> N directly raises the
-- mark by N), and a mail that just sits there through many redundant events
-- is never re-logged (its count never exceeds its own mark).
--
-- SECOND REAL BUG FOUND 2026-09-17 (Vial of the Sands, 3x logged, same
-- buyer all 3 times - this happened with e6bf225 already live, i.e. with
-- playerName already OUT of the signature, so the buyer-name theory above
-- cannot be what caused this one): SIGNATURE_GRACE_SECONDS was originally
-- set to 60, calibrated for the wrong failure mode (sub-second scan
-- flicker within one burst). MAIL_INBOX_UPDATE only fires while
-- interacting with a mailbox, and a /waht salesdebug trace of the incident
-- (14 scans in under a second, numItems draining 6->0) confirmed the
-- client's cached inbox view collapses to empty the moment the mailbox
-- window is closed - regardless of whether anything was actually claimed.
-- pruneExpiredSignatures runs every scan on pure wall-clock elapsed time,
-- with no way to tell "confirmed gone" apart from "no visibility right
-- now" - so a signature's lastSeenAt simply stops refreshing the instant
-- the mailbox closes, and 60 real seconds of the player doing anything
-- else is enough to expire the mark. That makes a re-log near-guaranteed
-- on ordinary usage (open mailbox, look, close, come back a bit later to
-- actually claim) rather than the rare flicker case it was meant for -
-- exactly matching both incidents (N logs = N mailbox visits more than a
-- minute apart while the mail sat unclaimed, /reload or not).
--
-- Fixed by raising SIGNATURE_GRACE_SECONDS to the mail system's own 30-day
-- invoice expiry instead of an arbitrary short window - a real invoice
-- mail cannot still exist past that point regardless, so it's a genuine
-- upper bound rather than a guess, and it comfortably covers any realistic
-- gap between mailbox visits for mail that's still actually sitting there.
--
-- KNOWN REMAINING GAP (flagged rather than silently accepted, per Simon's
-- ask, and now back to roughly its original width - the 60s window turned
-- out to be actively harmful, not just narrow): two genuinely separate
-- real sales of the same item, same price, same count, within the same
-- ~30-day SIGNATURE_GRACE_SECONDS window of each other, can still collapse
-- into one record. Buyer name is NOT part of the disambiguation any more
-- (see the 2026-09-17 root-cause note above - it's demonstrably
-- unreliable, not just unavailable for commodities), so this now applies
-- across different buyers too. Given the choice between this (a quiet,
-- narrow undercount that a reconciliation pass could in principle catch)
-- and the over-counting bugs actually observed twice tonight (loud,
-- immediate, and would silently inflate recorded revenue with nothing to
-- prompt a second look), biasing hard against over-counting is the right
-- tradeoff here. Worth remembering if a future reconciliation pass ever
-- finds a real AH sale that isn't in this log.
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
-- 30 real days, matching the Auction House invoice mail's own expiry - a
-- real invoice cannot still exist past that, so this is a genuine upper
-- bound rather than an arbitrary guess. See the 2026-09-17 "SECOND REAL
-- BUG" note above for why a short window (originally 60s) actively caused
-- duplicate logging instead of preventing it.
local SIGNATURE_GRACE_SECONDS = 30 * 24 * 60 * 60
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

-- playerName is deliberately NOT part of the signature - confirmed (from
-- Simon's actual duplicated saved-variables rows, 2026-09-17) to sometimes
-- come back as "" on one GetInboxInvoiceInfo(index) read of a mail and the
-- real buyer name on a later read of the exact same still-present mail,
-- with every other field byte-identical - a client-side async name
-- resolution, not a real change. Including it in the signature meant that
-- single field flipping mid-flight produced two different signature
-- strings for one physical mail, which is what actually caused tonight's
-- double-logging (the high-water-mark/grace-period mechanism below does
-- NOT protect against a signature's own content changing, only against an
-- unchanged signature disappearing and reappearing - both are real risks,
-- so both mitigations stay in place).
local function buildSignature(invoice)
	return table.concat({
		invoice.itemName or "",
		tostring(invoice.count or 1),
		tostring(invoice.bid or 0),
		tostring(invoice.consignment or 0),
		tostring(invoice.deposit or 0),
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

local function copperToGoldString(copper)
	if not copper then
		return "?"
	end
	return string.format("%.2fg", copper / 10000)
end

local function recordSale(invoice)
	local count = invoice.count or 1
	local totalSalePrice = invoice.bid or 0
	local record = {
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
	}
	table.insert(WowAHTrackerSalesDB.sales, record)
	return record
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

-- Prints the instant a capture happens, in addition to the persisted
-- trace - added 2026-09-17 after the Vial of the Sands incident, where the
-- rolling /waht salesdebug buffer had already scrolled past the actual
-- over-count moment by the time it was checked. This is the thing to
-- watch during the next real sale: it should print exactly once per
-- physical sale, never more.
local function announceCapture(record)
	printMsg(
		string.format(
			"CAPTURED: %s x%d, net %s, buyer %s (%s)",
			record.itemName or "?",
			record.count or 1,
			copperToGoldString(record.netReceived),
			(record.buyer and record.buyer ~= "") and record.buyer or "anonymous/unresolved",
			record.capturedAt or "?"
		)
	)
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
				announceCapture(recordSale(sample[sig]))
				newlyLogged = newlyLogged + 1
			end
		end
		seen[sig] = { count = math.max(currentCount, recordedCount), lastSeenAt = now }
	end

	pruneExpiredSignatures(seen, now)
	appendTrace(now, GetInboxNumItems(), currentBag, newlyLogged)
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
