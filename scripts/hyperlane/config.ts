// Single source of truth for the Hyperlane Base <-> SKALE FULA bridge.
//
// WHY HYPERLANE, WHY THESE CHAINS: see docs/bridge-hyperlane-skale.md. In one line: LayerZero marks
// SKALE deprecated with a single live DVN, SKALE's IMA needs a mint/burn token, and Hyperlane is
// permissionless — but it has NOTHING deployed on SKALE, so we deploy the core ourselves and run one
// validator + one relayer on the owner's single server. Base (not Ethereum) is the other end because
// the relayer pays destination gas out of pocket and Base holds most of the FULA supply.
//
// Everything a script needs is here: chain metadata (mirrored in registry/chains/*/metadata.yaml),
// token/owner addresses, the warp route ids, the per-stage limits and the security stack shape.
// Scripts read this file and render the Hyperlane CLI's YAML from it; nothing is typed twice.
import { ethers } from "ethers";

const F = (n: number | string) => ethers.parseEther(String(n));

/** One end of the bridge. `name` is the Hyperlane registry chain name (lower-case, no dashes). */
export interface HlChain {
  /** Hyperlane registry chain name. */
  name: string;
  /** Hardhat network name in hardhat.config.ts. */
  hardhatNetwork: string;
  chainId: number;
  /** Hyperlane domain id. We use the chain id (fits uint32 for all four chains). */
  domainId: number;
  isTestnet: boolean;
  /** true = SKALE chain: free/fixed gas, no Hyperlane infra, we deploy the core ourselves. */
  skale: boolean;
  rpc: string;
  explorer: string;
  /** FULA token (StorageToken proxy) on this chain. */
  token: string;
  /** Owner of the router, its ISMs and (on SKALE) the core contracts. */
  owner: string;
  /** Owner kind, for the runbooks and the DRY_RUN calldata path. */
  ownerKind: "safe" | "eoa";
  /**
   * Hyperlane's public validator set for messages ORIGINATING on this chain (from the SDK's
   * defaultMultisigConfigs, read out of CLI 44.0.2 on 2026-09-27). Present only for registry
   * chains; SKALE origins are attested by OUR validator (see `validatorFor`).
   */
  publicValidators?: { threshold: number; validators: { address: string; alias: string }[] };
  /**
   * Registry core addresses for chains Hyperlane already runs (from `hyperlane registry addresses
   * --chain <name>`, 2026-09-27). For SKALE chains these are read from
   * registry/chains/<name>/addresses.yaml after `deployCore.ts` has run.
   */
  core?: CoreAddresses;
}

export interface CoreAddresses {
  mailbox: string;
  merkleTreeHook: string;
  validatorAnnounce: string;
  interchainGasPaymaster: string;
  staticAggregationIsmFactory: string;
  staticMessageIdMultisigIsmFactory: string;
  proxyAdmin?: string;
}

export const CHAINS: Record<string, HlChain> = {
  // ---------------------------------------------------------------- mainnet
  base: {
    name: "base",
    hardhatNetwork: "base",
    chainId: 8453,
    domainId: 8453,
    isTestnet: false,
    skale: false,
    rpc: "https://mainnet.base.org",
    explorer: "https://basescan.org",
    token: "0x9e12735d77c72c5C3670636D428f2F3815d8A4cB",
    // The 2-of-2 Safe (v1.4.1) that already owns the LayerZero escrow on Base.
    owner: "0x3167688A46c01CF23d7969cdBf2D9147c9767341",
    ownerKind: "safe",
    publicValidators: {
      threshold: 3,
      validators: [
        { address: "0xb9453d675e0fa3c178a17b4ce1ad5b1a279b3af9", alias: "Abacus Works" },
        { address: "0x5450447aee7b544c462c9352bef7cad049b0c2dc", alias: "Zee Prime" },
        { address: "0xb8cf45d7bab79c965843206d5f4d83bb866d6e86", alias: "Substance Labs" },
        { address: "0xe957310e17730f29862e896709cce62d24e4b773", alias: "Luganodes" },
        { address: "0x34a14934d7c18a21440b59dfe9bf132ce601457d", alias: "Enigma" },
      ],
    },
    core: {
      mailbox: "0xeA87ae93Fa0019a82A727bfd3eBd1cFCa8f64f1D",
      merkleTreeHook: "0x19dc38aeae620380430C200a6E990D5Af5480117",
      validatorAnnounce: "0x182E8d7c5F1B06201b102123FC7dF0EaeB445a7B",
      interchainGasPaymaster: "0xc3F23848Ed2e04C0c6d41bd7804fa8f89F940B94",
      staticAggregationIsmFactory: "0xEb9FcFDC9EfDC17c1EC5E1dc085B98485da213D6",
      staticMessageIdMultisigIsmFactory: "0x8F7454AC98228f3504Bb91eA3D8Adafe6406110A",
    },
  },
  skaleeuropa: {
    name: "skaleeuropa",
    hardhatNetwork: "skale",
    chainId: 2046399126,
    domainId: 2046399126,
    isTestnet: false,
    skale: true,
    rpc: "https://mainnet.skalenodes.com/v1/elated-tan-skat",
    explorer: "https://elated-tan-skat.explorer.mainnet.skalenodes.com",
    token: "0x9e12735d77c72c5C3670636D428f2F3815d8A4cB",
    // No Safe contracts exist on SKALE Europa (checked 2026-09-26). Owner decision: the admin EOA,
    // with the mailbox and router ProxyAdmins burned after final configuration (burnProxyAdmins.ts).
    owner: "0xFa8b02596a84F3b81B4144eA2F30482f8C33D446",
    ownerKind: "eoa",
  },
  // ---------------------------------------------------------------- testnets
  basesepolia: {
    name: "basesepolia",
    hardhatNetwork: "base-sepolia",
    chainId: 84532,
    domainId: 84532,
    isTestnet: true,
    skale: false,
    rpc: "https://base-sepolia-rpc.publicnode.com",
    explorer: "https://sepolia.basescan.org",
    // Testnet StorageToken proxy from the LayerZero rehearsal (scripts/bridge/testnet-deployments.md).
    token: "0x32d6929c9F552068D54481FeAe75674fD29F337e",
    owner: "0x694451c22627eff3Dd8C2D7002197e69FC687e7C", // PK_TEST
    ownerKind: "eoa",
    publicValidators: {
      threshold: 1,
      validators: [{ address: "0x82e3b437a2944e3ff00258c93e72cd1ba5e0e921", alias: "Abacus Works" }],
    },
    core: {
      mailbox: "0x6966b0E55883d49BFB24539356a2f8A673E02039",
      merkleTreeHook: "0x86fb9F1c124fB20ff130C41a79a432F770f67AFD",
      validatorAnnounce: "0x20c44b1E3BeaDA1e9826CFd48BeEDABeE9871cE9",
      interchainGasPaymaster: "0x28B02B97a850872C4D33C3E024fab6499ad96564",
      staticAggregationIsmFactory: "0x275aCcCa81cAD931dC6fB6E49ED233Bc99Bed4A7",
      staticMessageIdMultisigIsmFactory: "0xfc6e546510dC9d76057F1f76633FCFfC188CB213",
    },
  },
  skalebasesepolia: {
    name: "skalebasesepolia",
    hardhatNetwork: "skale-base-sepolia",
    chainId: 324705682,
    domainId: 324705682,
    isTestnet: true,
    skale: true,
    rpc: "https://base-sepolia-testnet.skalenodes.com/v1/jubilant-horrible-ancha",
    explorer: "https://base-sepolia-testnet-explorer.skalenodes.com",
    // Filled in by scripts/hyperlane/testnet/deployTestnetToken run (see README); placeholder until then.
    token: process.env.SKALE_TESTNET_TOKEN?.trim() || "0x0000000000000000000000000000000000000000",
    owner: "0x694451c22627eff3Dd8C2D7002197e69FC687e7C", // PK_TEST
    ownerKind: "eoa",
  },
};

