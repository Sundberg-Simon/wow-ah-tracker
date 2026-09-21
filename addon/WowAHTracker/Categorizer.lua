-- WoW AH Tracker - bag categorizer (v1)
--
-- A UI for building the tracked-item list from what's actually in Simon's
-- bags, instead of looking up item IDs by hand. Opened via /waht categorize.
-- Persists selections in WowAHTrackerCategorizerDB (a separate
-- SavedVariables table declared in the .toc - NOT data.lua, which the sync
-- pipeline overwrites on every fetch and must never be touched here) so a
-- bulk first pass can span multiple play sessions. Export produces a plain
-- text block Simon pastes to Claude Code (not read by anything in this
-- addon or repo) to actually update config/trackedItems.json.

local ROW_HEIGHT = 20
local COLUMN_WIDTH = 260
local COLUMN_HEIGHT = 380

local function printMsg(msg)
	DEFAULT_CHAT_FRAME:AddMessage("|cff33ff99WoW AH Tracker|r: " .. msg)
end

-- ---- bag scanning ----

-- BACKPACK_CONTAINER (0) and NUM_BAG_SLOTS (4, the four equippable bag
-- slots) are long-standing FrameXML globals - covers bags 0-4. The reagent
-- bag (added in Dragonflight) is a separate enum member, included only if
-- present so this doesn't error on a client where it isn't.
local function GetAllBagIDs()
	local bags = {}
	for i = BACKPACK_CONTAINER, NUM_BAG_SLOTS do
		table.insert(bags, i)
	end
	if Enum.BagIndex and Enum.BagIndex.ReagentBag then
		table.insert(bags, Enum.BagIndex.ReagentBag)
	end
	return bags
end

-- ---- item variants ----
--
-- Gear that is the same base item but at different item levels (a heroic
-- helm at ilvl 308 vs 311) trades at very different prices, so for the
-- patch-specific list gear is told apart by ilvl. Nothing else about the item
-- (secondary stats, sockets, ...) matters here - only the item level.
-- Non-gear (materials, consumables, ...) has no variants and stays keyed by
-- item id alone.

-- Plain-text split (no patterns), keeping empty fields: item links are full
-- of them ("item:271441::::::::80:...").
local function SplitOn(str, sep)
	local parts = {}
	local from = 1
	while true do
		local at = string.find(str, sep, from, true)
		if not at then
			table.insert(parts, string.sub(str, from))
			return parts
		end
		table.insert(parts, string.sub(str, from, at - 1))
		from = at + 1
	end
end

-- The bonus ids embedded in an item link. Fields after "item:" are
-- itemID:enchant:gem1..gem4:suffix:unique:linkLevel:spec:modifiersMask:
-- context:numBonusIDs:bonusID1... so the count is field 13 and the ids follow.
-- Not used to tell variants apart (ilvl is) - exported so the mapping from
-- bonus ids to ilvl can be learned for the sync side.
local function ParseBonusIds(link)
	local itemString = link and string.match(link, "item:([^|]*)")
	if not itemString then
		return {}
	end
	local parts = SplitOn(itemString, ":")
	local count = tonumber(parts[13]) or 0
	local ids = {}
	for i = 1, count do
		local id = tonumber(parts[13 + i])
		if id then
			table.insert(ids, id)
		end
	end
	return ids
end

-- Weapons (class 2) and armor (class 4) that go in an equipment slot. Armor
-- with no equip slot is cosmetic/misc and has nothing to vary by.
local function IsGear(itemId)
	local _, _, _, equipLoc, _, classID = C_Item.GetItemInfoInstant(itemId)
	return (classID == 2 or classID == 4) and equipLoc ~= nil and equipLoc ~= ""
end

-- The item level the player sees on the tooltip, upgrades included. nil when
-- the client hasn't loaded the item yet (the caller then treats it as
-- unknown rather than guessing).
local function GetItemLevel(link)
	local level = C_Item.GetDetailedItemLevelInfo and C_Item.GetDetailedItemLevelInfo(link)
	if not level or level <= 0 then
		level = select(4, C_Item.GetItemInfo(link))
	end
	if level and level > 0 then
		return math.floor(level + 0.5)
	end
	return nil
end

-- Persistence key: the bare item id for a base entry, "id@ilvl" for one
-- variant of a gear item.
local function EntryKey(itemId, ilvl)
	if ilvl then
		return string.format("%d@%d", itemId, ilvl)
	end
	return itemId
