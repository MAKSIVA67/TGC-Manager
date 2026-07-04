import React, { useState, useRef, useEffect } from "react";
import * as Tone from "tone";
import { Trophy, Lock, User, PlayCircle, List, Layers, Check, Flame, Coins, ShoppingBag, Sparkles, X, Star, Gem, RefreshCw, Repeat, Home, Gift, Award, Newspaper } from "lucide-react";

const COLORS = {
  bg: "#080F1A", bg2: "#0D1826", panel: "#132234", panelLight: "#1C3348",
  turf: "#2FD180", pitch: "#0F2A1C", pitchLine: "#2E6B47", pitchLine2: "#14351f", gold: "#FFB020",
  pink: "#E14F8A", cyan: "#2FB6D9", purple: "#8B7FE8", cream: "#F3F6FA",
  muted: "#6C84A3", danger: "#FB5A5A",
};
const RARITY = {
  Common: { color: "#9AA5B1", label: "COMMON" }, Uncommon: { color: "#4ADE80", label: "UNCOMMON" },
  Rare: { color: "#2FD180", label: "RARE" }, Epic: { color: "#2FB6D9", label: "EPIC" },
  Elite: { color: "#3B82F6", label: "ELITE" }, Ultra: { color: "#8B7FE8", label: "ULTRA" },
  Legendary: { color: "#FFB020", label: "LEGENDARY" }, Mythic: { color: "#F97316", label: "MYTHIC" },
  Icon: { color: "#E14F8A", label: "ICON" }, GOAT: { color: "#FFD700", label: "GOAT" },
};
const RARITY_ORDER = ["Common", "Uncommon", "Rare", "Epic", "Elite", "Ultra", "Legendary", "Mythic", "Icon", "GOAT"];
function tierRank(r) { return RARITY_ORDER.indexOf(r); }
function isTopTier(r) { return tierRank(r) >= tierRank("Legendary"); }
function isHighTier(r) { return tierRank(r) >= tierRank("Epic"); }
const STARTER_PLAYERS = [
  { id: 1, name: "K. Fenwick", position: "FWD", power: 78, rarity: "Rare", owned: true },
  { id: 2, name: "R. Adeyemi", position: "MID", power: 71, rarity: "Common", owned: true },
  { id: 3, name: "D. Falcone", position: "DEF", power: 69, rarity: "Common", owned: true },
  { id: 4, name: "M. Storm", position: "FWD", power: 88, rarity: "Epic", owned: true },
  { id: 5, name: "T. Vasquez", position: "GK", power: 74, rarity: "Rare", owned: true },
  { id: 6, name: "L. Okafor", position: "MID", power: 65, rarity: "Common", owned: true },
  { id: 7, name: "N. Petrov", position: "DEF", power: 95, rarity: "Legendary", owned: false },
  { id: 8, name: "A. Sundberg", position: "FWD", power: 91, rarity: "Epic", owned: false },
  { id: 9, name: "J. Marchetti", position: "MID", power: 83, rarity: "Rare", owned: false },
  { id: 10, name: "C. Duarte", position: "GK", power: 97, rarity: "Legendary", owned: false },
  { id: 11, name: "H. Ibrahim", position: "FWD", power: 73, rarity: "Rare", owned: false },
  { id: 12, name: "P. Kowalski", position: "DEF", power: 60, rarity: "Common", owned: true },
  { id: 100, name: "R. Whitfield", position: "MID", power: 66, rarity: "Common", owned: true },
  { id: 101, name: "S. Nakamura", position: "MID", power: 72, rarity: "Rare", owned: true },
  { id: 102, name: "T. Okonkwo", position: "DEF", power: 70, rarity: "Common", owned: true },
  { id: 13, name: "S. Odongo", position: "MID", power: 85, rarity: "Epic", owned: false },
  { id: 14, name: "V. Laurent", position: "GK", power: 66, rarity: "Common", owned: false },
  { id: 15, name: "B. Kessler", position: "FWD", power: 99, rarity: "Legendary", owned: false },
  { id: 16, name: "O. Renard", position: "MID", power: 76, rarity: "Rare", owned: false },
  { id: 17, name: "L. Messi", position: "FWD", power: 98, rarity: "Legendary", owned: false },
  { id: 18, name: "K. Mbappé", position: "FWD", power: 99, rarity: "Legendary", owned: false },
  { id: 19, name: "C. Ronaldo", position: "FWD", power: 96, rarity: "Legendary", owned: false },
  { id: 20, name: "E. Haaland", position: "FWD", power: 97, rarity: "Legendary", owned: false },
  { id: 21, name: "Vinícius Jr", position: "FWD", power: 93, rarity: "Epic", owned: false },
  { id: 22, name: "J. Bellingham", position: "MID", power: 92, rarity: "Epic", owned: false },
  { id: 23, name: "L. Yamal", position: "FWD", power: 90, rarity: "Epic", owned: false },
  { id: 24, name: "L. Modrić", position: "MID", power: 82, rarity: "Rare", owned: false },
  { id: 25, name: "M. Salah", position: "FWD", power: 88, rarity: "Epic", owned: false },
  { id: 26, name: "H. Kane", position: "FWD", power: 87, rarity: "Epic", owned: false },
  { id: 27, name: "World XI Captain", position: "FWD", power: 100, rarity: "Legendary", owned: false, exclusive: true, priceEUR: 5 },
  { id: 28, name: "Golden Boot Star", position: "MID", power: 100, rarity: "Legendary", owned: false, exclusive: true, priceEUR: 5 },
  { id: 29, name: "Iron Wall Elite", position: "DEF", power: 100, rarity: "Legendary", owned: false, exclusive: true, priceEUR: 5 },
  // Real-world roster expansion
  { id: 30, name: "Alisson Becker", position: "GK", power: 91, rarity: "Legendary", owned: false },
  { id: 31, name: "Thibaut Courtois", position: "GK", power: 90, rarity: "Epic", owned: false },
  { id: 32, name: "Marc-André ter Stegen", position: "GK", power: 88, rarity: "Epic", owned: false },
  { id: 33, name: "Ederson", position: "GK", power: 87, rarity: "Epic", owned: false },
  { id: 34, name: "Jan Oblak", position: "GK", power: 89, rarity: "Epic", owned: false },
  { id: 35, name: "Gianluigi Donnarumma", position: "GK", power: 87, rarity: "Epic", owned: false },
  { id: 36, name: "Emiliano Martínez", position: "GK", power: 86, rarity: "Epic", owned: false },
  { id: 37, name: "Yassine Bounou", position: "GK", power: 82, rarity: "Rare", owned: false },
  { id: 38, name: "Manuel Neuer", position: "GK", power: 85, rarity: "Epic", owned: false },
  { id: 39, name: "Mike Maignan", position: "GK", power: 86, rarity: "Epic", owned: false },
  { id: 40, name: "Virgil van Dijk", position: "DEF", power: 90, rarity: "Legendary", owned: false },
  { id: 41, name: "Rúben Dias", position: "DEF", power: 89, rarity: "Epic", owned: false },
  { id: 42, name: "William Saliba", position: "DEF", power: 86, rarity: "Epic", owned: false },
  { id: 43, name: "Antonio Rüdiger", position: "DEF", power: 87, rarity: "Epic", owned: false },
  { id: 44, name: "Kim Min-jae", position: "DEF", power: 85, rarity: "Epic", owned: false },
  { id: 45, name: "Marquinhos", position: "DEF", power: 86, rarity: "Epic", owned: false },
  { id: 46, name: "Achraf Hakimi", position: "DEF", power: 87, rarity: "Epic", owned: false },
  { id: 47, name: "Trent Alexander-Arnold", position: "DEF", power: 88, rarity: "Epic", owned: false },
  { id: 48, name: "Alphonso Davies", position: "DEF", power: 85, rarity: "Epic", owned: false },
  { id: 49, name: "Theo Hernández", position: "DEF", power: 86, rarity: "Epic", owned: false },
  { id: 50, name: "Josko Gvardiol", position: "DEF", power: 84, rarity: "Rare", owned: false },
  { id: 51, name: "Éder Militão", position: "DEF", power: 85, rarity: "Epic", owned: false },
  { id: 52, name: "David Alaba", position: "DEF", power: 84, rarity: "Rare", owned: false },
  { id: 53, name: "Kyle Walker", position: "DEF", power: 83, rarity: "Rare", owned: false },
  { id: 54, name: "Dani Carvajal", position: "DEF", power: 84, rarity: "Rare", owned: false },
  { id: 55, name: "Jules Koundé", position: "DEF", power: 83, rarity: "Rare", owned: false },
  { id: 56, name: "Sergio Ramos", position: "DEF", power: 85, rarity: "Epic", owned: false },
  { id: 57, name: "Thiago Silva", position: "DEF", power: 83, rarity: "Rare", owned: false },
  { id: 58, name: "Kevin De Bruyne", position: "MID", power: 91, rarity: "Legendary", owned: false },
  { id: 59, name: "Rodri", position: "MID", power: 90, rarity: "Legendary", owned: false },
  { id: 60, name: "Toni Kroos", position: "MID", power: 88, rarity: "Epic", owned: false },
  { id: 61, name: "Casemiro", position: "MID", power: 86, rarity: "Epic", owned: false },
  { id: 62, name: "Frenkie de Jong", position: "MID", power: 87, rarity: "Epic", owned: false },
  { id: 63, name: "Pedri", position: "MID", power: 87, rarity: "Epic", owned: false },
  { id: 64, name: "Gavi", position: "MID", power: 84, rarity: "Rare", owned: false },
  { id: 65, name: "Bruno Fernandes", position: "MID", power: 88, rarity: "Epic", owned: false },
  { id: 66, name: "İlkay Gündoğan", position: "MID", power: 86, rarity: "Epic", owned: false },
  { id: 67, name: "Federico Valverde", position: "MID", power: 87, rarity: "Epic", owned: false },
  { id: 68, name: "Martin Ødegaard", position: "MID", power: 87, rarity: "Epic", owned: false },
  { id: 69, name: "N'Golo Kanté", position: "MID", power: 85, rarity: "Epic", owned: false },
  { id: 70, name: "Declan Rice", position: "MID", power: 85, rarity: "Epic", owned: false },
  { id: 71, name: "Joshua Kimmich", position: "MID", power: 88, rarity: "Epic", owned: false },
  { id: 72, name: "Marco Verratti", position: "MID", power: 84, rarity: "Rare", owned: false },
  { id: 73, name: "Jorginho", position: "MID", power: 82, rarity: "Rare", owned: false },
  { id: 74, name: "Aurélien Tchouaméni", position: "MID", power: 83, rarity: "Rare", owned: false },
  { id: 75, name: "Enzo Fernández", position: "MID", power: 83, rarity: "Rare", owned: false },
  { id: 76, name: "Neymar Jr", position: "FWD", power: 89, rarity: "Epic", owned: false },
  { id: 77, name: "Robert Lewandowski", position: "FWD", power: 91, rarity: "Legendary", owned: false },
  { id: 78, name: "Karim Benzema", position: "FWD", power: 89, rarity: "Epic", owned: false },
  { id: 79, name: "Antoine Griezmann", position: "FWD", power: 88, rarity: "Epic", owned: false },
  { id: 80, name: "Son Heung-min", position: "FWD", power: 88, rarity: "Epic", owned: false },
  { id: 81, name: "Rafael Leão", position: "FWD", power: 86, rarity: "Epic", owned: false },
  { id: 82, name: "Victor Osimhen", position: "FWD", power: 88, rarity: "Epic", owned: false },
  { id: 83, name: "Marcus Rashford", position: "FWD", power: 85, rarity: "Epic", owned: false },
  { id: 84, name: "Phil Foden", position: "FWD", power: 87, rarity: "Epic", owned: false },
  { id: 85, name: "Bukayo Saka", position: "FWD", power: 87, rarity: "Epic", owned: false },
  { id: 86, name: "Ousmane Dembélé", position: "FWD", power: 85, rarity: "Epic", owned: false },
  { id: 87, name: "Federico Chiesa", position: "FWD", power: 83, rarity: "Rare", owned: false },
  { id: 88, name: "Julián Álvarez", position: "FWD", power: 85, rarity: "Epic", owned: false },
  { id: 89, name: "Cole Palmer", position: "FWD", power: 84, rarity: "Rare", owned: false },
  { id: 90, name: "Gabriel Jesus", position: "FWD", power: 83, rarity: "Rare", owned: false },
  { id: 91, name: "Darwin Núñez", position: "FWD", power: 83, rarity: "Rare", owned: false },
  { id: 92, name: "Khvicha Kvaratskhelia", position: "FWD", power: 87, rarity: "Epic", owned: false },
  { id: 93, name: "Jamal Musiala", position: "FWD", power: 87, rarity: "Epic", owned: false },
  { id: 94, name: "Serhou Guirassy", position: "FWD", power: 81, rarity: "Rare", owned: false },
  { id: 95, name: "Alexander Isak", position: "FWD", power: 84, rarity: "Rare", owned: false },
  { id: 96, name: "Dušan Vlahović", position: "FWD", power: 84, rarity: "Rare", owned: false },
  { id: 97, name: "Randal Kolo Muani", position: "FWD", power: 82, rarity: "Rare", owned: false },
  { id: 98, name: "Rodrygo", position: "FWD", power: 85, rarity: "Epic", owned: false },
  { id: 99, name: "Ángel Di María", position: "FWD", power: 83, rarity: "Rare", owned: false },
  { id: 104, name: "Pelé", position: "FWD", power: 100, rarity: "GOAT", owned: false },
  { id: 105, name: "Diego Maradona", position: "MID", power: 100, rarity: "GOAT", owned: false },
  { id: 106, name: "Johan Cruyff", position: "FWD", power: 98, rarity: "GOAT", owned: false },
  { id: 107, name: "Franz Beckenbauer", position: "DEF", power: 97, rarity: "GOAT", owned: false },
  { id: 108, name: "Zinedine Zidane", position: "MID", power: 98, rarity: "GOAT", owned: false },
  { id: 109, name: "Ronaldinho", position: "MID", power: 97, rarity: "GOAT", owned: false },
  { id: 110, name: "Ronaldo Nazário", position: "FWD", power: 98, rarity: "GOAT", owned: false },
  { id: 111, name: "Marta", position: "FWD", power: 97, rarity: "GOAT", owned: false },
  { id: 112, name: "Thierry Henry", position: "FWD", power: 95, rarity: "Icon", owned: false },
  { id: 113, name: "David Beckham", position: "MID", power: 92, rarity: "Icon", owned: false },
  { id: 114, name: "Paolo Maldini", position: "DEF", power: 96, rarity: "Icon", owned: false },
  { id: 115, name: "Xavi Hernández", position: "MID", power: 94, rarity: "Icon", owned: false },
  { id: 116, name: "Andrés Iniesta", position: "MID", power: 95, rarity: "Icon", owned: false },
  { id: 117, name: "Iker Casillas", position: "GK", power: 93, rarity: "Icon", owned: false },
  { id: 118, name: "Gianluigi Buffon", position: "GK", power: 95, rarity: "Icon", owned: false },
  { id: 119, name: "Roberto Carlos", position: "DEF", power: 92, rarity: "Icon", owned: false },
  { id: 120, name: "Cafu", position: "DEF", power: 92, rarity: "Icon", owned: false },
  { id: 121, name: "George Best", position: "FWD", power: 93, rarity: "Icon", owned: false },
  { id: 122, name: "Michel Platini", position: "MID", power: 94, rarity: "Icon", owned: false },
  { id: 123, name: "Marco van Basten", position: "FWD", power: 95, rarity: "Icon", owned: false },
  { id: 124, name: "Alfredo Di Stéfano", position: "FWD", power: 96, rarity: "Icon", owned: false },
  { id: 125, name: "Garrincha", position: "FWD", power: 93, rarity: "Icon", owned: false },
  { id: 126, name: "Eusébio", position: "FWD", power: 94, rarity: "Icon", owned: false },
  { id: 127, name: "Bobby Moore", position: "DEF", power: 91, rarity: "Icon", owned: false },
  { id: 128, name: "Franco Baresi", position: "DEF", power: 93, rarity: "Icon", owned: false },
  { id: 129, name: "Fabio Cannavaro", position: "DEF", power: 92, rarity: "Icon", owned: false },
  { id: 130, name: "Andrea Pirlo", position: "MID", power: 92, rarity: "Icon", owned: false },
  { id: 131, name: "Didier Drogba", position: "FWD", power: 91, rarity: "Icon", owned: false },
  { id: 132, name: "Samuel Eto'o", position: "FWD", power: 92, rarity: "Icon", owned: false },
  { id: 133, name: "Luís Figo", position: "MID", power: 91, rarity: "Icon", owned: false },
  { id: 134, name: "Kaká", position: "MID", power: 92, rarity: "Icon", owned: false },
  { id: 135, name: "Alexia Putellas", position: "MID", power: 94, rarity: "Icon", owned: false },
  { id: 136, name: "Aitana Bonmatí", position: "MID", power: 93, rarity: "Icon", owned: false },
  { id: 137, name: "Steven Gerrard", position: "MID", power: 90, rarity: "Mythic", owned: false },
  { id: 138, name: "Frank Lampard", position: "MID", power: 89, rarity: "Mythic", owned: false },
  { id: 139, name: "Wayne Rooney", position: "FWD", power: 90, rarity: "Mythic", owned: false },
  { id: 140, name: "Ryan Giggs", position: "MID", power: 88, rarity: "Mythic", owned: false },
  { id: 141, name: "Eric Cantona", position: "FWD", power: 89, rarity: "Mythic", owned: false },
  { id: 142, name: "Raúl González", position: "FWD", power: 90, rarity: "Mythic", owned: false },
  { id: 143, name: "Carles Puyol", position: "DEF", power: 88, rarity: "Mythic", owned: false },
  { id: 144, name: "Gerard Piqué", position: "DEF", power: 87, rarity: "Mythic", owned: false },
  { id: 145, name: "Sergio Agüero", position: "FWD", power: 91, rarity: "Mythic", owned: false },
  { id: 146, name: "Radamel Falcao", position: "FWD", power: 87, rarity: "Mythic", owned: false },
  { id: 147, name: "James Rodríguez", position: "MID", power: 87, rarity: "Mythic", owned: false },
  { id: 148, name: "Zico", position: "MID", power: 90, rarity: "Mythic", owned: false },
  { id: 149, name: "Sócrates", position: "MID", power: 88, rarity: "Mythic", owned: false },
  { id: 150, name: "Alex Morgan", position: "FWD", power: 89, rarity: "Mythic", owned: false },
  { id: 151, name: "Sam Kerr", position: "FWD", power: 90, rarity: "Mythic", owned: false },
  { id: 152, name: "Megan Rapinoe", position: "FWD", power: 87, rarity: "Mythic", owned: false },
  { id: 153, name: "Ada Hegerberg", position: "FWD", power: 89, rarity: "Mythic", owned: false },
  { id: 154, name: "Wendie Renard", position: "DEF", power: 88, rarity: "Mythic", owned: false },
  { id: 155, name: "Lucy Bronze", position: "DEF", power: 89, rarity: "Mythic", owned: false },
  { id: 156, name: "Lautaro Martínez", position: "FWD", power: 87, rarity: "Ultra", owned: false },
  { id: 157, name: "Nicolò Barella", position: "MID", power: 86, rarity: "Ultra", owned: false },
  { id: 158, name: "Federico Dimarco", position: "DEF", power: 84, rarity: "Elite", owned: false },
  { id: 159, name: "Christian Pulisic", position: "MID", power: 83, rarity: "Elite", owned: false },
  { id: 160, name: "Paulo Dybala", position: "FWD", power: 85, rarity: "Ultra", owned: false },
  { id: 161, name: "Domenico Berardi", position: "FWD", power: 82, rarity: "Elite", owned: false },
  { id: 162, name: "Sandro Tonali", position: "MID", power: 83, rarity: "Elite", owned: false },
  { id: 163, name: "Davide Frattesi", position: "MID", power: 81, rarity: "Rare", owned: false },
  { id: 164, name: "Warren Zaïre-Emery", position: "MID", power: 80, rarity: "Rare", owned: false },
  { id: 165, name: "Bradley Barcola", position: "FWD", power: 81, rarity: "Rare", owned: false },
  { id: 166, name: "Vitinha", position: "MID", power: 83, rarity: "Elite", owned: false },
  { id: 167, name: "Manuel Ugarte", position: "MID", power: 81, rarity: "Rare", owned: false },
  { id: 168, name: "Gonçalo Ramos", position: "FWD", power: 82, rarity: "Elite", owned: false },
  { id: 169, name: "Florian Wirtz", position: "MID", power: 87, rarity: "Ultra", owned: false },
  { id: 170, name: "Kai Havertz", position: "FWD", power: 85, rarity: "Ultra", owned: false },
  { id: 171, name: "Leroy Sané", position: "FWD", power: 86, rarity: "Ultra", owned: false },
  { id: 172, name: "Serge Gnabry", position: "FWD", power: 84, rarity: "Elite", owned: false },
  { id: 173, name: "Thomas Müller", position: "FWD", power: 85, rarity: "Ultra", owned: false },
  { id: 174, name: "Leon Goretzka", position: "MID", power: 84, rarity: "Elite", owned: false },
  { id: 175, name: "Niclas Füllkrug", position: "FWD", power: 82, rarity: "Elite", owned: false },
  { id: 176, name: "Takefusa Kubo", position: "FWD", power: 82, rarity: "Elite", owned: false },
  { id: 177, name: "Ritsu Doan", position: "FWD", power: 80, rarity: "Rare", owned: false },
  { id: 178, name: "Wataru Endo", position: "MID", power: 79, rarity: "Rare", owned: false },
  { id: 179, name: "Hwang Hee-chan", position: "FWD", power: 81, rarity: "Rare", owned: false },
  { id: 180, name: "Jonathan David", position: "FWD", power: 83, rarity: "Elite", owned: false },
  { id: 181, name: "Cyle Larin", position: "FWD", power: 76, rarity: "Rare", owned: false },
  { id: 182, name: "Weston McKennie", position: "MID", power: 80, rarity: "Rare", owned: false },
  { id: 183, name: "Folarin Balogun", position: "FWD", power: 79, rarity: "Rare", owned: false },
  { id: 184, name: "Sadio Mané", position: "FWD", power: 87, rarity: "Ultra", owned: false },
  { id: 185, name: "Hakim Ziyech", position: "MID", power: 82, rarity: "Elite", owned: false },
  { id: 186, name: "Youssef En-Nesyri", position: "FWD", power: 81, rarity: "Rare", owned: false },
  { id: 187, name: "Sofyan Amrabat", position: "MID", power: 80, rarity: "Rare", owned: false },
  { id: 188, name: "Thomas Partey", position: "MID", power: 83, rarity: "Elite", owned: false },
  { id: 189, name: "André Onana", position: "GK", power: 84, rarity: "Elite", owned: false },
  { id: 190, name: "Édouard Mendy", position: "GK", power: 83, rarity: "Elite", owned: false },
  { id: 191, name: "Nico Williams", position: "FWD", power: 84, rarity: "Elite", owned: false },
  { id: 192, name: "Iñaki Williams", position: "FWD", power: 82, rarity: "Elite", owned: false },
  { id: 193, name: "Mikel Oyarzabal", position: "FWD", power: 83, rarity: "Elite", owned: false },
  { id: 194, name: "Álvaro Morata", position: "FWD", power: 82, rarity: "Elite", owned: false },
  { id: 195, name: "Marco Asensio", position: "FWD", power: 81, rarity: "Rare", owned: false },
  { id: 196, name: "Dani Olmo", position: "MID", power: 84, rarity: "Elite", owned: false },
  { id: 197, name: "Raphinha", position: "FWD", power: 85, rarity: "Ultra", owned: false },
  { id: 198, name: "Ronald Araújo", position: "DEF", power: 85, rarity: "Ultra", owned: false },
  { id: 199, name: "Alejandro Balde", position: "DEF", power: 81, rarity: "Rare", owned: false },
  { id: 200, name: "Cody Gakpo", position: "FWD", power: 83, rarity: "Elite", owned: false },
  { id: 201, name: "Xavi Simons", position: "MID", power: 82, rarity: "Elite", owned: false },
  { id: 202, name: "Memphis Depay", position: "FWD", power: 84, rarity: "Elite", owned: false },
  { id: 203, name: "Matthijs de Ligt", position: "DEF", power: 83, rarity: "Elite", owned: false },
  { id: 204, name: "Denzel Dumfries", position: "DEF", power: 81, rarity: "Rare", owned: false },
];

