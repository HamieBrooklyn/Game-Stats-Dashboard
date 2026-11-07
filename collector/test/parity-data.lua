-- Parity fixture, the Luau side: run in Roblox Studio (Edit, command bar or MCP) in a place with Spotlight Admin
-- @ dd14298 and Roll-A-Car-Show's FunnelConfig. It builds the same store data as test/parity-data.js (same
-- deterministic generator), runs the package's real Query.build on it, and prints one hash per widget. Paste
-- the printed JSON into test/fixtures/parity-hashes.json; `npm test` compares the JS port's widgets with it.

local SSS = game:GetService("ServerScriptService")
local Http = game:GetService("HttpService")
local function fresh(m) local c = m:Clone(); c.Parent = m.Parent; local ok, r = pcall(require, c); c:Destroy(); assert(ok, r); return r end
local folder = SSS.SpotlightAdmin.Stats
local State = require(folder.State)
local Store = require(folder.Store)
local Query = require(folder.Query)
local FunnelConfig = fresh(game.ReplicatedStorage.Shared.Config.FunnelConfig)
State.set({ shards = 1, funnels = FunnelConfig.FUNNELS, journeyFunnel = "Onboarding", currencies = { "Cash", "Gems" } })

local AT = os.time() -- printed with the hashes; the JS side rebuilds the data for the same time
local seed = 42
local function int(a, b)
	seed = (seed * 16807) % 2147483647
	return a + seed % (b - a + 1)
end

local data = {}
local hour, day = AT // 3600, AT // 86400
local function bucket()
	local c = {}
	for _, name in { "dau", "dau_gap#new", "dau_gap#1", "dau_gap#2", "dau_gap#5", "dau_gap#old", "hau", "hau_gap#new", "hau_gap#1", "hau_gap#3", "hau_gap#old", "new_users", "session_sum", "sessions_ended", "playtime", "robux", "payers", "dau|platform=PC", "fu#Shop:Opened", "fu#Shop:Purchased", "funnel#Shop:01:Opened", "funnel#Shop:03:Purchased", "onb#01:Joined" } do
		c[name] = int(0, 90)
	end
	c.session_sum = int(100, 90000)
	return { c = c, m = { ccu = int(1, 40) } }
end
for h = hour - 47, hour do data[`H{h}_0`] = bucket() end
for d = day - 59, day do data[`D{d}_0`] = bucket() end
for d = day - 30, day do
	local cnt = { size = int(5, 60), d1 = int(0, 20), d7 = int(0, 8) }
	local reach = cnt.size
	for i, step in FunnelConfig.FUNNELS[1].Steps do
		reach = math.max(reach - int(0, 4), 0)
		cnt[`f#Onboarding:{step}`] = reach
		cnt[`fpt#Onboarding:{step}`] = reach * 30 * i
		cnt[`ffar#Onboarding:{step}`] = int(0, 3)
		if i % 3 == 0 then cnt[`fq1#Onboarding:{step}`] = int(1, 3) end
	end
	cnt["f#Comeback:Session2"] = int(0, 9)
	cnt["f#Onboarding:OldStep"] = 2
	data[`C{d}`] = cnt
end
local defs = { Version = 7, At = AT, Since = {}, Funnels = {} }
for _, funnel in State.funnels do
	local steps = {}
	for _, step in funnel.Steps do
		table.insert(steps, { Id = step.Id, Label = step.Label })
		defs.Since[`{funnel.Id}:{step.Id}`] = AT - 3 * 86400
	end
	table.insert(defs.Funnels, { Id = funnel.Id, Title = funnel.Title, Kind = funnel.Kind, Description = funnel.Description, Steps = steps })
end
data.FunnelDefs = defs
data.Journeys = {
	{ U = 1, N = "Alpha", T = AT - 3600, L = 1500, P = "PC", C = "SE", S = 1, F = "Roll5", D = false, E = { "Onboarding:Joined", "Shop:Opened" }, R = 0 },
	{ U = 2, N = "Beta", T = AT - 7200, L = 40, P = "Mobile", C = "US", S = 3, F = "Roll10", D = true, E = { "Onboarding:Roll10" }, R = 99 },
	{ U = 3, N = "Gamma", T = AT - 9000, L = 4000, P = "Tablet", C = "DE", S = 2, F = "", D = false, E = {}, R = 0 },
}
data.Markers = { Version = 7, List = { { T = AT - 5 * 3600, Kind = "Update", Text = "Version 7" }, { T = AT - 3 * 86400, Kind = "Note", Text = "Sale" } } }
Store.read = function(key) return data[key] end
Store.readMany = function(keys) local out = {} for _, k in keys do out[k] = data[k] end return out end

-- Canonical text of a value: sorted keys, numbers to 4 decimals; then FNV-1a
local function canon(value): string
	local kind = type(value)
	if kind == "number" then
		if value ~= value then return "nan" end
		return string.format("%.4f", value)
	elseif kind == "string" then
		return '"' .. value .. '"' -- raw UTF-8 bytes, hashed the same way on both sides
	elseif kind == "boolean" then
		return tostring(value)
	elseif kind == "table" then
		if #value > 0 or next(value) == nil then
			local parts = {}
			for _, item in value do table.insert(parts, canon(item)) end
			return "[" .. table.concat(parts, ",") .. "]"
		end
		local keys = {}
		for key in value do table.insert(keys, key) end
		table.sort(keys)
		local parts = {}
		for _, key in keys do table.insert(parts, key .. ":" .. canon(value[key])) end
		return "{" .. table.concat(parts, ",") .. "}"
	end
	return "null"
end
local function hash(text: string): string
	local h = 2166136261
	for i = 1, #text do
		h = bit32.bxor(h, string.byte(text, i))
		-- h * 16777619 mod 2^32, in 16-bit halves so it stays exact
		local lo, hi = h % 65536, h // 65536
		h = (lo * 16777619 + ((hi * 16777619) % 65536) * 65536) % 4294967296
	end
	return string.format("%08x", h)
end

local out = {}
local ok, err = pcall(function()
	for _, tab in { "Overview", "Funnels" } do
		for _, range in { "24h", "7d", "30d" } do
			local widgets = Query.build({ Tab = tab, Range = range }).Widgets
			local list = {}
			for _, widget in widgets do
				-- Equal bars come out in any order in Luau: sort them the same way on both sides
				if widget.Type == "Bars" then
					table.sort(widget.Items, function(a, b) if a.Value ~= b.Value then return a.Value > b.Value end return a.Label < b.Label end)
				end
				table.insert(list, hash(canon(widget)))
			end
			out[`{tab}:{range}`] = list
		end
	end
end)
assert(ok, err)
assert(os.time() // 3600 == AT // 3600, "crossed an hour while building: run again")
return Http:JSONEncode({ at = AT, hashes = out })