end

-- Dedupes by item id - and, for gear, by item id + ilvl - so a stack split
-- across multiple slots/bags shows once (with its total count) while a 308
-- and a 311 helm show as two rows. Resolves a name even if C_Container's own
-- itemName field is empty (item data not yet cached client-side - falls back
-- to C_Item.GetItemInfo, then a placeholder rather than erroring).
local function ScanBagContents()
	local seen = {}
	local items = {}
	for _, bagID in ipairs(GetAllBagIDs()) do
		local numSlots = C_Container.GetContainerNumSlots(bagID)
		for slot = 1, numSlots do
			local info = C_Container.GetContainerItemInfo(bagID, slot)
			if info and info.itemID then
				local link = info.hyperlink
				local ilvl = link and IsGear(info.itemID) and GetItemLevel(link) or nil
				local key = EntryKey(info.itemID, ilvl)
				if seen[key] then
					seen[key].count = seen[key].count + (info.stackCount or 1)
				else
					local name = info.itemName
					if not name or name == "" then
						name = C_Item.GetItemInfo(info.itemID)
					end
					-- bagID/slot kept (not just itemID) so the row can show the
					-- exact real tooltip via GameTooltip:SetBagItem - durability,
					-- enchants, etc. - not just a generic base-item tooltip.
					local item = {
						id = info.itemID,
						name = name or ("Item " .. info.itemID),
						icon = info.iconFileID,
						bagID = bagID,
						slot = slot,
						ilvl = ilvl,
						bonus = table.concat(ParseBonusIds(link), ","),
						count = info.stackCount or 1,
					}
					seen[key] = item
					table.insert(items, item)
				end
			end
		end
	end
	table.sort(items, function(a, b)
		if a.name ~= b.name then
			return a.name < b.name
		end
		return (a.ilvl or 0) < (b.ilvl or 0)
	end)
	return items
end

-- ---- persistence ----

local function EnsureDB()
	WowAHTrackerCategorizerDB = WowAHTrackerCategorizerDB or {}
	WowAHTrackerCategorizerDB.permanent = WowAHTrackerCategorizerDB.permanent or {}
	WowAHTrackerCategorizerDB.patchSpecific = WowAHTrackerCategorizerDB.patchSpecific or {}
end

