-- WoW AH Tracker (v1)
--
-- Reads WowAhTrackerData, a Lua table exported by the wow-ah-tracker sync
-- pipeline (see repo README) and refreshed on this machine by a scheduled
-- Windows job - this addon does no network access of its own. data.lua may
-- be missing or stale (fetch job never ran, or hasn't run since login); all
-- of this is handled gracefully rather than throwing a Lua error.

local function printMsg(msg)
	DEFAULT_CHAT_FRAME:AddMessage("|cff33ff99WoW AH Tracker|r: " .. msg)
end

local function copperToGoldString(copper)
	if not copper then
		return "?"
	end
	return string.format("%.2fg", copper / 10000)
end

-- GetRealmName() strips spaces from the realm name (a documented WoW API
-- quirk - e.g. "Tarren Mill" becomes "TarrenMill"), but the connected-realm
-- export keeps the names as Blizzard's own API returns them, spaces
-- included. Normalize both sides the same way before comparing, or every
-- multi-word realm name would fail to match.
local function normalizeRealmName(name)
	return (name or ""):gsub("%s+", ""):lower()
end

local function findMyConnectedRealmId()
	if not WowAhTrackerData or not WowAhTrackerData.connectedRealms then
		return nil
	end
	local myRealm = normalizeRealmName(GetRealmName())
	for connectedRealmId, realmNames in pairs(WowAhTrackerData.connectedRealms) do
		for _, name in ipairs(realmNames) do
			if normalizeRealmName(name) == myRealm then
				return tonumber(connectedRealmId)
			end
		end
	end
	return nil
end

local function findMyRealmRow(item, myConnectedRealmId)
	if not myConnectedRealmId or not item.realms then
		return nil
	end
	for _, row in ipairs(item.realms) do
		if row.connectedRealmId == myConnectedRealmId then
			return row
		end
	end
	return nil
end

-- Sorted item ids so output order is stable run to run, not hash-order.
local function sortedItemIds(items)
	local ids = {}
	for itemId in pairs(items) do
		table.insert(ids, itemId)
	end
	table.sort(ids, function(a, b)
		return tonumber(a) < tonumber(b)
	end)
	return ids
end

local function buildSummaryLines()
	local lines = {}

	if not WowAhTrackerData then
		table.insert(
			lines,
			"No data file found - has the scheduled Windows fetch job run since this addon was installed?"
		)
		return lines
	end
	if not WowAhTrackerData.items or next(WowAhTrackerData.items) == nil then
		table.insert(lines, "Data file loaded but has no tracked items.")
		return lines
	end

	local myConnectedRealmId = findMyConnectedRealmId()
	if not myConnectedRealmId then
		table.insert(
			lines,
			string.format(
				"Could not match your realm (%s) to a connected-realm group - connectedRealms data may be missing or stale.",
				GetRealmName()
			)
		)
	end

	for _, itemId in ipairs(sortedItemIds(WowAhTrackerData.items)) do
		local item = WowAhTrackerData.items[itemId]
		local line = string.format(
			"%s: EU min %s, median %s",
			item.name or ("item " .. tostring(itemId)),
			copperToGoldString(item.euMinCopper),
			copperToGoldString(item.euMedianCopper)
		)

		local myRow = findMyRealmRow(item, myConnectedRealmId)
		if myRow then
			local compareText
			if item.euMinCopper and myRow.minPriceCopper <= item.euMinCopper then
				compareText = "at or below EU min"
			elseif item.euMinCopper then
				compareText = copperToGoldString(myRow.minPriceCopper - item.euMinCopper) .. " above EU min"
			else
				compareText = "no EU min to compare against"
			end
			line = line
				.. string.format(
					" | your realm: %s (%s, qty %d)",
					copperToGoldString(myRow.minPriceCopper),
					compareText,
					myRow.quantity or 0
				)
		elseif myConnectedRealmId then
			line = line .. " | no listings on your realm right now"
		end

		table.insert(lines, line)
	end

	return lines
end

local function printSummary()
	printMsg("Price summary:")
	for _, line in ipairs(buildSummaryLines()) do
		DEFAULT_CHAT_FRAME:AddMessage("  " .. line)
	end
end

-- AuctionHouseFrame.SearchBar only exists/works while the Auction House
-- window is open - driving it otherwise silently does nothing useful (no
-- error, no results), which reads as the addon being broken. Check
-- visibility ourselves and say so plainly instead.
local function searchAuctionHouse(query)
	if not query or query == "" then
		printMsg("Usage: /waht search <item name>")
		return
	end
	if not (AuctionHouseFrame and AuctionHouseFrame:IsShown()) then
		printMsg("Open the Auction House window first - the search API only works while it's active.")
		return
	end
	if not WowAhTrackerData or not WowAhTrackerData.items then
		printMsg("No tracked-item data loaded - can't resolve a name to an item id.")
		return
	end

	-- pairs() iteration order is undefined, so picking the first substring
	-- match found that way is arbitrary and can change between logins/
	-- reloads once two tracked items' names can plausibly share a substring
	-- (e.g. "ore" or "flask" matching more than one item at real-list
	-- scale). Resolve deterministically instead: an exact case-insensitive
	-- full-name match wins immediately if one exists; otherwise walk
	-- candidates in a stable item-id order and keep the shortest matching
	-- name (closest to an exact match), with item id as the tie-breaker.
	local needle = query:lower()
	local matchName
	for _, itemId in ipairs(sortedItemIds(WowAhTrackerData.items)) do
		local item = WowAhTrackerData.items[itemId]
		if item.name and item.name:lower() == needle then
			matchName = item.name
			break
		end
	end

	if not matchName then
		local bestName, bestItemId
		for _, itemId in ipairs(sortedItemIds(WowAhTrackerData.items)) do
			local item = WowAhTrackerData.items[itemId]
			if item.name and item.name:lower():find(needle, 1, true) then
				if not bestName or #item.name < #bestName then
					bestName, bestItemId = item.name, itemId
				end
			end
		end
		matchName = bestName
	end

	if not matchName then
		printMsg(string.format('No tracked item matches "%s".', query))
		return
	end

	-- Drive the actual search bar (SetSearchText + StartSearch), the same
	-- two calls the search box's own OnEnterPressed handler makes - do NOT
	-- call C_AuctionHouse.SendSearchQuery/SendBrowseQuery directly. That API
	-- technically fires the query and gets a real server response, but
	-- AuctionHouseFrame tracks its own "current search" state and only
	-- renders results it recognizes as belonging to that state; bypassing
	-- the search bar leaves the results list empty even though the query
	-- succeeded - confirmed via in-game testing, then verified against
	-- Blizzard's own client UI source (AuctionHouseSearchBarMixin:StartSearch
	-- in Blizzard_AuctionHouseSearchBar.lua), which itself calls
	-- AuctionHouseFrame:SendBrowseQuery(), never the C_AuctionHouse API
	-- directly.
	AuctionHouseFrame.SearchBar:SetSearchText(matchName)
	AuctionHouseFrame.SearchBar:StartSearch()
	printMsg(string.format("Searching the Auction House for %s...", matchName))
