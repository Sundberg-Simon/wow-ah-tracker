-- Gold capture (addon/WowAHTracker/Gold.lua, CLAUDE.md #18): the sample log
-- rules and the login / gold-change / Warband / guild-bank events, with the WoW
-- API stubbed. Run: npm run test:addon
local passed, failed = 0, 0
local function check(name, cond, detail)
	if cond then passed = passed + 1 else failed = failed + 1; print("FAIL: " .. name .. (detail ~= nil and ("  -> " .. tostring(detail)) or "")) end
end

-- ---------- stubs ----------
local frames = {}
function CreateFrame()
	local f = { events = {}, scripts = {} }
	f.RegisterEvent = function(self, ev) self.events[ev] = true end
	f.SetScript = function(self, n, fn) self.scripts[n] = fn end
	table.insert(frames, f)
	return f
end
local function fire(ev, ...)
	for _, f in ipairs(frames) do if f.events[ev] and f.scripts.OnEvent then f.scripts.OnEvent(f, ev, ...) end end
end
local clock = 1790000000
function time() return clock end
local pending = {}
C_Timer = { After = function(_, fn) table.insert(pending, fn) end }
local function runTimers() local p = pending; pending = {}; for _, fn in ipairs(p) do fn() end end
local money, warband, gbank = 1000000, 132077200000, 50000000
function GetMoney() return money end
function GetRealmName() return "Garona" end
function UnitName() return "Tester" end
local guild = "Storage Guild"
function GetGuildInfo() return guild, "Rank", 0, nil end
function GetGuildBankMoney() return gbank end
Enum = { BankType = { Account = 2 }, PlayerInteractionType = { GuildBanker = 10, Banker = 8, AccountBanker = 53, CharacterBanker = 52, Auctioneer = 21 } }
C_Bank = { FetchDepositedMoney = function(t) return t == 2 and warband or nil end }

-- Saved data from the first version (no dataVersion): character logs hold the
-- false logout zeros; the Warband/guild logs are fine.
WowAHTrackerGoldDB = {
	characters = { ["SomeRealm|Old"] = { realm = "SomeRealm", character = "Old", log = { { ts = 100, copper = 0 } } } },
	warband = { log = { { ts = 100, copper = 5, ctx = "login" } } },
	guilds = { ["SomeRealm|G"] = { realm = "SomeRealm", name = "G", log = { { ts = 100, copper = 7, ctx = "guildbank" } } } },
}

local chunk, err = load(addonSource("Gold.lua"), "@Gold.lua")
check("Gold.lua loads", chunk ~= nil, err)
chunk()

-- ---------- pure Append ----------
local log = {}
local A = WowAHTrackerGold_Append
check("first sample", A(log, 100, 1000, nil, false) and #log == 1)
check("unchanged skipped", not A(log, 100, 2000, nil, false) and #log == 1)
check("unchanged recorded when forced", A(log, 100, 2000, "login", true) and #log == 2)
A(log, 150, 2010, nil, false) -- same 5-min slot as 2000 -> replaces
check("same slot keeps one sample, latest value", #log == 2 and log[2].copper == 150 and log[2].ts == 2010, #log)
A(log, 175, 2400, nil, false) -- next slot -> appends
check("new slot appends", #log == 3 and log[3].copper == 175)
check("negative/non-number rejected", not A(log, -5, 3000) and not A(log, "x", 3000) and #log == 3)
A(log, 33.7, 3000)
check("copper floored", log[#log].copper == 33)
local old = { { ts = 0, copper = 1 }, { ts = 10, copper = 2 } }
A(old, 3, 200 * 86400)
check("old samples pruned, newest kept", #old == 1 and old[1].copper == 3, #old)
local lone = { { ts = 0, copper = 1 } }
A(lone, 1, 200 * 86400) -- unchanged, not forced: nothing appended, and the lone old sample stays
check("lone old sample never dropped", #lone == 1)

-- ---------- events ----------
fire("ADDON_LOADED", "WowAHTracker")
check("old character logs dropped once (logout-zero bug)", next(WowAHTrackerGoldDB.characters) == nil and WowAHTrackerGoldDB.dataVersion == 2)
check("old Warband and guild logs kept", #WowAHTrackerGoldDB.warband.log == 1 and WowAHTrackerGoldDB.guilds["SomeRealm|G"] ~= nil)
WowAHTrackerGoldDB.warband.log = {} -- the rest of this file expects a fresh Warband log
WowAHTrackerGoldDB.guilds = {}
fire("PLAYER_ENTERING_WORLD")
local ch = WowAHTrackerGoldDB.characters["Garona|Tester"]
check("character recorded at login", ch and #ch.log == 1 and ch.log[1].copper == 1000000)
check("warband waits for the timer", #WowAHTrackerGoldDB.warband.log == 0)
runTimers()
check("warband recorded after login delay", #WowAHTrackerGoldDB.warband.log == 1 and WowAHTrackerGoldDB.warband.log[1].ctx == "login")

clock = clock + 600; money = 1500000
fire("PLAYER_MONEY")
check("gold change recorded", #ch.log == 2 and ch.log[2].copper == 1500000)
clock = clock + 30; money = 1600000
fire("PLAYER_MONEY")
check("change in same slot merged", #ch.log == 2 and ch.log[2].copper == 1600000)

-- logout: the client reports 0 gold there - must never be recorded
local before = #ch.log
local lastBefore = ch.log[#ch.log].copper
money = 0
fire("PLAYER_LOGOUT")
check("logout reading (0g) is not recorded", #ch.log == before and ch.log[#ch.log].copper == lastBefore)
money = 1600000
-- a second load of the same (already migrated) data keeps the characters
local keep = WowAHTrackerGoldDB.characters
fire("ADDON_LOADED", "WowAHTracker")
check("migration runs only once", WowAHTrackerGoldDB.characters == keep and next(keep) ~= nil)

-- guild bank: not open -> nothing, even on the money event
fire("GUILDBANK_UPDATE_MONEY")
check("guild bank ignored when not open", next(WowAHTrackerGoldDB.guilds) == nil)
fire("PLAYER_INTERACTION_MANAGER_FRAME_SHOW", 21) -- AH, not a guild bank
runTimers()
check("other interactions don't record a guild", next(WowAHTrackerGoldDB.guilds) == nil)
fire("PLAYER_INTERACTION_MANAGER_FRAME_SHOW", 10)
runTimers()
local g = WowAHTrackerGoldDB.guilds["Garona|Storage Guild"]
check("guild bank recorded while open", g and #g.log >= 1 and g.log[#g.log].copper == 50000000 and g.name == "Storage Guild")
clock = clock + 400; gbank = 40000000
fire("GUILDBANK_UPDATE_MONEY")
check("guild withdrawal recorded", g.log[#g.log].copper == 40000000)
fire("PLAYER_INTERACTION_MANAGER_FRAME_HIDE", 10)
clock = clock + 400; gbank = 1
fire("GUILDBANK_UPDATE_MONEY")
check("closed again -> ignored", g.log[#g.log].copper == 40000000)

-- warband at a bank and on change
clock = clock + 400; warband = 132000000000
fire("ACCOUNT_MONEY")
check("warband change recorded", WowAHTrackerGoldDB.warband.log[#WowAHTrackerGoldDB.warband.log].copper == 132000000000)
clock = clock + 400
fire("PLAYER_INTERACTION_MANAGER_FRAME_SHOW", 8)
check("warband read at the bank with ctx", WowAHTrackerGoldDB.warband.log[#WowAHTrackerGoldDB.warband.log].ctx == "bank")

-- guild realm from GetGuildInfo when it differs
function GetGuildInfo() return "Far Guild", "R", 0, "OtherRealm" end
fire("PLAYER_INTERACTION_MANAGER_FRAME_SHOW", 10); runTimers()
check("guild keyed by its own realm", WowAHTrackerGoldDB.guilds["OtherRealm|Far Guild"] ~= nil)
fire("PLAYER_INTERACTION_MANAGER_FRAME_HIDE", 10)

-- missing APIs never error
C_Bank = nil; GetGuildBankMoney = nil
fire("PLAYER_ENTERING_WORLD"); runTimers()
fire("PLAYER_INTERACTION_MANAGER_FRAME_SHOW", 10); runTimers()
check("missing APIs are harmless", true)

print(string.format("%d passed, %d failed", passed, failed))
