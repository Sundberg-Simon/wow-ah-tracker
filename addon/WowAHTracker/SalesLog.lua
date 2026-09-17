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
-- Instead we snapshot the *multiset* of currently-open seller-invoice
-- signatures on every event and diff it against the multiset seen last
-- time (persisted, so it survives /reload and relogs):
--   - Same signature present both times -> already counted, skip.
--   - A signature's count went up (0->1, or 1->2 for two simultaneous
--     identical sales) -> that many new sales, record that many rows.
--   - A signature's count went down -> mail was claimed/removed; nothing
--     to record (if it disappeared before we ever saw it - e.g. TSM
--     claimed it between logins before this addon loaded - that sale is
--     simply never observed; a real gap, but not one this addon can close
--     without an API-exposed mail ID that doesn't exist).
-- This avoids re-recording a mail that just sits there through many
-- redundant events, and correctly records N distinct sales when N
-- identical-signature sale mails genuinely coexist at once.
--
-- KNOWN REMAINING GAP (flagged rather than silently accepted, per Simon's
-- ask): if a signature's count goes from 1 to 1 within a single event
-- because one matching mail was claimed at the *exact same moment* a new,
-- genuinely separate sale with an identical signature (same item, same
-- price, same count, same buyer-or-both-anonymous) arrived, the net delta
-- is zero and the new sale is silently missed. That needs an exact content
-- collision AND a same-tick claim+arrival race, so it should be rare - but
-- it's a real precision hole, not just a theoretical one, and this data
-- model can't fully close it without a mail ID the API doesn't expose.
-- Worth remembering if a future reconciliation pass ever finds a real AH
-- sale that isn't in this log.
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

local function EnsureDB()
	WowAHTrackerSalesDB = WowAHTrackerSalesDB or {}
	WowAHTrackerSalesDB.sales = WowAHTrackerSalesDB.sales or {}
	WowAHTrackerSalesDB.lastSellerSignatures = WowAHTrackerSalesDB.lastSellerSignatures or {}
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

local function scanForNewSales()
	EnsureDB()
	local currentBag, sample = scanSellerInvoices()
	local previousBag = WowAHTrackerSalesDB.lastSellerSignatures

	for sig, currentCount in pairs(currentBag) do
		local previousCount = previousBag[sig] or 0
		if currentCount > previousCount then
			for _ = 1, currentCount - previousCount do
				recordSale(sample[sig])
			end
		end
	end

	WowAHTrackerSalesDB.lastSellerSignatures = currentBag
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

-- Exposed for the /waht sales slash command in WowAHTracker.lua.
function WowAHTrackerSalesLog_Print()
	printSales()
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
