import { HardhatUserConfig, vars } from "hardhat/config";
import "@nomicfoundation/hardhat-toolbox";
import "@nomicfoundation/hardhat-web3-v4";
import '@openzeppelin/hardhat-upgrades';
import "@nomicfoundation/hardhat-verify";
import "hardhat-contract-sizer";

const config: HardhatUserConfig = {
  solidity: {
    compilers: [
      {
        version: "0.8.24",
        settings: {
          optimizer: {
            enabled: true,
            runs: 200,
          },
          viaIR: true,
          evmVersion: "shanghai",
          outputSelection: {
            "*": {
              "*": ["storageLayout"],
            },
          },
        },
      },
    ],
    overrides: {
      "contracts/rewards/RewardsProgram.sol": {
        version: "0.8.24",
        settings: {
          optimizer: {
            enabled: true,
            runs: 1,
          },
          viaIR: true,
          evmVersion: "shanghai",
          outputSelection: {
            "*": {
              "*": ["storageLayout"],
            },
          },
        },
      },
      "contracts/rewards/RewardsExtension.sol": {
        version: "0.8.24",
        settings: {
          optimizer: {
            enabled: true,
            runs: 1,
          },
          viaIR: true,
          evmVersion: "shanghai",
        },
      },
      "contracts/rewards/RewardsStorageBase.sol": {
        version: "0.8.24",
        settings: {
          optimizer: {
            enabled: true,
            runs: 1,
          },
          viaIR: true,
          evmVersion: "shanghai",
        },
      },
      // CommunityVoting inherits the full GovernanceModule multisig (~14 KiB before any of its
      // own logic), so it needs the same size-over-speed trade the rewards contracts make.
      // `outputSelection` must stay: CommunityVotingLayout.test.ts reads solc's storageLayout.
      "contracts/core/CommunityVoting.sol": {
        version: "0.8.24",
        settings: {
          optimizer: {
            enabled: true,
            runs: 1,
          },
          viaIR: true,
          evmVersion: "shanghai",
          outputSelection: {
            "*": {
              "*": ["storageLayout"],
            },
          },
        },
      },
      "contracts/core/FulaFileNFT.sol": {
        version: "0.8.24",
        settings: {
          optimizer: {
            enabled: true,
            runs: 25,
          },
          viaIR: true,
          evmVersion: "shanghai",
          outputSelection: {
            "*": {
              "*": ["storageLayout"],
            },
          },
        },
      },
      // NOTE: there is deliberately NO override for contracts/core/StorageToken.sol.
      // One existed briefly (runs: 100) while the bridge was implemented as mint/burn INSIDE the
      // token, which pushed it to ~23.95 KiB against the 24 KiB EIP-170 cap. The bridge is now a
      // lock/release escrow adapter that requires no token change at all, so StorageToken is back
      // to its deployed form (~22 KiB) and compiles at the default `runs: 200` like everything
      // else. Do not re-add an override without a size measurement that justifies it.
      // RewardEngine: lower runs to keep deployed bytecode under the EIP-170
      // 24KB cap after wiring per-peer storage rewards + per-month cap. Reward-
      // claim path is user-triggered (not high-frequency), so the runtime-gas
      // tradeoff is acceptable. Same pattern as RewardsProgram / RewardsExtension above.
      "contracts/core/RewardEngine.sol": {
        version: "0.8.24",
        settings: {
          optimizer: {
            enabled: true,
            runs: 1,
          },
          viaIR: true,
          evmVersion: "shanghai",
          outputSelection: {
            "*": {
              "*": ["storageLayout"],
            },
          },
        },
      },
    },
  },
  // DISABLED: Sourcify's API v1 is in a scheduled brownout until 2027-01-08 and returns 503 on
  // every request, which made `hardhat verify` exit non-zero and print "found one or more errors
  // during the verification process" even when Etherscan verification had SUCCEEDED. A step that
  // always fails trains you to ignore verification output, which is exactly when a real failure
  // slips through. Re-enable once hardhat-verify supports Sourcify API v2.
  sourcify: {
    enabled: false,
  },
  networks: {
    // Mainnets
    ethereum: {
      // ETHEREUM_RPC overrides everything. Without it this falls back to Alchemy, and if
      // ALCHEMY_KEY is unset the URL degrades to ".../v2/" and every call fails with
      // "Must be authenticated!" — which looks like a script bug but is purely RPC config.
      // Note an Alchemy key also has to have ETH mainnet ENABLED for the app, or it 403s with
      // "ETH_MAINNET is not enabled for this app" even when the key is correct.
      url:
        process.env.ETHEREUM_RPC?.trim() ||
        `https://eth-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_KEY || ""}`,
      accounts: (() => {
        const accounts = [];
        if (vars.has("PK")) accounts.push(vars.get("PK"));
        if (vars.has("ADMIN_PK")) accounts.push(vars.get("ADMIN_PK"));
        return accounts;
      })(),
      chainId: 1,
      gasPrice: "auto",
      // Uncomment if you need higher gas limits (adjust as needed)
      // gas: 2100000,
    },
    // Keyless, READ-ONLY Ethereum mainnet endpoint. The `ethereum` entry above requires
    // ALCHEMY_KEY; without it the URL is malformed and every call fails. This mirrors the
    // existing `base-alt` / `base-alt2` pattern so read-only gates (Phase 0 bytecode parity,
    // `checkProxyStorage.ts`, `verifyStorageTokenImplParity.ts`) can run with no secrets.
    //
    // `accounts` is DELIBERATELY EMPTY: this network cannot sign or send a transaction, so it
    // is safe to point verification scripts at mainnet. Use `ethereum` for anything that writes.
    "ethereum-alt": {
      url: "https://ethereum-rpc.publicnode.com",
      accounts: [],
      chainId: 1,
      gasPrice: "auto",
      timeout: 60000,
    },
    base: {
      url: "https://mainnet.base.org",
      accounts: (() => {
        const accounts = [];
        if (vars.has("PK")) accounts.push(vars.get("PK"));
        if (vars.has("ADMIN_PK")) accounts.push(vars.get("ADMIN_PK"));
        return accounts;
      })(),
      chainId: 8453,
      gasPrice: "auto",
      timeout: 60000,
      // Base can sometimes need higher gas estimates
      // gas: 3000000,
    },
    "base-alt": {
      url: "https://base.blockpi.network/v1/rpc/public",
      accounts: vars.has("PK") ? [vars.get("PK")] : [],
      chainId: 8453,
      gasPrice: "auto",
      timeout: 60000,
    },
    "base-alt2": {
      url: "https://base.llamarpc.com",
      accounts: vars.has("PK") ? [vars.get("PK")] : [],
      chainId: 8453,
      gasPrice: "auto",
      timeout: 60000,
    },
    "iotex-mainnet": {
      url: "https://babel-api.mainnet.iotex.io",
      accounts: vars.has("PK") ? [vars.get("PK")] : [],
      chainId: 4689,
      gasPrice: "auto",
    },
    skale: {
      url: "https://mainnet.skalenodes.com/v1/elated-tan-skat",
      accounts: (() => {
        const accounts = [];
        if (vars.has("PK")) accounts.push(vars.get("PK"));
        if (vars.has("ADMIN_PK")) accounts.push(vars.get("ADMIN_PK"));
        return accounts;
      })(),
      chainId: 2046399126,
    },

    // Testnets
    // TESTNETS USE DEDICATED THROWAWAY KEYS ONLY — never PK / ADMIN_PK.
    //
    // WHY: the production `PK` is `0x383a6A34...`, which is a LIVE ADMIN_ROLE HOLDER on the
    // mainnet FULA token. Wiring it into testnet entries means one mistyped `--network` could
    // sign a mainnet transaction with an admin key. `PK_TEST` / `ADMIN_PK_TEST` are freshly
    // generated wallets with no authority anywhere.
    //
    // TWO signers are required, not one: StorageToken governance needs an ADMIN_ROLE quorum of 2,
    // and `createProposal` auto-approves for its proposer, so a proposal can only reach quorum if
    // a DIFFERENT admin calls `approveProposal`. With a single key, NO governance action can ever
    // execute — including authorizing a bridge minter.
    //
    // Set them with:  npx hardhat vars set PK_TEST   /   npx hardhat vars set ADMIN_PK_TEST
    sepolia: {
      url: "https://ethereum-sepolia.publicnode.com",
      accounts: (() => {
        const accounts: string[] = [];
        if (vars.has("PK_TEST")) accounts.push(vars.get("PK_TEST"));
        if (vars.has("ADMIN_PK_TEST")) accounts.push(vars.get("ADMIN_PK_TEST"));
        return accounts;
      })(),
      chainId: 11155111,
    },
    "base-sepolia": {
      // `https://sepolia.base.org` serves STALE state immediately after a deployment: a contract
      // that was just created reads back as `0x` for several seconds, which makes post-deploy
      // verification spuriously fail (observed twice on 2026-07-26 — the deploys had in fact
      // succeeded). publicnode is consistent; override with BASE_SEPOLIA_RPC if needed.
      url: process.env.BASE_SEPOLIA_RPC || "https://base-sepolia-rpc.publicnode.com",
      accounts: (() => {
        const accounts: string[] = [];
        if (vars.has("PK_TEST")) accounts.push(vars.get("PK_TEST"));
        if (vars.has("ADMIN_PK_TEST")) accounts.push(vars.get("ADMIN_PK_TEST"));
        return accounts;
      })(),
      chainId: 84532,
    },
    amoy: {
      url: "https://polygon-amoy-bor-rpc.publicnode.com",
      accounts: vars.has("PK") ? [vars.get("PK")] : [],
      chainId: 80002,
    },
    "iotex-testnet": {
      url: "https://babel-api.testnet.iotex.io",
      accounts: vars.has("PK") ? [vars.get("PK")] : [],
      chainId: 4690,
    },
    // SKALE Base Sepolia — SKALE's current testnet (same skaled software and gas model as Europa:
    // fixed 100000 wei gas price, EIP-1559 fields present, contract deployment open, CREDIT gas
    // token from https://base-sepolia-faucet.skale.space). Replaces the retired Europa Hub testnet
    // (juicy-low-small-testnet), whose hostname no longer resolves (checked 2026-09-27). Used for
    // the Hyperlane Base<->SKALE bridge rehearsal (scripts/hyperlane). TESTNET KEYS ONLY.
    "skale-base-sepolia": {
      url: "https://base-sepolia-testnet.skalenodes.com/v1/jubilant-horrible-ancha",
      accounts: (() => {
        const accounts: string[] = [];
        if (vars.has("PK_TEST")) accounts.push(vars.get("PK_TEST"));
        if (vars.has("ADMIN_PK_TEST")) accounts.push(vars.get("ADMIN_PK_TEST"));
        return accounts;
      })(),
      chainId: 324705682,
      gasPrice: 100000,
    },
    "sfi-testnet": {
      url: "https://rpc-testnet.singularityfinance.ai",
      accounts: vars.has("PK") ? [vars.get("PK")] : [],
      chainId: 751,
    },
    hardhat: {
      allowUnlimitedContractSize: true,
      // Mainnet forking for upgrade rehearsals and fork tests.
      // Enable by setting FORK_RPC_URL (and optionally FORK_BLOCK for a pinned, reproducible run):
      //   FORK_RPC_URL=https://eth-mainnet.g.alchemy.com/v2/$ALCHEMY_KEY npx hardhat test test/fork/...
      // Leave unset for normal local runs.
      ...(process.env.FORK_RPC_URL
        ? {
            forking: {
              url: process.env.FORK_RPC_URL,
              ...(process.env.FORK_BLOCK
                ? { blockNumber: Number(process.env.FORK_BLOCK) }
                : {}),
            },
            // Hardhat ships a hardfork-activation history only for chains it knows (mainnet,
            // sepolia, ...). Forking any other chain fails in `before all` with:
            //   "No known hardfork for execution on historical block N ... in chain with id X.
            //    The node was not configured with a hardfork activation history."
            // Declaring the history here is what makes `FORK_TARGET=base` actually runnable.
            // All of these chains are past Cancun, so activating it at genesis is correct for
            // any block we would realistically fork.
            chains: {
              8453: { hardforkHistory: { cancun: 0 } }, // Base
              2046399126: { hardforkHistory: { cancun: 0 } }, // SKALE Europa
              4689: { hardforkHistory: { cancun: 0 } }, // IoTeX
              84532: { hardforkHistory: { cancun: 0 } }, // Base Sepolia
            },
          }
        : {}),
    },
    localhost: {
      url: "http://127.0.0.1:8545",
      chainId: 31337,
    },
  },
  etherscan: {
    apiKey: process.env.ETHERSCAN_API_KEY || "",
     //Activate for skale and iotex verify  and deactivate for base and ethereum verification
    /*apiKey: {
      mainnet: vars.has("ETHERSCAN_API_KEY")
        ? vars.get("ETHERSCAN_API_KEY")
        : "",
      sepolia: vars.has("ETHERSCAN_API_KEY")
        ? vars.get("ETHERSCAN_API_KEY")
        : "",
      base: vars.has("BASESCAN_API_KEY") ? vars.get("BASESCAN_API_KEY") : "",
      "base-sepolia": vars.has("BASESCAN_API_KEY")
        ? vars.get("BASESCAN_API_KEY")
        : "",
      "iotex-mainnet": vars.has("IOTEXSCAN_API_KEY")
        ? vars.get("IOTEXSCAN_API_KEY")
        : "arbitrary",
      "skale": 'empty',
      "iotex-testnet": vars.has("IOTEXSCAN_API_KEY")
        ? vars.get("IOTEXSCAN_API_KEY")
        : "arbitrary",
      "skale-base-sepolia": "empty",
    },*/
    customChains: [
      {
        network: "base",
        chainId: 8453,
        urls: {
          apiURL: "https://api.basescan.org/api",
          browserURL: "https://basescan.org",
        },
      },
      {
        network: "base-sepolia",
        chainId: 84532,
        urls: {
          apiURL: "https://api-sepolia.basescan.org/api",
          browserURL: "https://sepolia.basescan.org",
        },
      },
      {
        network: "iotex-mainnet",
        chainId: 4689,
        urls: {
          apiURL: "https://iotexscout.io/api",
          browserURL: "https://iotexscan.io",
        },
      },
      {
        network: "skale",
        chainId: 2046399126,
        urls: {
          apiURL: "https://internal-hubs.explorer.mainnet.skalenodes.com:10021/api",
          browserURL: "https://internal-hubs.explorer.mainnet.skalenodes.com",
        },
      },
      {
        network: "skale-base-sepolia",
        chainId: 324705682,
        urls: {
          apiURL: "https://base-sepolia-testnet-explorer.skalenodes.com/api",
          browserURL: "https://base-sepolia-testnet-explorer.skalenodes.com",
        },
      },
    ],
    
  },
  mocha: {
    timeout: 40000,
  },
  gasReporter: {
    enabled: process.env.REPORT_GAS !== undefined,
    currency: "USD",
    excludeContracts: ["contracts/mocks/"],
  },
  contractSizer: {
    alphaSort: true,
    runOnCompile: true,
    disambiguatePaths: false,
    strict: true,
  },
};

export default config;
