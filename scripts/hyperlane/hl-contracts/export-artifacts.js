// Exports ABI + bytecode of the compiled Hyperlane contracts to ../artifacts-shanghai/<Name>.json,
// plus SOURCES.md (versions, compiler settings, sha256 of each bytecode) so the build is auditable
// and reproducible. Run via `yarn build` / `npm run build` in this directory.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const WANT = [
  "Mailbox", "ProxyAdmin", "TransparentUpgradeableProxy", "ValidatorAnnounce",
  "MerkleTreeHook", "ProtocolFee",
  "TrustedRelayerIsm", "PausableIsm", "RateLimitedIsm",
  "StaticAggregationIsmFactory", "StaticAggregationIsm",
  "StaticMessageIdMultisigIsmFactory", "StaticMessageIdMultisigIsm",
  "HypERC20Collateral", "TestRecipient",
];

const artifactsDir = path.join(__dirname, "artifacts");
const outDir = path.join(__dirname, "..", "artifacts-shanghai");
fs.mkdirSync(outDir, { recursive: true });

function findArtifact(name) {
  const hits = [];
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name === `${name}.json`) hits.push(p);
    }
  })(artifactsDir);
  if (hits.length !== 1) throw new Error(`expected exactly one artifact for ${name}, found ${hits.length}: ${hits.join(", ")}`);
  return JSON.parse(fs.readFileSync(hits[0], "utf8"));
}

const corePkg = JSON.parse(fs.readFileSync(path.join(__dirname, "node_modules", "@hyperlane-xyz", "core", "package.json"), "utf8"));
const ozPkg = JSON.parse(fs.readFileSync(path.join(__dirname, "node_modules", "@openzeppelin", "contracts", "package.json"), "utf8"));
const cfg = require("./hardhat.config.js");
const rows = [];
for (const name of WANT) {
  const a = findArtifact(name);
  if (!a.bytecode || a.bytecode === "0x") throw new Error(`${name} has no bytecode (abstract?)`);
  const out = { contractName: a.contractName, sourceName: a.sourceName, abi: a.abi, bytecode: a.bytecode, deployedBytecode: a.deployedBytecode, linkReferences: a.linkReferences };
  fs.writeFileSync(path.join(outDir, `${name}.json`), JSON.stringify(out));
  const sha = crypto.createHash("sha256").update(a.bytecode).digest("hex");
  rows.push(`| ${name} | ${a.sourceName} | ${(a.bytecode.length - 2) / 2} | ${sha.slice(0, 16)}... |`);
}
const md = `# artifacts-shanghai

Hyperlane contracts compiled for the **Shanghai** EVM (skaled 5.2 has no Cancun opcodes and no BASEFEE).

- @hyperlane-xyz/core **${corePkg.version}**, @openzeppelin/contracts **${ozPkg.version}**
- solc **${cfg.solidity.version}**, optimizer ${cfg.solidity.settings.optimizer.enabled ? "on" : "off"} runs ${cfg.solidity.settings.optimizer.runs}, evmVersion **${cfg.solidity.settings.evmVersion}**
- built ${new Date().toISOString()} by scripts/hyperlane/hl-contracts (\`npm run build\`)

| contract | source | bytecode bytes | sha256(bytecode) |
|---|---|---|---|
${rows.join("\n")}

Rebuild and diff this table after any dependency bump. The deploy scripts refuse artifacts whose
evmVersion is not shanghai (see scripts/hyperlane/lib/artifacts.ts).
`;
fs.writeFileSync(path.join(outDir, "SOURCES.md"), md);
fs.writeFileSync(path.join(outDir, "build-info.json"), JSON.stringify({ core: corePkg.version, openzeppelin: ozPkg.version, solc: cfg.solidity.version, evmVersion: cfg.solidity.settings.evmVersion, optimizer: cfg.solidity.settings.optimizer, builtAt: new Date().toISOString(), contracts: WANT }, null, 2));
console.log(`exported ${WANT.length} artifacts to ${outDir}`);

