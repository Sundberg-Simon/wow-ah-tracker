-- WoW AH Tracker - crafted-item stock (step 1 of 3: the PROBE)
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

local loader = CreateFrame("Frame")
loader:RegisterEvent("ADDON_LOADED")
loader:SetScript("OnEvent", function(_, _, addonName)
	if addonName == "WowAHTracker" then
		EnsureDB()
	end
end)
