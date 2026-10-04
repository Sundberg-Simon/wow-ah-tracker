-- WoW AH Tracker - crafted-item stock
--
-- Two halves in this file: the PROBE (step 1, `/waht stockprobe`, unchanged) and
-- the SNAPSHOTS + `/waht stock` (step 2, at the bottom - see the "step 2" banner).
-- The probe's findings (verified in-game 2026-09-19, CLAUDE.md #15) are what step 2
-- is built on: bags are live; bank/Warband, mail and own auction listings are only
-- visible while their window is open.
--
-- Simon wants to know how many of each crafted item (Vial of the Sands, Sky
-- Golem) he has left per realm cluster, and to be told when a cluster runs
-- low, across 3 accounts / ~81 characters. That needs per-character
-- inventory snapshots, which this addon has never taken: the Categorizer only
-- lists what's in the bags (never stack counts, nothing persisted), and the
-- sales/purchase logs read mail *invoice headers* only, never attachments.
-- So this is new ground, and the plan is: probe -> bags-only pipeline -> add
-- more sources one at a time (see CLAUDE.md).
--
-- This file is only the probe, and it exists because the API docs leave the
-- questions that decide the design unanswered - e.g. whether the client can
-- see bank contents while the bank is CLOSED, whether the Warband bank is
-- readable away from the banker, and what the client knows about mail
-- attachments and your own auction listings when those windows are closed.
-- Rather than guess, `/waht stockprobe` reports what each API actually returns
-- RIGHT NOW, alongside which interaction windows are open, so running it once
-- with everything closed and once at each of the bank / mailbox / Auction
-- House answers those questions with facts.
--
-- Purely observational and side-effect free: it only READS. It never opens or
-- takes mail, never queries the server (no QueryOwnedAuctions - open the AH's
-- "Auctions" tab yourself first), and never touches the bank. Every API call
-- is pcall-guarded so a missing/changed API prints "n/a" instead of erroring
-- and taking the rest of the probe down with it.
--
-- API names below were checked against Blizzard's own client source
-- (Gethe/wow-ui-source, live branch), not memory:
--   C_Container.GetContainerNumSlots / GetContainerItemInfo (-> stackCount, itemID)
--   C_Item.GetItemCount(item, includeBank, includeUses, includeReagentBank, includeAccountBank)
--   GetInboxNumItems / GetInboxItem(mail, attachment) -> name, itemID, texture, count, ...
--     (ATTACHMENTS_MAX_RECEIVE = 16 slots per mail)
--   C_AuctionHouse.GetNumOwnedAuctions / GetOwnedAuctionInfo(i)
--     -> itemKey.itemID, quantity, status (Enum.AuctionStatus: Active=0, Sold=1)
--   C_Bank.CanViewBank(Enum.BankType.*)
--   C_PlayerInteractionManager.IsInteractingWithNpcOfType(Enum.PlayerInteractionType.*)
--     (Banker, CharacterBanker, AccountBanker, MailInfo, Auctioneer)
-- Enum.BagIndex's member names are deliberately DISCOVERED at runtime and dumped
-- into the output rather than assumed.
--
-- Results are printed to chat AND appended to WowAHTrackerStockDB.probes (kept
-- to the last PROBE_KEEP runs) so they can be read back from the SavedVariables
-- file after a logout or /reload instead of being copied out of the chat window.
--
-- NOT YET LIVE-VERIFIED - needs Simon to run it in the game (see CLAUDE.md
-- "Obligatoriskt sista steg").

local PROBE_KEEP = 50

-- The crafted items this feature is about. Ids resolved via Blizzard's item
-- search (each the single exact-name match); `/waht stockprobe <id or name>`
-- adds one more to the run.
local PROBE_ITEMS = {
	{ id = 65891, name = "Vial of the Sands" },
	{ id = 95416, name = "Sky Golem" },
}

local function printMsg(msg)
	DEFAULT_CHAT_FRAME:AddMessage("|cff33ff99WoW AH Tracker|r: " .. msg)
end

local function EnsureDB()
	WowAHTrackerStockDB = WowAHTrackerStockDB or {}
	WowAHTrackerStockDB.probes = WowAHTrackerStockDB.probes or {}
	WowAHTrackerStockDB.characters = WowAHTrackerStockDB.characters or {}
end

-- pcall wrapper that returns (ok, value...) and never throws.
local function try(fn, ...)
	return pcall(fn, ...)
end

local function fmt(ok, value)
	if not ok then
		return "n/a (error)"
	end
	if value == nil then
		return "nil"
	end
	return tostring(value)
end

-- Sorted "Name=Value" list of an Enum table's members, optionally filtered by
-- a case-insensitive Lua pattern on the member name. Discovery beats guessing.
local function enumMembers(enumTable, pattern)
	local out = {}
	if type(enumTable) ~= "table" then
		return out
	end
	for name, value in pairs(enumTable) do
		if type(name) == "string" and (not pattern or name:lower():find(pattern)) then
			table.insert(out, { name = name, value = value })
		end
	end
	table.sort(out, function(a, b)
		if type(a.value) == "number" and type(b.value) == "number" and a.value ~= b.value then
			return a.value < b.value
		end
		return a.name < b.name
	end)
	return out
end

local function joinMembers(members)
	local parts = {}
	for _, m in ipairs(members) do
		table.insert(parts, m.name .. "=" .. tostring(m.value))
	end
	return #parts > 0 and table.concat(parts, " ") or "(none found)"
end

-- Which interaction windows are open right now, by discovered enum member.
local INTERACTION_NAMES = { "Banker", "CharacterBanker", "AccountBanker", "MailInfo", "Auctioneer" }

local function interactionState()
	local state = {}
	local pim = C_PlayerInteractionManager
	local types = Enum and Enum.PlayerInteractionType
	for _, name in ipairs(INTERACTION_NAMES) do
		local value = types and types[name]
		if pim and pim.IsInteractingWithNpcOfType and value ~= nil then
			local ok, result = try(pim.IsInteractingWithNpcOfType, value)
			-- Explicit branch, NOT `ok and result or "n/a"`: that idiom turns a genuine
			-- `false` (window closed) into "n/a" because false is falsy.
			if ok then
				state[name] = result and true or false
			else
				state[name] = "n/a"
			end
		else
			state[name] = "n/a"
		end
	end
	return state