-- Add-if-missing merge from the live tracked-item data, never overwrites or
-- removes anything already staged - safe to call on every refresh. This is
-- what makes a later top-up session show "already tracked" items correctly
-- instead of only whatever was picked in that one sitting, while still
-- preserving a multi-session bulk pass that hasn't been exported yet.
local function SeedFromTrackedData()
	if not WowAhTrackerData or not WowAhTrackerData.items then
		return
	end
	for itemId, item in pairs(WowAhTrackerData.items) do
		local id = tonumber(itemId)
		if id and not WowAHTrackerCategorizerDB.permanent[id] and not WowAHTrackerCategorizerDB.patchSpecific[id] then
			if item.category == "patch-specific" and item.variants then
				-- Variant-tracked gear (CLAUDE.md #17): one staged entry per
				-- tracked item level - never a base entry, which would cover
				-- every ilvl and hide the per-ilvl bag rows.
				for ilvl in pairs(item.variants) do
					local key = EntryKey(id, ilvl)
					if not WowAHTrackerCategorizerDB.patchSpecific[key] then
						WowAHTrackerCategorizerDB.patchSpecific[key] = { id = id, name = item.name, ilvl = ilvl }
					end
				end
			elseif item.category == "patch-specific" then
				WowAHTrackerCategorizerDB.patchSpecific[id] = { id = id, name = item.name }
			else
				WowAHTrackerCategorizerDB.permanent[id] = { id = id, name = item.name }
			end
		end
	end
end

-- Which list, if any, already covers this bag item. Permanent entries and
-- patch-specific base entries (no ilvl) cover every variant of the item id;
-- a patch-specific variant entry covers just its own ilvl.
local function TrackedIn(item)
	local db = WowAHTrackerCategorizerDB
	if db.permanent[item.id] then
		return "permanent"
	end
	if db.patchSpecific[item.id] or (item.ilvl and db.patchSpecific[EntryKey(item.id, item.ilvl)]) then
		return "patch-specific"
	end
	return nil
end

local function IsTracked(item)
	return TrackedIn(item) ~= nil
end

-- Permanent items are always tracked by base id. Patch-specific gear is
-- tracked per ilvl (a variant entry); anything without an ilvl is a plain
-- base entry.
local function AddToCategory(item, itemName, category)
	if IsTracked(item) then
		return
	end
	if category == "patch-specific" then
		WowAHTrackerCategorizerDB.patchSpecific[EntryKey(item.id, item.ilvl)] = {
			id = item.id,
			name = itemName,
			ilvl = item.ilvl,
			bonus = item.ilvl and item.bonus or nil,
		}
	else
		WowAHTrackerCategorizerDB.permanent[item.id] = { id = item.id, name = itemName }
	end
end

local function RemoveFromCategory(entry, category)
	if category == "patch-specific" then
		WowAHTrackerCategorizerDB.patchSpecific[EntryKey(entry.id, entry.ilvl)] = nil
	else
		WowAHTrackerCategorizerDB.permanent[entry.id] = nil
	end
end

local function SortedEntries(dbTable)
	local list = {}
	for _, entry in pairs(dbTable) do
		table.insert(list, entry)
	end
	table.sort(list, function(a, b)
		if a.name ~= b.name then
			return a.name < b.name
		end
		return (a.ilvl or 0) < (b.ilvl or 0)
	end)
	return list
end

-- "[311] " for a variant; "[any ilvl] " for a base entry of a gear item
-- (tracked before variants existed - it lumps every ilvl together, which is
-- what the player can now remove and re-add per ilvl); "" for non-gear.
local function IlvlLabel(entry)
	if entry.ilvl then
		return string.format("[%d] ", entry.ilvl)
	end
	if IsGear(entry.id) then
		return "[any ilvl] "
	end
	return ""
end

-- ---- UI ----

local frame
local bagRows, permRows, patchRows = {}, {}, {}
local bagContent, permContent, patchContent
local exportFrame, exportEditBox

local function HideRowsFrom(pool, fromIndex)
	for i = fromIndex, #pool do
		pool[i]:Hide()
	end
end

-- Sizes to the row's actual parent (the scroll frame's content child), not
-- the outer column constant - the content area is narrower than the column
-- itself to leave room for the scrollbar, and hardcoding the wrong width
-- here would let row buttons overflow past the visible/scrollable area.
local function PositionRow(row, index)
	row:ClearAllPoints()
	row:SetPoint("TOPLEFT", 0, -(index - 1) * ROW_HEIGHT)
	row:SetWidth(row:GetParent():GetWidth())
end

local RefreshAll -- forward-declared, rows call this after mutating the DB

local function GetOrCreateBagRow(index)
	local row = bagRows[index]
	if row then
		return row
	end
	row = CreateFrame("Frame", nil, bagContent)
	row:SetHeight(ROW_HEIGHT)

	row.icon = row:CreateTexture(nil, "ARTWORK")
	row.icon:SetSize(16, 16)
	row.icon:SetPoint("LEFT", 2, 0)

	row.text = row:CreateFontString(nil, "OVERLAY", "GameFontNormalSmall")
	row.text:SetPoint("LEFT", row.icon, "RIGHT", 4, 0)
	row.text:SetPoint("RIGHT", row, "RIGHT", -52, 0)
	row.text:SetJustifyH("LEFT")
	row.text:SetWordWrap(false)

	-- Hover the row (icon or name) to see the item's real tooltip, exactly
	-- as it would show in the actual bag - SetBagItem rather than
	-- SetItemByID so it reflects this specific instance (durability,
	-- enchants, etc.), not just the generic base item.
	row:EnableMouse(true)
	row:SetScript("OnLeave", function()
		GameTooltip:Hide()
	end)

	row.addPerm = CreateFrame("Button", nil, row, "UIPanelButtonTemplate")
	row.addPerm:SetSize(24, 18)
	row.addPerm:SetPoint("RIGHT", -26, 0)
	row.addPerm:SetText("+P")
	row.addPerm:GetFontString():SetFontObject("GameFontNormalSmall")

	row.addPatch = CreateFrame("Button", nil, row, "UIPanelButtonTemplate")
	row.addPatch:SetSize(24, 18)
	row.addPatch:SetPoint("RIGHT", 0, 0)
	row.addPatch:SetText("+S")
	row.addPatch:GetFontString():SetFontObject("GameFontNormalSmall")

	bagRows[index] = row
	return row
end

