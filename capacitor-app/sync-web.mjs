#!/usr/bin/env node
// Copies the real game (../server/) into ./www/, which is the folder
// Capacitor packages into the native iOS/Android shells. server/ stays the
// single source of truth -- this script is deliberately the only thing that
// touches www/, so re-running it after any server/ change (then `npx cap
// sync`) is always safe and never drifts.
import { existsSync, mkdirSync, copyFileSync, readdirSync, statSync, rmSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC = join(__dirname, "..", "server");
const DEST = join(__dirname, "www");

function copyRecursive(src, dest) {
  if (statSync(src).isDirectory()) {
    if (!existsSync(dest)) mkdirSync(dest, { recursive: true });
    for (const entry of readdirSync(src)) {
      copyRecursive(join(src, entry), join(dest, entry));
    }
  } else {
    copyFileSync(src, dest);
  }
}

// Only the actual web assets -- not the PowerShell/bat launchers, the
// cloudflared binary, or tunnel logs, none of which belong in an app bundle.
const INCLUDE = ["index.html", "manifest.json", "icon-192.png", "icon-512.png", "lib"];

if (existsSync(DEST)) rmSync(DEST, { recursive: true, force: true });
mkdirSync(DEST, { recursive: true });

for (const name of INCLUDE) {
  const srcPath = join(SRC, name);
  if (!existsSync(srcPath)) { console.warn(`skip (not found): ${name}`); continue; }
  copyRecursive(srcPath, join(DEST, name));
}

console.log(`Synced server/ -> www/ (${INCLUDE.join(", ")})`);
