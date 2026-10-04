-- Restock window (addon/WowAHTracker/Stock.lua, CLAUDE.md #15): the pure
-- RestockList/RestockText functions and the event-driven window, with just
-- enough of the WoW API stubbed to load the file. Run: npm run test:addon
local passed, failed = 0, 0
local function check(name, cond, detail)
	if cond then
		passed = passed + 1
	else
		failed = failed + 1
		print("FAIL: " .. name .. (detail and ("  -> " .. tostring(detail)) or ""))
	end
end
local function contains(s, needle)
	return s ~= nil and string.find(s, needle, 1, true) ~= nil
end

-- ---------- WoW API stubs ----------
local frames = {}
local function newObject(kind)
	local o = { kind = kind, shown = true, scripts = {}, events = {}, text = nil }
	local mt = {}
	mt.__index = function(_, k)
		return function(...)
			return nil
		end
	end
	setmetatable(o, mt)
	o.SetScript = function(self, name, fn) self.scripts[name] = fn end
	o.RegisterEvent = function(self, ev)
		if ev == "UNKNOWN_EVENT_FOR_TEST" then error("Attempt to register unknown event") end
		self.events[ev] = true
	end
	o.Show = function(self) self.shown = true end
	o.Hide = function(self) self.shown = false end
	o.IsShown = function(self) return self.shown end
	o.SetText = function(self, t) self.text = t end
	o.GetText = function(self) return self.text end
	o.GetStringHeight = function(self)
		local n = 1
		for _ in string.gmatch(self.text or "", "\n") do n = n + 1 end
		return n * 12
	end
	o.SetHeight = function(self, h) self.height = h end
	o.CreateFontString = function(self) local fs = newObject("FontString"); return fs end
	o.CreateTexture = function(self) return newObject("Texture") end
	o.GetPoint = function(self) return "CENTER", nil, "CENTER", 10, 20 end
	o.SetPoint = function(self, ...) self.point = { ... } end
	return o
end
function CreateFrame(kind, name, parent, template)
	local f = newObject(kind)
	f.name, f.parent, f.template = name, parent, template
	table.insert(frames, f)
	if name then _G[name] = f end
	return f
end
UIParent = newObject("Frame")
Minimap = newObject("Frame")
Minimap.GetWidth = function() return 140 end
Minimap.GetCenter = function() return 500, 400 end
Minimap.GetEffectiveScale = function() return 1 end
local cursorX, cursorY = 500, 600
function GetCursorPosition() return cursorX, cursorY end
local tooltipLines = {}
GameTooltip = {
	SetOwner = function() tooltipLines = {} end,
	SetText = function(_, t) table.insert(tooltipLines, t) end,
	AddLine = function(_, t) table.insert(tooltipLines, t) end,
	Show = function() end,
	Hide = function() end,
}
DEFAULT_CHAT_FRAME = { AddMessage = function(_, msg) end }
SlashCmdList = {}
BACKPACK_CONTAINER, NUM_BAG_SLOTS = 0, 4
Enum = {
	BagIndex = { ReagentBag = 5 },
	AuctionStatus = { Active = 0, Sold = 1 },
	PlayerInteractionType = { Auctioneer = 21, MailInfo = 17 },
}
function GetRealmName() return "Garona" end
function UnitName() return "Tester" end
local clock = 1000
function GetTime() return clock end
C_Timer = { After = function(_, fn) fn() end }
local nowUnix = 1790000000
function time() return nowUnix end
-- date() exists in 5.4's os library only
date = os.date

-- Bags: bagContents[itemID] = count, all in bag 0
local bagContents = {}
local bagsLoaded = true
C_Container = {
	GetContainerNumSlots = function(bag)
		if not bagsLoaded then return 0 end
		return bag == 0 and 16 or 0
	end,
	GetContainerItemInfo = function(bag, slot)
		if bag ~= 0 then return nil end
		local i = 0
		for id, n in pairs(bagContents) do
			if n > 0 then
				i = i + 1
				if i == slot then return { itemID = id, stackCount = n } end
			end
		end
		return nil
	end,
}
-- Own auctions
local owned, ownedFull = {}, false
C_AuctionHouse = {
	HasFullOwnedAuctionResults = function() return ownedFull end,
	GetNumOwnedAuctions = function() return #owned end,
	GetOwnedAuctionInfo = function(i) return owned[i] end,
}

local VIAL, SAPPHIRE, ONYX, GOLEM = 65891, 83090, 82453, 95416
WowAhTrackerData = {
	items = {
		[VIAL] = { id = VIAL, name = "Vial of the Sands", crafted = true },
		[SAPPHIRE] = { id = SAPPHIRE, name = "Sapphire Panther", crafted = true },
		[ONYX] = { id = ONYX, name = "Jeweled Onyx Panther", crafted = true },
		[GOLEM] = { id = GOLEM, name = "Sky Golem", crafted = true, restock = false },
		[12345] = { id = 12345, name = "Some Patch Item", category = "patch-specific" },
	},
}

-- ---------- pure function tests (before loading, they don't exist yet) ----------
local chunk, err = load(addonSource("Stock.lua"), "@Stock.lua")
check("Stock.lua loads", chunk ~= nil, err)
chunk()

local items = {
	{ id = 1, name = "A", restock = true },
	{ id = 2, name = "B", restock = true },
	{ id = 3, name = "Golem", restock = false },
}
local r = WowAHTrackerStock_RestockList(items, { [1] = 1, [2] = 0, [3] = 0 }, { [1] = 0, [2] = 0, [3] = 0 })
check("pure: B missing", #r.missing == 1 and r.missing[1] == "B", #r.missing)
check("pure: Golem never expected", r.expected == 2, r.expected)
check("pure: A stocked via bags", r.stocked == 1, r.stocked)
r = WowAHTrackerStock_RestockList(items, { [1] = 0, [2] = 0 }, { [1] = 1, [2] = 2 })
check("pure: listed counts as stocked", r.stocked == 2 and #r.missing == 0)
check("pure: all stocked text", contains(WowAHTrackerStock_RestockText(r), "All 2 items stocked"))
r = WowAHTrackerStock_RestockList(items, { [1] = 1, [2] = 0 }, nil)
check("pure: listings unknown -> unsure, not missing", #r.missing == 0 and #r.unsure == 1 and r.unsure[1] == "B")
check("pure: unsure text points to Auctions tab", contains(WowAHTrackerStock_RestockText(r), "open the Auctions tab"))
r = WowAHTrackerStock_RestockList(items, nil, nil)
check("pure: bags unknown", r.bagsKnown == false and #r.missing == 0)
check("pure: bags unknown text", contains(WowAHTrackerStock_RestockText(r), "Bags not loaded"))
r = WowAHTrackerStock_RestockList({ { id = 3, name = "Golem", restock = false } }, {}, {})
check("pure: nothing marked", contains(WowAHTrackerStock_RestockText(r), "No crafted items are marked"))
r = WowAHTrackerStock_RestockList(items, { [1] = 0, [2] = 0 }, { [1] = 0, [2] = 0 })
local t = WowAHTrackerStock_RestockText(r)
check("pure: two missing listed + count", contains(t, "Restock (2):") and contains(t, "  A") and contains(t, "  B") and contains(t, "Stocked: 0/2"), t)

-- ---------- event-driven tests ----------
local function fire(ev, ...)
	for _, f in ipairs(frames) do
		if f.events[ev] and f.scripts.OnEvent then f.scripts.OnEvent(f, ev, ...) end
	end
end
local function window() return _G.WowAHTrackerRestockFrame end
local function bodyText()
	local w = window()
	if not w then return nil end
	-- the body is the second FontString created on the window (title first)
	return w.__body
end
-- capture the window's font strings
local origCreate = CreateFrame
CreateFrame = function(kind, name, parent, template)
	local f = origCreate(kind, name, parent, template)
	if name == "WowAHTrackerRestockFrame" then
		local made = {}
		f.CreateFontString = function(self)
			local fs = newObject("FontString")
			table.insert(made, fs)
			if #made == 1 then f.__title = fs else f.__bodyFs = fs end
			return fs
		end
	end
	return f
end
local function body() return window() and window().__bodyFs and window().__bodyFs.text end
local function title() return window() and window().__title and window().__title.text end

fire("ADDON_LOADED", "WowAHTracker")
fire("PLAYER_LOGIN")
check("no window before AH", window() == nil)

-- Mail collected: Vial + Sapphire back in bags; Onyx sold; Golem not here.
bagContents = { [VIAL] = 1, [SAPPHIRE] = 1 }
fire("BAG_UPDATE_DELAYED")
check("bag update outside AH creates no window", window() == nil)

ownedFull = false
fire("AUCTION_HOUSE_SHOW")
check("window shown on AH open", window() ~= nil and window():IsShown())
check("title has realm", contains(title(), "Restock - Garona"), title())
check("listings not loaded -> Onyx unsure, not missing", contains(body(), "Not in bags (1)") and contains(body(), "Jeweled Onyx Panther") and not contains(body(), "Restock ("), body())
check("Sky Golem never shown", not contains(body(), "Sky Golem"), body())

-- Owned list arrives: nothing of ours listed yet.
ownedFull = true
owned = {}
fire("OWNED_AUCTIONS_UPDATED")
check("listings loaded -> Onyx missing", contains(body(), "Restock (1):") and contains(body(), "Jeweled Onyx Panther"), body())
check("count line", contains(body(), "Stocked: 2/3"), body())
local snap = WowAHTrackerStockDB.characters["Garona|Tester"]
check("auction snapshot still recorded", snap and snap.auctions and snap.auctions.counts[SAPPHIRE] == 0)

-- Post the Vial and Sapphire: bags empty, listed.
bagContents = {}
owned = {
	{ itemKey = { itemID = VIAL }, quantity = 1, status = 0 },
	{ itemKey = { itemID = SAPPHIRE }, quantity = 1, status = 0 },
	{ itemKey = { itemID = ONYX }, quantity = 1, status = 1 }, -- sold listing: not stock
}
fire("BAG_UPDATE_DELAYED")
fire("OWNED_AUCTIONS_UPDATED")
check("posted items stay stocked", contains(body(), "Stocked: 2/3") and contains(body(), "Restock (1):"), body())
check("sold listing doesn't count", contains(body(), "Jeweled Onyx Panther"), body())

-- Bring an Onyx in -> all stocked.
bagContents = { [ONYX] = 1 }
fire("BAG_UPDATE_DELAYED")
check("all stocked", contains(body(), "All 3 items stocked"), body())

-- Close button dismisses until the next visit.
local closeBtn
for _, f in ipairs(frames) do
	if f.template == "UIPanelCloseButton" then closeBtn = f end
end
check("close button exists", closeBtn ~= nil)
closeBtn.scripts.OnClick()
check("closed", not window():IsShown())
fire("BAG_UPDATE_DELAYED")
check("stays closed after a bag update", not window():IsShown())
fire("PLAYER_INTERACTION_MANAGER_FRAME_SHOW", 21)
check("second open-event of same visit doesn't reopen", not window():IsShown())

fire("AUCTION_HOUSE_CLOSED")
fire("PLAYER_INTERACTION_MANAGER_FRAME_HIDE", 21)
check("hidden after AH closed", not window():IsShown())
fire("PLAYER_INTERACTION_MANAGER_FRAME_SHOW", 17) -- mailbox: not the AH
check("mailbox doesn't open it", not window():IsShown())
fire("PLAYER_INTERACTION_MANAGER_FRAME_SHOW", 21) -- AH via the generic event
check("reopens on next AH visit (generic event)", window():IsShown())

-- Bags not loaded (e.g. right at login).
bagsLoaded = false
fire("BAG_UPDATE_DELAYED")
check("bags not loaded text", contains(body(), "Bags not loaded"), body())
bagsLoaded = true

-- Dragging remembers the position.
window().scripts.OnDragStop(window())
check("position saved", WowAHTrackerStockDB.restockPos and WowAHTrackerStockDB.restockPos.x == 10)

-- ---------- minimap button + /waht restock ----------
local mb = _G.WowAHTrackerMinimapButton
check("minimap button created at login", mb ~= nil and mb:IsShown())
check("button sits on the minimap edge", mb.point and mb.point[2] == Minimap and math.abs(math.sqrt(mb.point[4] ^ 2 + mb.point[5] ^ 2) - 80) < 0.01, mb.point and (mb.point[4] .. "," .. mb.point[5]))

-- reset: AH closed, window closed
fire("AUCTION_HOUSE_CLOSED")
if window():IsShown() then WowAHTrackerStock_ToggleRestockWindow() end
check("window closed before the button tests", not window():IsShown())

-- away from the AH: last snapshot (1h old) stands in for listings
bagContents = {}
WowAHTrackerStockDB.characters["Garona|Tester"].auctions = { ts = nowUnix - 3600, counts = { [VIAL] = 1, [SAPPHIRE] = 1, [ONYX] = 0, [GOLEM] = 0 } }
mb.scripts.OnClick(mb, "LeftButton")
check("left-click opens the window away from the AH", window():IsShown())
check("away from the AH: snapshot listings count, age shown", contains(body(), "Restock (1):") and contains(body(), "Jeweled Onyx Panther") and contains(body(), "Listings as of your last AH visit (60m ago)"), body())
mb.scripts.OnClick(mb, "LeftButton")
check("left-click again closes it", not window():IsShown())

-- a snapshot older than 48h is not trusted
WowAHTrackerStockDB.characters["Garona|Tester"].auctions.ts = nowUnix - 49 * 3600
WowAHTrackerStock_RestockCommand("show")
check("/waht restock show opens it", window():IsShown())
check("stale snapshot -> not sure, never 'restock'", contains(body(), "Not in bags (3)") and not contains(body(), "Restock (") and contains(body(), "listings unknown until you open it"), body())

-- a manually opened window survives the AH opening and closing, and goes live at the AH
ownedFull = true
owned = { { itemKey = { itemID = VIAL }, quantity = 1, status = 0 } }
fire("AUCTION_HOUSE_SHOW")
check("manual window goes live at the AH", window():IsShown() and contains(body(), "Restock (2):") and not contains(body(), "last AH visit"), body())
fire("AUCTION_HOUSE_CLOSED")
check("manual window stays after the AH closes", window():IsShown())
WowAHTrackerStock_RestockCommand("show")
check("closed again", not window():IsShown())

-- right-click: automatic opening off/on
mb.scripts.OnClick(mb, "RightButton")
check("right-click switches automatic opening off", WowAHTrackerStockDB.restockAuto == false)
fire("AUCTION_HOUSE_SHOW")
check("auto off -> the AH doesn't open it", not window():IsShown())
mb.scripts.OnEnter(mb)
check("tooltip says OFF", contains(table.concat(tooltipLines, "\n"), "OFF"))
WowAHTrackerStock_RestockCommand("")
check("/waht restock switches it back on, and opens it at the open AH", WowAHTrackerStockDB.restockAuto == true and window():IsShown())
mb.scripts.OnEnter(mb)
check("tooltip says ON", contains(table.concat(tooltipLines, "\n"), "ON"))
fire("AUCTION_HOUSE_CLOSED")
check("auto-opened window closes with the AH", not window():IsShown())
WowAHTrackerStock_RestockCommand("bogus")
check("unknown argument changes nothing", WowAHTrackerStockDB.restockAuto == true and not window():IsShown())

-- dragging moves it around the edge and remembers the angle
cursorX, cursorY = 500, 600 -- straight above the minimap centre
mb.scripts.OnDragStart(mb)
check("drag starts following the cursor", mb.scripts.OnUpdate ~= nil)
mb.scripts.OnUpdate(mb)
mb.scripts.OnDragStop(mb)
check("angle saved (90 degrees)", math.abs((WowAHTrackerStockDB.minimap.angle or 0) - 90) < 0.01, WowAHTrackerStockDB.minimap.angle)
check("button moved to the top of the edge", math.abs(mb.point[4]) < 0.01 and math.abs(mb.point[5] - 80) < 0.01)
check("drag stops following", mb.scripts.OnUpdate == nil)

-- /waht minimap hides and shows the button
WowAHTrackerStock_MinimapCommand()
check("/waht minimap hides it (remembered)", not mb:IsShown() and WowAHTrackerStockDB.minimap.hide == true)
WowAHTrackerStock_MinimapCommand()
check("and shows it again", mb:IsShown() and WowAHTrackerStockDB.minimap.hide == false)

print(string.format("%d passed, %d failed", passed, failed))
