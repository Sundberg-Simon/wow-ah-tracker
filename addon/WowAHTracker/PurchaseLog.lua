-- WoW AH Tracker - AH purchase receipt logger (v1, data layer only)
--
-- Second half of the sale-capture work (see SalesLog.lua): builds Simon's
-- own record of what he's actually bought via the Auction House, for the
-- arbitrage workflow (buy cheap on one realm, move the item via Warband
-- Bank or a dedicated trader character, sell where price + population are
-- both good). Read straight from mailbox invoice receipts, same mechanism
-- as sales - purely observational, never takes/loots/deletes mail, never
-- requests more inbox pages. Persists to WowAHTrackerPurchaseDB, a
-- SavedVariables table separate from the sales log's DB - kept as its own
-- file/table rather than merged into WowAHTrackerSalesDB, since a purchase
-- has no deposit/consignment/net-payout concept at all (see below), and
-- forcing both shapes into one record would mean either a discriminated
-- union or a pile of always-nil fields depending on direction. Matches
-- this project's existing one-file-per-concern pattern (Categorizer,
-- SalesLog, RealmRoster).
--
-- Verified against Blizzard's own client source before writing anything,
-- same practice as the sales log - specifically the assumption that
-- needed checking: does a purchase generate any mail record, or does the
-- item just land in bags with nothing to key off? Confirmed via
-- Interface/AddOns/Blizzard_MailFrame/MailFrame.lua (Gethe/wow-ui-source,
-- live branch): GetInboxInvoiceInfo's invoiceType == "buyer" is a real,
-- dedicated case - the mail UI labels it "Item Purchased:", "Sold By:
-- <seller>", "Amount Paid:" (MoneyFrame_Update on the same `bid` field
-- sellers use for their sale price), and explicitly hides the deposit/
-- consignment/house-cut UI elements for this invoice type - those are
-- seller-only concepts that don't apply to what a buyer pays. Also
-- checked Blizzard_AuctionHouseUI/Shared/Blizzard_AuctionHouseBuyDialog.lua
-- and searched the whole client mirror for any instant-to-bag delivery
-- path bypassing mail - found none; every buyer-purchase-notification
-- reference lives inside the mail system. So this is the same
-- MAIL_INBOX_UPDATE + GetInboxInvoiceInfo mechanism as SalesLog.lua, just
-- filtering invoiceType == "buyer" instead of "seller" - not a new
-- mechanism, and no C_AuctionHouse purchase-confirmation hook is needed.
--
-- `bid` is again the TOTAL paid for the whole purchased quantity, not per-
-- unit, even for a stack (same multipleSale display math as the seller
-- side) - fields below are named totalPricePaid/pricePerUnit for the same
-- reason SalesLog.lua does.
--
-- playerName here is the SELLER's name (SOLD_BY_COLON in the mail UI),
-- and it is NOT part of the dedup signature - applying the sales log's
-- hard-won lesson up front rather than rediscovering it: seller invoices
-- proved that this field can come back "" on one read of a mail and the
-- real name on a later read of the *same* still-present mail (async name
-- resolution), and a signature that includes it would misfire the exact
-- same way SalesLog.lua's did before that was fixed. Stored on the record
-- for display only.
--
-- Dedup: identical confirmed-miss-streak design as SalesLog.lua (see that
-- file's extensive comments for the full history - two real over-counting
-- bugs, then a 2026-09-18 redesign, all found on the sales side and
-- applied here from the start rather than rediscovered). Summary: a
-- signature is forgotten once it's been actively checked for and NOT
-- found, while the mailbox is verifiably open
-- (C_PlayerInteractionManager.IsInteractingWithNpcOfType(Enum.
-- PlayerInteractionType.MailInfo) - engine-level, UI-agnostic, not
-- inferred from GetInboxNumItems() being zero, which is what caused the
-- first redesign's bug since a closed mailbox and a genuinely empty one
-- both report 0), MISS_THRESHOLD separate times, each at least
-- MIN_MISS_INTERVAL_SECONDS apart (comfortably above the observed ~15s
-- inbox-pagination-retry cadence, so multiple sub-samples of one refresh
-- burst - mailbox-close teardown or a mid-session pagination catch-up -
-- can only ever advance the streak by one tick). The 30-day
-- SIGNATURE_GRACE_SECONDS wall-clock check is kept as an outer safety net
-- only, not the primary aging path.
--
-- Signature = itemName + count + bid + realm + character (no deposit/
-- consignment - those return slots aren't meaningful for a buyer invoice,
-- per the mail UI hiding them, so they're left out rather than included
-- on the assumption they're stable). realm+character included for the
-- same reason as the sales log: WowAHTrackerPurchaseDB is account-wide,
-- and Simon runs ~81 characters across 3 accounts sharing 3 such tables.
--
-- KNOWN REMAINING GAP, same shape as the sales log's, now much narrower:
-- two genuinely separate real purchases of the same item/price/count/
-- character/realm would only collapse into one record if the first
-- purchase's mail is still sitting there UNCLAIMED (never confirmed-
-- missing at all) when the second, identical-signature purchase lands -
-- bounded by real confirmed observation now, not a time window. Buying
-- the identical item/price/count twice while the first receipt is still
-- unclaimed is plausible for an arbitrage workflow (buying out the same
-- cheap listing type repeatedly), so this isn't purely theoretical -
-- worth remembering if a future reconciliation pass finds a real purchase
-- missing from this log.
--
-- Item identification is name-only (GetInboxInvoiceInfo has no itemID/
-- itemLink return at all) - same best-effort, same classic-suffix caveat
-- as SalesLog.lua's findTrackedItemId.
--
-- NOT YET LIVE-VERIFIED - cannot be tested synthetically, only by a real
-- AH purchase actually landing in the mailbox. Treat as unverified until
-- Simon confirms after a genuine purchase (see CLAUDE.md "Obligatoriskt
-- sista steg").

local function printMsg(msg)
	DEFAULT_CHAT_FRAME:AddMessage("|cff33ff99WoW AH Tracker|r: " .. msg)
end

local SIG_SEP = "\30"
-- Outer safety-net backstop only (see the dedup note above) - 30 real
-- days, matching the Auction House invoice mail's own expiry. The
-- confirmed-miss-streak mechanism below is the primary aging path.
local SIGNATURE_GRACE_SECONDS = 30 * 24 * 60 * 60
-- How many separate, time-separated confirmed-absent checks it takes to
-- forget a signature.
local MISS_THRESHOLD = 2
-- Minimum real time between two miss ticks counting as "separate" - well
-- above the observed ~15s inbox-pagination-retry cadence, so multiple
-- sub-samples of one refresh burst can only ever contribute one tick.
local MIN_MISS_INTERVAL_SECONDS = 90
local TRACE_MAX_ENTRIES = 25

local function EnsureDB()
	WowAHTrackerPurchaseDB = WowAHTrackerPurchaseDB or {}
	WowAHTrackerPurchaseDB.purchases = WowAHTrackerPurchaseDB.purchases or {}
	WowAHTrackerPurchaseDB.seenSignatures = WowAHTrackerPurchaseDB.seenSignatures or {}
	WowAHTrackerPurchaseDB.trace = WowAHTrackerPurchaseDB.trace or {}
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
		invoice.realm or "",
		invoice.character or "",
	}, SIG_SEP)
