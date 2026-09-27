// Standalone build of the Hyperlane contracts the FULA Base<->SKALE bridge deploys, compiled for the
// SHANGHAI EVM.
//
// WHY THIS EXISTS: SKALE chains run skaled 5.2, which supports Shanghai (PUSH0) but NOT Cancun
// (MCOPY, TSTORE/TLOAD) and not BASEFEE (probed on Europa and SKALE Base Sepolia, 2026-09-27).
// @hyperlane-xyz/core ships bytecode compiled with solc 0.8.33 for `cancun`, and the Hyperlane CLI
// deploys that bytecode — its first proxy creation on a SKALE chain burns the whole gas limit on an
// invalid opcode. So we recompile the same sources, same solc, same optimizer, `evmVersion: shanghai`,
// and deploy them with our own scripts (scripts/hyperlane/deployCore.ts, deployWarp.ts).
//
// Pinned: @hyperlane-xyz/core 12.1.0, OpenZeppelin 4.9.3 (what core 12.x is written against).
// `yarn build` compiles and exports ABI+bytecode to ../artifacts-shanghai/. Commit the export.
require("hardhat/config");

module.exports = {
  solidity: {
    version: "0.8.33",
    settings: {
      optimizer: { enabled: true, runs: 3599 }, // same as the CLI's build artifact
      evmVersion: "shanghai",
      metadata: { bytecodeHash: "ipfs" },
    },
  },
  paths: { sources: "./contracts", artifacts: "./artifacts", cache: "./cache" },
};
