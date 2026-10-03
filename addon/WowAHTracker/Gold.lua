-- WoW AH Tracker - gold balances over time
--
-- Records how much gold each character holds, how much is in the Warband bank,
-- and how much is in each guild bank you open, so the local earnings report can
-- graph the TOTAL over time (CLAUDE.md #18). Own capture on purpose - not
-- TSM's gold log (Simon's choice, 2026-10-03).
--
-- What is recorded, and when:
--   character  GetMoney() at login, on every change (PLAYER_MONEY) and at
--              logout. Always readable.
--   warband    C_Bank.FetchDepositedMoney(Enum.BankType.Account) at login, when
--              it changes (ACCOUNT_MONEY) and at a bank. The Warband bank is ONE
--              bank shared by all accounts - every account records it and the
--              report merges them, never adds them. Each sample says where it
--              was taken (ctx); the report only trusts a 0 read at a bank, in
--              case the value isn't loaded yet at login (unverified in game).
--   guild      GetGuildBankMoney() ONLY while that guild's bank is open: outside
--              it the client may hold an old value. Keyed by realm|guild name,
--              shared across accounts like the Warband bank. Which guild banks
--              count toward the total is chosen in the report's local config.
--
-- Storage (WowAHTrackerGoldDB): per source a small log of { ts, copper[, ctx] }.
-- At most one sample per source per 5-minute slot (the latest value in it), a
-- sample only when the value changed (or at login, so "last seen" stays
-- current), and samples older than KEEP_DAYS are dropped here - the DB keeps
-- them after the next ingest.

local SLOT_SECONDS = 300
local KEEP_DAYS = 120

local function EnsureDB()
	WowAHTrackerGoldDB = WowAHTrackerGoldDB or {}
	WowAHTrackerGoldDB.characters = WowAHTrackerGoldDB.characters or {}
	WowAHTrackerGoldDB.guilds = WowAHTrackerGoldDB.guilds or {}
	WowAHTrackerGoldDB.warband = WowAHTrackerGoldDB.warband or { log = {} }
	WowAHTrackerGoldDB.warband.log = WowAHTrackerGoldDB.warband.log or {}
end

-- Adds a sample to a log. force = record even if unchanged (login).
-- Pure apart from the `now` it's given, so the harness can test it.
function WowAHTrackerGold_Append(log, copper, now, ctx, force)
	if type(copper) ~= "number" or copper < 0 then
		return false
	end
	copper = math.floor(copper)
	local last = log[#log]
	if last and last.copper == copper and not force then
		return false
	end
	if last and math.floor(last.ts / SLOT_SECONDS) == math.floor(now / SLOT_SECONDS) then
		-- same 5-minute slot: keep only the latest value
		last.ts, last.copper, last.ctx = now, copper, ctx
	else
		table.insert(log, { ts = now, copper = copper, ctx = ctx })
	end
	-- drop old samples, always keeping the newest one
	local cutoff = now - KEEP_DAYS * 86400
	while #log > 1 and log[1].ts < cutoff do
		table.remove(log, 1)
	end
	return true
end

local function try(fn, ...)
	return pcall(fn, ...)
end

local function recordCharacter(force)
	if not GetMoney then
		return
	end
	local ok, copper = try(GetMoney)
	if not ok then
		return
	end
	EnsureDB()
	local realm, name = GetRealmName and GetRealmName(), UnitName and UnitName("player")
	if not realm or not name then
		return
	end
	local key = realm .. "|" .. name
	local rec = WowAHTrackerGoldDB.characters[key]
	if not rec then
		rec = { realm = realm, character = name, log = {} }
		WowAHTrackerGoldDB.characters[key] = rec
	end
	WowAHTrackerGold_Append(rec.log, copper, time(), nil, force)
end

local function recordWarband(ctx, force)
	if not (C_Bank and C_Bank.FetchDepositedMoney and Enum and Enum.BankType and Enum.BankType.Account) then
		return
	end
	local ok, copper = try(C_Bank.FetchDepositedMoney, Enum.BankType.Account)
	if ok and type(copper) == "number" then
		EnsureDB()
		WowAHTrackerGold_Append(WowAHTrackerGoldDB.warband.log, copper, time(), ctx, force)
	end
end

local guildBankOpen = false

local function recordGuildBank()
	if not (guildBankOpen and GetGuildBankMoney and GetGuildInfo) then
		return
	end
	local okI, guildName, _, _, guildRealm = try(GetGuildInfo, "player")
	if not okI or not guildName then
		return
	end
	local okM, copper = try(GetGuildBankMoney)
	if not (okM and type(copper) == "number") then
		return
	end
	local realm = guildRealm or (GetRealmName and GetRealmName()) or "?"
	EnsureDB()
	local key = realm .. "|" .. guildName
	local rec = WowAHTrackerGoldDB.guilds[key]
	if not rec then
		rec = { realm = realm, name = guildName, log = {} }
		WowAHTrackerGoldDB.guilds[key] = rec
	end
	WowAHTrackerGold_Append(rec.log, copper, time(), "guildbank", true)
end

local function after(seconds, fn)
	if C_Timer and C_Timer.After then
		C_Timer.After(seconds, fn)
	else
		fn()
	end
end

local function interaction(name)
	return Enum and Enum.PlayerInteractionType and Enum.PlayerInteractionType[name]
end

local frame = CreateFrame("Frame")
frame:RegisterEvent("ADDON_LOADED")
frame:RegisterEvent("PLAYER_ENTERING_WORLD")
frame:RegisterEvent("PLAYER_MONEY")
frame:RegisterEvent("PLAYER_LOGOUT")
for _, ev in ipairs({ "ACCOUNT_MONEY", "GUILDBANK_UPDATE_MONEY", "PLAYER_INTERACTION_MANAGER_FRAME_SHOW", "PLAYER_INTERACTION_MANAGER_FRAME_HIDE" }) do
	pcall(frame.RegisterEvent, frame, ev) -- a name this client doesn't know must not break the file
end
frame:SetScript("OnEvent", function(_, event, arg1)
	if event == "ADDON_LOADED" then
		if arg1 == "WowAHTracker" then
			EnsureDB()
		end
	elseif event == "PLAYER_ENTERING_WORLD" then
		recordCharacter(true)
		-- give the client a moment to load account data before reading the Warband bank
		after(3, function()
			recordWarband("login", true)
		end)
	elseif event == "PLAYER_MONEY" then
		recordCharacter(false)
	elseif event == "PLAYER_LOGOUT" then
		recordCharacter(false)
	elseif event == "ACCOUNT_MONEY" then
		recordWarband("event", false)
	elseif event == "GUILDBANK_UPDATE_MONEY" then
		recordGuildBank()
	elseif event == "PLAYER_INTERACTION_MANAGER_FRAME_SHOW" then
		if arg1 == interaction("GuildBanker") then
			guildBankOpen = true
			after(2, recordGuildBank) -- once the bank's data has arrived
		elseif arg1 == interaction("Banker") or arg1 == interaction("AccountBanker") or arg1 == interaction("CharacterBanker") then
			recordWarband("bank", true)
		end
	elseif event == "PLAYER_INTERACTION_MANAGER_FRAME_HIDE" then
		if arg1 == interaction("GuildBanker") then
			recordGuildBank()
			guildBankOpen = false
		end
	end
end)
