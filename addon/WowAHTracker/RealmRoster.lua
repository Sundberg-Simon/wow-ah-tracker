-- WoW AH Tracker - realm roster / EU coverage checker (v1)
--
-- Simon plays ~81 characters across 3 WoW accounts and wants to know which
-- EU realms he actually has a character on, so he can compare that against
-- every EU connected-realm group and spot gaps in his AH coverage. This
-- addon has no way to enumerate characters itself (no roster API access -
-- see CLAUDE.md, this project only uses Blizzard's client-credentials Game
-- Data API, never a user-authorized Profile API), so building the roster
-- is a manual, one-click-per-character opt-in: log into a character once,
-- click "Add this character", move on. Purely local bookkeeping - nothing
-- here is uploaded anywhere or touches the sync pipeline.
--
-- Persists to WowAHTrackerRealmRosterDB, a SavedVariables table separate
-- from the categorizer's DB, the sales log's DB, and data.lua. Like those,
-- this is account-wide (see the .toc), not per-character - across Simon's
-- 3 separate WoW accounts, each account's SavedVariables file only ever
-- sees that account's own characters. A true combined 81-character view
-- needs the same manual cross-account merge already used for
-- config/trackedItems.json (paste each account's /waht realms export to
-- Claude Code) - this addon only ever shows one account's coverage at a
-- time, which is an honest reflection of what a single WoW account can
-- see, not a limitation worth working around with new infrastructure.
--
-- Coverage is computed entirely from data.lua's connectedRealms table
-- (already synced nightly, no new pipeline needed) - every EU connected-
-- realm group with its member realm names, regardless of whether any
-- tracked item currently lists there. A roster entry "covers" whichever
-- connected-realm group its realm belongs to (reuses the same
-- normalize-and-match approach as WowAHTracker.lua's findMyConnectedRealmId
-- - GetRealmName() strips spaces, the connectedRealms export doesn't).

local function printMsg(msg)
	DEFAULT_CHAT_FRAME:AddMessage("|cff33ff99WoW AH Tracker|r: " .. msg)
end

local ROW_HEIGHT = 18
local LIST_WIDTH = 640
local LIST_HEIGHT = 380

local function EnsureDB()
	WowAHTrackerRealmRosterDB = WowAHTrackerRealmRosterDB or {}
	WowAHTrackerRealmRosterDB.characters = WowAHTrackerRealmRosterDB.characters or {}
end

local function normalizeRealmName(name)
	return (name or ""):gsub("%s+", ""):lower()
end

local function findConnectedRealmIdForRealm(realmName)
	if not WowAhTrackerData or not WowAhTrackerData.connectedRealms then
		return nil
	end
	local needle = normalizeRealmName(realmName)
	for connectedRealmId, realmNames in pairs(WowAhTrackerData.connectedRealms) do
		for _, name in ipairs(realmNames) do
			if normalizeRealmName(name) == needle then
				return tonumber(connectedRealmId)
			end
		end
	end
	return nil
end

-- The one place the roster's "realm|character" key is built - AddCurrentCharacter
-- writes with it and the sale/purchase classifier below reads with it, so the
-- two can't drift apart.
local function rosterKey(realm, character)
	return realm .. "|" .. character
end

-- "Cross-realm stuff" vs "other stuff" classification for the sales/purchase
-- totals (requested 2026-09-19: Simon will earn gold on characters outside the
-- 81-character roster and wants those tallied separately from the registered
-- cross-realm operation, never blended).
--
-- DELIBERATELY computed on demand against the roster as it stands right now,
-- never stored on the sale/purchase record: if a character is added to the
-- roster later, every sale/purchase it already logged reclassifies as
-- cross-realm the next time a total is computed. Do not "optimize" this by
-- caching a bucket on the record at capture time - that would freeze the
-- classification that applied back then and silently defeat the requirement.
--
-- Returns "cross" (record's realm|character is on the roster), "other" (it
-- isn't), or nil when the record has no realm/character to match on at all
-- (can't be classified either way - callers show these separately rather than
-- guessing a bucket). A missing/never-opened roster DB just means "nothing is
-- on the roster", so everything is "other" - no error, and no EnsureDB here
-- since this is a pure read.
function WowAHTrackerRealmRoster_Classify(record)
	if not record.realm or not record.character then
		return nil
	end
	local db = WowAHTrackerRealmRosterDB
	if db and db.characters and db.characters[rosterKey(record.realm, record.character)] then
		return "cross"
	end
	return "other"
end

-- Sums a list of sale/purchase records into the two buckets (plus an
-- "unclassified" one for records with no realm/character). `amountField` is
-- the record field to total - netReceived for sales, totalPricePaid for
-- purchases. Copper in, copper out.
function WowAHTrackerRealmRoster_Tally(records, amountField)
	local tally = {
		cross = { count = 0, total = 0 },
		other = { count = 0, total = 0 },
		unclassified = { count = 0, total = 0 },
	}
	for _, record in ipairs(records) do
		local bucket = tally[WowAHTrackerRealmRoster_Classify(record) or "unclassified"]
		bucket.count = bucket.count + 1
		bucket.total = bucket.total + (record[amountField] or 0)
	end
	return tally
end

-- True when this account's roster has no characters yet - every record then
-- (correctly, per the rule) lands in "other", which is worth flagging to the
-- player as probably-not-what-they-expect rather than presenting silently.
function WowAHTrackerRealmRoster_IsEmpty()
	local db = WowAHTrackerRealmRosterDB
	return not db or not db.characters or next(db.characters) == nil
end

-- Short colored prefix for a single row in the "recent" lists, so it's clear
-- which bucket each individual line counts toward.
function WowAHTrackerRealmRoster_Tag(record)
	local bucket = WowAHTrackerRealmRoster_Classify(record)
	if bucket == "cross" then
		return "|cff33ff99[cross-realm]|r"
	elseif bucket == "other" then
		return "|cffffcc00[other]|r"
	end
	return "|cff999999[unclassified]|r"
end

-- Prints the two tallies as separate, labeled lines - never a combined total.
-- Shared by /waht sales and /waht purchases so the two can't drift apart in
-- layout. `noun` is "sales"/"purchases", `amountWord` is "net"/"paid",
-- `formatAmount` turns copper into the caller's display string. The
-- unclassified line only appears when there's actually something in it.
function WowAHTrackerRealmRoster_PrintTally(records, amountField, noun, amountWord, formatAmount)
	local tally = WowAHTrackerRealmRoster_Tally(records, amountField)
	local function line(label, bucket)
		DEFAULT_CHAT_FRAME:AddMessage(
			string.format("  %s: %d %s, %s %s", label, bucket.count, noun, amountWord, formatAmount(bucket.total))
		)
	end
	line("|cff33ff99CROSS-REALM stuff|r", tally.cross)
	line("|cffffcc00OTHER stuff|r", tally.other)
	if tally.unclassified.count > 0 then
		line("|cff999999Unclassified (no realm/character on record)|r", tally.unclassified)
	end
	if WowAHTrackerRealmRoster_IsEmpty() then
		printMsg("Note: this account's realm roster is empty, so everything counts as OTHER. Run /waht realms and add characters.")
	end
end

local function AddCurrentCharacter()
	EnsureDB()
	local realm = GetRealmName()
	local character = UnitName("player")
	local key = rosterKey(realm, character)
	local connectedRealmId = findConnectedRealmIdForRealm(realm)

	WowAHTrackerRealmRosterDB.characters[key] = {
		realm = realm,
		character = character,
		connectedRealmId = connectedRealmId,
		addedAt = date("%Y-%m-%dT%H:%M:%S"),
	}

	if connectedRealmId then
		printMsg(string.format("Added %s (%s) to the realm roster.", character, realm))
	else
		printMsg(
			string.format(
				"Added %s (%s) to the realm roster - could not match it to a connected-realm group (connectedRealms data may be missing or stale).",
				character,
				realm
			)
		)
	end
end

-- Every connected-realm group from data.lua, each tagged with whether the
-- roster already has a character in it and, if so, which one(s). Sorted
-- missing-first (the actionable gap list), then alphabetically by the
-- group's first realm name - covered groups are still shown, just lower
-- down, so this doubles as a full at-a-glance coverage view.
local function ComputeCoverage()
	local rows = {}
	if not WowAhTrackerData or not WowAhTrackerData.connectedRealms then
		return rows, 0, 0
	end

	local coveredBy = {}
	for _, entry in pairs(WowAHTrackerRealmRosterDB.characters) do
		if entry.connectedRealmId then
			coveredBy[entry.connectedRealmId] = coveredBy[entry.connectedRealmId] or {}
			table.insert(coveredBy[entry.connectedRealmId], entry.character)
		end
	end

	local totalGroups = 0
	local coveredGroups = 0
	for connectedRealmId, realmNames in pairs(WowAhTrackerData.connectedRealms) do
		totalGroups = totalGroups + 1
		local id = tonumber(connectedRealmId)
		local characters = coveredBy[id]
		if characters then
			coveredGroups = coveredGroups + 1
		end
		table.insert(rows, {
			connectedRealmId = id,
			realmNames = realmNames,
			characters = characters,
		})
	end

	table.sort(rows, function(a, b)
		if (a.characters ~= nil) ~= (b.characters ~= nil) then
			return a.characters == nil
		end
		return a.realmNames[1] < b.realmNames[1]
	end)

	return rows, coveredGroups, totalGroups
end

local function BuildExportText()
	local lines = {}
	table.insert(lines, "# wow-ah-tracker realm roster export - " .. date("%Y-%m-%d %H:%M"))

	local characters = {}
	for _, entry in pairs(WowAHTrackerRealmRosterDB.characters) do
		table.insert(characters, entry)
	end
	table.sort(characters, function(a, b)
		return a.realm < b.realm
	end)
	table.insert(lines, string.format("# Roster (%d characters)", #characters))
	for _, entry in ipairs(characters) do
		table.insert(lines, string.format("%s | %s | connectedRealmId=%s", entry.realm, entry.character, tostring(entry.connectedRealmId)))
	end

	local rows, covered, total = ComputeCoverage()
	table.insert(lines, string.format("# Coverage: %d/%d EU connected-realm groups", covered, total))
	table.insert(lines, "# Missing groups (no roster character):")
	for _, row in ipairs(rows) do
		if not row.characters then
			table.insert(lines, string.format("%d | %s", row.connectedRealmId or -1, table.concat(row.realmNames, ", ")))
		end
	end

	return table.concat(lines, "\n")
end

-- ---- UI ----

local frame
local rows = {}
local listContent
local summaryText
local exportFrame, exportEditBox

local function ShowExport()
	if not exportFrame then
		exportFrame = CreateFrame("Frame", "WowAHTrackerRealmRosterExportFrame", frame, "BackdropTemplate")
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

local function GetOrCreateRow(index)
	local row = rows[index]
	if row then
		return row
	end
	row = CreateFrame("Frame", nil, listContent)
	row:SetHeight(ROW_HEIGHT)
	row:SetWidth(LIST_WIDTH - 20)

	row.text = row:CreateFontString(nil, "OVERLAY", "GameFontNormalSmall")
	row.text:SetPoint("LEFT", 2, 0)
	row.text:SetPoint("RIGHT", row, "RIGHT", -2, 0)
	row.text:SetJustifyH("LEFT")
	row.text:SetWordWrap(false)

	rows[index] = row
	return row
end

local function RefreshList()
	local coverageRows, covered, total = ComputeCoverage()
	summaryText:SetText(string.format("Coverage: %d / %d EU connected-realm groups", covered, total))

	for i, row in ipairs(coverageRows) do
		local uiRow = GetOrCreateRow(i)
		uiRow:ClearAllPoints()
		uiRow:SetPoint("TOPLEFT", 0, -(i - 1) * ROW_HEIGHT)

		local names = table.concat(row.realmNames, ", ")
		if row.characters then
			uiRow.text:SetText(string.format("|cff33ff99[covered]|r %s - %s", names, table.concat(row.characters, ", ")))
		else
			uiRow.text:SetText(string.format("|cffff5555[missing]|r %s", names))
		end
		uiRow:Show()
	end
	for i = #coverageRows + 1, #rows do
		rows[i]:Hide()
	end
	listContent:SetHeight(math.max(1, #coverageRows * ROW_HEIGHT))
end

local function CreateRealmRosterFrame()
	frame = CreateFrame("Frame", "WowAHTrackerRealmRosterFrame", UIParent, "BackdropTemplate")
	frame:SetSize(LIST_WIDTH + 40, LIST_HEIGHT + 130)
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
	frame.title:SetText("WoW AH Tracker - Realm Coverage")

	local close = CreateFrame("Button", nil, frame, "UIPanelCloseButton")
	close:SetPoint("TOPRIGHT", -4, -4)
	close:SetScript("OnClick", function()
		frame:Hide()
	end)

	local addBtn = CreateFrame("Button", nil, frame, "UIPanelButtonTemplate")
	addBtn:SetSize(260, 22)
	addBtn:SetPoint("TOPLEFT", 20, -44)
	addBtn:SetScript("OnClick", function()
		AddCurrentCharacter()
		RefreshList()
	end)
	frame.addBtn = addBtn

	summaryText = frame:CreateFontString(nil, "OVERLAY", "GameFontNormal")
	summaryText:SetPoint("LEFT", addBtn, "RIGHT", 16, 0)

	local scroll = CreateFrame("ScrollFrame", nil, frame, "UIPanelScrollFrameTemplate")
	scroll:SetPoint("TOPLEFT", 20, -76)
	scroll:SetSize(LIST_WIDTH, LIST_HEIGHT)

	listContent = CreateFrame("Frame", nil, scroll)
	listContent:SetSize(LIST_WIDTH, LIST_HEIGHT)
	scroll:SetScrollChild(listContent)

	local exportBtn = CreateFrame("Button", nil, frame, "UIPanelButtonTemplate")
	exportBtn:SetSize(100, 22)
	exportBtn:SetPoint("BOTTOMRIGHT", -20, 16)
	exportBtn:SetText("Export")
	exportBtn:SetScript("OnClick", ShowExport)

	-- Starts hidden - CreateFrame() defaults to shown, and the toggle logic
	-- below assumes the opposite (see the /waht categorize double-call bug
	-- this project already hit and fixed for the exact same reason).
	frame:Hide()
end

function WowAHTrackerRealmRoster_Toggle()
	EnsureDB()

	if not frame then
		CreateRealmRosterFrame()
	end

	local character = UnitName("player")
	local realm = GetRealmName()
	frame.addBtn:SetText(string.format("Add %s (%s)", character, realm))

	if frame:IsShown() then
		frame:Hide()
	else
		RefreshList()
		frame:Show()
	end
end

-- `/waht realms remove <realm>, <character>` - drops a roster entry. The roster
-- can only grow otherwise, so a DELETED character stays listed forever; for the
-- crafted-item stock feature that matters, because a roster character in a cluster
-- that can never be scanned again keeps the cluster "unknown" permanently (the
-- stock could be on them). Realm and character are matched case- and
-- space-insensitively ("area52" finds "Area 52"), separated by a comma because
-- realm names contain spaces and apostrophes but never commas. The change reaches
-- the DB the same way as everything else: on logout or /reload, then the next
-- ingest replaces that account's roster snapshot. Past sales/purchases logged by
-- the removed character are untouched (they classify by the roster as it is now,
-- so if it never sold anything nothing changes).
function WowAHTrackerRealmRoster_Remove(arg)
	EnsureDB()
	local realm, character = (arg or ""):match("^%s*(.-)%s*,%s*(.-)%s*$")
	if not realm or realm == "" or not character or character == "" then
		printMsg("Usage: /waht realms remove <realm>, <character>   e.g. /waht realms remove ExampleRealm, ExampleChar")
		return
	end

	local wantRealm = normalizeRealmName(realm)
	local wantCharacter = character:lower()
	local matches = {}
	for key, entry in pairs(WowAHTrackerRealmRosterDB.characters) do
		if normalizeRealmName(entry.realm) == wantRealm and (entry.character or ""):lower() == wantCharacter then
			table.insert(matches, key)
		end
	end

	if #matches == 0 then
		printMsg(string.format('No roster entry matches "%s" on "%s". /waht realms shows the roster (Export lists every entry).', character, realm))
		return
	end
	if #matches > 1 then
		printMsg(string.format('"%s" on "%s" matches %d roster entries - not removing anything; be more specific.', character, realm, #matches))
		return
	end

	local key = matches[1]
	local entry = WowAHTrackerRealmRosterDB.characters[key]
	WowAHTrackerRealmRosterDB.characters[key] = nil
	printMsg(
		string.format(
			"Removed %s (%s) from the realm roster. It reaches the DB on logout or /reload, then the next Push Earnings.",
			entry.character or "?",
			entry.realm or "?"
		)
	)
	if frame and frame:IsShown() then
		RefreshList()
	end
end

local loader = CreateFrame("Frame")
loader:RegisterEvent("ADDON_LOADED")
loader:SetScript("OnEvent", function(_, _, addonName)
	if addonName == "WowAHTracker" then
		EnsureDB()
	end
end)
