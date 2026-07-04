--[[
	TGCManagerData
	Ported game content from the TGC Manager web prototype (server/index.html).

	Scope (deliberately limited): the 203-player roster, the 10 rarity tiers,
	the 3 formations, and the 4 pack definitions + their odds, plus the small
	self-contained helper functions needed to actually use that data
	(rarity ranking, weighted pack draws). This does NOT include match
	simulation, UI, save/load, or monetization wiring -- those are a
	separate, larger pass once this data layer is in place.

	Where to put this file in Roblox Studio:
	  1. In the Explorer window, right-click "ReplicatedStorage".
	  2. Insert Object -> ModuleScript.
	  3. Rename it to "TGCManagerData".
	  4. Delete the placeholder line Studio puts in it, paste this whole file in its place.
	  5. Save.

	How other scripts use it (from a Script or LocalScript):
	  local ReplicatedStorage = game:GetService("ReplicatedStorage")
	  local TGCManagerData = require(ReplicatedStorage:WaitForChild("TGCManagerData"))

	  -- look up a player by id
	  local messi = TGCManagerData.PlayersById[17]

	  -- draw a random card from a pack, out of the players you don't own yet
	  local lockedPlayers = {}
	  for _, p in ipairs(TGCManagerData.Players) do
	      if not myOwnedIds[p.Id] then table.insert(lockedPlayers, p) end
	  end
	  local pack = TGCManagerData.PacksById["gold"]
	  local pulled = TGCManagerData.PickWeighted(lockedPlayers, pack.Weights)
]]

local TGCManagerData = {}

-- ===== Rarities (listed low -> high) =====
TGCManagerData.RarityOrder = {
	"Common", "Uncommon", "Rare", "Epic", "Elite",
	"Ultra", "Legendary", "Mythic", "Icon", "GOAT",
}

-- Colors are hex strings (same palette as the web version) -- use
-- TGCManagerData.HexToColor3(hex) to get a Color3 for Roblox UI objects.
TGCManagerData.Rarity = {
	Common    = { Color = "#9AA5B1", Label = "COMMON" },
	Uncommon  = { Color = "#4ADE80", Label = "UNCOMMON" },
	Rare      = { Color = "#2FD180", Label = "RARE" },
	Epic      = { Color = "#2FB6D9", Label = "EPIC" },
	Elite     = { Color = "#3B82F6", Label = "ELITE" },
	Ultra     = { Color = "#8B7FE8", Label = "ULTRA" },
	Legendary = { Color = "#FFB020", Label = "LEGENDARY" },
	Mythic    = { Color = "#F97316", Label = "MYTHIC" },
	Icon      = { Color = "#E14F8A", Label = "ICON" },
	GOAT      = { Color = "#FFD700", Label = "GOAT" },
}

function TGCManagerData.HexToColor3(hex)
	hex = hex:gsub("#", "")
	local r = tonumber(hex:sub(1, 2), 16) or 0
	local g = tonumber(hex:sub(3, 4), 16) or 0
	local b = tonumber(hex:sub(5, 6), 16) or 0
	return Color3.fromRGB(r, g, b)
end

function TGCManagerData.TierRank(rarity)
	for i, r in ipairs(TGCManagerData.RarityOrder) do
		if r == rarity then
			return i
		end
	end
	return -1
end

function TGCManagerData.IsTopTier(rarity)
	return TGCManagerData.TierRank(rarity) >= TGCManagerData.TierRank("Legendary")
end

function TGCManagerData.IsHighTier(rarity)
	return TGCManagerData.TierRank(rarity) >= TGCManagerData.TierRank("Epic")
end