end

-- Every currently-open buyer invoice in the inbox, as a signature -> count
-- multiset, plus one sample invoice per signature to record from. Pure
-- reads only (see file header) - never touches/opens mail, and only looks
-- at whatever GetInboxNumItems() already reports as loaded; never
-- proactively requests more pages itself.
local function scanBuyerInvoices()
	local bag = {}
	local sample = {}
	local numItems = GetInboxNumItems()
	for index = 1, numItems do
		local invoiceType, itemName, playerName, bid, _buyout, _deposit, _consignment, _moneyDelay, _etaHour, _etaMin, count, commerceAuction =
			GetInboxInvoiceInfo(index)
		if invoiceType == "buyer" then
			local invoice = {
				itemName = itemName,
				playerName = playerName,
				bid = bid,
				count = count,
				commerceAuction = commerceAuction,
				realm = GetRealmName(),
				character = UnitName("player"),
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

local function recordPurchase(invoice)
	local count = invoice.count or 1
	local totalPricePaid = invoice.bid or 0
	local record = {
		itemName = invoice.itemName,
		itemId = findTrackedItemId(invoice.itemName),
		count = count,
		seller = invoice.playerName,
		totalPricePaid = totalPricePaid,
		pricePerUnit = count > 0 and (totalPricePaid / count) or totalPricePaid,
		commerceAuction = invoice.commerceAuction or false,
		realm = invoice.realm,
		character = invoice.character,
		capturedAt = date("%Y-%m-%dT%H:%M:%S"),
	}
	table.insert(WowAHTrackerPurchaseDB.purchases, record)
	return record
end

-- Ages every tracked signature by one scan's worth of evidence, and
-- forgets it once either aging path allows it (mirrors SalesLog.lua's
-- ageSignatures exactly - see that file's "REDESIGNED 2026-09-18" note
-- for the full reasoning):
--   - Confirmed-miss-streak (primary): for a signature NOT in this scan's
--     currentBag, only count a miss if the mailbox is verifiably open
--     (mailboxOpen) AND at least MIN_MISS_INTERVAL_SECONDS has passed
--     since the last counted miss for it.
--   - Wall-clock backstop (outer safety net): `now < info.lastSeenAt`
--     guards a rollback of GetTime() (a full game client restart, not
--     just /reload - GetTime() doesn't reset on /reload).
local function ageSignatures(seen, currentBag, mailboxOpen, now)
	for sig, info in pairs(seen) do
		if not currentBag[sig] then
			if mailboxOpen and (info.lastMissAt == nil or (now - info.lastMissAt) >= MIN_MISS_INTERVAL_SECONDS) then
				info.missStreak = (info.missStreak or 0) + 1
				info.lastMissAt = now
			end
		end

		if seen[sig] then
			local confirmedGone = (info.missStreak or 0) >= MISS_THRESHOLD
			local backstopExpired = now < info.lastSeenAt or (now - info.lastSeenAt) > SIGNATURE_GRACE_SECONDS
			if confirmedGone or backstopExpired then
				seen[sig] = nil
			end
		end
	end
end

local function appendTrace(now, numItems, currentBag, mailboxOpen, newlyLogged)
	local sigSummaries = {}
	for sig, count in pairs(currentBag) do
		table.insert(sigSummaries, count > 1 and (sig .. " x" .. count) or sig)
	end
	table.insert(WowAHTrackerPurchaseDB.trace, {
		at = date("%H:%M:%S"),
		gameTime = now,
		numItems = numItems,
		mailboxOpen = mailboxOpen,
		buyerSignatures = sigSummaries,
		newlyLogged = newlyLogged,
	})
	while #WowAHTrackerPurchaseDB.trace > TRACE_MAX_ENTRIES do
		table.remove(WowAHTrackerPurchaseDB.trace, 1)
	end
end

-- Prints the instant a capture happens, in addition to the persisted
-- trace - the sales log only added this after a rolling debug buffer had
-- already scrolled past the actual moment during a real incident, so it
-- starts here from day one instead of being bolted on after the fact.
local function announceCapture(record)
	printMsg(
		string.format(
			"PURCHASED: %s x%d, paid %s, seller %s (%s)",
			record.itemName or "?",
			record.count or 1,
			copperToGoldString(record.totalPricePaid),
			(record.seller and record.seller ~= "") and record.seller or "anonymous/unresolved",
			record.capturedAt or "?"
		)
	)
end

local function scanForNewPurchases()
	EnsureDB()
	local currentBag, sample = scanBuyerInvoices()
	local seen = WowAHTrackerPurchaseDB.seenSignatures
	local now = GetTime()
	local mailboxOpen = C_PlayerInteractionManager.IsInteractingWithNpcOfType(Enum.PlayerInteractionType.MailInfo)
	local newlyLogged = 0

	for sig, currentCount in pairs(currentBag) do
		local recorded = seen[sig]
		local recordedCount = recorded and recorded.count or 0
		if currentCount > recordedCount then
			for _ = 1, currentCount - recordedCount do
				announceCapture(recordPurchase(sample[sig]))
				newlyLogged = newlyLogged + 1
			end
		end
		seen[sig] = { count = math.max(currentCount, recordedCount), lastSeenAt = now, missStreak = 0, lastMissAt = nil }
	end

	ageSignatures(seen, currentBag, mailboxOpen, now)
	appendTrace(now, GetInboxNumItems(), currentBag, mailboxOpen, newlyLogged)
end

local function printPurchases()
	EnsureDB()
	local purchases = WowAHTrackerPurchaseDB.purchases
	printMsg(string.format("Captured purchases: %d", #purchases))
	-- Split against the roster as it stands right now - see the note on
	-- WowAHTrackerRealmRoster_Classify (RealmRoster.lua) for why this is never
	-- cached on the purchase record.
	WowAHTrackerRealmRoster_PrintTally(purchases, "totalPricePaid", "purchases", "paid", copperToGoldString)
	local from = math.max(1, #purchases - 9)
	for i = #purchases, from, -1 do
		local purchase = purchases[i]
		DEFAULT_CHAT_FRAME:AddMessage(
			string.format(
				"  %s %s | %s x%d | %s | paid %s | %s",
				WowAHTrackerRealmRoster_Tag(purchase),
				purchase.capturedAt or "?",
				purchase.itemName or "?",
				purchase.count or 1,
				purchase.realm or "?",
				copperToGoldString(purchase.totalPricePaid),
				purchase.seller and ("bought from " .. purchase.seller) or "anonymous/commodity seller"
			)
		)
	end
end

local function printTrace()
	EnsureDB()
	local trace = WowAHTrackerPurchaseDB.trace
	printMsg(string.format("MAIL_INBOX_UPDATE purchase trace (last %d scans):", #trace))
	for _, entry in ipairs(trace) do
		DEFAULT_CHAT_FRAME:AddMessage(
			string.format(
				"  %s (t=%.2f) numItems=%d mailboxOpen=%s buyerInvoices=%d newlyLogged=%d",
				entry.at or "?",
				entry.gameTime or 0,
				entry.numItems or 0,
				tostring(entry.mailboxOpen),
				#(entry.buyerSignatures or {}),
				entry.newlyLogged or 0
			)
		)
		for _, sig in ipairs(entry.buyerSignatures or {}) do
			DEFAULT_CHAT_FRAME:AddMessage("    - " .. sig:gsub(SIG_SEP, " | "))
		end
	end
end

-- Exposed for the /waht purchases and /waht purchasedebug slash commands
-- in WowAHTracker.lua.
function WowAHTrackerPurchaseLog_Print()
	printPurchases()
end

function WowAHTrackerPurchaseLog_PrintTrace()
	printTrace()
end

local eventFrame = CreateFrame("Frame")
eventFrame:RegisterEvent("ADDON_LOADED")
eventFrame:RegisterEvent("MAIL_INBOX_UPDATE")
eventFrame:SetScript("OnEvent", function(_, event, addonName)
	if event == "ADDON_LOADED" and addonName == "WowAHTracker" then
		EnsureDB()
	elseif event == "MAIL_INBOX_UPDATE" then
		scanForNewPurchases()
	end
end)
