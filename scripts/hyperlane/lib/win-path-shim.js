// Node preload shim for running the Hyperlane CLI on WINDOWS.
//
// Hyperlane's FileSystemRegistry lists files with `path.join` (backslashes on Windows) and then
// matches them against regexes written with forward slashes (`chains\/<name>\/metadata.yaml`), so a
// local registry directory is silently EMPTY on Windows and every command fails with
// "No chain metadata set for <chain>" (reproduced with CLI 44.0.2 on 2026-09-27).
//
// Windows accepts forward slashes in every fs call, so making `path.join` return forward slashes
// is enough to fix the listing without touching the CLI. Loaded with `node --require` by
// scripts/hyperlane/lib/hl.ts; never used on Linux (the server) where the CLI runs natively.
"use strict";
const path = require("path");
if (process.platform === "win32") {
  const origJoin = path.join.bind(path);
  const fwd = (p) => (typeof p === "string" ? p.replace(/\\/g, "/") : p);
  path.join = (...parts) => fwd(origJoin(...parts));
  path.win32.join = path.join;
}