const AVATARS = ["⚽", "🦁", "🐺", "🦅", "🔥", "⭐", "🐯", "🦈", "🐉", "👑", "💎", "🚀", "🛡️", "⚡", "🌟", "🏆", "🥷", "🤖"];
const TEAM_COLORS = [
  { id: "green", hex: "#52D68A" }, { id: "cyan", hex: "#4CC9F0" }, { id: "pink", hex: "#FF6FB5" },
  { id: "purple", hex: "#B784F0" }, { id: "gold", hex: "#FFC94A" }, { id: "red", hex: "#FF6B6B" },
];
const WIN_GEMS = 20, LOSS_GEMS = 5, DRAW_GEMS = 10, STARTING_GEMS = 60;
// Odds tuned so a "good" pull (Elite tier or above) is genuinely rare on the
// base pack -- about 1 in 20 opens (5%), matching "1000 packs opened, only
// ~50 good ones" -- then scales up through the tiers from there.
const PACKS = [
  { id: "bronze", name: "Bronze Pack", cost: 20, icon: "📦", blurb: "Great value — mostly Common & Uncommon (~5% chance of Elite+)", weights: { Common: 48, Uncommon: 30, Rare: 13, Epic: 4, Elite: 3.5, Ultra: 1, Legendary: 0.4, Mythic: 0.08, Icon: 0.018, GOAT: 0.002 }, grad: ["#B87333", "#8C5A2B"], glow: "#D08A4F" },
  { id: "silver", name: "Silver Pack", cost: 45, icon: "🎁", blurb: "Balanced odds across all rarities (~10% chance of Elite+)", weights: { Common: 30, Uncommon: 25, Rare: 20, Epic: 15, Elite: 6, Ultra: 2.5, Legendary: 1.2, Mythic: 0.25, Icon: 0.045, GOAT: 0.005 }, grad: ["#C7D3E0", "#7C8DA6"], glow: "#C0C0C0" },
  { id: "gold", name: "Gold Pack", cost: 90, icon: "💰", blurb: "Boosted Elite & Legendary+ odds (~25% chance of Elite+)", weights: { Common: 10, Uncommon: 15, Rare: 25, Epic: 25, Elite: 15, Ultra: 7, Legendary: 2.5, Mythic: 0.4, Icon: 0.09, GOAT: 0.01 }, grad: ["#FFC94A", "#FF9F4A"], glow: "#FFC94A" },
  { id: "legendary", name: "Legendary Pack", cost: 180, icon: "👑", blurb: "Guaranteed Elite tier or better!", weights: { Elite: 45, Ultra: 30, Legendary: 18, Mythic: 5, Icon: 1.8, GOAT: 0.2 }, grad: ["#B784F0", "#FF6FB5"], glow: "#B784F0" },
];
function pickWeighted(lockedPool, weights) {
  const buckets = RARITY_ORDER.map((r) => ({ r, pool: lockedPool.filter((p) => p.rarity === r), w: weights[r] || 0 })).filter((b) => b.pool.length > 0 && b.w > 0);
  if (!buckets.length) {
    const fallback = lockedPool;
    return fallback.length ? fallback[Math.floor(Math.random() * fallback.length)] : null;
  }
  const totalW = buckets.reduce((s, b) => s + b.w, 0);
  let roll = Math.random() * totalW;
  for (const b of buckets) { if (roll < b.w) return b.pool[Math.floor(Math.random() * b.pool.length)]; roll -= b.w; }
  return buckets[buckets.length - 1].pool[Math.floor(Math.random() * buckets[buckets.length - 1].pool.length)];
}

const FORMATIONS = {
  balanced: { name: "Balanced (1-2-4-2)", counts: { GK: 1, DEF: 2, MID: 4, FWD: 2 } },
  defensive: { name: "Defensive (1-3-3-2)", counts: { GK: 1, DEF: 3, MID: 3, FWD: 2 } },
  attacking: { name: "Attacking (1-2-3-3)", counts: { GK: 1, DEF: 2, MID: 3, FWD: 3 } },
};
const MY_Y = { GK: 90, DEF: 71, MID: 51, FWD: 30 };
const OPP_Y = { GK: 10, DEF: 29, MID: 47, FWD: 68 };
const ROW_XS = { 1: [50], 2: [28, 72], 3: [18, 50, 82], 4: [12, 37, 63, 88] };
function buildSlots(formationKey, side) {
  const counts = FORMATIONS[formationKey].counts;
  const yMap = side === "my" ? MY_Y : OPP_Y;
  const slots = [];
  ["GK", "DEF", "MID", "FWD"].forEach((pos) => {
    const n = counts[pos];
    const xs = ROW_XS[n] || [50];
    xs.forEach((x, i) => slots.push({ id: pos + (n > 1 ? i + 1 : ""), position: pos, label: pos, x, y: yMap[pos] }));
  });
  return slots;
}
function zoneOf(id) { return id.replace(/\d+$/, ""); }
function computeZone(zoneKey, myLU, oppLU) {
  const myTotal = Object.entries(myLU).reduce((sum, [id, p]) => sum + (zoneOf(id) === zoneKey && p ? p.power : 0), 0);
  const oppTotal = Object.entries(oppLU).reduce((sum, [id, p]) => sum + (zoneOf(id) === zoneKey && p ? p.power : 0), 0);
  const result = myTotal > oppTotal ? "win" : myTotal < oppTotal ? "lose" : "tie";
  return { myTotal, oppTotal, result };
}
const ZONES = [{ key: "GK", label: "Goalkeeper" }, { key: "DEF", label: "Defense" }, { key: "MID", label: "Midfield" }, { key: "FWD", label: "Attack" }];
const HALF_DURATION = 15000;
const SEASON_CLUBS = ["Ironclad FC", "Blaze United", "Falcon Rovers", "Crimson Athletic", "Storm City", "Aurora Sporting"];

// ---- Async "Challenge a Friend" codes: encode/decode a completed lineup so a
// friend can paste it into their own app and battle it, with no server involved.
const RARITY_CODE = { Common: "C", Uncommon: "U", Rare: "R", Epic: "E", Elite: "X", Ultra: "T", Legendary: "L", Mythic: "M", Icon: "I", GOAT: "G" };
const RARITY_FROM_CODE = { C: "Common", U: "Uncommon", R: "Rare", E: "Epic", X: "Elite", T: "Ultra", L: "Legendary", M: "Mythic", I: "Icon", G: "GOAT" };
function b64encode(str) { return btoa(unescape(encodeURIComponent(str))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); }
function b64decode(str) { const pad = str.length % 4 === 0 ? "" : "=".repeat(4 - (str.length % 4)); const b64 = str.replace(/-/g, "+").replace(/_/g, "/") + pad; return decodeURIComponent(escape(atob(b64))); }
function encodeChallenge(formationKey, lineup, profile) {
  const pl = Object.values(lineup).filter(Boolean).map((p) => [p.name, p.position, p.power, RARITY_CODE[p.rarity] || "C"]);
  const payload = { v: 1, f: formationKey, tn: profile.teamName || "My Team", pn: profile.name || "Player", av: profile.avatar, cl: profile.color, pl };
  return "LXI1-" + b64encode(JSON.stringify(payload));
}
function decodeChallenge(code) {
  try {
    const raw = String(code).trim().replace(/^LXI1-/, "");
    const payload = JSON.parse(b64decode(raw));
    if (!payload || payload.v !== 1 || !Array.isArray(payload.pl) || !payload.pl.length || !FORMATIONS[payload.f]) return null;
    return payload;
  } catch (e) { return null; }
}