end

local function interactionText(state)
	local parts = {}
	for _, name in ipairs(INTERACTION_NAMES) do
		local v = state[name]
		table.insert(parts, name .. "=" .. (v == true and "OPEN" or (v == false and "no" or "n/a")))
	end
	return table.concat(parts, " ")
end

-- Sum of `itemId` in one container, plus how many slots the API reports for it.
-- Returns (numSlots, found, ok). Nothing is assumed about which containers
-- exist; the caller decides which ids to try.
local function scanContainer(containerId, itemId)
	if not (C_Container and C_Container.GetContainerNumSlots and C_Container.GetContainerItemInfo) then
		return nil, nil, false
	end
	local okN, numSlots = try(C_Container.GetContainerNumSlots, containerId)
	if not okN or type(numSlots) ~= "number" then
		return nil, nil, false
	end
	local found = 0
	for slot = 1, numSlots do
		local okI, info = try(C_Container.GetContainerItemInfo, containerId, slot)
		if okI and type(info) == "table" and info.itemID == itemId then
			found = found + (info.stackCount or 1)
		end
	end
	return numSlots, found, true
end

-- The player's carried bags: backpack + the equippable bag slots, plus the
-- reagent bag if this client has one (same set the Categorizer scans).
local function carriedBagIds()
	local ids = {}
	local first = BACKPACK_CONTAINER or 0
	local last = NUM_BAG_SLOTS or 4
	for i = first, last do
		table.insert(ids, i)
	end
	if Enum and Enum.BagIndex and Enum.BagIndex.ReagentBag then
		table.insert(ids, Enum.BagIndex.ReagentBag)
	end
	return ids
end