/** The two lanes. `routeId` is the Hyperlane warp route id (registry path deployments/warp_routes/<id>-deploy.yaml). */
export const LANES = {
  mainnet: { base: "base", skale: "skaleeuropa", routeId: "FULA/base-skaleeuropa" },
  testnet: { base: "basesepolia", skale: "skalebasesepolia", routeId: "FULA/basesepolia-skalebasesepolia" },
} as const;

export type LaneName = keyof typeof LANES;

/**
 * Limits per stage. `inboundCapPerDay` is the RateLimitedIsm bucket on the RECEIVING router: the
 * most a forged or runaway stream of releases can take out of that escrow in 24h. `seed` is the
 * escrow liquidity moved in from the token contract. Stage 2 only after 7 clean days of stage 1.
 */
export const STAGES: Record<number, { seed: bigint; inboundCapPerDay: bigint }> = {
  1: { seed: F(1_000_000), inboundCapPerDay: F(100_000) },
  2: { seed: F(5_000_000), inboundCapPerDay: F(500_000) },
};
/** Testnet: tiny numbers so cap exhaustion is cheap to exercise. */
export const TESTNET_STAGE = { seed: F(50_000), inboundCapPerDay: F(1_000) };

/** RateLimitedIsm refill window (seconds). Immutable on-chain. */
export const RATE_LIMIT_DURATION = 86_400;

/**
 * OUR validator address per lane (the key lives on the server; install.sh prints it). The Base-side
 * router's ISM embeds it, so it must be known before `deployWarp.ts` runs on mainnet.
 * Override with HL_VALIDATOR=0x... . The testnet default is the throwaway generated 2026-09-27.
 */
export function validatorFor(lane: LaneName): string {
  const env = process.env.HL_VALIDATOR?.trim();
  if (env) return ethers.getAddress(env);
  if (lane === "testnet") return "0xEdCACFcD3F51c9BCd41a77D354c3e55EaBE96B05";
  throw new Error("HL_VALIDATOR not set. Run server/install.sh first and pass the validator address it prints.");
}

/** The relayer address per lane — only needed for the SKALE core's placeholder default ISM and the runbooks. */
export function relayerFor(lane: LaneName): string {
  const env = process.env.HL_RELAYER?.trim();
  if (env) return ethers.getAddress(env);
  if (lane === "testnet") return "0x6E674Fa4b05c0CB364beF8B28bb070210360c572";
  throw new Error("HL_RELAYER not set. Run server/install.sh first and pass the relayer address it prints.");
}

export function laneOf(network: string): { lane: LaneName; local: HlChain; remote: HlChain } {
  for (const lane of Object.keys(LANES) as LaneName[]) {
    const l = LANES[lane];
    const a = CHAINS[l.base], b = CHAINS[l.skale];
    if (a.hardhatNetwork === network) return { lane, local: a, remote: b };
    if (b.hardhatNetwork === network) return { lane, local: b, remote: a };
  }
  throw new Error(`Hardhat network "${network}" is not part of any Hyperlane lane (see scripts/hyperlane/config.ts)`);
}

export function chainByName(name: string): HlChain {
  const c = CHAINS[name];
  if (!c) throw new Error(`Unknown Hyperlane chain "${name}"`);
  return c;
}
