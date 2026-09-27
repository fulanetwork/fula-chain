// Shared helpers for the Hyperlane scripts: locating and running the Hyperlane CLI, the local
// registry layout, YAML/JSON file IO, deployment records and RPC-lag-tolerant reads.
import { spawnSync, execSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import * as yaml from "js-yaml";
import { vars } from "hardhat/config";
import { ethers } from "ethers";
import type { CoreAddresses, HlChain } from "../config";

export const HL_DIR = path.resolve(__dirname, "..");
export const REGISTRY_DIR = path.join(HL_DIR, "registry");
export const DEPLOYMENTS_DIR = path.resolve(HL_DIR, "..", "..", "deployments");
export const GITHUB_REGISTRY = "https://github.com/hyperlane-xyz/hyperlane-registry";

/** Pinned so a registry-side schema change cannot silently alter what these scripts deploy. */
export const CLI_VERSION = "44.0.2";

// ---------------------------------------------------------------- CLI

/**
 * WINDOWS: Hyperlane's FileSystemRegistry lists files with `path.join` (backslashes on Windows) and
 * then matches them against regexes written with forward slashes (`chains\/([a-z0-9]+)\/...`), so a
 * local registry is silently EMPTY on Windows and every command fails with "No chain metadata set
 * for <chain>" (reproduced with CLI 44.0.2, 2026-09-27). Two ways around it, both handled here:
 *   default  — run the CLI natively with the preload shim lib/win-path-shim.js (`node --require`),
 *              which makes `path.join` return forward slashes (Windows fs accepts them).
 *   HL_WSL=1 — run the CLI inside WSL (Ubuntu with Node 22 + the pinned CLI on PATH), translating
 *              paths to /mnt/<drive>/... ; the key travels via WSLENV, never via argv.
 * On Linux/macOS (the server) the CLI runs natively with no shim.
 */
const useWsl = process.platform === "win32" && process.env.HL_WSL?.trim() === "1";
const useShim = process.platform === "win32" && !useWsl;
const SHIM = path.join(__dirname, "win-path-shim.js");

/** Path to the CLI's JS entry for the shim mode (spawned as `node --require shim <entry>`). */
function cliEntry(): string {
  const env = process.env.HYPERLANE_CLI?.trim();
  if (env) return env;
  let root = "";
  try { root = execSync("npm root -g", { encoding: "utf8" }).trim(); } catch { /* fall through */ }
  const pkg = path.join(root, "@hyperlane-xyz", "cli", "package.json");
  if (!root || !fs.existsSync(pkg)) throw new Error(`Hyperlane CLI not installed globally. Run: npm i -g @hyperlane-xyz/cli@${CLI_VERSION} (or set HYPERLANE_CLI=<path to bundle/index.js>)`);
  const meta = JSON.parse(fs.readFileSync(pkg, "utf8"));
  if (meta.version !== CLI_VERSION) throw new Error(`Hyperlane CLI ${meta.version} found, these scripts are pinned to ${CLI_VERSION}. Run: npm i -g @hyperlane-xyz/cli@${CLI_VERSION}`);
  const bin = typeof meta.bin === "string" ? meta.bin : meta.bin?.hyperlane;
  return path.join(root, "@hyperlane-xyz", "cli", bin);
}

/** `E:\a\b` -> `/mnt/e/a/b` (what WSL mounts the drive as). */
export function toWslPath(p: string): string {
  const abs = path.resolve(p);
  const m = abs.match(/^([A-Za-z]):[\\/](.*)$/);
  if (!m) return abs.replace(/\\/g, "/");
  return `/mnt/${m[1].toLowerCase()}/${m[2].replace(/\\/g, "/")}`;
}

/** Path of the local registry as the CLI process sees it (forward slashes in shim mode). */
export function registryDirForCli(): string {
  return useWsl ? toWslPath(REGISTRY_DIR) : REGISTRY_DIR.replace(/\\/g, "/");
}

/** A local file path as the CLI process sees it. */
export function cliPath(p: string): string {
  return useWsl ? toWslPath(p) : path.resolve(p).replace(/\\/g, "/");
}

/** Verify the pinned CLI is installed where it will run. */
export function checkCli(): void {
  if (useShim) { cliEntry(); return; }
  const cmd = useWsl ? ["wsl.exe", ["-e", "bash", "-lc", "hyperlane --version 2>/dev/null | tail -1"]] as const : ["hyperlane", ["--version"]] as const;
  const res = spawnSync(cmd[0], [...cmd[1]], { encoding: "utf8" });
  const version = (res.stdout ?? "").trim().split("\n").pop()?.trim();
  if (res.status !== 0 || !version) {
    throw new Error(
      useWsl
        ? `Hyperlane CLI not found inside WSL. In an Ubuntu WSL shell run: npm i -g @hyperlane-xyz/cli@${CLI_VERSION}`
        : `Hyperlane CLI not found on PATH. Run: npm i -g @hyperlane-xyz/cli@${CLI_VERSION}`
    );
  }
  if (version !== CLI_VERSION) {
    throw new Error(`Hyperlane CLI ${version} found, these scripts are pinned to ${CLI_VERSION}. Run: npm i -g @hyperlane-xyz/cli@${CLI_VERSION}`);
  }
}

/** Registry arguments: GitHub first (base/basesepolia metadata), ours last (takes priority, receives writes). */
export function registryArgs(): string[] {
  return ["-r", GITHUB_REGISTRY, "-r", registryDirForCli()];
}

export interface RunOpts {
  /** Private key for HYP_KEY. Omit for read-only commands. */
  key?: string;
  /** Working directory (the CLI writes ./configs and ./generated relative to it). */
  cwd?: string;
  /** Extra environment. */
  env?: Record<string, string>;
  /** Print the command (with the key redacted) before running. Default true. */
  echo?: boolean;
}

/**
 * Run the Hyperlane CLI non-interactively (`-y`) and return stdout. Throws with the tail of the
 * output on a non-zero exit. The key is passed ONLY via the environment, never as an argument.
 */
export function runCli(args: string[], opts: RunOpts = {}): string {
  checkCli();
  const full = [...args, ...registryArgs(), "-y", "--log", "pretty"];
  if (opts.echo !== false) console.log(`\n$ hyperlane ${args.join(" ")}  (registry: github + ${path.relative(process.cwd(), REGISTRY_DIR)}${useWsl ? ", via WSL" : ""})`);
  const env: NodeJS.ProcessEnv = { ...process.env, ...(opts.env ?? {}) };
  if (opts.key) env.HYP_KEY = opts.key;
  else delete env.HYP_KEY;
  const cwd = opts.cwd ?? HL_DIR;
  let res;
  if (useWsl) {
    // Forward HYP_KEY (and any extra env) into the WSL process through WSLENV — not argv.
    const forwarded = ["HYP_KEY", ...Object.keys(opts.env ?? {})].filter((k) => env[k] !== undefined);
    env.WSLENV = [process.env.WSLENV, ...forwarded].filter(Boolean).join(":");
    res = spawnSync("wsl.exe", ["--cd", toWslPath(cwd), "-e", "hyperlane", ...full], { env, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  } else if (useShim) {
    res = spawnSync(process.execPath, ["--require", SHIM, cliEntry(), ...full], { cwd, env, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  } else {
    res = spawnSync("hyperlane", full, { cwd, env, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  }
  const out = (res.stdout ?? "") + (res.stderr ?? "");
  if (res.status !== 0) {
    const tail = out.split("\n").slice(-60).join("\n");
    throw new Error(`hyperlane ${args[0]} ${args[1] ?? ""} failed (exit ${res.status}):\n${tail}`);
  }
  return out;
}

// ---------------------------------------------------------------- keys

/** The signing key for a chain: PK_TEST on testnets, PK on mainnets (both from `hardhat vars`). */
export function signingKeyFor(chain: HlChain): string {
  const name = chain.isTestnet ? "PK_TEST" : "PK";
  if (!vars.has(name)) throw new Error(`hardhat var ${name} is not set (npx hardhat vars set ${name})`);
  const k = vars.get(name);
  return k.startsWith("0x") ? k : `0x${k}`;
}

// ---------------------------------------------------------------- registry files

export function chainDir(name: string): string {
  return path.join(REGISTRY_DIR, "chains", name);
}

export function readYaml<T = any>(file: string): T {
  return yaml.load(fs.readFileSync(file, "utf8")) as T;
}

export function writeYaml(file: string, data: unknown, header?: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const body = yaml.dump(data, { lineWidth: 120, noRefs: true, quotingType: '"' });
  fs.writeFileSync(file, (header ? header.trimEnd() + "\n" : "") + body);
}

/** Core addresses of a chain: from config for registry chains, from our registry for SKALE chains. */
export function coreAddresses(chain: HlChain): CoreAddresses & { all: Record<string, string> } {
  const file = path.join(chainDir(chain.name), "addresses.yaml");
  if (fs.existsSync(file)) {
    const all = readYaml<Record<string, string>>(file);
    for (const k of ["mailbox", "merkleTreeHook", "validatorAnnounce", "interchainGasPaymaster", "staticAggregationIsmFactory", "staticMessageIdMultisigIsmFactory"]) {
      if (!all[k]) throw new Error(`${file} is missing ${k}`);
    }
    return { ...(all as unknown as CoreAddresses), all };
  }
  if (chain.core) return { ...chain.core, all: { ...chain.core } };
  throw new Error(`No core addresses for ${chain.name}: run deployCore.ts --network ${chain.hardhatNetwork} first`);
}

/** Wallet for a chain from the hardhat vars key (PK_TEST on testnets, PK on mainnets; HL_<NAME>_KEY overrides). */
export function walletFor(chain: HlChain): ethers.Wallet {
  const override = process.env[`HL_${chain.name.toUpperCase()}_KEY`]?.trim();
  const key = override ? (override.startsWith("0x") ? override : `0x${override}`) : signingKeyFor(chain);
  return new ethers.Wallet(key, new ethers.JsonRpcProvider(chain.rpc, undefined, { staticNetwork: true }));
}

export function warpDeployConfigPath(routeId: string): string {
  return path.join(REGISTRY_DIR, "deployments", "warp_routes", `${routeId}-deploy.yaml`);
}

export function warpCoreConfigPath(routeId: string): string {
  return path.join(REGISTRY_DIR, "deployments", "warp_routes", `${routeId}-config.yaml`);
}

/** Router addresses per chain name from the CLI-written warp core config (after deployWarp.ts). */
export function routers(routeId: string): Record<string, string> {
  const file = warpCoreConfigPath(routeId);
  if (!fs.existsSync(file)) throw new Error(`No warp core config at ${file}: run deployWarp.ts first`);
  const cfg = readYaml<{ tokens: { chainName: string; addressOrDenom: string }[] }>(file);
  const out: Record<string, string> = {};
  for (const t of cfg.tokens) out[t.chainName] = t.addressOrDenom;
  return out;
}

// ---------------------------------------------------------------- records

/** Write deployments/<Name>_<net>_<ts>.json, like the other deploy scripts. Returns the path. */
export function writeRecord(name: string, network: string, record: unknown): string {
  fs.mkdirSync(DEPLOYMENTS_DIR, { recursive: true });
  const file = path.join(DEPLOYMENTS_DIR, `${name}_${network}_${Date.now()}.json`);
  fs.writeFileSync(file, JSON.stringify(record, null, 2));
  return file;
}

// ---------------------------------------------------------------- misc

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Retry a read: public RPCs serve stale state for several seconds after a transaction. */
export async function retryRead<T>(label: string, fn: () => Promise<T>, attempts = 12, delayMs = 5000): Promise<T> {
  let last: any;
  for (let i = 1; i <= attempts; i++) {
    try {
      return await fn();
    } catch (e: any) {
      last = e;
      console.log(`  ${label}: attempt ${i}/${attempts} failed (${e.shortMessage ?? e.message}); retrying in ${delayMs / 1000}s`);
      await sleep(delayMs);
    }
  }
  throw last;
}

export const fmt = (x: bigint) => Number(x / 10n ** 14n) / 10_000;
export const fmtFula = (x: bigint) => fmt(x).toLocaleString("en-US", { maximumFractionDigits: 4 });

export function dryRun(): boolean {
  // TRIM: `set DRY_RUN=1 && ...` on Windows leaves a trailing space (see scripts/bridge/wireOApp.ts).
  return process.env.DRY_RUN?.trim() === "1";
}

export function deployFlag(): boolean {
  return process.env.DEPLOY?.trim() === "1";
}