end

-- Single source of truth for both `/waht help` and the unknown-command
-- fallback, so the two can never drift out of sync with each other.
local COMMANDS = {
	{ usage = "/waht", desc = "Print the price summary (also shown automatically on login)." },
	{
		usage = "/waht search <item name>",
		desc = "Look up a tracked item and drive the Auction House search bar to it (AH window must be open).",
	},
	{ usage = "/waht categorize", desc = "Open the bag categorizer to build the tracked-item list from your bags." },
	{ usage = "/waht sales", desc = "Show recently captured AH sales (count + last 10)." },
	{
		usage = "/waht salesdebug",
		desc = "Show the last 25 mailbox scan traces, for diagnosing the sales log if something looks off.",
	},
	{ usage = "/waht purchases", desc = "Show recently captured AH purchases (count + last 10)." },
	{
		usage = "/waht purchasedebug",
		desc = "Show the last 25 mailbox scan traces, for diagnosing the purchase log if something looks off.",
	},
	{ usage = "/waht realms", desc = "Open the realm roster - add this character and see EU connected-realm coverage." },
	{ usage = "/waht help", desc = "List all commands (this)." },
}

local function printHelp()
	printMsg("Commands:")
	for _, entry in ipairs(COMMANDS) do
		DEFAULT_CHAT_FRAME:AddMessage(string.format("  %s - %s", entry.usage, entry.desc))
	end
end

SLASH_WOWAHTRACKER1 = "/waht"
SlashCmdList["WOWAHTRACKER"] = function(msg)
	local command, rest = (msg or ""):match("^(%S*)%s*(.-)$")
	command = (command or ""):lower()

	if command == "" then
		printSummary()
	elseif command == "search" then
		searchAuctionHouse(rest)
	elseif command == "categorize" then
		if WowAHTrackerCategorizer_Toggle then
			WowAHTrackerCategorizer_Toggle()
		else
			printMsg("Categorizer failed to load - check for a Lua error at login.")
		end
	elseif command == "sales" then
		if WowAHTrackerSalesLog_Print then
			WowAHTrackerSalesLog_Print()
		else
			printMsg("Sales log failed to load - check for a Lua error at login.")
		end
	elseif command == "salesdebug" then
		if WowAHTrackerSalesLog_PrintTrace then
			WowAHTrackerSalesLog_PrintTrace()
		else
			printMsg("Sales log failed to load - check for a Lua error at login.")
		end
	elseif command == "purchases" then
		if WowAHTrackerPurchaseLog_Print then
			WowAHTrackerPurchaseLog_Print()
		else
			printMsg("Purchase log failed to load - check for a Lua error at login.")
		end
	elseif command == "purchasedebug" then
		if WowAHTrackerPurchaseLog_PrintTrace then
			WowAHTrackerPurchaseLog_PrintTrace()
		else
			printMsg("Purchase log failed to load - check for a Lua error at login.")
		end
	elseif command == "realms" then
		if WowAHTrackerRealmRoster_Toggle then
			WowAHTrackerRealmRoster_Toggle()
		else
			printMsg("Realm roster failed to load - check for a Lua error at login.")
		end
	elseif command == "help" then
		printHelp()
	else
		printMsg('Unknown command "' .. command .. '". Type /waht help for a list of commands.')
	end
end

local eventFrame = CreateFrame("Frame")
eventFrame:RegisterEvent("PLAYER_LOGIN")
eventFrame:SetScript("OnEvent", function(_, event)
	if event == "PLAYER_LOGIN" then
		printSummary()
	end
end)