local function GetOrCreateTrackedRow(pool, parent, category)
	local index = #pool + 1
	local row = CreateFrame("Frame", nil, parent)
	row:SetHeight(ROW_HEIGHT)

	row.text = row:CreateFontString(nil, "OVERLAY", "GameFontNormalSmall")
	row.text:SetPoint("LEFT", 2, 0)
	row.text:SetJustifyH("LEFT")
	row.text:SetWordWrap(false)

	if category == "patch-specific" then
		row.patchBox = CreateFrame("EditBox", nil, row, "InputBoxTemplate")
		row.patchBox:SetSize(44, 16)
		row.patchBox:SetAutoFocus(false)
		row.patchBox:SetPoint("RIGHT", -26, 0)
		row.text:SetPoint("RIGHT", row.patchBox, "LEFT", -4, 0)
	else
		row.text:SetPoint("RIGHT", row, "RIGHT", -26, 0)
	end

	row.remove = CreateFrame("Button", nil, row, "UIPanelButtonTemplate")
	row.remove:SetSize(20, 18)
	row.remove:SetPoint("RIGHT", 0, 0)
	row.remove:SetText("x")
	row.remove:GetFontString():SetFontObject("GameFontNormalSmall")

	pool[index] = row
	return row
end

local function RebuildBagColumn(bagItems)
	local shown = 0
	for _, item in ipairs(bagItems) do
		if not IsTracked(item) then
			shown = shown + 1
			local row = GetOrCreateBagRow(shown)
			PositionRow(row, shown)
			row.text:SetText(string.format("%s%s (%d)", IlvlLabel(item), item.name, item.id))
			row.icon:SetTexture(item.icon)
			row:SetScript("OnEnter", function(self)
				GameTooltip:SetOwner(self, "ANCHOR_RIGHT")
				GameTooltip:SetBagItem(item.bagID, item.slot)
				GameTooltip:Show()
			end)
			row.addPerm:SetScript("OnClick", function()
				-- Permanent items are tracked by item id alone, and random-
				-- suffix variants ("Ring of the X" vs "Ring of the Y") share
				-- one base id with the suffix conveyed separately (verified
				-- against Blizzard's own item/auction API - see CLAUDE.md).
				-- So the *tracked id* already covers every suffix roll
				-- automatically; only the display name needs resolving to
				-- the generic base name here, via the bare item id rather
				-- than this specific bag instance's suffixed name.
				local baseName = C_Item.GetItemInfo(item.id)
				AddToCategory(item, baseName or item.name, "permanent")
				RefreshAll()
			end)
			row.addPatch:SetScript("OnClick", function()
				-- Gear is added as this specific ilvl (item.ilvl); anything
				-- else as a plain base entry.
				local baseName = C_Item.GetItemInfo(item.id)
				AddToCategory(item, baseName or item.name, "patch-specific")
				RefreshAll()
			end)
			row:Show()
		end
	end
	HideRowsFrom(bagRows, shown + 1)
	bagContent:SetHeight(math.max(1, shown * ROW_HEIGHT))
end

local function RebuildTrackedColumn(pool, parent, dbTable, category)
	local entries = SortedEntries(dbTable)
	for i = 1, #pool do
		pool[i]:Hide()
	end
	for i, entry in ipairs(entries) do
		local row = pool[i] or GetOrCreateTrackedRow(pool, parent, category)
		PositionRow(row, i)
		local label = category == "patch-specific" and IlvlLabel(entry) or ""
		row.text:SetText(string.format("%s%s (%d)", label, entry.name, entry.id))
		if row.patchBox then
			row.patchBox:SetText(entry.patch or "")
			row.patchBox:SetScript("OnEditFocusLost", function(self)
				local text = self:GetText()
				entry.patch = (text ~= "" and text) or nil
			end)
			row.patchBox:SetScript("OnEnterPressed", function(self)
				self:ClearFocus()
			end)
		end
		row.remove:SetScript("OnClick", function()
			RemoveFromCategory(entry, category)
			RefreshAll()
		end)
		row:Show()
	end
	parent:SetHeight(math.max(1, #entries * ROW_HEIGHT))
end

RefreshAll = function()
	EnsureDB()
	RebuildTrackedColumn(permRows, permContent, WowAHTrackerCategorizerDB.permanent, "permanent")
	RebuildTrackedColumn(patchRows, patchContent, WowAHTrackerCategorizerDB.patchSpecific, "patch-specific")
	RebuildBagColumn(ScanBagContents())
end

-- ---- export ----

local function BuildExportText()
	local lines = {}
	table.insert(lines, "# wow-ah-tracker categorizer export - " .. date("%Y-%m-%d %H:%M"))

	local perm = SortedEntries(WowAHTrackerCategorizerDB.permanent)
	table.insert(lines, string.format("# Permanent (%d)", #perm))
	for _, entry in ipairs(perm) do
		table.insert(lines, string.format("%d | %s", entry.id, entry.name))
	end

	local patch = SortedEntries(WowAHTrackerCategorizerDB.patchSpecific)
	table.insert(lines, string.format("# Patch-specific (%d)", #patch))
	for _, entry in ipairs(patch) do
		local line = string.format("%d | %s", entry.id, entry.name)
		if entry.ilvl then
			line = line .. string.format(" | ilvl=%d", entry.ilvl)
			if entry.bonus and entry.bonus ~= "" then
				line = line .. " | bonus=" .. entry.bonus
			end
		end
		if entry.patch then
			line = line .. " | patch=" .. entry.patch
		end
		table.insert(lines, line)
	end

	-- Everything in the bags right now, whether or not it is staged above, so
	-- it can be compared against config/trackedItems.json (the list the sync
	-- actually uses) rather than only against this addon's own staging.
	local bags = ScanBagContents()
	table.insert(lines, string.format("# Bags (%d)", #bags))
	for _, item in ipairs(bags) do
		local line = string.format("%d | %s", item.id, item.name)
		if item.ilvl then
			line = line .. string.format(" | ilvl=%d", item.ilvl)
			if item.bonus ~= "" then
				line = line .. " | bonus=" .. item.bonus
			end
		end
		line = line .. string.format(" | x%d", item.count)
		local staged = TrackedIn(item)
		if staged then
			line = line .. " | staged=" .. staged
		end
		table.insert(lines, line)
	end

	return table.concat(lines, "\n")
end

local function ShowExport()
	if not exportFrame then
		exportFrame = CreateFrame("Frame", "WowAHTrackerExportFrame", frame, "BackdropTemplate")
		exportFrame:SetSize(700, 420)
		exportFrame:SetPoint("CENTER")
		exportFrame:SetFrameStrata("DIALOG")
		exportFrame:SetBackdrop({
			bgFile = "Interface/DialogFrame/UI-DialogBox-Background",
			edgeFile = "Interface/DialogFrame/UI-DialogBox-Border",
			tile = true,
			tileSize = 32,
			edgeSize = 32,
			insets = { left = 11, right = 12, top = 12, bottom = 11 },
		})
		exportFrame:EnableMouse(true)
		exportFrame:SetMovable(true)
		exportFrame.title = exportFrame:CreateFontString(nil, "OVERLAY", "GameFontNormal")
		exportFrame.title:SetPoint("TOP", 0, -16)
		exportFrame.title:SetText("Export - Ctrl+A, Ctrl+C, paste to Claude Code")

		local close = CreateFrame("Button", nil, exportFrame, "UIPanelCloseButton")
		close:SetPoint("TOPRIGHT", -4, -4)
		close:SetScript("OnClick", function()
			exportFrame:Hide()
		end)

		local scroll = CreateFrame("ScrollFrame", nil, exportFrame, "UIPanelScrollFrameTemplate")
		scroll:SetPoint("TOPLEFT", 20, -40)
		scroll:SetPoint("BOTTOMRIGHT", -32, 20)

		exportEditBox = CreateFrame("EditBox", nil, scroll)
		exportEditBox:SetMultiLine(true)
		exportEditBox:SetFontObject("ChatFontNormal")
		exportEditBox:SetWidth(630)
		exportEditBox:SetAutoFocus(false)
		exportEditBox:SetScript("OnEscapePressed", function(self)
			self:ClearFocus()
		end)
		scroll:SetScrollChild(exportEditBox)
	end

	exportEditBox:SetText(BuildExportText())
	exportFrame:Show()
	exportEditBox:SetFocus()
	exportEditBox:HighlightText()
end

-- ---- frame construction ----

local function CreateColumn(parent, xOffset, titleText)
	local container = CreateFrame("Frame", nil, parent)
	container:SetSize(COLUMN_WIDTH, COLUMN_HEIGHT + 24)
	container:SetPoint("TOPLEFT", xOffset, -50)

	local title = container:CreateFontString(nil, "OVERLAY", "GameFontNormal")
	title:SetPoint("TOPLEFT", 0, 0)
	title:SetText(titleText)

	local scroll = CreateFrame("ScrollFrame", nil, container, "UIPanelScrollFrameTemplate")
	scroll:SetPoint("TOPLEFT", 0, -24)
	scroll:SetSize(COLUMN_WIDTH - 20, COLUMN_HEIGHT)

	local content = CreateFrame("Frame", nil, scroll)
	content:SetSize(COLUMN_WIDTH - 20, COLUMN_HEIGHT)
	scroll:SetScrollChild(content)

	return content
end

local function CreateCategorizerFrame()
	frame = CreateFrame("Frame", "WowAHTrackerCategorizerFrame", UIParent, "BackdropTemplate")
	frame:SetSize(3 * COLUMN_WIDTH + 60, COLUMN_HEIGHT + 120)
	frame:SetPoint("CENTER")
	frame:SetFrameStrata("HIGH")
	frame:SetBackdrop({
		bgFile = "Interface/DialogFrame/UI-DialogBox-Background",
		edgeFile = "Interface/DialogFrame/UI-DialogBox-Border",
		tile = true,
		tileSize = 32,
		edgeSize = 32,
		insets = { left = 11, right = 12, top = 12, bottom = 11 },
	})
	frame:EnableMouse(true)
	frame:SetMovable(true)
	frame:RegisterForDrag("LeftButton")
	frame:SetScript("OnDragStart", frame.StartMoving)
	frame:SetScript("OnDragStop", frame.StopMovingOrSizing)

	frame.title = frame:CreateFontString(nil, "OVERLAY", "GameFontNormalLarge")
	frame.title:SetPoint("TOP", 0, -16)
	frame.title:SetText("WoW AH Tracker - Categorizer")

	local close = CreateFrame("Button", nil, frame, "UIPanelCloseButton")
	close:SetPoint("TOPRIGHT", -4, -4)
	close:SetScript("OnClick", function()
		frame:Hide()
	end)

	bagContent = CreateColumn(frame, 20, "Bag contents")
	permContent = CreateColumn(frame, 20 + COLUMN_WIDTH + 10, "Permanent")
	patchContent = CreateColumn(frame, 20 + 2 * (COLUMN_WIDTH + 10), "Patch-specific")

	local refreshBtn = CreateFrame("Button", nil, frame, "UIPanelButtonTemplate")
	refreshBtn:SetSize(100, 22)
	refreshBtn:SetPoint("BOTTOMLEFT", 20, 16)
	refreshBtn:SetText("Refresh")
	refreshBtn:SetScript("OnClick", RefreshAll)

	local exportBtn = CreateFrame("Button", nil, frame, "UIPanelButtonTemplate")
	exportBtn:SetSize(100, 22)
	exportBtn:SetPoint("BOTTOMRIGHT", -20, 16)
	exportBtn:SetText("Export")
	exportBtn:SetScript("OnClick", ShowExport)

	-- Bags can change while this frame is open (moving items to/from bank,
	-- vendoring, etc.) - BAG_UPDATE_DELAYED fires once after a batch of
	-- individual BAG_UPDATE events settle, so this stays current without
	-- rebuilding on every single slot change.
	frame:RegisterEvent("BAG_UPDATE_DELAYED")
	frame:SetScript("OnEvent", function(_, event)
		if event == "BAG_UPDATE_DELAYED" and frame:IsShown() then
			RefreshAll()
		end
	end)

	-- CreateFrame() returns a frame that is shown by default. Without this,
	-- the very first /waht categorize after login/reload (the only time
	-- `frame` is still nil here) would create it already "shown", so the
	-- toggle's IsShown() check below immediately hides it right back in the
	-- same call - the window never actually appears, and it takes a second
	-- invocation to show the now-correctly-hidden existing frame. Starting
	-- hidden here makes the first toggle call behave the same as every
	-- later one.
	frame:Hide()
end

function WowAHTrackerCategorizer_Toggle()
	EnsureDB()
	SeedFromTrackedData()

	if not frame then
		CreateCategorizerFrame()
	end

	if frame:IsShown() then
		frame:Hide()
	else
		RefreshAll()
		frame:Show()
	end
end

local loader = CreateFrame("Frame")
loader:RegisterEvent("ADDON_LOADED")
loader:SetScript("OnEvent", function(_, _, addonName)
	if addonName == "WowAHTracker" then
		EnsureDB()
	end
end)