const WIN_LINES = ["Absolute masterclass. 🏆", "They never stood a chance.", "That's a statement win.", "Trophy cabinet's getting crowded.", "Textbook. Pure textbook."];
const LOSS_LINES = ["Rough one. Shake it off.", "They caught a break. Run it back.", "Not your day — next one is.", "Tough draw. Regroup and go again.", "So close. Adjust your tactics and retry."];
const DRAW_LINES = ["Honours even. Sharp margins next time.", "Dead heat — adjust and go again.", "A fair result out there.", "Neither side could find a way through.", "Stalemate. Strike first next time."];

const RANKS = [
  { name: "Bronze", min: 0, icon: "🥉", color: "#CD7F32" },
  { name: "Silver", min: 5, icon: "🥈", color: "#C0C0C0" },
  { name: "Gold", min: 15, icon: "🥇", color: "#FFD700" },
  { name: "Diamond", min: 30, icon: "💎", color: "#4CC9F0" },
  { name: "Legend", min: 50, icon: "👑", color: "#FFC94A" },
];
function rankForWins(wins) { let r = RANKS[0]; for (const t of RANKS) if (wins >= t.min) r = t; return r; }

const ACHIEVEMENTS = [
  { id: "first_win", label: "First Win", emoji: "🥇", check: (s) => s.wins >= 1 },
  { id: "hat_trick", label: "3 Win Streak", emoji: "🔥", check: (s) => s.bestStreak >= 3 },
  { id: "unstoppable", label: "5 Win Streak", emoji: "⚡", check: (s) => s.bestStreak >= 5 },
  { id: "century", label: "10 Wins", emoji: "💯", check: (s) => s.wins >= 10 },
  { id: "collector", label: "10 Cards Owned", emoji: "🗂️", check: (s, p) => p.filter((x) => x.owned).length >= 10 },
  { id: "legend_owner", label: "Own a Legendary", emoji: "🌟", check: (s, p) => p.some((x) => x.owned && isTopTier(x.rarity)) },
  { id: "high_roller", label: "Own an Exclusive", emoji: "💎", check: (s, p) => p.some((x) => x.owned && x.exclusive) },
  { id: "full_squad", label: "Full Collection", emoji: "🏆", check: (s, p) => p.filter((x) => !x.exclusive).every((x) => x.owned) },
  { id: "gold_rank", label: "Reach Gold Rank", emoji: "🥇", check: (s) => ["Gold", "Diamond", "Legend"].includes(rankForWins(s.wins).name) },
  { id: "season_champ", label: "Finish a Season", emoji: "📅", check: (s, p, e) => e && e.season && e.season.number >= 2 },
];

const OBJECTIVES = [
  { id: "obj_win3", label: "Win 3 Matches", desc: "Win 3 matches this season", reward: 25, target: 3, progress: (s, p, season) => season.wins },
  { id: "obj_collect10", label: "Collect 10 Cards", desc: "Own 10 different players", reward: 20, target: 10, progress: (s, p) => p.filter((x) => x.owned).length },
  { id: "obj_epic", label: "Pull a Big One", desc: "Own an Epic-tier card or better", reward: 30, target: 1, progress: (s, p) => (p.some((x) => x.owned && isHighTier(x.rarity)) ? 1 : 0) },
  { id: "obj_streak3", label: "Win Streak", desc: "Reach a 3-match win streak", reward: 35, target: 3, progress: (s) => s.bestStreak },
];
const DAILY_REWARDS = [10, 15, 20, 25, 35, 45, 60];

let started = false;
async function ensureAudio() { if (!started) { await Tone.start(); started = true; } }
function playWhistle() { const s = new Tone.NoiseSynth({ noise: { type: "white" }, envelope: { attack: 0.001, decay: 0.15, sustain: 0 } }).toDestination(); s.volume.value = -14; s.triggerAttackRelease("16n"); }
function playKick() { const s = new Tone.MembraneSynth().toDestination(); s.volume.value = -8; s.triggerAttackRelease("C2", "8n"); }
function playWin() { const s = new Tone.PolySynth(Tone.Synth).toDestination(); s.volume.value = -10; const n = Tone.now(); s.triggerAttackRelease("C5", "8n", n); s.triggerAttackRelease("E5", "8n", n + 0.12); s.triggerAttackRelease("G5", "8n", n + 0.24); s.triggerAttackRelease("C6", "4n", n + 0.36); }
function playLose() { const s = new Tone.Synth({ oscillator: { type: "sawtooth" } }).toDestination(); s.volume.value = -14; const n = Tone.now(); s.triggerAttackRelease("A3", "8n", n); s.triggerAttackRelease("G3", "8n", n + 0.18); s.triggerAttackRelease("F3", "4n", n + 0.36); }
function playTap() { const s = new Tone.Synth().toDestination(); s.volume.value = -20; s.triggerAttackRelease("C6", "32n"); }
function playChime() { const s = new Tone.PolySynth(Tone.Synth).toDestination(); s.volume.value = -12; const n = Tone.now(); s.triggerAttackRelease("E5", "16n", n); s.triggerAttackRelease("G5", "16n", n + 0.08); }
function playSparkle() { const s = new Tone.PolySynth(Tone.Synth).toDestination(); s.volume.value = -8; const n = Tone.now(); ["C5", "E5", "G5", "C6", "E6"].forEach((note, i) => s.triggerAttackRelease(note, "16n", n + i * 0.07)); }
function playZoneWin() { const s = new Tone.Synth().toDestination(); s.volume.value = -14; s.triggerAttackRelease("A5", "16n"); }
function playZoneLose() { const s = new Tone.Synth().toDestination(); s.volume.value = -14; s.triggerAttackRelease("D4", "16n"); }
function playWhoosh() { const s = new Tone.NoiseSynth({ noise: { type: "pink" }, envelope: { attack: 0.05, decay: 0.4, sustain: 0 } }).toDestination(); s.volume.value = -18; s.triggerAttackRelease("4n"); }
function playFanfare() { const s = new Tone.PolySynth(Tone.Synth).toDestination(); s.volume.value = -8; const n = Tone.now(); [["C5","E5","G5"], ["D5","F5","A5"], ["E5","G5","C6"]].forEach((chord, i) => chord.forEach((note) => s.triggerAttackRelease(note, "8n", n + i * 0.18))); }
function playImpact() { const s = new Tone.MembraneSynth({ pitchDecay: 0.05, octaves: 5 }).toDestination(); s.volume.value = -4; s.triggerAttackRelease("C1", "4n"); }

const EMOJI_BURST = ["⚽", "🎉", "⭐", "✨", "🔥"];

function Confetti() {
  const pieces = useRef(Array.from({ length: 40 }, (_, i) => ({ id: i, left: Math.random() * 100, delay: Math.random() * 0.4, duration: 1.6 + Math.random() * 1, emoji: EMOJI_BURST[i % EMOJI_BURST.length], size: 14 + Math.random() * 10, rotate: Math.random() * 360 }))).current;
  return (<div style={{ position: "fixed", inset: 0, pointerEvents: "none", overflow: "hidden", zIndex: 50 }}>{pieces.map((p) => (<div key={p.id} style={{ position: "absolute", left: `${p.left}%`, top: "-20px", fontSize: p.size, animation: `confettiFall ${p.duration}s ease-in ${p.delay}s forwards`, transform: `rotate(${p.rotate}deg)` }}>{p.emoji}</div>))}</div>);
}
function PackBurst({ rarityColor, big }) {
  const count = big ? 24 : 14;
  const particles = useRef(Array.from({ length: count }, (_, i) => { const angle = (i / count) * 2 * Math.PI + Math.random() * 0.3; const dist = 90 + Math.random() * (big ? 110 : 60); return { id: i, dx: Math.cos(angle) * dist, dy: Math.sin(angle) * dist, delay: Math.random() * 0.1, isEmoji: Math.random() > 0.5, emoji: EMOJI_BURST[i % EMOJI_BURST.length] }; })).current;
  return (<div style={{ position: "absolute", left: "50%", top: "50%", width: 0, height: 0, zIndex: 5 }}>{particles.map((p) => (<div key={p.id} style={{ position: "absolute", left: 0, top: 0, "--dx": `${p.dx}px`, "--dy": `${p.dy}px`, animation: `burstOut 0.8s cubic-bezier(0.2,0.8,0.3,1) ${p.delay}s forwards`, fontSize: p.isEmoji ? 16 : 0, width: p.isEmoji ? "auto" : 7, height: p.isEmoji ? "auto" : 7, borderRadius: "50%", backgroundColor: p.isEmoji ? "transparent" : rarityColor }}>{p.isEmoji ? p.emoji : null}</div>))}</div>);
}

function PackRevealOverlay({ card, pack, onContinue }) {
  const rarityColor = card ? RARITY[card.rarity].color : COLORS.gold;
  const isLegendary = card ? isTopTier(card.rarity) : false;
  const isEpic = card ? (isHighTier(card.rarity) && !isTopTier(card.rarity)) : false;
  const big = isLegendary || isEpic;
  const [flash, setFlash] = useState(isLegendary);
  useEffect(() => { if (isLegendary) { const t = setTimeout(() => setFlash(false), 350); return () => clearTimeout(t); } }, [isLegendary]);

  return (
    <div className="fixed inset-0 z-50 flex flex-col items-center justify-center px-6" style={{ background: `radial-gradient(circle at 50% 38%, ${rarityColor}22, transparent 65%), rgba(3,7,14,0.97)` }}>
      {flash && <div className="fixed inset-0" style={{ backgroundColor: "#fff", animation: "flashOut 0.35s ease forwards", zIndex: 2 }} />}
      <div className="absolute pointer-events-none" style={{ width: 460, height: 460, borderRadius: "50%", background: `conic-gradient(from 0deg, ${rarityColor}, ${pack?.grad?.[1] || COLORS.gold}, ${COLORS.cyan}, ${rarityColor})`, animation: "spinRays 6s linear infinite", opacity: 0.22, filter: "blur(10px)" }} />
      {card ? (
        <>
          {isLegendary && (<div className="display mb-3 text-center" style={{ fontSize: 26, color: rarityColor, animation: "popIn 0.5s ease", letterSpacing: "0.05em" }}>⚡ {RARITY[card.rarity].label} PULL ⚡</div>)}
          <div className="relative flex flex-col items-center" style={{ zIndex: 3 }}>
            <PackBurst rarityColor={rarityColor} big={big} />
            <div className="rounded-3xl flex flex-col items-center justify-center relative" style={{ width: 210, padding: "28px 20px", background: `linear-gradient(165deg, ${COLORS.panelLight}, ${COLORS.panel})`, border: `4px solid ${rarityColor}`, boxShadow: `0 0 ${isLegendary ? 70 : isEpic ? 42 : 24}px ${rarityColor}aa`, animation: "riseIn 0.7s cubic-bezier(0.2,0.9,0.25,1.1) both" }}>
              {big && <Sparkles size={22} color={rarityColor} className="mb-2" />}
              <div className="flex items-center justify-center rounded-full font-black" style={{ width: 88, height: 88, fontSize: 30, backgroundColor: rarityColor, color: COLORS.bg, marginBottom: 12 }}>{card.power}</div>
              <div className="display text-center leading-tight" style={{ fontSize: 22, color: COLORS.cream }}>{card.name}</div>
              <div className="text-xs font-bold mt-1" style={{ color: COLORS.muted }}>{card.position}</div>
              <div className="font-black mt-2" style={{ fontSize: 11, letterSpacing: "0.15em", color: rarityColor }}>{RARITY[card.rarity].label}</div>
            </div>
          </div>
        </>
      ) : (
        <div className="text-center relative" style={{ zIndex: 3 }}>
          <div className="display mb-2" style={{ fontSize: 24, color: COLORS.gold }}>Collection complete!</div>
          <div className="text-sm" style={{ color: COLORS.muted }}>Here's a partial refund instead.</div>
        </div>
      )}
      <button onClick={onContinue} className="display mt-8 px-8 py-3 rounded-xl active:translate-y-0.5 active:shadow-none transition-all" style={{ fontSize: 18, backgroundColor: rarityColor, color: COLORS.bg, boxShadow: "0 4px 0 rgba(0,0,0,0.35)", zIndex: 3 }}>CONTINUE</button>
    </div>
  );
}

function Card({ player, mode, selected, onToggle, style, flipIndex }) {
  const rarity = RARITY[player.rarity];
  const locked = mode === "index" && !player.owned;
  return (
    <button onClick={onToggle} disabled={mode !== "select" || !player.owned} className="relative rounded-xl pl-4 pr-3 py-3 text-left w-full transition-transform active:scale-95 overflow-hidden" style={{ backgroundColor: COLORS.panel, borderTop: `1px solid ${COLORS.panelLight}`, borderRight: `1px solid ${COLORS.panelLight}`, borderBottom: `1px solid ${COLORS.panelLight}`, borderLeft: `4px solid ${selected ? COLORS.turf : rarity.color}`, opacity: locked ? 0.45 : 1, animation: flipIndex !== undefined ? `flipIn 0.5s ease ${flipIndex * 0.15}s both` : undefined, ...style }}>
      {!locked && isTopTier(player.rarity) && (<div className="absolute inset-0 pointer-events-none" style={{ background: "linear-gradient(120deg, transparent 40%, rgba(255,255,255,0.35) 50%, transparent 60%)", animation: "shineSweep 3s ease-in-out infinite" }} />)}
      <div className="flex justify-between items-start mb-2">
        <span className="text-[10px] font-bold tracking-widest px-2 py-0.5 rounded-full" style={{ backgroundColor: rarity.color + "33", color: rarity.color }}>{rarity.label}</span>
        {locked && <Lock size={14} color={COLORS.muted} />}
        {selected && (<span className="rounded-full p-0.5" style={{ backgroundColor: COLORS.turf }}><Check size={12} color={COLORS.bg} /></span>)}
      </div>
      <div className="flex items-center gap-3">
        <div className="flex items-center justify-center rounded-full font-black text-lg shrink-0" style={{ width: 44, height: 44, backgroundColor: locked ? COLORS.panelLight : rarity.color, color: locked ? COLORS.muted : COLORS.bg }}>{locked ? "?" : player.power}</div>
        <div><div className="font-bold text-sm" style={{ color: COLORS.cream }}>{locked ? "Locked" : player.name}</div><div className="text-xs" style={{ color: COLORS.muted }}>{locked ? "Coming soon" : player.position}</div></div>
      </div>
    </button>
  );
}

const NEWS_ITEMS = [
  { v: "v7", text: "New Home hub — daily rewards, live objectives, and featured packs. Plus 70 real-world footballers added to the pool!" },
  { v: "v6", text: "Packs now come in 4 tiers — Bronze, Silver, Gold, and Legendary — each with different odds." },
  { v: "v5", text: "Real formations, half-time substitutions, and a 6-matchday Season with ranks are live." },
  { v: "v4", text: "Matches now play out with animated passing and a running 90' match clock." },
  { v: "v3", text: "Your progress now saves automatically between visits." },
];

function RailButton({ icon: Icon, label, onClick, badge, accent, disabled }) {
  return (
    <button onClick={onClick} disabled={disabled} className="relative flex flex-col items-center justify-center gap-1 rounded-xl active:scale-95 transition-transform disabled:opacity-50 disabled:pointer-events-none" style={{ width: 56, height: 56, backgroundColor: COLORS.panel, border: `1px solid ${COLORS.panelLight}` }}>
      {badge && (<span className="absolute -top-1 -right-1 rounded-full flex items-center justify-center font-black" style={{ width: 16, height: 16, fontSize: 9, backgroundColor: COLORS.gold, color: COLORS.bg }}>{badge}</span>)}
      <Icon size={18} color={accent || COLORS.muted} />
      <span className="font-bold" style={{ fontSize: 8, color: COLORS.muted, letterSpacing: "0.03em" }}>{label}</span>
    </button>
  );
}