-- ===== Players =====
-- StartingOwned = true marks the 10 cards a brand-new player begins with
-- (mirrors the web version's default roster). Track *actual* per-player
-- ownership in your own save data / DataStore -- don't mutate this table.
-- Exclusive = true + PriceEUR marks the 3 non-pack "buy directly" cards.
TGCManagerData.Players = {
	{ Id = 1, Name = "K. Fenwick", Position = "FWD", Power = 78, Rarity = "Rare", StartingOwned = true },
	{ Id = 2, Name = "R. Adeyemi", Position = "MID", Power = 71, Rarity = "Common", StartingOwned = true },
	{ Id = 3, Name = "D. Falcone", Position = "DEF", Power = 69, Rarity = "Common", StartingOwned = true },
	{ Id = 4, Name = "M. Storm", Position = "FWD", Power = 88, Rarity = "Epic", StartingOwned = true },
	{ Id = 5, Name = "T. Vasquez", Position = "GK", Power = 74, Rarity = "Rare", StartingOwned = true },
	{ Id = 6, Name = "L. Okafor", Position = "MID", Power = 65, Rarity = "Common", StartingOwned = true },
	{ Id = 7, Name = "N. Petrov", Position = "DEF", Power = 95, Rarity = "Legendary", StartingOwned = false },
	{ Id = 8, Name = "A. Sundberg", Position = "FWD", Power = 91, Rarity = "Epic", StartingOwned = false },
	{ Id = 9, Name = "J. Marchetti", Position = "MID", Power = 83, Rarity = "Rare", StartingOwned = false },
	{ Id = 10, Name = "C. Duarte", Position = "GK", Power = 97, Rarity = "Legendary", StartingOwned = false },
	{ Id = 11, Name = "H. Ibrahim", Position = "FWD", Power = 73, Rarity = "Rare", StartingOwned = false },
	{ Id = 12, Name = "P. Kowalski", Position = "DEF", Power = 60, Rarity = "Common", StartingOwned = true },
	{ Id = 100, Name = "R. Whitfield", Position = "MID", Power = 66, Rarity = "Common", StartingOwned = true },
	{ Id = 101, Name = "S. Nakamura", Position = "MID", Power = 72, Rarity = "Rare", StartingOwned = true },
	{ Id = 102, Name = "T. Okonkwo", Position = "DEF", Power = 70, Rarity = "Common", StartingOwned = true },
	{ Id = 13, Name = "S. Odongo", Position = "MID", Power = 85, Rarity = "Epic", StartingOwned = false },
	{ Id = 14, Name = "V. Laurent", Position = "GK", Power = 66, Rarity = "Common", StartingOwned = false },
	{ Id = 15, Name = "B. Kessler", Position = "FWD", Power = 99, Rarity = "Legendary", StartingOwned = false },
	{ Id = 16, Name = "O. Renard", Position = "MID", Power = 76, Rarity = "Rare", StartingOwned = false },
	{ Id = 17, Name = "L. Messi", Position = "FWD", Power = 98, Rarity = "Legendary", StartingOwned = false },
	{ Id = 18, Name = "K. Mbappé", Position = "FWD", Power = 99, Rarity = "Legendary", StartingOwned = false },
	{ Id = 19, Name = "C. Ronaldo", Position = "FWD", Power = 96, Rarity = "Legendary", StartingOwned = false },
	{ Id = 20, Name = "E. Haaland", Position = "FWD", Power = 97, Rarity = "Legendary", StartingOwned = false },
	{ Id = 21, Name = "Vinícius Jr", Position = "FWD", Power = 93, Rarity = "Epic", StartingOwned = false },
	{ Id = 22, Name = "J. Bellingham", Position = "MID", Power = 92, Rarity = "Epic", StartingOwned = false },
	{ Id = 23, Name = "L. Yamal", Position = "FWD", Power = 90, Rarity = "Epic", StartingOwned = false },
	{ Id = 24, Name = "L. Modrić", Position = "MID", Power = 82, Rarity = "Rare", StartingOwned = false },
	{ Id = 25, Name = "M. Salah", Position = "FWD", Power = 88, Rarity = "Epic", StartingOwned = false },
	{ Id = 26, Name = "H. Kane", Position = "FWD", Power = 87, Rarity = "Epic", StartingOwned = false },
	{ Id = 27, Name = "World XI Captain", Position = "FWD", Power = 100, Rarity = "Legendary", StartingOwned = false, Exclusive = true, PriceEUR = 5 },
	{ Id = 28, Name = "Golden Boot Star", Position = "MID", Power = 100, Rarity = "Legendary", StartingOwned = false, Exclusive = true, PriceEUR = 5 },
	{ Id = 29, Name = "Iron Wall Elite", Position = "DEF", Power = 100, Rarity = "Legendary", StartingOwned = false, Exclusive = true, PriceEUR = 5 },
	{ Id = 30, Name = "Alisson Becker", Position = "GK", Power = 91, Rarity = "Legendary", StartingOwned = false },
	{ Id = 31, Name = "Thibaut Courtois", Position = "GK", Power = 90, Rarity = "Epic", StartingOwned = false },
	{ Id = 32, Name = "Marc-André ter Stegen", Position = "GK", Power = 88, Rarity = "Epic", StartingOwned = false },
	{ Id = 33, Name = "Ederson", Position = "GK", Power = 87, Rarity = "Epic", StartingOwned = false },
	{ Id = 34, Name = "Jan Oblak", Position = "GK", Power = 89, Rarity = "Epic", StartingOwned = false },
	{ Id = 35, Name = "Gianluigi Donnarumma", Position = "GK", Power = 87, Rarity = "Epic", StartingOwned = false },
	{ Id = 36, Name = "Emiliano Martínez", Position = "GK", Power = 86, Rarity = "Epic", StartingOwned = false },
	{ Id = 37, Name = "Yassine Bounou", Position = "GK", Power = 82, Rarity = "Rare", StartingOwned = false },
	{ Id = 38, Name = "Manuel Neuer", Position = "GK", Power = 85, Rarity = "Epic", StartingOwned = false },
	{ Id = 39, Name = "Mike Maignan", Position = "GK", Power = 86, Rarity = "Epic", StartingOwned = false },
	{ Id = 40, Name = "Virgil van Dijk", Position = "DEF", Power = 90, Rarity = "Legendary", StartingOwned = false },
	{ Id = 41, Name = "Rúben Dias", Position = "DEF", Power = 89, Rarity = "Epic", StartingOwned = false },
	{ Id = 42, Name = "William Saliba", Position = "DEF", Power = 86, Rarity = "Epic", StartingOwned = false },
	{ Id = 43, Name = "Antonio Rüdiger", Position = "DEF", Power = 87, Rarity = "Epic", StartingOwned = false },
	{ Id = 44, Name = "Kim Min-jae", Position = "DEF", Power = 85, Rarity = "Epic", StartingOwned = false },
	{ Id = 45, Name = "Marquinhos", Position = "DEF", Power = 86, Rarity = "Epic", StartingOwned = false },
	{ Id = 46, Name = "Achraf Hakimi", Position = "DEF", Power = 87, Rarity = "Epic", StartingOwned = false },
	{ Id = 47, Name = "Trent Alexander-Arnold", Position = "DEF", Power = 88, Rarity = "Epic", StartingOwned = false },
	{ Id = 48, Name = "Alphonso Davies", Position = "DEF", Power = 85, Rarity = "Epic", StartingOwned = false },
	{ Id = 49, Name = "Theo Hernández", Position = "DEF", Power = 86, Rarity = "Epic", StartingOwned = false },
	{ Id = 50, Name = "Josko Gvardiol", Position = "DEF", Power = 84, Rarity = "Rare", StartingOwned = false },
	{ Id = 51, Name = "Éder Militão", Position = "DEF", Power = 85, Rarity = "Epic", StartingOwned = false },
	{ Id = 52, Name = "David Alaba", Position = "DEF", Power = 84, Rarity = "Rare", StartingOwned = false },
	{ Id = 53, Name = "Kyle Walker", Position = "DEF", Power = 83, Rarity = "Rare", StartingOwned = false },
	{ Id = 54, Name = "Dani Carvajal", Position = "DEF", Power = 84, Rarity = "Rare", StartingOwned = false },
	{ Id = 55, Name = "Jules Koundé", Position = "DEF", Power = 83, Rarity = "Rare", StartingOwned = false },
	{ Id = 56, Name = "Sergio Ramos", Position = "DEF", Power = 85, Rarity = "Epic", StartingOwned = false },
	{ Id = 57, Name = "Thiago Silva", Position = "DEF", Power = 83, Rarity = "Rare", StartingOwned = false },
	{ Id = 58, Name = "Kevin De Bruyne", Position = "MID", Power = 91, Rarity = "Legendary", StartingOwned = false },
	{ Id = 59, Name = "Rodri", Position = "MID", Power = 90, Rarity = "Legendary", StartingOwned = false },
	{ Id = 60, Name = "Toni Kroos", Position = "MID", Power = 88, Rarity = "Epic", StartingOwned = false },
	{ Id = 61, Name = "Casemiro", Position = "MID", Power = 86, Rarity = "Epic", StartingOwned = false },
	{ Id = 62, Name = "Frenkie de Jong", Position = "MID", Power = 87, Rarity = "Epic", StartingOwned = false },
	{ Id = 63, Name = "Pedri", Position = "MID", Power = 87, Rarity = "Epic", StartingOwned = false },
	{ Id = 64, Name = "Gavi", Position = "MID", Power = 84, Rarity = "Rare", StartingOwned = false },
	{ Id = 65, Name = "Bruno Fernandes", Position = "MID", Power = 88, Rarity = "Epic", StartingOwned = false },
	{ Id = 66, Name = "İlkay Gündoğan", Position = "MID", Power = 86, Rarity = "Epic", StartingOwned = false },
	{ Id = 67, Name = "Federico Valverde", Position = "MID", Power = 87, Rarity = "Epic", StartingOwned = false },
	{ Id = 68, Name = "Martin Ødegaard", Position = "MID", Power = 87, Rarity = "Epic", StartingOwned = false },
	{ Id = 69, Name = "N'Golo Kanté", Position = "MID", Power = 85, Rarity = "Epic", StartingOwned = false },
	{ Id = 70, Name = "Declan Rice", Position = "MID", Power = 85, Rarity = "Epic", StartingOwned = false },
	{ Id = 71, Name = "Joshua Kimmich", Position = "MID", Power = 88, Rarity = "Epic", StartingOwned = false },
	{ Id = 72, Name = "Marco Verratti", Position = "MID", Power = 84, Rarity = "Rare", StartingOwned = false },
	{ Id = 73, Name = "Jorginho", Position = "MID", Power = 82, Rarity = "Rare", StartingOwned = false },
	{ Id = 74, Name = "Aurélien Tchouaméni", Position = "MID", Power = 83, Rarity = "Rare", StartingOwned = false },
	{ Id = 75, Name = "Enzo Fernández", Position = "MID", Power = 83, Rarity = "Rare", StartingOwned = false },
	{ Id = 76, Name = "Neymar Jr", Position = "FWD", Power = 89, Rarity = "Epic", StartingOwned = false },
	{ Id = 77, Name = "Robert Lewandowski", Position = "FWD", Power = 91, Rarity = "Legendary", StartingOwned = false },
	{ Id = 78, Name = "Karim Benzema", Position = "FWD", Power = 89, Rarity = "Epic", StartingOwned = false },
	{ Id = 79, Name = "Antoine Griezmann", Position = "FWD", Power = 88, Rarity = "Epic", StartingOwned = false },
	{ Id = 80, Name = "Son Heung-min", Position = "FWD", Power = 88, Rarity = "Epic", StartingOwned = false },
	{ Id = 81, Name = "Rafael Leão", Position = "FWD", Power = 86, Rarity = "Epic", StartingOwned = false },
	{ Id = 82, Name = "Victor Osimhen", Position = "FWD", Power = 88, Rarity = "Epic", StartingOwned = false },
	{ Id = 83, Name = "Marcus Rashford", Position = "FWD", Power = 85, Rarity = "Epic", StartingOwned = false },
	{ Id = 84, Name = "Phil Foden", Position = "FWD", Power = 87, Rarity = "Epic", StartingOwned = false },
	{ Id = 85, Name = "Bukayo Saka", Position = "FWD", Power = 87, Rarity = "Epic", StartingOwned = false },
	{ Id = 86, Name = "Ousmane Dembélé", Position = "FWD", Power = 85, Rarity = "Epic", StartingOwned = false },
	{ Id = 87, Name = "Federico Chiesa", Position = "FWD", Power = 83, Rarity = "Rare", StartingOwned = false },
	{ Id = 88, Name = "Julián Álvarez", Position = "FWD", Power = 85, Rarity = "Epic", StartingOwned = false },
	{ Id = 89, Name = "Cole Palmer", Position = "FWD", Power = 84, Rarity = "Rare", StartingOwned = false },
	{ Id = 90, Name = "Gabriel Jesus", Position = "FWD", Power = 83, Rarity = "Rare", StartingOwned = false },
	{ Id = 91, Name = "Darwin Núñez", Position = "FWD", Power = 83, Rarity = "Rare", StartingOwned = false },
	{ Id = 92, Name = "Khvicha Kvaratskhelia", Position = "FWD", Power = 87, Rarity = "Epic", StartingOwned = false },
	{ Id = 93, Name = "Jamal Musiala", Position = "FWD", Power = 87, Rarity = "Epic", StartingOwned = false },
	{ Id = 94, Name = "Serhou Guirassy", Position = "FWD", Power = 81, Rarity = "Rare", StartingOwned = false },
	{ Id = 95, Name = "Alexander Isak", Position = "FWD", Power = 84, Rarity = "Rare", StartingOwned = false },
	{ Id = 96, Name = "Dušan Vlahović", Position = "FWD", Power = 84, Rarity = "Rare", StartingOwned = false },
	{ Id = 97, Name = "Randal Kolo Muani", Position = "FWD", Power = 82, Rarity = "Rare", StartingOwned = false },
	{ Id = 98, Name = "Rodrygo", Position = "FWD", Power = 85, Rarity = "Epic", StartingOwned = false },
	{ Id = 99, Name = "Ángel Di María", Position = "FWD", Power = 83, Rarity = "Rare", StartingOwned = false },
	{ Id = 104, Name = "Pelé", Position = "FWD", Power = 100, Rarity = "GOAT", StartingOwned = false },
	{ Id = 105, Name = "Diego Maradona", Position = "MID", Power = 100, Rarity = "GOAT", StartingOwned = false },
	{ Id = 106, Name = "Johan Cruyff", Position = "FWD", Power = 98, Rarity = "GOAT", StartingOwned = false },
	{ Id = 107, Name = "Franz Beckenbauer", Position = "DEF", Power = 97, Rarity = "GOAT", StartingOwned = false },
	{ Id = 108, Name = "Zinedine Zidane", Position = "MID", Power = 98, Rarity = "GOAT", StartingOwned = false },
	{ Id = 109, Name = "Ronaldinho", Position = "MID", Power = 97, Rarity = "GOAT", StartingOwned = false },
	{ Id = 110, Name = "Ronaldo Nazário", Position = "FWD", Power = 98, Rarity = "GOAT", StartingOwned = false },
	{ Id = 111, Name = "Marta", Position = "FWD", Power = 97, Rarity = "GOAT", StartingOwned = false },
	{ Id = 112, Name = "Thierry Henry", Position = "FWD", Power = 95, Rarity = "Icon", StartingOwned = false },
	{ Id = 113, Name = "David Beckham", Position = "MID", Power = 92, Rarity = "Icon", StartingOwned = false },
	{ Id = 114, Name = "Paolo Maldini", Position = "DEF", Power = 96, Rarity = "Icon", StartingOwned = false },
	{ Id = 115, Name = "Xavi Hernández", Position = "MID", Power = 94, Rarity = "Icon", StartingOwned = false },
	{ Id = 116, Name = "Andrés Iniesta", Position = "MID", Power = 95, Rarity = "Icon", StartingOwned = false },
	{ Id = 117, Name = "Iker Casillas", Position = "GK", Power = 93, Rarity = "Icon", StartingOwned = false },
	{ Id = 118, Name = "Gianluigi Buffon", Position = "GK", Power = 95, Rarity = "Icon", StartingOwned = false },
	{ Id = 119, Name = "Roberto Carlos", Position = "DEF", Power = 92, Rarity = "Icon", StartingOwned = false },
	{ Id = 120, Name = "Cafu", Position = "DEF", Power = 92, Rarity = "Icon", StartingOwned = false },
	{ Id = 121, Name = "George Best", Position = "FWD", Power = 93, Rarity = "Icon", StartingOwned = false },
	{ Id = 122, Name = "Michel Platini", Position = "MID", Power = 94, Rarity = "Icon", StartingOwned = false },
	{ Id = 123, Name = "Marco van Basten", Position = "FWD", Power = 95, Rarity = "Icon", StartingOwned = false },
	{ Id = 124, Name = "Alfredo Di Stéfano", Position = "FWD", Power = 96, Rarity = "Icon", StartingOwned = false },
	{ Id = 125, Name = "Garrincha", Position = "FWD", Power = 93, Rarity = "Icon", StartingOwned = false },
	{ Id = 126, Name = "Eusébio", Position = "FWD", Power = 94, Rarity = "Icon", StartingOwned = false },
	{ Id = 127, Name = "Bobby Moore", Position = "DEF", Power = 91, Rarity = "Icon", StartingOwned = false },
	{ Id = 128, Name = "Franco Baresi", Position = "DEF", Power = 93, Rarity = "Icon", StartingOwned = false },
	{ Id = 129, Name = "Fabio Cannavaro", Position = "DEF", Power = 92, Rarity = "Icon", StartingOwned = false },
	{ Id = 130, Name = "Andrea Pirlo", Position = "MID", Power = 92, Rarity = "Icon", StartingOwned = false },
	{ Id = 131, Name = "Didier Drogba", Position = "FWD", Power = 91, Rarity = "Icon", StartingOwned = false },
	{ Id = 132, Name = "Samuel Eto'o", Position = "FWD", Power = 92, Rarity = "Icon", StartingOwned = false },
	{ Id = 133, Name = "Luís Figo", Position = "MID", Power = 91, Rarity = "Icon", StartingOwned = false },
	{ Id = 134, Name = "Kaká", Position = "MID", Power = 92, Rarity = "Icon", StartingOwned = false },
	{ Id = 135, Name = "Alexia Putellas", Position = "MID", Power = 94, Rarity = "Icon", StartingOwned = false },
	{ Id = 136, Name = "Aitana Bonmatí", Position = "MID", Power = 93, Rarity = "Icon", StartingOwned = false },
	{ Id = 137, Name = "Steven Gerrard", Position = "MID", Power = 90, Rarity = "Mythic", StartingOwned = false },
	{ Id = 138, Name = "Frank Lampard", Position = "MID", Power = 89, Rarity = "Mythic", StartingOwned = false },
	{ Id = 139, Name = "Wayne Rooney", Position = "FWD", Power = 90, Rarity = "Mythic", StartingOwned = false },
	{ Id = 140, Name = "Ryan Giggs", Position = "MID", Power = 88, Rarity = "Mythic", StartingOwned = false },
	{ Id = 141, Name = "Eric Cantona", Position = "FWD", Power = 89, Rarity = "Mythic", StartingOwned = false },
	{ Id = 142, Name = "Raúl González", Position = "FWD", Power = 90, Rarity = "Mythic", StartingOwned = false },
	{ Id = 143, Name = "Carles Puyol", Position = "DEF", Power = 88, Rarity = "Mythic", StartingOwned = false },
	{ Id = 144, Name = "Gerard Piqué", Position = "DEF", Power = 87, Rarity = "Mythic", StartingOwned = false },
	{ Id = 145, Name = "Sergio Agüero", Position = "FWD", Power = 91, Rarity = "Mythic", StartingOwned = false },
	{ Id = 146, Name = "Radamel Falcao", Position = "FWD", Power = 87, Rarity = "Mythic", StartingOwned = false },
	{ Id = 147, Name = "James Rodríguez", Position = "MID", Power = 87, Rarity = "Mythic", StartingOwned = false },
	{ Id = 148, Name = "Zico", Position = "MID", Power = 90, Rarity = "Mythic", StartingOwned = false },
	{ Id = 149, Name = "Sócrates", Position = "MID", Power = 88, Rarity = "Mythic", StartingOwned = false },
	{ Id = 150, Name = "Alex Morgan", Position = "FWD", Power = 89, Rarity = "Mythic", StartingOwned = false },
	{ Id = 151, Name = "Sam Kerr", Position = "FWD", Power = 90, Rarity = "Mythic", StartingOwned = false },
	{ Id = 152, Name = "Megan Rapinoe", Position = "FWD", Power = 87, Rarity = "Mythic", StartingOwned = false },
	{ Id = 153, Name = "Ada Hegerberg", Position = "FWD", Power = 89, Rarity = "Mythic", StartingOwned = false },
	{ Id = 154, Name = "Wendie Renard", Position = "DEF", Power = 88, Rarity = "Mythic", StartingOwned = false },
	{ Id = 155, Name = "Lucy Bronze", Position = "DEF", Power = 89, Rarity = "Mythic", StartingOwned = false },
	{ Id = 156, Name = "Lautaro Martínez", Position = "FWD", Power = 87, Rarity = "Ultra", StartingOwned = false },
	{ Id = 157, Name = "Nicolò Barella", Position = "MID", Power = 86, Rarity = "Ultra", StartingOwned = false },
	{ Id = 158, Name = "Federico Dimarco", Position = "DEF", Power = 84, Rarity = "Elite", StartingOwned = false },
	{ Id = 159, Name = "Christian Pulisic", Position = "MID", Power = 83, Rarity = "Elite", StartingOwned = false },
	{ Id = 160, Name = "Paulo Dybala", Position = "FWD", Power = 85, Rarity = "Ultra", StartingOwned = false },
	{ Id = 161, Name = "Domenico Berardi", Position = "FWD", Power = 82, Rarity = "Elite", StartingOwned = false },
	{ Id = 162, Name = "Sandro Tonali", Position = "MID", Power = 83, Rarity = "Elite", StartingOwned = false },
	{ Id = 163, Name = "Davide Frattesi", Position = "MID", Power = 81, Rarity = "Rare", StartingOwned = false },
	{ Id = 164, Name = "Warren Zaïre-Emery", Position = "MID", Power = 80, Rarity = "Rare", StartingOwned = false },
	{ Id = 165, Name = "Bradley Barcola", Position = "FWD", Power = 81, Rarity = "Rare", StartingOwned = false },
	{ Id = 166, Name = "Vitinha", Position = "MID", Power = 83, Rarity = "Elite", StartingOwned = false },
	{ Id = 167, Name = "Manuel Ugarte", Position = "MID", Power = 81, Rarity = "Rare", StartingOwned = false },
	{ Id = 168, Name = "Gonçalo Ramos", Position = "FWD", Power = 82, Rarity = "Elite", StartingOwned = false },
	{ Id = 169, Name = "Florian Wirtz", Position = "MID", Power = 87, Rarity = "Ultra", StartingOwned = false },
	{ Id = 170, Name = "Kai Havertz", Position = "FWD", Power = 85, Rarity = "Ultra", StartingOwned = false },
	{ Id = 171, Name = "Leroy Sané", Position = "FWD", Power = 86, Rarity = "Ultra", StartingOwned = false },
	{ Id = 172, Name = "Serge Gnabry", Position = "FWD", Power = 84, Rarity = "Elite", StartingOwned = false },
	{ Id = 173, Name = "Thomas Müller", Position = "FWD", Power = 85, Rarity = "Ultra", StartingOwned = false },
	{ Id = 174, Name = "Leon Goretzka", Position = "MID", Power = 84, Rarity = "Elite", StartingOwned = false },
	{ Id = 175, Name = "Niclas Füllkrug", Position = "FWD", Power = 82, Rarity = "Elite", StartingOwned = false },
	{ Id = 176, Name = "Takefusa Kubo", Position = "FWD", Power = 82, Rarity = "Elite", StartingOwned = false },
	{ Id = 177, Name = "Ritsu Doan", Position = "FWD", Power = 80, Rarity = "Rare", StartingOwned = false },
	{ Id = 178, Name = "Wataru Endo", Position = "MID", Power = 79, Rarity = "Rare", StartingOwned = false },
	{ Id = 179, Name = "Hwang Hee-chan", Position = "FWD", Power = 81, Rarity = "Rare", StartingOwned = false },
	{ Id = 180, Name = "Jonathan David", Position = "FWD", Power = 83, Rarity = "Elite", StartingOwned = false },
	{ Id = 181, Name = "Cyle Larin", Position = "FWD", Power = 76, Rarity = "Rare", StartingOwned = false },
	{ Id = 182, Name = "Weston McKennie", Position = "MID", Power = 80, Rarity = "Rare", StartingOwned = false },
	{ Id = 183, Name = "Folarin Balogun", Position = "FWD", Power = 79, Rarity = "Rare", StartingOwned = false },
	{ Id = 184, Name = "Sadio Mané", Position = "FWD", Power = 87, Rarity = "Ultra", StartingOwned = false },
	{ Id = 185, Name = "Hakim Ziyech", Position = "MID", Power = 82, Rarity = "Elite", StartingOwned = false },
	{ Id = 186, Name = "Youssef En-Nesyri", Position = "FWD", Power = 81, Rarity = "Rare", StartingOwned = false },
	{ Id = 187, Name = "Sofyan Amrabat", Position = "MID", Power = 80, Rarity = "Rare", StartingOwned = false },
	{ Id = 188, Name = "Thomas Partey", Position = "MID", Power = 83, Rarity = "Elite", StartingOwned = false },
	{ Id = 189, Name = "André Onana", Position = "GK", Power = 84, Rarity = "Elite", StartingOwned = false },
	{ Id = 190, Name = "Édouard Mendy", Position = "GK", Power = 83, Rarity = "Elite", StartingOwned = false },
	{ Id = 191, Name = "Nico Williams", Position = "FWD", Power = 84, Rarity = "Elite", StartingOwned = false },
	{ Id = 192, Name = "Iñaki Williams", Position = "FWD", Power = 82, Rarity = "Elite", StartingOwned = false },
	{ Id = 193, Name = "Mikel Oyarzabal", Position = "FWD", Power = 83, Rarity = "Elite", StartingOwned = false },
	{ Id = 194, Name = "Álvaro Morata", Position = "FWD", Power = 82, Rarity = "Elite", StartingOwned = false },
	{ Id = 195, Name = "Marco Asensio", Position = "FWD", Power = 81, Rarity = "Rare", StartingOwned = false },
	{ Id = 196, Name = "Dani Olmo", Position = "MID", Power = 84, Rarity = "Elite", StartingOwned = false },
	{ Id = 197, Name = "Raphinha", Position = "FWD", Power = 85, Rarity = "Ultra", StartingOwned = false },
	{ Id = 198, Name = "Ronald Araújo", Position = "DEF", Power = 85, Rarity = "Ultra", StartingOwned = false },
	{ Id = 199, Name = "Alejandro Balde", Position = "DEF", Power = 81, Rarity = "Rare", StartingOwned = false },
	{ Id = 200, Name = "Cody Gakpo", Position = "FWD", Power = 83, Rarity = "Elite", StartingOwned = false },
	{ Id = 201, Name = "Xavi Simons", Position = "MID", Power = 82, Rarity = "Elite", StartingOwned = false },
	{ Id = 202, Name = "Memphis Depay", Position = "FWD", Power = 84, Rarity = "Elite", StartingOwned = false },
	{ Id = 203, Name = "Matthijs de Ligt", Position = "DEF", Power = 83, Rarity = "Elite", StartingOwned = false },
	{ Id = 204, Name = "Denzel Dumfries", Position = "DEF", Power = 81, Rarity = "Rare", StartingOwned = false },
}

-- Fast id -> player lookup, built once when this module is required.
TGCManagerData.PlayersById = {}
for _, p in ipairs(TGCManagerData.Players) do
	TGCManagerData.PlayersById[p.Id] = p
end

-- ===== Formations =====
TGCManagerData.Formations = {
	balanced = { Name = "Balanced (1-2-4-2)", Counts = { GK = 1, DEF = 2, MID = 4, FWD = 2 } },
	defensive = { Name = "Defensive (1-3-3-2)", Counts = { GK = 1, DEF = 3, MID = 3, FWD = 2 } },
	attacking = { Name = "Attacking (1-2-3-3)", Counts = { GK = 1, DEF = 2, MID = 3, FWD = 3 } },
}

-- ===== Packs =====
-- Weights are relative, not percentages -- PickWeighted below normalizes
-- them against whatever pool of cards you pass in.
TGCManagerData.Packs = {
	{
		Id = "bronze", Name = "Bronze Pack", Cost = 20, Icon = "📦",
		Blurb = "Great value — mostly Common & Uncommon",
		Weights = { Common = 45, Uncommon = 32, Rare = 16, Epic = 5, Elite = 1.5, Ultra = 0.4, Legendary = 0.08, Mythic = 0.015, Icon = 0.004, GOAT = 0.001 },
		GradientFrom = "#B87333", GradientTo = "#8C5A2B", Glow = "#D08A4F",
	},
	{
		Id = "silver", Name = "Silver Pack", Cost = 45, Icon = "🎁",
		Blurb = "Balanced odds across all rarities",
		Weights = { Common = 20, Uncommon = 22, Rare = 24, Epic = 18, Elite = 9, Ultra = 4, Legendary = 2, Mythic = 0.7, Icon = 0.25, GOAT = 0.05 },
		GradientFrom = "#C7D3E0", GradientTo = "#7C8DA6", Glow = "#C0C0C0",
	},
	{
		Id = "gold", Name = "Gold Pack", Cost = 90, Icon = "💰",
		Blurb = "Boosted Elite & Legendary+ odds",
		Weights = { Common = 2, Uncommon = 5, Rare = 12, Epic = 22, Elite = 22, Ultra = 18, Legendary = 12, Mythic = 5, Icon = 1.7, GOAT = 0.3 },
		GradientFrom = "#FFC94A", GradientTo = "#FF9F4A", Glow = "#FFC94A",
	},
	{
		Id = "legendary", Name = "Legendary Pack", Cost = 180, Icon = "👑",
		Blurb = "Guaranteed Elite tier or better!",
		Weights = { Elite = 10, Ultra = 20, Legendary = 35, Mythic = 22, Icon = 10, GOAT = 3 },
		GradientFrom = "#B784F0", GradientTo = "#FF6FB5", Glow = "#B784F0",
	},
}

TGCManagerData.PacksById = {}
for _, pack in ipairs(TGCManagerData.Packs) do
	TGCManagerData.PacksById[pack.Id] = pack
end

-- Draw one random player from `pool` (an array of player rows, e.g. the
-- cards a given player doesn't own yet), weighted by rarity according to
-- `weights` (one of the Weights tables above). Mirrors the web version's
-- pickWeighted() exactly, including its fallback when no bucket matches.
function TGCManagerData.PickWeighted(pool, weights)
	local buckets = {}
	for _, rarity in ipairs(TGCManagerData.RarityOrder) do
		local w = weights[rarity] or 0
		if w > 0 then
			local bucketPool = {}
			for _, p in ipairs(pool) do
				if p.Rarity == rarity then
					table.insert(bucketPool, p)
				end
			end
			if #bucketPool > 0 then
				table.insert(buckets, { rarity = rarity, pool = bucketPool, w = w })
			end
		end
	end

	if #buckets == 0 then
		if #pool == 0 then
			return nil
		end
		return pool[math.random(1, #pool)]
	end

	local totalW = 0
	for _, b in ipairs(buckets) do
		totalW += b.w
	end

	local roll = math.random() * totalW
	for _, b in ipairs(buckets) do
		if roll < b.w then
			return b.pool[math.random(1, #b.pool)]
		end
		roll -= b.w
	end

	local last = buckets[#buckets]
	return last.pool[math.random(1, #last.pool)]
end

return TGCManagerData
