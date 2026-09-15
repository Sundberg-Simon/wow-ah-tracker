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

-- Dedupes by item id (a stack split across multiple slots/bags should only
-- show once) and resolves a name even if C_Container's own itemName field
-- is empty (item data not yet cached client-side - falls back to
-- C_Item.GetItemInfo, then a placeholder rather than erroring).
local function ScanBagContents()
	local seen = {}
	local items = {}
	for _, bagID in ipairs(GetAllBagIDs()) do
		local numSlots = C_Container.GetContainerNumSlots(bagID)
		for slot = 1, numSlots do
			local info = C_Container.GetContainerItemInfo(bagID, slot)
			if info and info.itemID and not seen[info.itemID] then
				seen[info.itemID] = true
				local name = info.itemName
				if not name or name == "" then
					name = C_Item.GetItemInfo(info.itemID)
				end
				-- bagID/slot kept (not just itemID) so the row can show the
				-- exact real tooltip via GameTooltip:SetBagItem - durability,
				-- enchants, etc. - not just a generic base-item tooltip.
				table.insert(items, {
					id = info.itemID,
					name = name or ("Item " .. info.itemID),
					icon = info.iconFileID,
					bagID = bagID,
					slot = slot,
				})
			end
		end
	end
	table.sort(items, function(a, b)
		return a.name < b.name
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
			if item.category == "patch-specific" then
				WowAHTrackerCategorizerDB.patchSpecific[id] = { id = id, name = item.name }
			else
				WowAHTrackerCategorizerDB.permanent[id] = { id = id, name = item.name }
			end
		end
	end
end

local function IsTracked(itemId)
	return WowAHTrackerCategorizerDB.permanent[itemId] ~= nil or WowAHTrackerCategorizerDB.patchSpecific[itemId] ~= nil
end

local function AddToCategory(itemId, itemName, category)
	if IsTracked(itemId) then
		return
	end
	local entry = { id = itemId, name = itemName }
	if category == "patch-specific" then
		WowAHTrackerCategorizerDB.patchSpecific[itemId] = entry
	else
		WowAHTrackerCategorizerDB.permanent[itemId] = entry
	end
end

local function RemoveFromCategory(itemId, category)
	if category == "patch-specific" then
		WowAHTrackerCategorizerDB.patchSpecific[itemId] = nil
	else
		WowAHTrackerCategorizerDB.permanent[itemId] = nil
	end
end

local function SortedEntries(dbTable)
	local list = {}
	for _, entry in pairs(dbTable) do
		table.insert(list, entry)
	end
	table.sort(list, function(a, b)
		return a.name < b.name
	end)
	return list
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
		if not IsTracked(item.id) then
			shown = shown + 1
			local row = GetOrCreateBagRow(shown)
			PositionRow(row, shown)
			row.text:SetText(string.format("%s (%d)", item.name, item.id))
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
				AddToCategory(item.id, baseName or item.name, "permanent")
				RefreshAll()
			end)
			row.addPatch:SetScript("OnClick", function()
				AddToCategory(item.id, item.name, "patch-specific")
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
		row.text:SetText(string.format("%s (%d)", entry.name, entry.id))
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
			RemoveFromCategory(entry.id, category)
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
		if entry.patch then
			table.insert(lines, string.format("%d | %s | patch=%s", entry.id, entry.name, entry.patch))
		else
			table.insert(lines, string.format("%d | %s", entry.id, entry.name))
		end
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