local function bagsLine(itemId)
	local total, parts, anyOk = 0, {}, false
	for _, bagId in ipairs(carriedBagIds()) do
		local slots, found, ok = scanContainer(bagId, itemId)
		if ok then
			anyOk = true
			if found and found > 0 then
				total = total + found
				table.insert(parts, "bag" .. bagId .. ":" .. found)
			end
		end
	end
	if not anyOk then
		return "carried bags (C_Container scan): n/a"
	end
	return string.format("carried bags (C_Container scan): %d%s", total, #parts > 0 and ("  [" .. table.concat(parts, " ") .. "]") or "")
end

-- Every C_Item.GetItemCount variant, so the output shows exactly which flag adds what.
local function itemCountLines(itemId)
	local fn = (C_Item and C_Item.GetItemCount) or GetItemCount
	if not fn then
		return { "C_Item.GetItemCount: n/a" }
	end
	local variants = {
		{ "default", { itemId } },
		{ "+bank", { itemId, true } },
		{ "+bank +reagentBank", { itemId, true, false, true } },
		{ "+bank +reagentBank +warbandBank", { itemId, true, false, true, true } },
	}
	local lines = {}
	for _, v in ipairs(variants) do
		local ok, count = try(fn, unpack(v[2]))
		table.insert(lines, string.format("GetItemCount %-33s -> %s", "(" .. v[1] .. ")", fmt(ok, count)))
	end
	return lines
end

-- Character bank / reagent bank / Warband bank containers, DISCOVERED from
-- Enum.BagIndex by name. Reports slots the API claims and how many of the item
-- it can actually see - the interesting number is "slots=N found=0" vs
-- "slots=0", which shows whether a closed bank is readable at all.
local function bankContainerLines(itemId)
	local members = enumMembers(Enum and Enum.BagIndex, "bank")
	local more = enumMembers(Enum and Enum.BagIndex, "account")
	local seen, lines = {}, {}
	local function add(list)
		for _, m in ipairs(list) do
			if not seen[m.name] and type(m.value) == "number" then
				seen[m.name] = true
				local slots, found, ok = scanContainer(m.value, itemId)
				table.insert(lines, string.format("%s(%d): %s", m.name, m.value, ok and ("slots=" .. slots .. " found=" .. found) or "n/a"))
			end
		end
	end
	add(members)
	add(more)
	if #lines == 0 then
		return { "no bank-like members found in Enum.BagIndex" }
	end
	return lines
end

local function bankAccessText()
	local types = Enum and Enum.BankType
	if not (C_Bank and C_Bank.CanViewBank and type(types) == "table") then
		return "C_Bank.CanViewBank: n/a"
	end
	local parts = {}
	for _, m in ipairs(enumMembers(types)) do
		local ok, can = try(C_Bank.CanViewBank, m.value)
		table.insert(parts, m.name .. "=" .. fmt(ok, can))
	end
	return "C_Bank.CanViewBank: " .. (#parts > 0 and table.concat(parts, " ") or "n/a")
end

local function mailLine(itemId)
	if not GetInboxNumItems then
		return "mail: n/a"
	end
	local okN, numItems, totalItems = try(GetInboxNumItems)
	if not okN then
		return "mail: n/a (error)"
	end
	local maxAttach = ATTACHMENTS_MAX_RECEIVE or 16
	local total, inMails = 0, {}
	for mail = 1, (numItems or 0) do
		for attach = 1, maxAttach do
			local ok, _, id, _, count = try(GetInboxItem, mail, attach)
			if ok and id == itemId then
				total = total + (count or 1)
				table.insert(inMails, mail)
			end
		end
	end
	return string.format(
		"mail attachments: %d  (client has %s of %s mails loaded%s)",
		total,
		tostring(numItems or 0),
		tostring(totalItems or numItems or 0),
		#inMails > 0 and (", in mail " .. table.concat(inMails, ",")) or ""
	)
end

local function auctionLine(itemId)
	local ah = C_AuctionHouse
	if not (ah and ah.GetNumOwnedAuctions and ah.GetOwnedAuctionInfo) then
		return "own auction listings: n/a"
	end
	local okN, n = try(ah.GetNumOwnedAuctions)
	if not okN or type(n) ~= "number" then
		return "own auction listings: n/a (error)"
	end
	local activeStatus = Enum and Enum.AuctionStatus and Enum.AuctionStatus.Active
	local active, sold, other = 0, 0, 0
	for i = 1, n do
		local ok, info = try(ah.GetOwnedAuctionInfo, i)
		if ok and type(info) == "table" and info.itemKey and info.itemKey.itemID == itemId then
			local qty = info.quantity or 1
			if activeStatus ~= nil and info.status == activeStatus then
				active = active + qty
			elseif Enum and Enum.AuctionStatus and info.status == Enum.AuctionStatus.Sold then
				sold = sold + qty
			else
				other = other + qty
			end
		end
	end
	-- Only report "full results" if the call itself succeeded - a failed pcall's
	-- second value is an error message, which must not be mistaken for a result.
	local fullText = ""
	if ah.HasFullOwnedAuctionResults then
		local okF, full = try(ah.HasFullOwnedAuctionResults)
		if okF and full ~= nil then
			fullText = ", full results=" .. tostring(full)
		end
	end
	return string.format(
		"own auction listings: active=%d sold-awaiting-payout=%d other=%d  (client lists %d owned auctions%s)",
		active,
		sold,
		other,
		n,
		fullText
	)
end

local function resolveExtraItem(arg)
	if not arg or arg == "" then
		return nil
	end
	local asNumber = tonumber(arg)
	if asNumber then
		local name
		if C_Item and C_Item.GetItemNameByID then
			local ok, resolved = try(C_Item.GetItemNameByID, asNumber)
			name = ok and resolved or nil
		end
		return { id = asNumber, name = name or ("item " .. asNumber) }
	end
	if WowAhTrackerData and WowAhTrackerData.items then
		local needle = arg:lower()
		for _, item in pairs(WowAhTrackerData.items) do
			if item.name and item.name:lower() == needle then
				return { id = item.id, name = item.name }
			end
		end
		for _, item in pairs(WowAhTrackerData.items) do
			if item.name and item.name:lower():find(needle, 1, true) then
				return { id = item.id, name = item.name }
			end
		end
	end
	return nil
end

-- Runs one probe: returns the list of output lines (also what gets stored).
function WowAHTrackerStock_Probe(arg)
	EnsureDB()
	local items = {}
	for _, item in ipairs(PROBE_ITEMS) do
		table.insert(items, item)
	end
	local extra = resolveExtraItem(arg)
	if arg and arg ~= "" and not extra then
		printMsg(string.format('Could not resolve "%s" to an item id - probing the default items only.', arg))
	elseif extra then
		table.insert(items, extra)
	end

	local state = interactionState()
	local lines = {}
	local function add(line)
		table.insert(lines, line)
	end

	add(string.format("Stock probe - %s on %s", UnitName("player") or "?", GetRealmName() or "?"))
	add("Windows open now: " .. interactionText(state))
	add(bankAccessText())
	add("Enum.BagIndex: " .. joinMembers(enumMembers(Enum and Enum.BagIndex)))
	for _, item in ipairs(items) do
		add(string.format("== %s (%d) ==", item.name, item.id))
		add("  " .. bagsLine(item.id))
		for _, line in ipairs(itemCountLines(item.id)) do
			add("  " .. line)
		end
		for _, line in ipairs(bankContainerLines(item.id)) do
			add("  bank container " .. line)
		end
		add("  " .. mailLine(item.id))
		add("  " .. auctionLine(item.id))
	end

	for _, line in ipairs(lines) do
		DEFAULT_CHAT_FRAME:AddMessage("  " .. line)
	end

	local probes = WowAHTrackerStockDB.probes
	table.insert(probes, {
		at = date("%Y-%m-%dT%H:%M:%S"),
		character = UnitName("player"),
		realm = GetRealmName(),
		interaction = state,
		lines = lines,
	})
	while #probes > PROBE_KEEP do
		table.remove(probes, 1)
	end
	printMsg(
		string.format(
			"Probe #%d saved. It reaches disk on logout or /reload - do one of those before telling Claude Code to read it.",
			#probes
		)
	)
	return lines
end

-- =====================================================================
-- step 2: per-character SNAPSHOTS + `/waht stock`
-- =====================================================================
--
-- Goal: how many of each CRAFTED item Simon has left per realm cluster, and a
-- flag when a cluster runs out. The earnings report is the main place (it
-- merges all 3 accounts through the DB); this file records the raw per-
-- character snapshots that the ingest carries there, and `/waht stock` is the
-- quick per-character/per-account check in the game. Stock numbers are
-- personal data like earnings: they live in SavedVariables and the local DB
-- only - never in data.lua / anything published (CLAUDE.md #13, #15).
--
-- Sources counted now: BAGS (live) and own AUCTION LISTINGS (a snapshot taken
-- when the Auctions tab has loaded them). Mail and banks are NOT counted yet -
-- Simon empties his mailbox at each login until the mail source exists, and
-- never keeps stock in the bank/Warband bank.
--
-- Data model (WowAHTrackerStockDB.characters["<realm>|<character>"]):
--   bags     = { at = "<local time>", ts = <unix time>, counts = { [itemId] = n, ... } }
--   auctions = { same shape; ACTIVE listings only (sold ones already left) }
--   held     = { [itemId] = true }   -- this character has EVER been seen holding it
-- A snapshot lists EVERY crafted item id with an explicit count (0 included),
-- so "counted zero" is distinguishable from "not in the snapshot = unknown"
-- (an item marked crafted after the last scan simply isn't there yet).
--
-- Status per (cluster, item) - the rule the report implements identically:
--   a character's BAGS are known if a bags snapshot lists the item (they never
--   expire: they only change when the character is played);
--   its AUCTIONS are known only if the snapshot is fresh (<= 48h - listings
--   last at most 48h, after which they sold or came back as mail, so an older
--   snapshot says nothing);
--   total = sum of the KNOWN parts; unknown = any character missing a part;
--   fully known: total <= threshold -> OUT (0) / LOW (>0), else OK;
--   partly unknown: total > threshold -> OK (at least that many), else UNKNOWN
--   (it may be running out, we can't tell) - unknown is never shown as 0.

local AUCTION_MAX_AGE_SECONDS = 48 * 60 * 60
local LOW_STOCK_THRESHOLD = 0 -- flag at 0 left; per-item configuration comes later
local MIN_BAG_SCAN_INTERVAL = 0.5

-- Which items are "crafted": data.lua carries crafted = true (from
-- config/trackedItems.json). Until a data.lua with that flag has been fetched,
-- fall back to the two known crafted items so the feature works immediately.
local function craftedItems()
	local list = {}
	if WowAhTrackerData and WowAhTrackerData.items then
		for id, item in pairs(WowAhTrackerData.items) do
			if item.crafted == true then
				table.insert(list, {
					id = tonumber(item.id) or tonumber(id),
					name = item.name or ("item " .. tostring(id)),
					-- expected on every realm (the restock window); data.lua only says so when it's false
					restock = item.restock ~= false,
				})
			end
		end
	end
	if #list == 0 then
		for _, item in ipairs(PROBE_ITEMS) do
			table.insert(list, { id = item.id, name = item.name, restock = true })
		end
	end
	table.sort(list, function(a, b)
		return a.name < b.name
	end)
	return list
end

local function characterRecord(create)
	EnsureDB()
	local key = (GetRealmName() or "?") .. "|" .. (UnitName("player") or "?")
	local rec = WowAHTrackerStockDB.characters[key]
	if not rec and create then
		rec = { realm = GetRealmName(), character = UnitName("player") }
		WowAHTrackerStockDB.characters[key] = rec
	end
	return rec
end

-- Counts of each wanted item in the carried bags, or nil if the bags aren't
-- loaded yet (recording "0 everywhere" from an early scan would be a lie).
local function scanBagCounts(items)
	if not (C_Container and C_Container.GetContainerNumSlots and C_Container.GetContainerItemInfo) then
		return nil
	end
	local wanted, counts = {}, {}
	for _, item in ipairs(items) do
		wanted[item.id] = true
		counts[item.id] = 0
	end
	local sawSlots = false
	for _, bagId in ipairs(carriedBagIds()) do
		local okN, numSlots = try(C_Container.GetContainerNumSlots, bagId)
		if okN and type(numSlots) == "number" and numSlots > 0 then
			sawSlots = true
			for slot = 1, numSlots do
				local okI, info = try(C_Container.GetContainerItemInfo, bagId, slot)
				if okI and type(info) == "table" and info.itemID and wanted[info.itemID] then
					counts[info.itemID] = counts[info.itemID] + (info.stackCount or 1)
				end
			end
		end
	end
	if not sawSlots then
		return nil
	end
	return counts
end

local function recordSnapshot(source, counts)
	local rec = characterRecord(true)
	rec[source] = { at = date("%Y-%m-%dT%H:%M:%S"), ts = time(), counts = counts }
	rec.held = rec.held or {}
	for id, n in pairs(counts) do
		if n > 0 then
			rec.held[id] = true
		end
	end
end

local lastBagScan = -1000
local bagScanPending = false

local function scanBagsNow()
	lastBagScan = GetTime and GetTime() or 0
	local counts = scanBagCounts(craftedItems())
	if counts then
		recordSnapshot("bags", counts)
	end
end

-- BAG_UPDATE_DELAYED already batches slot changes, but bursts still happen
-- (looting, vendoring). Scan at most every MIN_BAG_SCAN_INTERVAL - and if an
-- event lands inside the window, schedule ONE trailing scan so the LAST change
-- is never dropped.
local function requestBagScan()
	local now = GetTime and GetTime() or 0
	if now - lastBagScan >= MIN_BAG_SCAN_INTERVAL then
		scanBagsNow()
	elseif not bagScanPending and C_Timer and C_Timer.After then
		bagScanPending = true
		C_Timer.After(MIN_BAG_SCAN_INTERVAL, function()
			bagScanPending = false
			scanBagsNow()
		end)
	end
end

-- Own auction listings, from the client's own owned-auction list, ONLY when it
-- reports FULL results (Blizzard's UI loads them when the Auctions tab is
-- opened/refreshed; we deliberately do not query them ourselves - see the
-- search-bar lesson in CLAUDE.md about bypassing the Auction House frame's own
-- state). Only ACTIVE listings count; sold ones already left. Zero listings
-- with full results is a legitimate all-zero snapshot.
-- Active listings per wanted item, or nil when the client doesn't hold the full
-- owned-auction list right now (nil = unknown, never 0).
local function ownedAuctionCounts(items)
	local ah = C_AuctionHouse
	if not (ah and ah.GetNumOwnedAuctions and ah.GetOwnedAuctionInfo and ah.HasFullOwnedAuctionResults) then
		return nil
	end
	local okF, full = try(ah.HasFullOwnedAuctionResults)
	if not (okF and full == true) then
		return nil
	end
	local activeStatus = Enum and Enum.AuctionStatus and Enum.AuctionStatus.Active
	if activeStatus == nil then
		return nil -- can't tell active from sold: don't guess
	end
	local okN, n = try(ah.GetNumOwnedAuctions)
	if not okN or type(n) ~= "number" then
		return nil
	end
	local wanted, counts = {}, {}
	for _, item in ipairs(items) do
		wanted[item.id] = true
		counts[item.id] = 0
	end
	for i = 1, n do
		local ok, info = try(ah.GetOwnedAuctionInfo, i)
		if ok and type(info) == "table" and info.itemKey and wanted[info.itemKey.itemID] and info.status == activeStatus then
			counts[info.itemKey.itemID] = counts[info.itemKey.itemID] + (info.quantity or 1)
		end
	end
	return counts
end

local function scanAuctionsNow()
	local counts = ownedAuctionCounts(craftedItems())
	if counts then
		recordSnapshot("auctions", counts)
	end
end

-- ---- status ----

-- The rule from the banner above, on plain data so it can be tested in
-- isolation and mirrored exactly by the report. `chars` is a list of
-- { bags = n or nil, auctions = n or nil } where nil means UNKNOWN (never
-- scanned, or an auction snapshot older than 48h - the caller decides that).
-- Returns total, unknown, status ("OUT" | "LOW" | "OK" | "UNKNOWN").
function WowAHTrackerStock_ClusterStatus(chars, threshold)
	threshold = threshold or LOW_STOCK_THRESHOLD
	local total, unknown = 0, false
	if #chars == 0 then
		unknown = true -- a cluster with no known character can't be judged
	end
	for _, c in ipairs(chars) do
		if c.bags == nil then
			unknown = true
		else
			total = total + c.bags
		end
		if c.auctions == nil then
			unknown = true
		else
			total = total + c.auctions
		end
	end
	local status
	if not unknown then
		if total > threshold then
			status = "OK"
		elseif total == 0 then
			status = "OUT"
		else
			status = "LOW"
		end
	else
		status = (total > threshold) and "OK" or "UNKNOWN"
	end
	return total, unknown, status
end

local function normalizeRealm(name)
	return (name or ""):gsub("%s+", ""):lower()
end

-- Connected-realm cluster of a realm name, via data.lua's connectedRealms
-- (same normalize-and-match as the realm roster). Returns id, names or nil.
local function clusterOf(realm)
	if WowAhTrackerData and WowAhTrackerData.connectedRealms then
		local needle = normalizeRealm(realm)
		for id, names in pairs(WowAhTrackerData.connectedRealms) do
			for _, n in ipairs(names) do
				if normalizeRealm(n) == needle then
					return tonumber(id), names
				end
			end
		end
	end
	return nil, nil
end

local function ageText(ts, now)
	if not ts then
		return "never"
	end
	local d = math.max(0, now - ts)
	if d < 90 then
		return "just now"
	elseif d < 5400 then
		return string.format("%dm ago", math.floor(d / 60 + 0.5))
	elseif d < 172800 then
		return string.format("%dh ago", math.floor(d / 3600 + 0.5))
	end
	return string.format("%dd ago", math.floor(d / 86400 + 0.5))
end

-- This account's picture, per crafted item and cluster. A cluster is IN SCOPE
-- for an item once a character here has held it or a sale of it was logged
-- there - otherwise ~80 clusters would each show "0, never stocked".
local function buildAccountStock(now)
	EnsureDB()
	local items = craftedItems()
	local roster = (WowAHTrackerRealmRosterDB and WowAHTrackerRealmRosterDB.characters) or {}
	local sales = (WowAHTrackerSalesDB and WowAHTrackerSalesDB.sales) or {}
	local results = {}

	for _, item in ipairs(items) do
		local clusters = {} -- clusterKey -> { label, members, chars = { [key] = {...} }, inScope }
		local function cluster(realm)
			local id, names = clusterOf(realm)
			local key = id and ("cr:" .. id) or ("name:" .. normalizeRealm(realm))
			local c = clusters[key]
			if not c then
				c = { key = key, members = names and #names or 1, chars = {}, inScope = false, realmSet = {} }
				clusters[key] = c
			end
			-- Labelled by the realm(s) actually used, not the group's first name.
			c.realmSet[realm] = true
			return c
		end
		local function addChar(c, realm, character)
			local k = realm .. "|" .. character
			if not c.chars[k] then
				c.chars[k] = { key = k, character = character }
			end
			return c.chars[k]
		end

		for key, rec in pairs(WowAHTrackerStockDB.characters) do
			local c = cluster(rec.realm or "?")
			local ch = addChar(c, rec.realm or "?", rec.character or key)
			ch.rec = rec
			if rec.held and rec.held[item.id] then
				c.inScope = true
			end
		end
		for _, entry in pairs(roster) do
			if entry.realm and entry.character then
				addChar(cluster(entry.realm), entry.realm, entry.character)
			end
		end
		local nameLower = item.name:lower()
		for _, sale in ipairs(sales) do
			if sale.itemName and sale.itemName:lower() == nameLower and sale.realm then
				cluster(sale.realm).inScope = true
			end
		end

		local rows = {}
		for _, c in pairs(clusters) do
			if c.inScope then
				local charInputs, details = {}, {}
				for _, ch in pairs(c.chars) do
					local rec = ch.rec
					local bags = rec and rec.bags and rec.bags.counts and rec.bags.counts[item.id] or nil
					local aucKnown = rec and rec.auctions and rec.auctions.counts and rec.auctions.counts[item.id] ~= nil
					local auctions = nil
					if aucKnown and rec.auctions.ts and (now - rec.auctions.ts) <= AUCTION_MAX_AGE_SECONDS then
						auctions = rec.auctions.counts[item.id]
					end
					table.insert(charInputs, { bags = bags, auctions = auctions })
					table.insert(details, {
						character = ch.character,
						bags = bags,
						bagsTs = rec and rec.bags and rec.bags.ts or nil,
						auctions = auctions,
						auctionsTs = rec and rec.auctions and rec.auctions.ts or nil,
						auctionsStale = aucKnown and auctions == nil,
					})
				end
				table.sort(details, function(a, b)
					return a.character < b.character
				end)
				local total, unknown, status = WowAHTrackerStock_ClusterStatus(charInputs, LOW_STOCK_THRESHOLD)
				local realmNames = {}
				for realmName in pairs(c.realmSet) do
					table.insert(realmNames, realmName)
				end
				table.sort(realmNames)
				table.insert(rows, {
					label = table.concat(realmNames, ", "),
					members = c.members,
					total = total,
					unknown = unknown,
					status = status,
					details = details,
				})
			end
		end
		table.sort(rows, function(a, b)
			local order = { OUT = 1, LOW = 2, UNKNOWN = 3, OK = 4 }
			if order[a.status] ~= order[b.status] then
				return order[a.status] < order[b.status]
			end
			return a.label < b.label
		end)
		table.insert(results, { item = item, rows = rows })
	end
	return results
end

local STATUS_COLOR = { OUT = "ff5555", LOW = "ffaa33", UNKNOWN = "aaaaaa", OK = "33ff99" }

local function detailText(d, now)
	local parts = {}
	table.insert(parts, d.bags ~= nil and string.format("bags %d (%s)", d.bags, ageText(d.bagsTs, now)) or "bags never scanned")
	if d.auctions ~= nil then
		table.insert(parts, string.format("AH %d (%s)", d.auctions, ageText(d.auctionsTs, now)))
	elseif d.auctionsStale then
		table.insert(parts, string.format("AH stale (%s)", ageText(d.auctionsTs, now)))
	else
		table.insert(parts, "AH never scanned")
	end
	return d.character .. ": " .. table.concat(parts, ", ")
end

function WowAHTrackerStock_Print()
	local now = time()
	local results = buildAccountStock(now)
	if #results == 0 then
		printMsg("No crafted items are known yet (data.lua carries none, and the fallback list is empty).")
		return
	end
	printMsg("Crafted-item stock - THIS account only (the earnings report combines all accounts). Mail and banks are not counted.")
	local any = false
	for _, result in ipairs(results) do
		DEFAULT_CHAT_FRAME:AddMessage(string.format("  %s", result.item.name))
		if #result.rows == 0 then
			DEFAULT_CHAT_FRAME:AddMessage("    nothing seen or sold here yet")
		end
		for _, row in ipairs(result.rows) do
			any = true
			local detailParts = {}
			for _, d in ipairs(row.details) do
				table.insert(detailParts, detailText(d, now))
			end
			local size = row.members > 1 and string.format(" (group of %d)", row.members) or ""
			local shown = row.unknown and (row.total > 0 and (tostring(row.total) .. "+ known") or "unknown") or tostring(row.total)
			DEFAULT_CHAT_FRAME:AddMessage(
				string.format(
					"    |cff%s[%s]|r %s%s: %s  -  %s",
					STATUS_COLOR[row.status] or "ffffff",
					row.status,
					row.label,
					size,
					shown,
					#detailParts > 0 and table.concat(detailParts, "; ") or "no characters here"
				)
			)
		end
	end
	if any then
		DEFAULT_CHAT_FRAME:AddMessage("  To refresh the AH numbers: open the Auction House and its Auctions tab. Unknown is never counted as 0.")
	end
end

-- One quiet line at login, only if a cluster on this account is OUT or LOW.
local function printLoginLine()
	local now = time()
	local flagged = 0
	for _, result in ipairs(buildAccountStock(now)) do
		for _, row in ipairs(result.rows) do
			if row.status == "OUT" or row.status == "LOW" then
				flagged = flagged + 1
			end
		end
	end
	if flagged > 0 then
		printMsg(string.format("Stock: %d crafted-item cluster(s) out or low on this account - /waht stock", flagged))
	end
end

-- ============================================================================
-- RESTOCK WINDOW: while the Auction House is open, a small window lists the
-- crafted items THIS character has none of - not in its bags and not listed.
-- Simon's routine per realm is: empty the mailbox (expired listings come back
-- to the bags), open the AH, post with TSM, log off. So when the AH opens, an
-- item that is neither in the bags nor listed is one that sold here and must be
-- brought in. Every crafted item counts unless data.lua says restock = false
-- (trackedItems.json; e.g. Sky Golem, which is only stocked on some realms).
-- Mail is not counted: an item still sitting in the mailbox shows as missing.
-- Read-only: it never writes to the SavedVariables (apart from where the window
-- was dragged to) and never queries the AH itself - listings are known only
-- once the client holds the full owned-auction list; until then an item that
-- isn't in the bags is shown as "not sure", never as missing.
-- ============================================================================

-- Pure (testable without the game). items: { {id, name, restock}, ... };
-- bagCounts/ahCounts: { [id] = n } or nil when unknown. Returns
-- { missing = {names}, unsure = {names}, stocked = n, expected = n, bagsKnown = bool }.
function WowAHTrackerStock_RestockList(items, bagCounts, ahCounts)
	local result = { missing = {}, unsure = {}, stocked = 0, expected = 0, bagsKnown = bagCounts ~= nil }
	for _, item in ipairs(items) do
		if item.restock then
			result.expected = result.expected + 1
			local bags = bagCounts and bagCounts[item.id] or 0
			local listed = ahCounts and ahCounts[item.id] or 0
			if bags + listed > 0 then
				result.stocked = result.stocked + 1
			elseif bagCounts == nil or ahCounts == nil then
				table.insert(result.unsure, item.name)
			else
				table.insert(result.missing, item.name)
			end
		end
	end
	return result
end

-- The window's text for a RestockList result.
function WowAHTrackerStock_RestockText(r)
	if r.expected == 0 then
		return "|cffaaaaaaNo crafted items are marked for restocking.|r"
	end
	if not r.bagsKnown then
		return "|cffaaaaaaBags not loaded yet.|r"
	end
	local lines = {}
	if #r.missing > 0 then
		table.insert(lines, string.format("|cffff5555Restock (%d):|r", #r.missing))
		for _, name in ipairs(r.missing) do
			table.insert(lines, "  " .. name)
		end
	end
	if #r.unsure > 0 then
		if #lines > 0 then
			table.insert(lines, " ")
		end
		table.insert(lines, string.format("|cffaaaaaaNot in bags (%d) - open the Auctions tab to see if they're listed:|r", #r.unsure))
		for _, name in ipairs(r.unsure) do
			table.insert(lines, "  |cffaaaaaa" .. name .. "|r")
		end
	end
	if #r.missing == 0 and #r.unsure == 0 then
		table.insert(lines, string.format("|cff33ff99All %d items stocked.|r", r.expected))
	else
		table.insert(lines, " ")
		table.insert(lines, string.format("Stocked: %d/%d", r.stocked, r.expected))
	end
	return table.concat(lines, "\n")
end

local restockFrame, restockBody
local ahOpen = false
-- Who has the window open: nil (closed), "ah" (opened by the AH, closes with
-- it) or "manual" (minimap button / /waht restock show, stays until closed).
-- The X just closes it: an AH-opened window comes back at the next AH visit.
local restockShownBy = nil

-- Opens with the AH unless switched off (/waht restock, or right-click on the
-- minimap button). Per account, like the rest of WowAHTrackerStockDB.
local function restockAutoEnabled()
	return not (WowAHTrackerStockDB and WowAHTrackerStockDB.restockAuto == false)
end

local function restockWindow()
	if restockFrame then
		return restockFrame
	end
	local f = CreateFrame("Frame", "WowAHTrackerRestockFrame", UIParent, "BackdropTemplate")
	f:SetSize(250, 80)
	f:SetFrameStrata("DIALOG")
	f:SetClampedToScreen(true)
	if f.SetBackdrop then
		f:SetBackdrop({
			bgFile = "Interface\\Tooltips\\UI-Tooltip-Background",
			edgeFile = "Interface\\Tooltips\\UI-Tooltip-Border",
			tile = true,
			tileSize = 16,
			edgeSize = 16,
			insets = { left = 4, right = 4, top = 4, bottom = 4 },
		})
		f:SetBackdropColor(0, 0, 0, 0.85)
	end
	-- Draggable; where it was left is remembered (per account, like the rest of the stock data).
	f:SetMovable(true)
	f:EnableMouse(true)
	f:RegisterForDrag("LeftButton")
	f:SetScript("OnDragStart", f.StartMoving)
	f:SetScript("OnDragStop", function(self)
		self:StopMovingOrSizing()
		local point, _, relativePoint, x, y = self:GetPoint()
		EnsureDB()
		WowAHTrackerStockDB.restockPos = { point = point, relativePoint = relativePoint, x = x, y = y }
	end)
	local pos = WowAHTrackerStockDB and WowAHTrackerStockDB.restockPos
	if pos and pos.point then
		f:SetPoint(pos.point, UIParent, pos.relativePoint or pos.point, pos.x or 0, pos.y or 0)
	else
		f:SetPoint("RIGHT", UIParent, "RIGHT", -60, 120)
	end

	local title = f:CreateFontString(nil, "OVERLAY", "GameFontNormal")
	title:SetPoint("TOPLEFT", 10, -10)
	title:SetPoint("RIGHT", -28, 0)
	title:SetJustifyH("LEFT")
	f.title = title

	local close = CreateFrame("Button", nil, f, "UIPanelCloseButton")
	close:SetPoint("TOPRIGHT", -2, -2)
	close:SetScript("OnClick", function()
		restockShownBy = nil -- an AH-opened window is back at the next AH visit
		f:Hide()
	end)

	local body = f:CreateFontString(nil, "OVERLAY", "GameFontHighlightSmall")
	body:SetPoint("TOPLEFT", title, "BOTTOMLEFT", 0, -6)
	body:SetWidth(230)
	body:SetJustifyH("LEFT")
	body:SetJustifyV("TOP")
	restockBody = body

	f:Hide()
	restockFrame = f
	return f
end

-- Listing counts for the window, and (outside the AH) how old they are.
-- At the AH only the live list counts: a saved snapshot from the last visit
-- would still show listings that have since sold or expired. Away from the AH
-- the client may still hold its owned-auction list from earlier in the
-- session, but with no age attached - so it's never used there; this
-- character's last snapshot (<= 48h, the same rule as everywhere else) stands
-- in instead, labelled with its age.
local function restockListings(items)
	if ahOpen then
		return ownedAuctionCounts(items), nil
	end
	local rec = characterRecord(false)
	local snap = rec and rec.auctions
	if snap and snap.counts and snap.ts and (time() - snap.ts) <= AUCTION_MAX_AGE_SECONDS then
		return snap.counts, snap.ts
	end
	return nil, nil
end

local function refreshRestockWindow()
	if not restockShownBy then
		return
	end
	local items = craftedItems()
	local listings, asOf = restockListings(items)
	local result = WowAHTrackerStock_RestockList(items, scanBagCounts(items), listings)
	local text = WowAHTrackerStock_RestockText(result)
	if asOf then
		text = text .. string.format("\n|cffaaaaaaListings as of your last AH visit (%s).|r", ageText(asOf, time()))
	elseif not ahOpen and not listings then
		text = text .. "\n|cffaaaaaaNot at the AH: listings unknown until you open it.|r"
	end
	local f = restockWindow()
	f.title:SetText(string.format("Restock - %s", GetRealmName() or "?"))
	restockBody:SetText(text)
	f:SetHeight(math.max(60, restockBody:GetStringHeight() + 40))
	f:Show()
end

local function hideRestockWindow()
	restockShownBy = nil
	if restockFrame then
		restockFrame:Hide()
	end
end

local function onAuctionHouseShown()
	if ahOpen then
		return -- both AH-open events can fire for the same visit
	end
	ahOpen = true
	if not restockShownBy and restockAutoEnabled() then
		restockShownBy = "ah"
	end
	refreshRestockWindow() -- a manually opened window switches to live listings
end

local function onAuctionHouseClosed()
	ahOpen = false
	if restockShownBy == "ah" then
		hideRestockWindow()
	else
		refreshRestockWindow() -- a manually opened window stays, back on the saved snapshot
	end
end

-- Minimap button left-click / `/waht restock show`: open or close the window now, anywhere.
function WowAHTrackerStock_ToggleRestockWindow()
	if restockShownBy then
		hideRestockWindow()
	else
		restockShownBy = "manual"
		refreshRestockWindow()
	end
end

-- Minimap button right-click / `/waht restock`: should the window open by itself at the AH?
function WowAHTrackerStock_ToggleRestockAuto()
	EnsureDB()
	local enable = not restockAutoEnabled()
	WowAHTrackerStockDB.restockAuto = enable
	if enable then
		printMsg("Restock window: opens automatically at the Auction House.")
		if ahOpen and not restockShownBy then
			restockShownBy = "ah"
			refreshRestockWindow()
		end
	else
		printMsg("Restock window: no longer opens by itself - left-click the minimap button or /waht restock show to open it.")
		if restockShownBy == "ah" then
			hideRestockWindow()
		end
	end
	if WowAHTrackerStock_UpdateMinimapButton then
		WowAHTrackerStock_UpdateMinimapButton()
	end
end

function WowAHTrackerStock_RestockCommand(arg)
	arg = (arg or ""):lower():gsub("^%s+", ""):gsub("%s+$", "")
	if arg == "show" or arg == "open" then
		WowAHTrackerStock_ToggleRestockWindow()
	elseif arg == "" or arg == "auto" then
		WowAHTrackerStock_ToggleRestockAuto()
	else
		printMsg("Usage: /waht restock (switch opening at the AH on/off) | /waht restock show (open/close it now)")
	end
end

-- ============================================================================
-- MINIMAP BUTTON: a small round button on the minimap's edge (no library -
-- the classic hand-built kind). Left-click opens/closes the restock window,
-- right-click switches automatic opening at the AH on/off, drag moves it around
-- the edge. Position and visibility are kept per account; /waht minimap hides
-- or shows it.
-- ============================================================================

local MINIMAP_DEFAULT_ANGLE = 210 -- degrees, lower left
local minimapButton

local function minimapSettings()
	EnsureDB()
	WowAHTrackerStockDB.minimap = WowAHTrackerStockDB.minimap or {}
	return WowAHTrackerStockDB.minimap
end

local function placeMinimapButton()
	if not (minimapButton and Minimap) then
		return
	end
	local angle = math.rad(minimapSettings().angle or MINIMAP_DEFAULT_ANGLE)
	local radius = (Minimap:GetWidth() or 140) / 2 + 10
	minimapButton:ClearAllPoints()
	minimapButton:SetPoint("CENTER", Minimap, "CENTER", math.cos(angle) * radius, math.sin(angle) * radius)
end

-- math.atan2 is Lua 5.1 (the game); math.atan(y, x) is the same in 5.3+.
local atan2 = math.atan2 or function(y, x)
	return math.atan(y, x)
end

local function dragMinimapButton()
	local mx, my = Minimap:GetCenter()
	local cx, cy = GetCursorPosition()
	local scale = Minimap:GetEffectiveScale()
	if not (mx and cx and scale and scale > 0) then
		return
	end
	minimapSettings().angle = math.deg(atan2(cy / scale - my, cx / scale - mx))
	placeMinimapButton()
end

function WowAHTrackerStock_UpdateMinimapButton()
	if not minimapButton then
		return
	end
	if minimapSettings().hide then
		minimapButton:Hide()
	else
		placeMinimapButton()
		minimapButton:Show()
	end
end

local function createMinimapButton()
	if minimapButton or not Minimap then
		return
	end
	local b = CreateFrame("Button", "WowAHTrackerMinimapButton", Minimap)
	b:SetSize(31, 31)
	b:SetFrameStrata("MEDIUM")
	b:SetFrameLevel(8)
	b:RegisterForClicks("LeftButtonUp", "RightButtonUp")
	b:RegisterForDrag("LeftButton")
	b:SetHighlightTexture("Interface\\Minimap\\UI-Minimap-ZoomButton-Highlight")
	local bg = b:CreateTexture(nil, "BACKGROUND")
	bg:SetSize(20, 20)
	bg:SetTexture("Interface\\Minimap\\UI-Minimap-Background")
	bg:SetPoint("TOPLEFT", 7, -5)
	local icon = b:CreateTexture(nil, "ARTWORK")
	icon:SetSize(17, 17)
	icon:SetTexture("Interface\\Icons\\INV_Misc_Coin_02")
	icon:SetPoint("TOPLEFT", 7, -6)
	local border = b:CreateTexture(nil, "OVERLAY")
	border:SetSize(53, 53)
	border:SetTexture("Interface\\Minimap\\MiniMap-TrackingBorder")
	border:SetPoint("TOPLEFT")

	b:SetScript("OnClick", function(_, button)
		if button == "RightButton" then
			WowAHTrackerStock_ToggleRestockAuto()
		else
			WowAHTrackerStock_ToggleRestockWindow()
		end
	end)
	b:SetScript("OnDragStart", function(self)
		self:SetScript("OnUpdate", dragMinimapButton)
	end)
	b:SetScript("OnDragStop", function(self)
		self:SetScript("OnUpdate", nil)
	end)
	b:SetScript("OnEnter", function(self)
		if not GameTooltip then
			return
		end
		GameTooltip:SetOwner(self, "ANCHOR_LEFT")
		GameTooltip:SetText("WoW AH Tracker")
		GameTooltip:AddLine("Left-click: open/close the restock window", 1, 1, 1)
		GameTooltip:AddLine(
			"Right-click: open it at the AH automatically - " .. (restockAutoEnabled() and "|cff33ff99ON|r" or "|cffff5555OFF|r"),
			1,
			1,
			1
		)
		GameTooltip:AddLine("Drag: move around the minimap. /waht minimap hides this button.", 0.7, 0.7, 0.7)
		GameTooltip:Show()
	end)
	b:SetScript("OnLeave", function()
		if GameTooltip then
			GameTooltip:Hide()
		end
	end)
	minimapButton = b
	WowAHTrackerStock_UpdateMinimapButton()
end

function WowAHTrackerStock_MinimapCommand()
	local s = minimapSettings()
	s.hide = not s.hide
	createMinimapButton()
	WowAHTrackerStock_UpdateMinimapButton()
	printMsg(s.hide and "Minimap button hidden - /waht minimap brings it back." or "Minimap button shown.")
end

local function isAuctioneerInteraction(interactionType)
	return Enum and Enum.PlayerInteractionType and interactionType == Enum.PlayerInteractionType.Auctioneer
end

local eventFrame = CreateFrame("Frame")
eventFrame:RegisterEvent("ADDON_LOADED")
eventFrame:RegisterEvent("PLAYER_LOGIN")
eventFrame:RegisterEvent("BAG_UPDATE_DELAYED")
eventFrame:RegisterEvent("OWNED_AUCTIONS_UPDATED")
-- AH open/close: the dedicated events plus the generic interaction ones, each
-- registered under pcall so a name this client doesn't know can't break the file.
for _, ev in ipairs({ "AUCTION_HOUSE_SHOW", "AUCTION_HOUSE_CLOSED", "PLAYER_INTERACTION_MANAGER_FRAME_SHOW", "PLAYER_INTERACTION_MANAGER_FRAME_HIDE" }) do
	pcall(eventFrame.RegisterEvent, eventFrame, ev)
end
eventFrame:SetScript("OnEvent", function(_, event, arg1)
	if event == "ADDON_LOADED" then
		if arg1 == "WowAHTracker" then
			EnsureDB()
		end
	elseif event == "PLAYER_LOGIN" then
		printLoginLine()
		createMinimapButton()
	elseif event == "BAG_UPDATE_DELAYED" then
		requestBagScan()
		refreshRestockWindow()
	elseif event == "OWNED_AUCTIONS_UPDATED" then
		scanAuctionsNow()
		refreshRestockWindow()
	elseif event == "AUCTION_HOUSE_SHOW" then
		onAuctionHouseShown()
	elseif event == "AUCTION_HOUSE_CLOSED" then
		onAuctionHouseClosed()
	elseif event == "PLAYER_INTERACTION_MANAGER_FRAME_SHOW" then
		if isAuctioneerInteraction(arg1) then
			onAuctionHouseShown()
		end
	elseif event == "PLAYER_INTERACTION_MANAGER_FRAME_HIDE" then
		if isAuctioneerInteraction(arg1) then
			onAuctionHouseClosed()
		end
	end
end)