function HomeView({ profile, stats, season, gems, players, home, dailyClaimed, onClaimDaily, onClaimObjective, onNavigate }) {
  const [newsOpen, setNewsOpen] = useState(false);
  const rank = rankForWins(stats.wins);
  const owned = players.filter((p) => p.owned);
  const xp = stats.wins * 15 + stats.losses * 3 + owned.length * 8 + stats.bestStreak * 10;
  const level = Math.floor(xp / 150) + 1, xpPct = Math.round(((xp % 150) / 150) * 100);
  const bestFive = [...owned].sort((a, b) => b.power - a.power).slice(0, 5);
  const teamRating = bestFive.length ? Math.round(bestFive.reduce((s, p) => s + p.power, 0) / bestFive.length) : 0;
  const currentClub = SEASON_CLUBS[(season.matchday - 1) % SEASON_CLUBS.length];
  const currentDay = (home.dailyStreak % 7) + 1;

  return (
    <div className="px-4 pb-24">
      {/* Live event banner */}
      <div className="rounded-xl px-3 py-2 mb-3 flex items-center gap-2" style={{ background: `linear-gradient(90deg, ${COLORS.purple}33, ${COLORS.pink}33)`, border: `1px solid ${COLORS.pink}55` }}>
        <span style={{ fontSize: 16 }}>🔥</span>
        <div>
          <div className="text-[10px] font-black" style={{ color: COLORS.pink }}>WEEKEND LEAGUE LIVE</div>
          <div className="text-[9px]" style={{ color: COLORS.muted }}>Win streaks earn bonus gems all week</div>
        </div>
      </div>

      {/* Level / XP row */}
      <div className="flex items-center gap-3 mb-4">
        <div className="flex items-center justify-center rounded-full text-2xl relative shrink-0" style={{ width: 52, height: 52, background: `linear-gradient(135deg, ${profile.color}, ${COLORS.purple})` }}>
          {profile.avatar}
          <div className="absolute -bottom-1 -right-1 rounded-full font-black flex items-center justify-center" style={{ width: 18, height: 18, fontSize: 9, backgroundColor: COLORS.bg, border: `2px solid ${profile.color}`, color: profile.color }}>{level}</div>
        </div>
        <div className="flex-1">
          <div className="flex items-center justify-between mb-1">
            <span className="display" style={{ fontSize: 17, color: COLORS.cream }}>{profile.name || "Player"}</span>
            <span className="text-[10px] font-black" style={{ color: rank.color }}>{rank.icon} {rank.name.toUpperCase()}</span>
          </div>
          <div className="h-2 rounded-full overflow-hidden" style={{ backgroundColor: COLORS.panelLight }}><div className="h-full rounded-full" style={{ width: `${xpPct}%`, background: `linear-gradient(90deg, ${profile.color}, ${COLORS.gold})` }} /></div>
        </div>
      </div>

      <div className="flex gap-3">
        {/* Left icon rail */}
        <div className="flex flex-col gap-2">
          <RailButton icon={Gift} label="DAILY" accent={dailyClaimed ? COLORS.muted : COLORS.gold} badge={!dailyClaimed ? "!" : null} onClick={onClaimDaily} disabled={dailyClaimed} />
          <RailButton icon={Trophy} label="SEASON" accent={COLORS.cyan} onClick={() => onNavigate("profile")} />
          <RailButton icon={Award} label="AWARDS" accent={COLORS.pink} onClick={() => onNavigate("profile")} />
          <RailButton icon={Newspaper} label="NEWS" accent={COLORS.turf} onClick={() => setNewsOpen(true)} />
        </div>

        <div className="flex-1 flex flex-col gap-3">
          {/* Hero rank card */}
          <div className="relative rounded-2xl flex flex-col items-center justify-center py-6 overflow-hidden" style={{ background: `radial-gradient(circle at 50% 20%, ${rank.color}22, ${COLORS.panel})`, border: `1px solid ${COLORS.panelLight}` }}>
            <div style={{ fontSize: 46, animation: "floatBounce 3s ease-in-out infinite" }}>{rank.icon}</div>
            <div className="display" style={{ fontSize: 20, color: rank.color, letterSpacing: "0.03em" }}>{rank.name.toUpperCase()}</div>
            <div className="text-[10px] font-bold" style={{ color: COLORS.muted }}>Season {season.number} · Matchday {season.matchday}/6</div>
          </div>

          {/* My team card */}
          <div className="rounded-2xl p-3" style={{ backgroundColor: COLORS.panel, border: `1px solid ${COLORS.panelLight}` }}>
            <div className="text-[10px] font-black tracking-widest mb-2" style={{ color: COLORS.muted }}>MY TEAM</div>
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <div className="flex items-center justify-center rounded-full text-lg" style={{ width: 36, height: 36, background: `linear-gradient(135deg, ${profile.color}, ${COLORS.purple})` }}>{profile.avatar}</div>
                <div><div className="text-xs font-bold" style={{ color: COLORS.cream }}>{profile.teamName || "My Team"}</div><div className="text-[9px]" style={{ color: COLORS.muted }}>{owned.length} players owned</div></div>
              </div>
              <div className="rounded-lg px-2 py-1 text-center" style={{ backgroundColor: COLORS.panelLight }}><div className="display" style={{ fontSize: 18, color: COLORS.gold, lineHeight: 1 }}>{teamRating}</div><div className="text-[7px] font-bold" style={{ color: COLORS.muted }}>RATING</div></div>
            </div>
          </div>
        </div>
      </div>

      {/* Action cards */}
      <div className="grid grid-cols-2 gap-3 mt-3">
        <button onClick={() => onNavigate("play")} className="rounded-2xl p-3 text-left active:scale-95 transition-transform" style={{ backgroundColor: COLORS.panel, border: `1px solid ${COLORS.panelLight}` }}>
          <PlayCircle size={18} color={COLORS.turf} className="mb-2" />
          <div className="text-xs font-black" style={{ color: COLORS.cream }}>NEXT MATCH</div>
          <div className="text-[10px]" style={{ color: COLORS.muted }}>vs {currentClub}</div>
        </button>
        <button onClick={() => onNavigate("profile")} className="rounded-2xl p-3 text-left active:scale-95 transition-transform" style={{ backgroundColor: COLORS.panel, border: `1px solid ${COLORS.panelLight}` }}>
          <Trophy size={18} color={COLORS.gold} className="mb-2" />
          <div className="text-xs font-black" style={{ color: COLORS.cream }}>SEASON</div>
          <div className="text-[10px]" style={{ color: COLORS.muted }}>{season.points} pts so far</div>
        </button>
      </div>

      {/* Daily reward strip */}
      <div className="rounded-2xl p-3 mt-3" style={{ backgroundColor: COLORS.panel, border: `1px solid ${COLORS.panelLight}` }}>
        <div className="flex items-center justify-between mb-2">
          <div className="text-[10px] font-black tracking-widest" style={{ color: COLORS.muted }}>DAILY REWARD</div>
          {dailyClaimed && <span className="text-[9px] font-bold" style={{ color: COLORS.turf }}>✅ Claimed today</span>}
        </div>
        <div className="flex gap-1.5 mb-2">
          {DAILY_REWARDS.map((amt, i) => {
            const dayNum = i + 1;
            const isPast = dayNum < currentDay || (dayNum === currentDay && dailyClaimed);
            const isToday = dayNum === currentDay && !dailyClaimed;
            return (
              <div key={i} className="flex-1 rounded-lg py-2 flex flex-col items-center" style={{ backgroundColor: isToday ? COLORS.gold + "22" : COLORS.panelLight, border: isToday ? `1px solid ${COLORS.gold}` : "1px solid transparent", opacity: isPast ? 0.4 : 1 }}>
                <Coins size={11} color={isPast ? COLORS.muted : COLORS.gold} />
                <span className="text-[9px] font-black mt-0.5" style={{ color: isPast ? COLORS.muted : COLORS.cream }}>{amt}</span>
              </div>
            );
          })}
        </div>
        <button onClick={onClaimDaily} disabled={dailyClaimed} className="w-full py-2 rounded-xl text-xs font-black disabled:opacity-40" style={{ backgroundColor: COLORS.gold, color: COLORS.bg }}>
          {dailyClaimed ? "COME BACK TOMORROW" : `CLAIM +${DAILY_REWARDS[currentDay - 1]} GEMS`}
        </button>
      </div>

      {/* Objectives */}
      <div className="rounded-2xl p-3 mt-3" style={{ backgroundColor: COLORS.panel, border: `1px solid ${COLORS.panelLight}` }}>
        <div className="text-[10px] font-black tracking-widest mb-2" style={{ color: COLORS.muted }}>OBJECTIVES</div>
        <div className="flex flex-col gap-2">
          {OBJECTIVES.map((o) => {
            const claimed = (home.objectivesClaimed || []).includes(o.id);
            const val = Math.min(o.target, o.progress(stats, players, season));
            const done = val >= o.target;
            const pct = Math.round((val / o.target) * 100);
            return (
              <div key={o.id} className="rounded-xl p-2" style={{ backgroundColor: COLORS.panelLight }}>
                <div className="flex items-center justify-between mb-1">
                  <span className="text-[11px] font-bold" style={{ color: COLORS.cream }}>{o.label}</span>
                  <span className="text-[9px] font-bold" style={{ color: COLORS.gold }}>+{o.reward} 🪙</span>
                </div>
                <div className="h-1.5 rounded-full overflow-hidden mb-1" style={{ backgroundColor: COLORS.bg }}><div className="h-full rounded-full" style={{ width: `${pct}%`, backgroundColor: done ? COLORS.turf : COLORS.cyan }} /></div>
                <div className="flex items-center justify-between">
                  <span className="text-[9px]" style={{ color: COLORS.muted }}>{o.desc} ({val}/{o.target})</span>
                  {claimed ? (
                    <span className="text-[9px] font-black" style={{ color: COLORS.turf }}>CLAIMED</span>
                  ) : (
                    <button onClick={() => done && onClaimObjective(o.id, o.reward)} disabled={!done} className="text-[9px] font-black px-2 py-0.5 rounded-full disabled:opacity-30" style={{ backgroundColor: done ? COLORS.turf : COLORS.panel, color: done ? COLORS.bg : COLORS.muted }}>CLAIM</button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Featured packs */}
      <div className="mt-3">
        <div className="text-[10px] font-black tracking-widest mb-2" style={{ color: COLORS.muted }}>FEATURED PACKS</div>
        <div className="flex gap-3 overflow-x-auto pb-1">
          {[PACKS[2], PACKS[3]].map((pack) => (
            <button key={pack.id} onClick={() => onNavigate("shop")} className="rounded-2xl p-3 text-center shrink-0 active:scale-95 transition-transform" style={{ width: 132, background: `linear-gradient(160deg, ${pack.grad[0]}, ${pack.grad[1]})`, boxShadow: `0 4px 14px ${pack.glow}44` }}>
              <div className="text-2xl mb-1">{pack.icon}</div>
              <div className="text-[10px] font-black" style={{ color: "#fff" }}>{pack.name}</div>
              <div className="text-[9px] mt-1 font-bold" style={{ color: "#ffffffcc" }}>🪙 {pack.cost}</div>
            </button>
          ))}
        </div>
      </div>

      {newsOpen && (
        <div className="fixed inset-0 z-40 flex items-end justify-center" style={{ backgroundColor: "rgba(0,0,0,0.6)" }} onClick={() => setNewsOpen(false)}>
          <div className="w-full rounded-t-3xl p-4 max-h-[70vh] overflow-y-auto" style={{ backgroundColor: COLORS.panel, maxWidth: 480 }} onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-3"><div className="display" style={{ fontSize: 20, color: COLORS.cream }}>What's New</div><button onClick={() => setNewsOpen(false)}><X size={20} color={COLORS.muted} /></button></div>
            {NEWS_ITEMS.map((n, i) => (<div key={i} className="rounded-xl p-3 mb-2" style={{ backgroundColor: COLORS.panelLight }}><span className="font-black text-[10px]" style={{ color: COLORS.turf }}>{n.v}</span><div className="text-xs mt-1" style={{ color: COLORS.cream }}>{n.text}</div></div>))}
          </div>
        </div>
      )}
    </div>
  );
}

function IndexView({ players }) {
  const ownedCount = players.filter((p) => p.owned).length;
  return (<div className="px-4 pb-24"><div className="rounded-2xl p-4 mb-4 flex items-center justify-between" style={{ background: `linear-gradient(135deg, ${COLORS.panel}, ${COLORS.panelLight})` }}><div><div className="text-xs tracking-widest font-bold" style={{ color: COLORS.muted }}>COLLECTION</div><div className="text-2xl font-black" style={{ color: COLORS.cream }}>{ownedCount} <span style={{ color: COLORS.muted, fontWeight: 700 }}>/ {players.length}</span></div></div><Layers size={28} color={COLORS.gold} /></div><div className="grid grid-cols-2 gap-3">{players.map((p) => <Card key={p.id} player={p} mode="index" />)}</div></div>);
}
function MyCardsView({ players }) {
  const owned = players.filter((p) => p.owned);
  const grouped = ["GK", "DEF", "MID", "FWD"].map((pos) => ({ pos, cards: owned.filter((p) => p.position === pos) }));
  return (<div className="px-4 pb-28"><div className="rounded-2xl p-4 mb-4" style={{ background: `linear-gradient(135deg, ${COLORS.panel}, ${COLORS.panelLight})` }}><div className="text-xs tracking-widest font-bold mb-1" style={{ color: COLORS.muted }}>YOUR SQUAD</div><div className="text-2xl font-black" style={{ color: COLORS.cream }}>{owned.length} <span style={{ color: COLORS.muted, fontWeight: 700 }}>players owned</span></div></div>{grouped.map(({ pos, cards }) => (<div key={pos} className="mb-4"><div className="text-xs tracking-widest font-bold mb-2" style={{ color: COLORS.muted }}>{pos} ({cards.length})</div>{cards.length === 0 ? (<div className="text-sm" style={{ color: COLORS.muted }}>None yet — try the Shop.</div>) : (<div className="grid grid-cols-2 gap-3">{cards.map((p) => <Card key={p.id} player={p} mode="index" />)}</div>)}</div>))}</div>);
}

function Chip({ player, onClick }) {
  const rarity = player ? RARITY[player.rarity] : null;
  return (<button onClick={onClick} className="absolute flex flex-col items-center active:scale-95 transition-transform" style={{ left: "50%", top: "50%", transform: "translate(-50%, -50%)" }}><div className="flex items-center justify-center rounded-full font-black text-sm shadow-lg" style={{ width: 40, height: 40, backgroundColor: player ? rarity.color : "transparent", border: player ? "2px solid rgba(255,255,255,0.7)" : `2px dashed ${COLORS.muted}`, color: player ? COLORS.bg : COLORS.muted, boxShadow: player ? `0 0 12px ${rarity.color}66` : "none" }}>{player ? player.power : "+"}</div><div className="text-[9px] font-bold mt-0.5 px-1 rounded" style={{ color: COLORS.cream, backgroundColor: "rgba(0,0,0,0.5)" }}>{player ? player.name.split(" ").slice(-1)[0] : ""}</div></button>);
}
const WANDER_KEYFRAMES = ["wanderA", "wanderB", "wanderC", "wanderD"];
function MovingChip({ player, x, y, hasBall, index }) {
  const rarity = RARITY[player.rarity];
  const kf = WANDER_KEYFRAMES[index % WANDER_KEYFRAMES.length];
  const duration = 2.8 + (index % 4) * 0.4, delay = (index % 5) * 0.2;
  return (<div className="absolute" style={{ left: `${x}%`, top: `${y}%`, transform: "translate(-50%, -50%)", transition: "left 0.4s ease, top 0.4s ease" }}><div style={{ animation: `${kf} ${duration}s ease-in-out infinite`, animationDelay: `${delay}s` }}><div className="flex flex-col items-center" style={{ transform: hasBall ? "scale(1.22)" : "scale(1)", transition: "transform 0.3s ease" }}><div className="rounded-full flex items-center justify-center font-black text-xs" style={{ width: 32, height: 32, backgroundColor: rarity.color, color: COLORS.bg, border: hasBall ? `2px solid ${COLORS.gold}` : "2px solid rgba(255,255,255,0.5)", boxShadow: hasBall ? `0 0 14px ${COLORS.gold}cc` : "none" }}>{player.power}</div></div></div></div>);
}
function Pitch({ mySlots, oppSlots, lineup, onSlotTap, zoneResults }) {
  return (
    <div className="relative rounded-2xl overflow-hidden mb-4" style={{ background: `repeating-linear-gradient(180deg, ${COLORS.pitch} 0px, ${COLORS.pitch} 34px, ${COLORS.pitchLine2} 34px, ${COLORS.pitchLine2} 68px)`, height: 380, boxShadow: "inset 0 0 60px rgba(0,0,0,0.45)" }}>
      <div className="absolute left-0 right-0 top-1/2 h-px" style={{ backgroundColor: COLORS.pitchLine }} />
      <div className="absolute rounded-full" style={{ width: 90, height: 90, left: "50%", top: "50%", transform: "translate(-50%,-50%)", border: `1px solid ${COLORS.pitchLine}` }} />
      <div className="absolute" style={{ left: "30%", right: "30%", top: 0, height: 36, border: `1px solid ${COLORS.pitchLine}`, borderTop: "none" }} />
      <div className="absolute" style={{ left: "30%", right: "30%", bottom: 0, height: 36, border: `1px solid ${COLORS.pitchLine}`, borderBottom: "none" }} />
      {zoneResults && ["FWD", "MID", "DEF", "GK"].map((z) => { const bands = { FWD: [0, 25], MID: [25, 50], DEF: [50, 75], GK: [75, 100] }; const [top, bottom] = bands[z]; const zr = zoneResults[z]; return (<div key={z} className="absolute left-0 right-0" style={{ top: `${top}%`, height: `${bottom - top}%`, backgroundColor: zr === "win" ? COLORS.turf + "22" : zr === "lose" ? COLORS.danger + "22" : "transparent" }} />); })}
      {oppSlots.map((slot) => (<div key={"opp-" + slot.id} className="absolute" style={{ left: `${slot.x}%`, top: `${slot.y}%` }}><Chip player={lineup.opp?.[slot.id] || null} /></div>))}
      {mySlots.map((slot) => (<div key={"my-" + slot.id} className="absolute" style={{ left: `${slot.x}%`, top: `${slot.y}%` }}><Chip player={lineup.my[slot.id] ? lineup.my[slot.id] : null} onClick={() => onSlotTap && onSlotTap(slot)} /></div>))}
    </div>
  );
}

const COMMENTARY = {
  GK: { win: "🧤 Your keeper pulls off a stunning save!", lose: "😱 Their keeper denies you at the near post!", tie: "🧤 Both keepers stand tall — nothing gets through." },
  DEF: { win: "🛡️ Your defense shuts them down completely!", lose: "💨 They slice right through your backline!", tie: "🛡️ Defenses holding firm on both ends." },
  MID: { win: "⚙️ Your midfield is running the whole game!", lose: "⚙️ They're dominating the midfield battle!", tie: "⚙️ Midfield battle is dead even." },
  FWD: { win: "⚡ GOAL! Your striker finds the net!", lose: "⚡ Ouch — they finish clinically up top!", tie: "⚡ Chances traded, nobody's finishing them." },
};

function PlayView({ players, setStats, setGems, streak, season, setSeason, profile }) {
  const [formationKey, setFormationKey] = useState("balanced");
  const [myLineup, setMyLineup] = useState({});
  const [activeSlot, setActiveSlot] = useState(null);
  const [subSlot, setSubSlot] = useState(null);
  const [halfSubUsed, setHalfSubUsed] = useState(false);
  const [phase, setPhase] = useState("building"); // building | battling | halftime | result
  const [currentHalf, setCurrentHalf] = useState(1);
  const [oppSlots, setOppSlots] = useState([]);
  const [oppLineup, setOppLineup] = useState(null);
  const [firstHalfLineup, setFirstHalfLineup] = useState(null);
  const [finalResult, setFinalResult] = useState(null);
  const [myGoals, setMyGoals] = useState(0);
  const [oppGoals, setOppGoals] = useState(0);
  const [commentary, setCommentary] = useState("Kick off!");
  const [ballOwnerKey, setBallOwnerKey] = useState(null);
  const [matchMinute, setMatchMinute] = useState(0);
  const [zoneResultsLive, setZoneResultsLive] = useState({});
  const [seasonSummary, setSeasonSummary] = useState(null);
  const [opponentMeta, setOpponentMeta] = useState(null);
  const [isChallengeMatch, setIsChallengeMatch] = useState(false);
  const [challengeOpen, setChallengeOpen] = useState(false);
  const [challengeTab, setChallengeTab] = useState("share");
  const [pasteCode, setPasteCode] = useState("");
  const [pasteError, setPasteError] = useState("");
  const [copyFeedback, setCopyFeedback] = useState(false);
  const timers = useRef([]);

  useEffect(() => () => timers.current.forEach(clearTimeout), []);
  useEffect(() => { setMyLineup({}); }, [formationKey]);

  const mySlots = buildSlots(formationKey, "my");
  const currentClub = SEASON_CLUBS[(season.matchday - 1) % SEASON_CLUBS.length];

  useEffect(() => {
    if (phase !== "battling") return;
    const motionList = [
      ...mySlots.map((s) => ({ key: `my-${s.id}`, x: s.x, y: s.y, team: "my" })),
      ...oppSlots.map((s) => ({ key: `opp-${s.id}`, x: s.x, y: s.y, team: "opp" })),
    ];
    if (!motionList.length) return;
    let current = motionList[Math.floor(Math.random() * motionList.length)].key;
    setBallOwnerKey(current);
    const passInterval = setInterval(() => {
      const teamPrefix = current.split("-")[0];
      const stayTeam = Math.random() < 0.8;
      const pool = motionList.filter((m) => m.key !== current && (stayTeam ? m.key.startsWith(teamPrefix) : !m.key.startsWith(teamPrefix)));
      const fallback = motionList.filter((m) => m.key !== current);
      const choices = pool.length ? pool : fallback;
      current = choices[Math.floor(Math.random() * choices.length)].key;
      setBallOwnerKey(current);
    }, 850);
    return () => clearInterval(passInterval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, currentHalf]);

  useEffect(() => {
    if (phase !== "battling") return;
    const t0 = performance.now();
    const base = currentHalf === 1 ? 0 : 45;
    const clockInterval = setInterval(() => {
      const elapsed = performance.now() - t0;
      const m = Math.min(45, Math.floor((elapsed / HALF_DURATION) * 45));
      setMatchMinute(Math.min(90, base + m));
    }, 250);
    return () => clearInterval(clockInterval);
  }, [phase, currentHalf]);

  const filled = Object.values(myLineup).filter(Boolean).length;
  const isComplete = filled === mySlots.length;
  const usedIds = Object.values(myLineup).filter(Boolean).map((p) => p.id);

  const assign = (slot, player) => { playTap(); setMyLineup((cur) => ({ ...cur, [slot.id]: player })); setActiveSlot(null); };
  const removeSlot = (slotId) => setMyLineup((cur) => ({ ...cur, [slotId]: null }));

  const beginMatch = async (newOppSlots, opp, label) => {
    await ensureAudio();
    playWhistle();
    setTimeout(playKick, 150);

    setOppSlots(newOppSlots);
    setOppLineup(opp);

    const snapshot = { ...myLineup };
    setFirstHalfLineup(snapshot);
    setCurrentHalf(1); setPhase("battling"); setMyGoals(0); setOppGoals(0);
    setCommentary(`Kick off ${label}!`); setMatchMinute(0); setZoneResultsLive({});

    const reveal = (zoneKey, delay) => timers.current.push(setTimeout(() => {
      const { result } = computeZone(zoneKey, snapshot, opp);
      setZoneResultsLive((z) => ({ ...z, [zoneKey]: result }));
      setCommentary(COMMENTARY[zoneKey][result]);
      if (result === "win") { playZoneWin(); setMyGoals((g) => g + 1); } else if (result === "lose") { playZoneLose(); setOppGoals((g) => g + 1); } else playTap();
    }, delay));
    reveal("GK", 6000); reveal("DEF", 13000);

    timers.current.push(setTimeout(() => { playWhistle(); setCommentary("⏸️ Half-time — make a substitution if you need one."); setPhase("halftime"); }, 15000));
  };

  const kickOff = () => {
    const formationKeys = Object.keys(FORMATIONS);
    const chosenOppFormation = formationKeys[Math.floor(Math.random() * formationKeys.length)];
    const newOppSlots = buildSlots(chosenOppFormation, "opp");
    const toughness = Math.min(streak + (season.number - 1), 8);
    const opp = {};
    newOppSlots.forEach((slot) => {
      const pool = players.filter((p) => p.position === slot.position && !usedIds.includes(p.id));
      let source = pool.length ? pool : players.filter((p) => p.position === slot.position);
      if (toughness >= 2) { const sorted = [...source].sort((a, b) => b.power - a.power); source = sorted.slice(0, Math.max(1, Math.ceil(sorted.length * (1 - toughness * 0.06)))); }
      opp[slot.id] = source[Math.floor(Math.random() * source.length)];
    });
    setOpponentMeta(null);
    setIsChallengeMatch(false);
    beginMatch(newOppSlots, opp, `vs ${currentClub}`);
  };

  const challengeCode = isComplete ? encodeChallenge(formationKey, myLineup, profile) : "";
  const copyChallengeCode = async () => {
    try { await navigator.clipboard.writeText(challengeCode); } catch (e) { /* clipboard unavailable */ }
    playTap(); setCopyFeedback(true);
    setTimeout(() => setCopyFeedback(false), 1800);
  };
  const startChallengeMatch = (payload) => {
    const newOppSlots = buildSlots(payload.f, "opp");
    const byPos = {};
    payload.pl.forEach(([name, position, power, rc], i) => {
      (byPos[position] = byPos[position] || []).push({ id: `chal-${i}-${position}-${power}`, name, position, power, rarity: RARITY_FROM_CODE[rc] || "Common", owned: true });
    });
    const opp = {};
    newOppSlots.forEach((slot) => { const pool = byPos[slot.position] || []; opp[slot.id] = pool.shift() || null; });
    setOpponentMeta({ teamName: payload.tn, profileName: payload.pn, avatar: payload.av, color: payload.cl });
    setIsChallengeMatch(true);
    setChallengeOpen(false);
    beginMatch(newOppSlots, opp, `vs ${payload.pn}'s ${payload.tn}`);
  };
  const handleJoinChallenge = () => {
    if (!isComplete) { setPasteError(`Fill all ${mySlots.length} of your own positions before battling.`); return; }
    const payload = decodeChallenge(pasteCode);
    if (!payload) { setPasteError("That code doesn't look right — double-check and try again."); return; }
    startChallengeMatch(payload);
  };

  const continueSecondHalf = () => {
    const secondHalfLineup = { ...myLineup };
    playWhistle();
    setCurrentHalf(2); setPhase("battling"); setCommentary("Second half underway!");

    const reveal = (zoneKey, delay) => timers.current.push(setTimeout(() => {
      const { result } = computeZone(zoneKey, secondHalfLineup, oppLineup);
      setZoneResultsLive((z) => ({ ...z, [zoneKey]: result }));
      setCommentary(COMMENTARY[zoneKey][result]);
      if (result === "win") { playZoneWin(); setMyGoals((g) => g + 1); } else if (result === "lose") { playZoneLose(); setOppGoals((g) => g + 1); } else playTap();
    }, delay));
    reveal("MID", 6000); reveal("FWD", 13000);

    timers.current.push(setTimeout(() => {
      const zGK = computeZone("GK", firstHalfLineup, oppLineup);
      const zDEF = computeZone("DEF", firstHalfLineup, oppLineup);
      const zMID = computeZone("MID", secondHalfLineup, oppLineup);
      const zFWD = computeZone("FWD", secondHalfLineup, oppLineup);
      const zr = { GK: zGK.result, DEF: zDEF.result, MID: zMID.result, FWD: zFWD.result };
      let myWins = 0, oppWins = 0;
      [zGK, zDEF, zMID, zFWD].forEach((z) => { if (z.result === "win") myWins++; else if (z.result === "lose") oppWins++; });
      const myTotalPower = zGK.myTotal + zDEF.myTotal + zMID.myTotal + zFWD.myTotal;
      const oppTotalPower = zGK.oppTotal + zDEF.oppTotal + zMID.oppTotal + zFWD.oppTotal;
      const outcome = myWins !== oppWins
        ? (myWins > oppWins ? "win" : "loss")
        : (myTotalPower === oppTotalPower ? "draw" : (myTotalPower > oppTotalPower ? "win" : "loss"));
      const won = outcome === "win";
      const isDraw = outcome === "draw";
      const gemsEarned = won ? WIN_GEMS : isDraw ? DRAW_GEMS : LOSS_GEMS;

      setStats((s) => { const ns = won ? s.streak + 1 : 0; return { wins: s.wins + (won ? 1 : 0), losses: s.losses + (!won && !isDraw ? 1 : 0), draws: (s.draws || 0) + (isDraw ? 1 : 0), streak: ns, bestStreak: Math.max(s.bestStreak, ns) }; });
      setGems((g) => g + gemsEarned);
      if (!isChallengeMatch) {
        setSeason((s) => {
          const pts = s.points + (won ? 3 : isDraw ? 1 : 0), w = s.wins + (won ? 1 : 0), l = s.losses + (!won && !isDraw ? 1 : 0), d = (s.draws || 0) + (isDraw ? 1 : 0);
          if (s.matchday >= 6) {
            const bonus = pts * 2;
            setGems((g) => g + bonus);
            setSeasonSummary({ number: s.number, points: pts, wins: w, losses: l, draws: d, bonus });
            return { number: s.number + 1, matchday: 1, points: 0, wins: 0, losses: 0, draws: 0 };
          }
          return { ...s, matchday: s.matchday + 1, points: pts, wins: w, losses: l, draws: d };
        });
      }
      won ? playWin() : isDraw ? playChime() : playLose();
      setCommentary(won ? "FULL TIME — What a performance! 🏆" : isDraw ? "FULL TIME — honours even." : "FULL TIME — tough result today.");
      setMatchMinute(90);
      setFinalResult({ won, isDraw, zoneResults: zr, myZoneWins: myWins, oppZoneWins: oppWins, gemsEarned, line: won ? WIN_LINES[Math.floor(Math.random() * WIN_LINES.length)] : isDraw ? DRAW_LINES[Math.floor(Math.random() * DRAW_LINES.length)] : LOSS_LINES[Math.floor(Math.random() * LOSS_LINES.length)] });
      setPhase("result");
    }, 15000));
  };

  const playAgain = () => { setPhase("building"); setOppLineup(null); setOppSlots([]); setFinalResult(null); setBallOwnerKey(null); setMatchMinute(0); setHalfSubUsed(false); setZoneResultsLive({}); setOpponentMeta(null); setIsChallengeMatch(false); };

  const combinedForMotion = phase === "battling" ? [
    ...mySlots.map((s) => ({ key: `my-${s.id}`, x: s.x, y: s.y, player: myLineup[s.id] })),
    ...oppSlots.map((s) => ({ key: `opp-${s.id}`, x: s.x, y: s.y, player: (oppLineup || {})[s.id] })),
  ].filter((c) => c.player) : [];
  const ballOwner = combinedForMotion.find((c) => c.key === ballOwnerKey);
  const benchFor = (position) => players.filter((p) => p.owned && p.position === position && !usedIds.includes(p.id));

  return (
    <div className="px-4 pb-24 pt-2">
      {phase === "result" && finalResult?.won && <Confetti />}
      {streak >= 2 && phase === "building" && (<div className="flex items-center justify-center gap-1 mb-2 text-sm font-bold" style={{ color: COLORS.gold }}><Flame size={16} /> {streak} win streak — opponents are getting tougher!</div>)}

      {phase === "building" && (
        <>
          <div className="text-center text-xs font-bold mb-2" style={{ color: COLORS.cyan }}>Season {season.number} · Matchday {season.matchday}/6 vs {currentClub}</div>
          <div className="flex gap-2 mb-3">
            {Object.entries(FORMATIONS).map(([key, f]) => (<button key={key} onClick={() => { playTap(); setFormationKey(key); }} className="flex-1 py-2 rounded-xl text-[10px] font-black" style={{ backgroundColor: formationKey === key ? COLORS.turf : COLORS.panel, color: formationKey === key ? COLORS.bg : COLORS.muted }}>{f.name}</button>))}
          </div>
        </>
      )}

      {(phase === "battling" || phase === "result" || phase === "halftime") && (
        <div className="flex items-center justify-center gap-4 mb-2">
          <span className="text-xs font-bold" style={{ color: COLORS.muted }}>YOU</span>
          <div key={myGoals} className="text-2xl font-black" style={{ color: COLORS.turf, animation: "popIn 0.35s ease" }}>{myGoals}</div>
          <span className="text-sm font-black" style={{ color: COLORS.muted }}>—</span>
          <div key={"o" + oppGoals} className="text-2xl font-black" style={{ color: COLORS.danger, animation: "popIn 0.35s ease" }}>{oppGoals}</div>
          <span className="text-xs font-bold" style={{ color: COLORS.muted }}>THEM</span>
        </div>
      )}
      {isChallengeMatch && opponentMeta && (phase === "battling" || phase === "result" || phase === "halftime") && (
        <div className="text-center text-[11px] font-bold mb-2" style={{ color: COLORS.pink }}>⚔️ Friendly vs {opponentMeta.profileName}'s {opponentMeta.teamName} {opponentMeta.avatar}</div>
      )}
      {phase === "battling" && (<div className="text-center text-xs font-bold mb-2" style={{ color: COLORS.gold }}>⏱ {matchMinute}'</div>)}
      {phase === "halftime" && (<div className="text-center text-xs font-bold mb-2" style={{ color: COLORS.gold }}>⏸ HALF-TIME — 45'</div>)}
      {phase === "result" && (<div className="text-center text-xs font-bold mb-2" style={{ color: COLORS.gold }}>FULL TIME — 90'</div>)}

      <div className="relative">
        <Pitch mySlots={phase === "battling" ? [] : mySlots} oppSlots={phase === "building" || phase === "battling" ? [] : oppSlots} lineup={{ my: myLineup, opp: phase === "building" ? {} : oppLineup || {} }} onSlotTap={phase === "building" ? (slot) => setActiveSlot(slot) : undefined} zoneResults={phase === "result" ? finalResult.zoneResults : phase === "halftime" ? zoneResultsLive : null} />
        {phase === "battling" && (<div className="absolute inset-0 pointer-events-none">{combinedForMotion.map((c, i) => (<MovingChip key={c.key} player={c.player} x={c.x} y={c.y} index={i} hasBall={c.key === ballOwnerKey} />))}{ballOwner && (<div className="absolute" style={{ left: `${ballOwner.x}%`, top: `${ballOwner.y}%`, transform: "translate(-50%, -180%)", fontSize: 16, transition: "left 0.4s ease, top 0.4s ease" }}>⚽</div>)}</div>)}
      </div>

      {(phase === "battling" || phase === "result" || phase === "halftime") && (<div className="rounded-xl px-3 py-2 mb-4 text-center text-sm font-bold" style={{ backgroundColor: COLORS.panel, color: COLORS.cream, minHeight: 20 }}>{commentary}</div>)}

      {phase === "building" && (
        <>
          <div className="text-center text-xs mb-3" style={{ color: COLORS.muted }}>{filled}/{mySlots.length} positions filled — tap a slot to assign a player</div>
          <button onClick={kickOff} disabled={!isComplete} className="display w-full py-3 rounded-xl flex items-center justify-center gap-2 active:translate-y-0.5 active:shadow-none transition-all disabled:opacity-40" style={{ fontSize: 20, letterSpacing: "0.03em", backgroundColor: COLORS.turf, color: COLORS.bg, boxShadow: `0 4px 0 #1C9E5C` }}><PlayCircle size={20} /> KICK OFF</button>
          <button onClick={() => setChallengeOpen(true)} className="w-full mt-2 py-2.5 rounded-xl text-xs font-black flex items-center justify-center gap-2 active:scale-95 transition-transform" style={{ backgroundColor: COLORS.panel, color: COLORS.pink, border: `1px solid ${COLORS.pink}55` }}>⚔️ CHALLENGE A FRIEND</button>
        </>
      )}

      {phase === "halftime" && (
        <div>
          <div className="text-xs tracking-widest font-bold mb-2" style={{ color: COLORS.muted }}>{halfSubUsed ? "SUBSTITUTION USED" : "ONE SUBSTITUTION AVAILABLE"}</div>
          <div className="grid grid-cols-1 gap-2 mb-4">
            {mySlots.map((slot) => { const p = myLineup[slot.id]; if (!p) return null; return (
              <div key={slot.id} className="rounded-xl p-2 flex items-center gap-3" style={{ backgroundColor: COLORS.panel }}>
                <div className="rounded-full flex items-center justify-center font-black text-sm" style={{ width: 34, height: 34, backgroundColor: RARITY[p.rarity].color, color: COLORS.bg }}>{p.power}</div>
                <div className="flex-1"><div className="text-xs font-bold" style={{ color: COLORS.cream }}>{p.name}</div><div className="text-[10px]" style={{ color: COLORS.muted }}>{slot.position}</div></div>
                <button onClick={() => !halfSubUsed && setSubSlot(slot)} disabled={halfSubUsed} className="px-3 py-1.5 rounded-lg text-[10px] font-black flex items-center gap-1 disabled:opacity-30" style={{ backgroundColor: COLORS.panelLight, color: COLORS.gold }}><Repeat size={12} /> SWAP</button>
              </div>
            ); })}
          </div>
          <button onClick={continueSecondHalf} className="display w-full py-3 rounded-xl active:translate-y-0.5 active:shadow-none transition-all" style={{ fontSize: 20, letterSpacing: "0.03em", backgroundColor: COLORS.turf, color: COLORS.bg, boxShadow: `0 4px 0 #1C9E5C` }}>KICK OFF 2ND HALF</button>
        </div>
      )}

      {phase === "result" && finalResult && (
        <div>
          <div className="rounded-2xl p-5 mb-4 text-center" style={{ backgroundColor: finalResult.won ? COLORS.turf + "22" : finalResult.isDraw ? COLORS.cyan + "22" : COLORS.danger + "22", border: `2px solid ${finalResult.won ? COLORS.turf : finalResult.isDraw ? COLORS.cyan : COLORS.danger}`, animation: finalResult.won ? "popIn 0.4s ease" : finalResult.isDraw ? "popIn 0.4s ease" : "shake 0.4s ease" }}>
            <div className="text-2xl font-black mb-1" style={{ color: finalResult.won ? COLORS.turf : finalResult.isDraw ? COLORS.cyan : COLORS.danger }}>{finalResult.won ? "VICTORY! 🎉" : finalResult.isDraw ? "DRAW" : "DEFEAT"}</div>
            <div className="text-sm mb-1" style={{ color: COLORS.cream }}>{finalResult.line}</div>
            <div className="text-xs mb-2" style={{ color: COLORS.muted }}>Zones won: {finalResult.myZoneWins} - {finalResult.oppZoneWins}</div>
            <div className="inline-flex items-center gap-1 px-3 py-1 rounded-full" style={{ backgroundColor: COLORS.panelLight }}><Coins size={14} color={COLORS.gold} /><span className="text-sm font-bold" style={{ color: COLORS.gold }}>+{finalResult.gemsEarned} gems</span></div>
          </div>
          <div className="grid grid-cols-2 gap-2 mb-4">{ZONES.map((z) => (<div key={z.key} className="rounded-xl p-2 flex items-center justify-between" style={{ backgroundColor: COLORS.panel, border: `1px solid ${finalResult.zoneResults[z.key] === "win" ? COLORS.turf : finalResult.zoneResults[z.key] === "lose" ? COLORS.danger : COLORS.muted}` }}><span className="text-xs font-bold" style={{ color: COLORS.cream }}>{z.label}</span><span className="text-xs font-black" style={{ color: finalResult.zoneResults[z.key] === "win" ? COLORS.turf : finalResult.zoneResults[z.key] === "lose" ? COLORS.danger : COLORS.muted }}>{finalResult.zoneResults[z.key] === "win" ? "WON" : finalResult.zoneResults[z.key] === "lose" ? "LOST" : "TIE"}</span></div>))}</div>
          {isChallengeMatch && (<div className="text-[10px] text-center mb-4" style={{ color: COLORS.muted }}>⚔️ Friendly challenge — season & matchday weren't affected.</div>)}
          {seasonSummary && (
            <div className="rounded-2xl p-4 mb-4 text-center" style={{ background: `linear-gradient(135deg, ${COLORS.purple}, ${COLORS.pink})` }}>
              <div className="font-black text-lg mb-1" style={{ color: "#fff" }}>🏁 Season {seasonSummary.number} Complete!</div>
              <div className="text-sm mb-1" style={{ color: "#ffffffdd" }}>{seasonSummary.wins}W - {seasonSummary.draws || 0}D - {seasonSummary.losses}L · {seasonSummary.points} pts</div>
              <div className="text-sm font-bold mb-3" style={{ color: COLORS.gold }}>+{seasonSummary.bonus} bonus gems!</div>
              <button onClick={() => setSeasonSummary(null)} className="px-4 py-2 rounded-xl text-sm font-black" style={{ backgroundColor: "#fff", color: COLORS.purple }}>Awesome!</button>
            </div>
          )}
          <button onClick={playAgain} className="w-full py-4 rounded-2xl font-black text-lg tracking-wide active:scale-95 transition-transform" style={{ backgroundColor: COLORS.panelLight, color: COLORS.cream }}>PLAY AGAIN</button>
        </div>
      )}

      {challengeOpen && (
        <div className="fixed inset-0 z-40 flex items-end justify-center" style={{ backgroundColor: "rgba(0,0,0,0.6)" }} onClick={() => setChallengeOpen(false)}>
          <div className="w-full rounded-t-3xl p-4 max-h-[80vh] overflow-y-auto" style={{ backgroundColor: COLORS.panel, maxWidth: 480 }} onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-3">
              <div className="font-black" style={{ color: COLORS.cream }}>⚔️ Challenge a Friend</div>
              <button onClick={() => setChallengeOpen(false)}><X size={20} color={COLORS.muted} /></button>
            </div>
            <div className="flex gap-2 mb-4">
              <button onClick={() => setChallengeTab("share")} className="flex-1 py-2 rounded-xl text-xs font-black" style={{ backgroundColor: challengeTab === "share" ? COLORS.turf : COLORS.panelLight, color: challengeTab === "share" ? COLORS.bg : COLORS.muted }}>SHARE MY SQUAD</button>
              <button onClick={() => setChallengeTab("join")} className="flex-1 py-2 rounded-xl text-xs font-black" style={{ backgroundColor: challengeTab === "join" ? COLORS.turf : COLORS.panelLight, color: challengeTab === "join" ? COLORS.bg : COLORS.muted }}>ENTER A CODE</button>
            </div>
            {challengeTab === "share" ? (
              isComplete ? (
                <div>
                  <div className="text-xs mb-2" style={{ color: COLORS.muted }}>Copy this code and send it to a friend any way you like (text, Discord, whatever). When they paste it into their own Legend XI, their squad plays yours — real lineup vs real lineup.</div>
                  <div className="rounded-xl p-3 mb-3 text-xs" style={{ backgroundColor: COLORS.panelLight, color: COLORS.gold, wordBreak: "break-all", fontFamily: "monospace" }}>{challengeCode}</div>
                  <button onClick={copyChallengeCode} className="w-full py-2.5 rounded-xl text-sm font-black" style={{ backgroundColor: COLORS.turf, color: COLORS.bg }}>{copyFeedback ? "✅ Copied!" : "COPY CODE"}</button>
                </div>
              ) : (
                <div className="text-sm text-center py-4" style={{ color: COLORS.muted }}>Fill all {mySlots.length} positions first, then come back to generate your code.</div>
              )
            ) : (
              <div>
                <div className="text-xs mb-2" style={{ color: COLORS.muted }}>Paste a friend's challenge code below to battle their real squad.</div>
                <textarea value={pasteCode} onChange={(e) => { setPasteCode(e.target.value); setPasteError(""); }} rows={3} placeholder="Paste LXI1-... code here" className="w-full rounded-xl p-3 text-xs outline-none mb-2" style={{ backgroundColor: COLORS.panelLight, color: COLORS.cream, fontFamily: "monospace" }} />
                {pasteError && <div className="text-xs font-bold mb-2" style={{ color: COLORS.danger }}>{pasteError}</div>}
                <button onClick={handleJoinChallenge} className="w-full py-2.5 rounded-xl text-sm font-black" style={{ backgroundColor: COLORS.gold, color: COLORS.bg }}>⚔️ BATTLE THIS SQUAD</button>
              </div>
            )}
          </div>
        </div>
      )}

      {activeSlot && (
        <div className="fixed inset-0 z-40 flex items-end justify-center" style={{ backgroundColor: "rgba(0,0,0,0.6)" }} onClick={() => setActiveSlot(null)}>
          <div className="w-full rounded-t-3xl p-4 max-h-[70vh] overflow-y-auto" style={{ backgroundColor: COLORS.panel, maxWidth: 480 }} onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-3"><div className="font-black" style={{ color: COLORS.cream }}>Choose your {activeSlot.label}</div><button onClick={() => setActiveSlot(null)}><X size={20} color={COLORS.muted} /></button></div>
            {myLineup[activeSlot.id] && (<button onClick={() => removeSlot(activeSlot.id)} className="w-full mb-3 py-2 rounded-xl text-sm font-bold" style={{ backgroundColor: COLORS.danger + "22", color: COLORS.danger }}>Remove current player</button>)}
            <div className="grid grid-cols-2 gap-3">
              {players.filter((p) => p.owned && p.position === activeSlot.position && !usedIds.includes(p.id)).map((p) => (<Card key={p.id} player={p} mode="select" selected={false} onToggle={() => assign(activeSlot, p)} />))}
              {players.filter((p) => p.owned && p.position === activeSlot.position && !usedIds.includes(p.id)).length === 0 && (<div className="col-span-2 text-sm text-center py-4" style={{ color: COLORS.muted }}>No available {activeSlot.position} cards. Try the Shop!</div>)}
            </div>
          </div>
        </div>
      )}

      {subSlot && (
        <div className="fixed inset-0 z-40 flex items-end justify-center" style={{ backgroundColor: "rgba(0,0,0,0.6)" }} onClick={() => setSubSlot(null)}>
          <div className="w-full rounded-t-3xl p-4 max-h-[70vh] overflow-y-auto" style={{ backgroundColor: COLORS.panel, maxWidth: 480 }} onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-3"><div className="font-black" style={{ color: COLORS.cream }}>Sub in a {subSlot.position}</div><button onClick={() => setSubSlot(null)}><X size={20} color={COLORS.muted} /></button></div>
            <div className="grid grid-cols-2 gap-3">
              {benchFor(subSlot.position).map((p) => (<Card key={p.id} player={p} mode="select" selected={false} onToggle={() => { playTap(); setMyLineup((cur) => ({ ...cur, [subSlot.id]: p })); setHalfSubUsed(true); setSubSlot(null); }} />))}
              {benchFor(subSlot.position).length === 0 && (<div className="col-span-2 text-sm text-center py-4" style={{ color: COLORS.muted }}>No bench {subSlot.position} available.</div>)}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

const GEM_PASSES = [{ id: "p100", gems: 100, price: 5 }, { id: "p500", gems: 500, price: 25, bestValue: true }, { id: "p1000", gems: 1000, price: 50 }];
const SPIN_ITEM_W = 76, SPIN_GAP = 8, SPIN_STEP = SPIN_ITEM_W + SPIN_GAP, SPIN_FILLER_COUNT = 22;

function SpinStrip({ pool, finalCard, onLanded }) {
  const wrapRef = useRef(null);
  const [translate, setTranslate] = useState(0);
  // Land on finalCard at a randomized position (not always the last slot) so
  // the reel doesn't visually stop in the same spot every time -- keep at
  // least 10 cards of spin distance so it never feels like it barely moved.
  const built = useRef((() => {
    const fillers = Array.from({ length: SPIN_FILLER_COUNT }, () => pool[Math.floor(Math.random() * pool.length)]);
    const insertAt = Math.floor(Math.random() * (SPIN_FILLER_COUNT - 10 + 1)) + 10;
    fillers.splice(insertAt, 0, finalCard);
    return { items: fillers, finalIndex: insertAt };
  })()).current;
  const items = built.items;
  const finalIndex = built.finalIndex;
  useEffect(() => {
    const tickTimes = [90, 180, 280, 390, 510, 650, 800, 970, 1160, 1380, 1630, 1920, 2260];
    const timers = tickTimes.map((t) => setTimeout(() => playTap(), t));
    const width = wrapRef.current.offsetWidth;
    const target = width / 2 - SPIN_ITEM_W / 2 - finalIndex * SPIN_STEP;
    const raf1 = requestAnimationFrame(() => { requestAnimationFrame(() => setTranslate(target)); });
    return () => { timers.forEach((t) => clearTimeout(t)); cancelAnimationFrame(raf1); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <div ref={wrapRef} className="relative overflow-hidden mx-auto" style={{ height: 104, width: "100%" }}>
      <div className="absolute left-1/2 top-0 z-10" style={{ transform: "translateX(-50%)" }}><div style={{ width: 0, height: 0, borderLeft: "7px solid transparent", borderRight: "7px solid transparent", borderTop: `9px solid ${COLORS.gold}` }} /></div>
      <div className="absolute left-1/2 top-0 bottom-0 z-10" style={{ width: 2, backgroundColor: COLORS.gold, transform: "translateX(-1px)", opacity: 0.6 }} />
      <div className="flex items-center absolute top-2 left-0" style={{ gap: SPIN_GAP, transform: `translateX(${translate}px)`, transition: "transform 2.6s cubic-bezier(0.1,0.7,0.15,1)" }} onTransitionEnd={(e) => { if (e.propertyName === "transform") onLanded(); }}>
        {items.map((p, i) => { const rc = RARITY[p.rarity].color; return (<div key={i} className="flex flex-col items-center justify-center rounded-xl shrink-0" style={{ width: SPIN_ITEM_W, height: 88, backgroundColor: COLORS.panelLight, border: `2px solid ${rc}55` }}><div className="rounded-full flex items-center justify-center font-black text-sm" style={{ width: 36, height: 36, backgroundColor: rc, color: COLORS.bg }}>{p.power}</div><div style={{ fontSize: 8, color: COLORS.muted, marginTop: 4, maxWidth: SPIN_ITEM_W - 8, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{p.name.split(" ").slice(-1)[0]}</div></div>); })}
      </div>
    </div>
  );
}

function ShopView({ players, setPlayers, gems, setGems }) {
  const [phase, setPhase] = useState("list"); // list | spinning | revealed
  const [selectedPack, setSelectedPack] = useState(null);
  const [revealed, setRevealed] = useState(null);
  const [pendingPick, setPendingPick] = useState(null);
  const [purchasedPass, setPurchasedPass] = useState(null);
  const [purchasedExclusive, setPurchasedExclusive] = useState(null);
  const lockedCount = players.filter((p) => !p.owned && !p.exclusive).length;

  const openPack = async (pack) => {
    if (gems < pack.cost || phase !== "list") return;
    await ensureAudio(); playWhoosh(); setGems((g) => g - pack.cost);
    const locked = players.filter((p) => !p.owned && !p.exclusive);
    const pick = pickWeighted(locked, pack.weights);
    setSelectedPack(pack);
    if (!pick) { setGems((g) => g + Math.round(pack.cost / 3)); playTap(); setRevealed(null); setPhase("revealed"); return; }
    setPendingPick(pick); setPhase("spinning");
  };
  const handleLanded = () => { const pick = pendingPick; setPlayers((ps) => ps.map((p) => (p.id === pick.id ? { ...p, owned: true } : p))); if (isTopTier(pick.rarity)) { playFanfare(); playImpact(); } else if (isHighTier(pick.rarity)) playSparkle(); else playChime(); setRevealed(pick); setPhase("revealed"); };
  const closeReveal = () => { setPhase("list"); setRevealed(null); setPendingPick(null); setSelectedPack(null); };
  const buyGemPass = async (pass) => { await ensureAudio(); playChime(); setGems((g) => g + pass.gems); setPurchasedPass(pass.id); setTimeout(() => setPurchasedPass(null), 1800); };
  const buyExclusive = async (card) => { await ensureAudio(); playFanfare(); setPlayers((ps) => ps.map((p) => (p.id === card.id ? { ...p, owned: true } : p))); setPurchasedExclusive(card.id); };

  const rarityColor = revealed ? RARITY[revealed.rarity].color : COLORS.gold;
  const isLegendary = revealed ? isTopTier(revealed.rarity) : false;
  const spinPool = players.filter((p) => !p.exclusive);
  const packTierIndex = selectedPack ? PACKS.findIndex((p) => p.id === selectedPack.id) : 1;

  return (
    <div className="px-4 pb-24">
      <div className="rounded-2xl p-4 mb-4 flex items-center justify-between" style={{ background: `linear-gradient(135deg, ${COLORS.panel}, ${COLORS.panelLight})` }}><div><div className="text-xs tracking-widest font-bold" style={{ color: COLORS.muted }}>YOUR GEMS</div><div className="text-2xl font-black flex items-center gap-1" style={{ color: COLORS.gold }}><Coins size={20} /> {gems}</div></div><div className="text-right"><div className="text-xs" style={{ color: COLORS.muted }}>Cards left to find</div><div className="text-lg font-black" style={{ color: COLORS.cream }}>{lockedCount}</div></div></div>

      <div className="text-xs tracking-widest font-bold mb-2" style={{ color: COLORS.muted }}>PLAYER PACKS</div>

      {phase === "list" && (
        <div className="grid grid-cols-2 gap-3 mb-6">
          {PACKS.map((pack) => (
            <div key={pack.id} className="relative rounded-2xl p-4 text-center overflow-hidden" style={{ background: `linear-gradient(160deg, ${pack.grad[0]}, ${pack.grad[1]})`, boxShadow: `0 4px 18px ${pack.glow}44` }}>
              <div className="absolute inset-0 opacity-20" style={{ background: `radial-gradient(circle at 30% 20%, #fff, transparent 60%)` }} />
              <div className="relative">
                <div className="text-4xl mb-1" style={{ animation: "floatBounce 2.4s ease-in-out infinite", animationDelay: `${PACKS.indexOf(pack) * 0.2}s` }}>{pack.icon}</div>
                <div className="font-black text-xs mb-1" style={{ color: "#fff" }}>{pack.name}</div>
                <div className="text-[9px] mb-3 leading-tight" style={{ color: "#ffffffcc", minHeight: 22 }}>{pack.blurb}</div>
                <button onClick={() => openPack(pack)} disabled={gems < pack.cost} className="w-full py-2 rounded-xl text-[11px] font-black active:scale-95 transition-transform disabled:opacity-40" style={{ backgroundColor: "#fff", color: pack.grad[0] }}><Coins size={12} className="inline mb-0.5" /> {pack.cost}</button>
              </div>
            </div>
          ))}
        </div>
      )}

      {phase === "spinning" && selectedPack && (
        <div className="relative rounded-2xl p-6 mb-6 text-center overflow-hidden" style={{ background: `radial-gradient(circle at 50% 20%, ${selectedPack.grad[0]}33, ${COLORS.panel})`, minHeight: 260 }}>
          <div className="absolute inset-0 flex items-center justify-center pointer-events-none" style={{ zIndex: 0 }}><div style={{ width: 300, height: 300, borderRadius: "50%", background: `conic-gradient(from 0deg, ${selectedPack.grad[0]}, ${selectedPack.grad[1]}, ${COLORS.cyan}, ${selectedPack.grad[0]})`, animation: "spinRays 1.3s linear infinite", opacity: 0.3, filter: "blur(6px)" }} /></div>
          <div className="relative" style={{ zIndex: 2 }}>
            <div className="text-[10px] font-black tracking-widest mb-2 flex items-center justify-center gap-1" style={{ color: selectedPack.glow }}>{selectedPack.icon} {selectedPack.name.toUpperCase()}</div>
            {pendingPick && (<><div className="font-bold tracking-widest text-xs mb-3" style={{ color: COLORS.gold }}>SPINNING...</div><SpinStrip pool={spinPool} finalCard={pendingPick} onLanded={handleLanded} /></>)}
          </div>
        </div>
      )}
      {phase === "revealed" && selectedPack && (<PackRevealOverlay card={revealed} pack={selectedPack} onContinue={closeReveal} />)}

      <div className="text-xs tracking-widest font-bold mb-2" style={{ color: COLORS.muted }}>GEM PASSES</div>
      <div className="text-[11px] mb-3" style={{ color: COLORS.muted }}>🚧 Demo only — these buttons add gems instantly for testing. A real app needs App Store / Google Play billing set up by an adult before it can charge real money.</div>
      <div className="grid grid-cols-3 gap-2 mb-6">{GEM_PASSES.map((pass) => (<div key={pass.id} className="relative rounded-2xl p-3 text-center" style={{ background: pass.bestValue ? `linear-gradient(160deg, ${COLORS.purple}, ${COLORS.pink})` : COLORS.panel, border: pass.bestValue ? "none" : `1px solid ${COLORS.panelLight}` }}>{pass.bestValue && <div className="absolute -top-2 left-1/2 -translate-x-1/2 text-[8px] font-black px-2 py-0.5 rounded-full" style={{ backgroundColor: COLORS.gold, color: COLORS.bg }}>BEST VALUE</div>}<Gem size={22} color={pass.bestValue ? "#fff" : COLORS.gold} className="mx-auto mb-1" /><div className="font-black text-sm" style={{ color: pass.bestValue ? "#fff" : COLORS.cream }}>{pass.gems}</div><div className="text-[9px] mb-2" style={{ color: pass.bestValue ? "#ffffffcc" : COLORS.muted }}>gems</div><button onClick={() => buyGemPass(pass)} className="w-full py-1.5 rounded-lg text-[11px] font-black active:scale-95 transition-transform" style={{ backgroundColor: pass.bestValue ? "#fff" : COLORS.panelLight, color: pass.bestValue ? COLORS.purple : COLORS.gold }}>{purchasedPass === pass.id ? "✅ Added!" : `€${pass.price}`}</button></div>))}</div>
      <div className="text-xs tracking-widest font-bold mb-2" style={{ color: COLORS.muted }}>EXCLUSIVE CARDS</div>
      <div className="text-[11px] mb-3" style={{ color: COLORS.muted }}>Guaranteed 100-rated cards — no luck involved, straight to your collection.</div>
      <div className="grid grid-cols-1 gap-3">{players.filter((p) => p.exclusive).map((card) => { const bought = card.owned || purchasedExclusive === card.id; return (<div key={card.id} className="rounded-2xl p-3 flex items-center gap-3" style={{ background: `linear-gradient(135deg, ${COLORS.panel}, ${COLORS.panelLight})`, border: `2px solid ${COLORS.gold}` }}><div className="flex items-center justify-center rounded-full font-black text-lg shrink-0" style={{ width: 48, height: 48, backgroundColor: COLORS.gold, color: COLORS.bg, boxShadow: `0 0 16px ${COLORS.gold}88` }}>{card.power}</div><div className="flex-1"><div className="font-black text-sm" style={{ color: COLORS.cream }}>{card.name}</div><div className="text-[10px] font-bold" style={{ color: COLORS.gold }}>{card.position} · LEGENDARY</div></div><button onClick={() => !bought && buyExclusive(card)} disabled={bought} className="px-3 py-2 rounded-xl text-xs font-black shrink-0 active:scale-95 transition-transform disabled:opacity-70" style={{ background: bought ? COLORS.turf : `linear-gradient(135deg, ${COLORS.gold}, #FF9F4A)`, color: COLORS.bg }}>{bought ? "✅ Owned" : `€${card.priceEUR}`}</button></div>); })}</div>
    </div>
  );
}

function ProfileView({ profile, setProfile, players, stats, gems, season, onReset }) {
  const owned = players.filter((p) => p.owned);
  const bestCard = owned.reduce((best, p) => (p.power > (best?.power || 0) ? p : best), null);
  const totalMatches = stats.wins + stats.losses + (stats.draws || 0);
  const winRate = totalMatches ? Math.round((stats.wins / totalMatches) * 100) : 0;
  const rank = rankForWins(stats.wins);
  const xp = stats.wins * 15 + stats.losses * 3 + owned.length * 8 + stats.bestStreak * 10;
  const level = Math.floor(xp / 150) + 1, xpIntoLevel = xp % 150, xpPct = Math.round((xpIntoLevel / 150) * 100);
  const [confirmReset, setConfirmReset] = useState(false);

  return (
    <div className="px-4 pb-24">
      <div className="rounded-2xl p-5 mb-4 text-center" style={{ background: `linear-gradient(160deg, ${COLORS.panel}, ${COLORS.panelLight})` }}>
        <div className="mx-auto mb-2 flex items-center justify-center rounded-full text-3xl relative" style={{ width: 76, height: 76, background: `linear-gradient(135deg, ${profile.color}, ${COLORS.purple})`, boxShadow: `0 0 20px ${profile.color}66` }}>
          {profile.avatar}
          <div className="absolute -bottom-1 -right-1 rounded-full font-black text-[10px] flex items-center justify-center" style={{ width: 24, height: 24, backgroundColor: COLORS.bg, border: `2px solid ${profile.color}`, color: profile.color }}>{profile.number}</div>
        </div>
        <div className="text-[10px] font-black tracking-widest mb-1" style={{ color: rank.color }}>{rank.icon} {rank.name.toUpperCase()}</div>
        <div className="grid grid-cols-2 gap-2 mb-3">
          <input value={profile.name} onChange={(e) => setProfile((p) => ({ ...p, name: e.target.value }))} placeholder="Your name" className="text-center font-bold rounded-xl py-2 px-2 outline-none text-sm" style={{ backgroundColor: COLORS.panelLight, color: COLORS.cream }} maxLength={16} />
          <input value={profile.teamName} onChange={(e) => setProfile((p) => ({ ...p, teamName: e.target.value }))} placeholder="Team name" className="text-center font-bold rounded-xl py-2 px-2 outline-none text-sm" style={{ backgroundColor: COLORS.panelLight, color: COLORS.cream }} maxLength={18} />
        </div>
        <div className="flex items-center justify-center gap-2 mb-3"><span className="text-[10px] font-bold" style={{ color: COLORS.muted }}>JERSEY #</span><input type="number" min={1} max={99} value={profile.number} onChange={(e) => setProfile((p) => ({ ...p, number: Math.max(1, Math.min(99, Number(e.target.value) || 1)) }))} className="text-center font-black rounded-lg py-1 outline-none text-sm" style={{ width: 52, backgroundColor: COLORS.panelLight, color: profile.color }} /></div>
        <div className="flex justify-center gap-2 mb-3 flex-wrap">{AVATARS.map((a) => (<button key={a} onClick={() => { playTap(); setProfile((p) => ({ ...p, avatar: a })); }} className="text-lg w-8 h-8 rounded-full flex items-center justify-center" style={{ backgroundColor: a === profile.avatar ? profile.color + "44" : "transparent", border: a === profile.avatar ? `1px solid ${profile.color}` : "1px solid transparent" }}>{a}</button>))}</div>
        <div className="flex justify-center gap-2">{TEAM_COLORS.map((c) => (<button key={c.id} onClick={() => { playTap(); setProfile((p) => ({ ...p, color: c.hex })); }} className="rounded-full" style={{ width: 22, height: 22, backgroundColor: c.hex, border: profile.color === c.hex ? "2px solid #fff" : "2px solid transparent" }} />))}</div>
      </div>

      <div className="rounded-2xl p-4 mb-4" style={{ backgroundColor: COLORS.panel }}>
        <div className="flex items-center justify-between mb-2"><div className="text-xs tracking-widest font-bold" style={{ color: COLORS.muted }}>FAN LEVEL</div><div className="font-black text-sm" style={{ color: profile.color }}>LV {level}</div></div>
        <div className="h-2.5 rounded-full overflow-hidden" style={{ backgroundColor: COLORS.panelLight }}><div className="h-full rounded-full" style={{ width: `${xpPct}%`, background: `linear-gradient(90deg, ${profile.color}, ${COLORS.gold})`, transition: "width 0.4s ease" }} /></div>
        <div className="text-[10px] mt-1" style={{ color: COLORS.muted }}>{xpIntoLevel} / 150 XP to next level</div>
      </div>

      <div className="rounded-2xl p-4 mb-4" style={{ backgroundColor: COLORS.panel }}>
        <div className="text-xs tracking-widest font-bold mb-2" style={{ color: COLORS.muted }}>THIS SEASON</div>
        <div className="flex items-center justify-between text-sm"><span style={{ color: COLORS.cream }}>Season {season.number} · Matchday {season.matchday}/6</span><span className="font-black" style={{ color: COLORS.gold }}>{season.points} pts</span></div>
        <div className="text-[10px] mt-1" style={{ color: COLORS.muted }}>{season.wins}W - {season.draws || 0}D - {season.losses}L this season</div>
      </div>

      <div className="grid grid-cols-4 gap-2 mb-4"><StatBox label="Wins" value={stats.wins} color={COLORS.turf} /><StatBox label="Losses" value={stats.losses} color={COLORS.danger} /><StatBox label="Win rate" value={`${winRate}%`} color={COLORS.gold} /><StatBox label="Best streak" value={stats.bestStreak} color={COLORS.pink} /></div>

      <div className="text-xs tracking-widest font-bold mb-2" style={{ color: COLORS.muted }}>ACHIEVEMENTS</div>
      <div className="grid grid-cols-4 gap-2 mb-4">{ACHIEVEMENTS.map((a) => { const unlocked = a.check(stats, players, { season, gems }); return (<div key={a.id} className="rounded-xl p-2 flex flex-col items-center text-center" style={{ backgroundColor: unlocked ? COLORS.panelLight : COLORS.panel, opacity: unlocked ? 1 : 0.4, border: unlocked ? `1px solid ${COLORS.gold}` : "1px solid transparent" }}><div className="text-lg mb-0.5">{a.emoji}</div><div className="text-[8px] font-bold leading-tight" style={{ color: unlocked ? COLORS.cream : COLORS.muted }}>{a.label}</div></div>); })}</div>

      <div className="text-xs tracking-widest font-bold mb-2" style={{ color: COLORS.muted }}>BEST CARD</div>
      {bestCard ? <Card player={bestCard} mode="index" /> : <div className="text-sm mb-4" style={{ color: COLORS.muted }}>No cards yet.</div>}

      <button onClick={() => { if (confirmReset) { onReset(); setConfirmReset(false); } else { setConfirmReset(true); setTimeout(() => setConfirmReset(false), 4000); } }} className="w-full mt-4 py-3 rounded-2xl text-xs font-bold flex items-center justify-center gap-2" style={{ backgroundColor: confirmReset ? COLORS.danger : COLORS.panel, color: confirmReset ? "#fff" : COLORS.muted }}>
        <RefreshCw size={14} /> {confirmReset ? "Tap again to confirm reset" : "Reset progress"}
      </button>
    </div>
  );
}
function StatBox({ label, value, color }) { return (<div className="rounded-2xl p-2 text-center" style={{ backgroundColor: COLORS.panel }}><div className="text-base font-black" style={{ color }}>{value}</div><div className="text-[9px] tracking-wide" style={{ color: COLORS.muted }}>{label}</div></div>); }

const DEFAULT_STATS = { wins: 0, losses: 0, draws: 0, streak: 0, bestStreak: 0 };
const DEFAULT_PROFILE = { name: "Player", avatar: "⚽", teamName: "My Team", number: 7, color: COLORS.turf };
const DEFAULT_SEASON = { number: 1, matchday: 1, points: 0, wins: 0, losses: 0, draws: 0 };
const DEFAULT_HOME = { dailyLastClaim: null, dailyStreak: 0, objectivesClaimed: [] };
const SAVE_KEY = "legendxi-save-v1";
function todayStr() { return new Date().toISOString().slice(0, 10); }

export default function LegendXI() {
  const [players, setPlayers] = useState(STARTER_PLAYERS);
  const [tab, setTab] = useState("home");
  const [stats, setStats] = useState(DEFAULT_STATS);
  const [profile, setProfile] = useState(DEFAULT_PROFILE);
  const [gems, setGems] = useState(STARTING_GEMS);
  const [season, setSeason] = useState(DEFAULT_SEASON);
  const [home, setHome] = useState(DEFAULT_HOME);
  const [loaded, setLoaded] = useState(false);
  const [rankUp, setRankUp] = useState(null);
  const prevRankRef = useRef(null);

  useEffect(() => {
    (async () => {
      try {
        if (window.storage) {
          const res = await window.storage.get(SAVE_KEY, false);
          if (res && res.value) {
            const data = JSON.parse(res.value);
            if (data.players) setPlayers(data.players);
            if (data.stats) setStats(data.stats);
            if (data.profile) setProfile(data.profile);
            if (typeof data.gems === "number") setGems(data.gems);
            if (data.season) setSeason(data.season);
            if (data.home) setHome({ ...DEFAULT_HOME, ...data.home });
          }
        }
      } catch (e) { /* no save yet */ }
      setLoaded(true);
    })();
  }, []);

  useEffect(() => {
    if (!loaded || !window.storage) return;
    const flush = () => { window.storage.set(SAVE_KEY, JSON.stringify({ players, stats, profile, gems, season, home }), false).catch(() => {}); };
    const t = setTimeout(flush, 600);
    const onHide = () => { if (document.visibilityState === "hidden") flush(); };
    window.addEventListener("pagehide", flush);
    window.addEventListener("beforeunload", flush);
    document.addEventListener("visibilitychange", onHide);
    return () => {
      clearTimeout(t);
      window.removeEventListener("pagehide", flush);
      window.removeEventListener("beforeunload", flush);
      document.removeEventListener("visibilitychange", onHide);
    };
  }, [players, stats, profile, gems, season, home, loaded]);

  const dailyClaimed = home.dailyLastClaim === todayStr();
  const claimDaily = () => {
    if (dailyClaimed) return;
    playChime();
    const reward = DAILY_REWARDS[home.dailyStreak % 7];
    setGems((g) => g + reward);
    setHome((h) => ({ ...h, dailyLastClaim: todayStr(), dailyStreak: h.dailyStreak + 1 }));
  };
  const claimObjective = (id, reward) => {
    if (home.objectivesClaimed.includes(id)) return;
    playSparkle();
    setGems((g) => g + reward);
    setHome((h) => ({ ...h, objectivesClaimed: [...h.objectivesClaimed, id] }));
  };

  useEffect(() => {
    if (!loaded) return;
    const r = rankForWins(stats.wins);
    if (prevRankRef.current === null) { prevRankRef.current = r.name; return; }
    if (r.name !== prevRankRef.current) {
      prevRankRef.current = r.name;
      setRankUp(r); playFanfare();
      const t = setTimeout(() => setRankUp(null), 3200);
      return () => clearTimeout(t);
    }
  }, [stats.wins, loaded]);

  const resetProgress = async () => {
    setPlayers(STARTER_PLAYERS); setStats(DEFAULT_STATS); setProfile(DEFAULT_PROFILE); setGems(STARTING_GEMS); setSeason(DEFAULT_SEASON); setHome(DEFAULT_HOME);
    prevRankRef.current = "Bronze";
    if (window.storage) { try { await window.storage.delete(SAVE_KEY, false); } catch (e) {} }
  };

  const tabs = [
    { key: "home", label: "Home", icon: Home }, { key: "index", label: "Index", icon: List }, { key: "cards", label: "My Cards", icon: Layers },
    { key: "shop", label: "Shop", icon: ShoppingBag }, { key: "play", label: "Play", icon: PlayCircle },
    { key: "profile", label: "Profile", icon: User },
  ];

  if (!loaded) {
    return (<div style={{ background: `linear-gradient(180deg, ${COLORS.bg}, ${COLORS.bg2})`, minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", flexDirection: "column", gap: 12 }}><div style={{ fontSize: 40, animation: "floatBounce 1.4s ease-in-out infinite" }}>⚽</div><div style={{ color: COLORS.muted, fontSize: 12, fontWeight: 700, letterSpacing: 1 }}>LOADING YOUR SQUAD...</div></div>);
  }

  return (
    <div style={{ background: COLORS.bg, minHeight: "100vh", fontFamily: "system-ui, sans-serif", position: "relative" }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Teko:wght@500;600;700&display=swap');
        .display { font-family: 'Teko', system-ui, sans-serif; }
        @keyframes confettiFall { to { transform: translateY(105vh) rotate(360deg); opacity: 0.4; } }
        @keyframes flipIn { from { opacity: 0; transform: rotateY(90deg) scale(0.8); } to { opacity: 1; transform: rotateY(0deg) scale(1); } }
        @keyframes popIn { 0% { transform: scale(0.85); opacity: 0; } 60% { transform: scale(1.04); opacity: 1; } 100% { transform: scale(1); } }
        @keyframes shake { 0%, 100% { transform: translateX(0); } 20% { transform: translateX(-6px); } 40% { transform: translateX(6px); } 60% { transform: translateX(-4px); } 80% { transform: translateX(4px); } }
        @keyframes floatBounce { 0%, 100% { transform: translateY(0) rotate(-3deg); } 50% { transform: translateY(-10px) rotate(3deg); } }
        @keyframes twinkle { 0%, 100% { opacity: 1; transform: scale(1) rotate(0deg); } 50% { opacity: 0.4; transform: scale(1.3) rotate(20deg); } }
        @keyframes spinRays { to { transform: rotate(360deg); } }
        @keyframes revealBounce { 0% { transform: scale(0.3) rotate(-10deg); opacity: 0; } 60% { transform: scale(1.1) rotate(4deg); opacity: 1; } 100% { transform: scale(1) rotate(0deg); } }
        @keyframes burstOut { from { transform: translate(0,0) scale(1); opacity: 1; } to { transform: translate(var(--dx), var(--dy)) scale(0.3); opacity: 0; } }
        @keyframes wanderA { 0% { transform: translate(0,0); } 25% { transform: translate(10px,-7px); } 50% { transform: translate(-8px,7px); } 75% { transform: translate(7px,9px); } 100% { transform: translate(0,0); } }
        @keyframes wanderB { 0% { transform: translate(0,0); } 30% { transform: translate(-9px,8px); } 60% { transform: translate(9px,-9px); } 100% { transform: translate(0,0); } }
        @keyframes wanderC { 0% { transform: translate(0,0); } 40% { transform: translate(8px,7px); } 70% { transform: translate(-9px,-5px); } 100% { transform: translate(0,0); } }
        @keyframes wanderD { 0% { transform: translate(0,0); } 35% { transform: translate(-7px,-9px); } 65% { transform: translate(9px,7px); } 100% { transform: translate(0,0); } }
        @keyframes shineSweep { 0% { transform: translateX(-150%); } 60% { transform: translateX(150%); } 100% { transform: translateX(150%); } }
        @keyframes slideDown { from { transform: translateY(-100%); } to { transform: translateY(0); } }
        @keyframes riseIn { 0% { transform: translateY(120px) scale(0.55); opacity: 0; } 70% { transform: translateY(-10px) scale(1.05); opacity: 1; } 100% { transform: translateY(0) scale(1); } }
        @keyframes flashOut { from { opacity: 1; } to { opacity: 0; } }
      `}</style>

      {/* Ambient stadium-night backdrop: floodlight glows + faint grass-mow texture */}
      <div className="fixed inset-0 pointer-events-none" style={{ zIndex: 0, background: `radial-gradient(circle at 12% 0%, ${COLORS.gold}1f, transparent 38%), radial-gradient(circle at 88% 4%, ${COLORS.cyan}1a, transparent 40%), repeating-linear-gradient(115deg, rgba(255,255,255,0.015) 0px, rgba(255,255,255,0.015) 40px, transparent 40px, transparent 80px), ${COLORS.bg}` }} />

      <div style={{ position: "relative", zIndex: 1 }}>
        {rankUp && (<div className="fixed top-0 left-0 right-0 z-50 flex items-center justify-center gap-2 py-3" style={{ background: `linear-gradient(90deg, ${rankUp.color}, ${COLORS.gold})`, animation: "slideDown 0.4s ease" }}><span style={{ fontSize: 22 }}>{rankUp.icon}</span><span className="font-black text-sm" style={{ color: COLORS.bg }}>PROMOTED TO {rankUp.name.toUpperCase()}!</span></div>)}

        <div className="px-4 pt-5 pb-3" style={{ borderBottom: `1px solid ${COLORS.panelLight}` }}>
          <div className="flex items-center justify-between">
            <div>
              <div className="flex items-center gap-1.5 mb-0.5">
                <span style={{ width: 6, height: 6, borderRadius: "50%", backgroundColor: COLORS.turf, boxShadow: `0 0 6px ${COLORS.turf}`, animation: "twinkle 1.8s ease-in-out infinite" }} />
                <span className="text-[9px] font-bold" style={{ color: COLORS.muted, letterSpacing: "0.2em" }}>MATCHDAY LIVE</span>
              </div>
              <div className="display leading-none" style={{ color: COLORS.cream, fontSize: 30, fontWeight: 600, letterSpacing: "0.01em" }}>LEGEND <span style={{ color: COLORS.gold }}>XI</span></div>
            </div>
            <div className="flex items-center gap-1.5">
              <div className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg" style={{ backgroundColor: COLORS.panel, borderBottom: `2px solid ${COLORS.gold}` }}><Coins size={14} color={COLORS.gold} /><span className="display font-semibold text-sm" style={{ color: COLORS.gold }}>{gems}</span></div>
              {stats.streak >= 2 && (<div className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg" style={{ backgroundColor: COLORS.panel, borderBottom: `2px solid ${COLORS.danger}` }}><Flame size={14} color={COLORS.danger} /><span className="display font-semibold text-sm" style={{ color: COLORS.danger }}>{stats.streak}</span></div>)}
              <div className="flex items-center gap-1 px-3 py-1.5 rounded-lg" style={{ backgroundColor: COLORS.panel, borderBottom: `2px solid ${COLORS.turf}` }}><Trophy size={16} color={COLORS.gold} /><span className="display font-semibold text-base" style={{ color: COLORS.cream }}>{stats.wins}</span></div>
            </div>
          </div>
        </div>

        {tab === "home" && <HomeView profile={profile} stats={stats} season={season} gems={gems} players={players} home={home} dailyClaimed={dailyClaimed} onClaimDaily={claimDaily} onClaimObjective={claimObjective} onNavigate={setTab} />}
        {tab === "index" && <IndexView players={players} />}
        {tab === "cards" && <MyCardsView players={players} />}
        {tab === "shop" && <ShopView players={players} setPlayers={setPlayers} gems={gems} setGems={setGems} />}
        {tab === "play" && <PlayView players={players} setStats={setStats} setGems={setGems} streak={stats.streak} season={season} setSeason={setSeason} profile={profile} />}
        {tab === "profile" && <ProfileView profile={profile} setProfile={setProfile} players={players} stats={stats} gems={gems} season={season} onReset={resetProgress} />}

        <div className="fixed bottom-0 left-0 right-0 z-10" style={{ maxWidth: 480, margin: "0 auto" }}>
          <div style={{ height: 2, background: `linear-gradient(90deg, transparent, ${COLORS.gold}99, transparent)` }} />
          <div className="flex justify-around py-2" style={{ backgroundColor: COLORS.panel }}>
            {tabs.map(({ key, label, icon: Icon }) => (
              <button key={key} onClick={() => { playTap(); setTab(key); }} className="flex flex-col items-center gap-1 px-2 py-1">
                <Icon size={18} color={tab === key ? COLORS.turf : COLORS.muted} />
                <span className="display font-semibold" style={{ fontSize: 11, letterSpacing: "0.04em", color: tab === key ? COLORS.turf : COLORS.muted }}>{label.toUpperCase()}</span>
                <span style={{ width: 4, height: 4, borderRadius: "50%", backgroundColor: tab === key ? COLORS.turf : "transparent" }} />
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
