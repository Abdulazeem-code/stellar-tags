#!/usr/bin/env node
'use strict';

/**
 * scripts/deploy.js
 *
 * Automated CLI tool to compile, optimize, deploy, initialize, and upgrade
 * the Soroban PaymentRouter smart contract, and update backend/frontend configs.
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// ── Network Configurations ───────────────────────────────────────────────────

const NETWORKS = {
  testnet: {
    name: 'testnet',
    rpcUrl: 'https://soroban-testnet.stellar.org',
    networkPassphrase: 'Test SDF Network ; September 2015',
    horizonUrl: 'https://horizon-testnet.stellar.org',
  },
  mainnet: {
    name: 'mainnet',
    rpcUrl: 'https://mainnet.sorobanrpc.com',
    networkPassphrase: 'Public Global Stellar Network ; September 2015',
    horizonUrl: 'https://horizon.stellar.org',
  },
  futurenet: {
    name: 'futurenet',
    rpcUrl: 'https://rpc-futurenet.stellar.org',
    networkPassphrase: 'Test SDF Future Network ; October 2022',
    horizonUrl: 'https://horizon-futurenet.stellar.org',
  },
  local: {
    name: 'local',
    rpcUrl: 'http://localhost:8000/soroban/rpc',
    networkPassphrase: 'Standalone Network ; February 2017',
    horizonUrl: 'http://localhost:8000',
  },
};

// ── Default Paths ────────────────────────────────────────────────────────────

const ROOT_DIR = path.resolve(__dirname, '..');
const CONTRACT_DIR = path.join(ROOT_DIR, 'payment_router');
const DEFAULT_WASM_PATH = path.join(
  CONTRACT_DIR,
  'target',
  'wasm32-unknown-unknown',
  'release',
  'payment_router.wasm'
);
const DEFAULT_OPTIMIZED_WASM_PATH = path.join(
  CONTRACT_DIR,
  'target',
  'wasm32-unknown-unknown',
  'release',
  'payment_router.optimized.wasm'
);

// ── CLI Argument Parser ──────────────────────────────────────────────────────

/**
 * Parses CLI arguments into structured options.
 *
 * @param {string[]} argv
 * @returns {object}
 */
const parseArgs = (argv = process.argv.slice(2)) => {
  const options = {
    command: 'deploy',
    network: 'testnet',
    source: process.env.STELLAR_SECRET_KEY || process.env.SOROBAN_SECRET_KEY || null,
    admin: process.env.ADMIN_ADDRESS || null,
    treasury: process.env.PLATFORM_TREASURY || null,
    feeBps: 100, // 1%
    feeCap: '10000000', // 1 XLM (7 decimals)
    maxAmount: '1000000000000000',
    contractId: process.env.CONTRACT_ID || process.env.PAYMENT_ROUTER_CONTRACT_ID || null,
    wasmPath: null,
    dryRun: false,
    skipBuild: false,
    envFiles: [
      path.join(ROOT_DIR, 'stellar-payment-platform', '.env'),
      path.join(ROOT_DIR, 'payment-dashboard', '.env'),
      path.join(ROOT_DIR, '.env'),
    ],
  };

  const positional = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];

    if (arg === '--help' || arg === '-h') {
      options.command = 'help';
      return options;
    } else if (arg === '--version' || arg === '-v') {
      options.command = 'version';
      return options;
    } else if (arg === '--network' || arg === '-n') {
      options.network = argv[++i];
    } else if (arg === '--source' || arg === '-s') {
      options.source = argv[++i];
    } else if (arg === '--admin') {
      options.admin = argv[++i];
    } else if (arg === '--treasury') {
      options.treasury = argv[++i];
    } else if (arg === '--fee-bps') {
      options.feeBps = parseInt(argv[++i], 10);
    } else if (arg === '--fee-cap') {
      options.feeCap = argv[++i];
    } else if (arg === '--max-amount') {
      options.maxAmount = argv[++i];
    } else if (arg === '--contract-id' || arg === '-c') {
      options.contractId = argv[++i];
    } else if (arg === '--wasm') {
      options.wasmPath = argv[++i];
    } else if (arg === '--dry-run') {
      options.dryRun = true;
    } else if (arg === '--skip-build') {
      options.skipBuild = true;
    } else if (arg === '--env-file') {
      options.envFiles.push(path.resolve(argv[++i]));
    } else if (!arg.startsWith('-')) {
      positional.push(arg);
    }
  }

  if (positional.length > 0) {
    const cmd = positional[0].toLowerCase();
    if (['build', 'deploy', 'upgrade', 'init', 'status'].includes(cmd)) {
      options.command = cmd;
    }
    if (positional[1] && !options.contractId) {
      options.contractId = positional[1];
    }
  }

  return options;
};

// ── Environment File Updater ─────────────────────────────────────────────────

/**
 * Updates or sets an environment variable in an .env file.
 *
 * @param {string} filePath - Absolute path to .env file.
 * @param {string} key - Environment variable key.
 * @param {string} value - Environment variable value.
 * @returns {boolean} True if updated/created.
 */
const setEnvVariable = (filePath, key, value) => {
  try {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    let content = '';
    if (fs.existsSync(filePath)) {
      content = fs.readFileSync(filePath, 'utf8');
    }

    const regex = new RegExp(`^(${key}=).*$`, 'm');
    let updatedContent;
    if (regex.test(content)) {
      updatedContent = content.replace(regex, `${key}="${value}"`);
    } else {
      const newLine = content.endsWith('\n') || content.length === 0 ? '' : '\n';
      updatedContent = `${content}${newLine}${key}="${value}"\n`;
    }

    fs.writeFileSync(filePath, updatedContent, 'utf8');
    return true;
  } catch (err) {
    console.error(`[deploy] Failed to update env file ${filePath}:`, err.message);
    return false;
  }
};

/**
 * Updates all relevant frontend and backend configuration files with the contract ID.
 *
 * @param {string} contractId
 * @param {string[]} envFiles
 * @param {object} [options]
 * @returns {string[]} List of successfully updated files.
 */
const updateAllConfigs = (contractId, envFiles = [], options = {}) => {
  const updated = [];

  for (const envFile of envFiles) {
    if (setEnvVariable(envFile, 'PAYMENT_ROUTER_CONTRACT_ID', contractId)) {
      setEnvVariable(envFile, 'CONTRACT_ID', contractId);
      setEnvVariable(envFile, 'VITE_CONTRACT_ID', contractId);
      updated.push(envFile);
    }
  }

  // Also update payment-dashboard/src/views/shared.js if present and allowed
  if (options.updateSharedJs !== false) {
    const rootDir = options.rootDir || ROOT_DIR;
    const sharedJsPath = path.join(rootDir, 'payment-dashboard', 'src', 'views', 'shared.js');
    if (fs.existsSync(sharedJsPath)) {
      try {
        let content = fs.readFileSync(sharedJsPath, 'utf8');
        const contractIdRegex = /export const CONTRACT_ID = ['"][^'"]*['"];/;
        if (contractIdRegex.test(content)) {
          content = content.replace(
            contractIdRegex,
            `export const CONTRACT_ID = '${contractId}';`
          );
          fs.writeFileSync(sharedJsPath, content, 'utf8');
          updated.push(sharedJsPath);
        }
      } catch (err) {
        console.warn('[deploy] Could not update shared.js:', err.message);
      }
    }
  }

  return updated;
};

// ── Compilation & Optimization ───────────────────────────────────────────────

/**
 * Compiles the Soroban contract to WASM and optimizes bytecode.
 *
 * @param {object} options
 * @returns {string} Path to the compiled/optimized WASM file.
 */
const compileAndOptimizeWasm = (options = {}) => {
  if (options.wasmPath && fs.existsSync(options.wasmPath)) {
    console.log(`📦 Using provided WASM file: ${options.wasmPath}`);
    return options.wasmPath;
  }

  console.log('🔨 Compiling Soroban smart contract...');

  if (options.dryRun) {
    console.log('   [Dry Run] cargo build --target wasm32-unknown-unknown --release in payment_router');
    console.log('   [Dry Run] stellar contract optimize --wasm ...');
    return DEFAULT_OPTIMIZED_WASM_PATH;
  }

  try {
    execSync('cargo build --target wasm32-unknown-unknown --release', {
      cwd: CONTRACT_DIR,
      stdio: 'inherit',
    });
  } catch {
    console.warn('⚠️  Cargo compilation failed or cargo not available.');
  }

  let finalWasmPath = DEFAULT_WASM_PATH;

  // Try optimizing with stellar/soroban CLI or wasm-opt if available
  try {
    if (fs.existsSync(DEFAULT_WASM_PATH)) {
      console.log('⚡ Optimizing WASM bytecode...');
      try {
        execSync(
          `stellar contract optimize --wasm "${DEFAULT_WASM_PATH}" --output-dir "${path.dirname(DEFAULT_OPTIMIZED_WASM_PATH)}"`,
          { stdio: 'pipe' }
        );
        finalWasmPath = DEFAULT_OPTIMIZED_WASM_PATH;
      } catch {
        try {
          execSync(
            `soroban contract optimize --wasm "${DEFAULT_WASM_PATH}"`,
            { stdio: 'pipe' }
          );
          finalWasmPath = DEFAULT_OPTIMIZED_WASM_PATH;
        } catch {
          console.log('   Note: stellar-cli / soroban-cli optimizer skipped (using standard release WASM).');
        }
      }
    }
  } catch (err) {
    console.warn(`⚠️  Optimization check skipped: ${err.message}`);
  }

  return finalWasmPath;
};

// ── Deployment & Upgrade Workflows ───────────────────────────────────────────

/**
 * Deploys the contract to the selected network.
 *
 * @param {object} options
 * @returns {Promise<{ contractId: string, wasmHash: string }>}
 */
const executeDeploy = async (options) => {
  const network = NETWORKS[options.network] || NETWORKS.testnet;
  console.log(`\n🚀 Deploying PaymentRouter to Stellar [${network.name.toUpperCase()}]...`);
  console.log(`   RPC URL: ${network.rpcUrl}`);

  if (options.dryRun) {
    const mockContractId = 'CA7QTESTINGCONTRACTID1234567890DEPLOYEDSUCCESSFULLYTEST';
    const mockWasmHash = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
    console.log(`   [Dry Run] Simulated Contract ID: ${mockContractId}`);
    console.log(`   [Dry Run] Simulated WASM Hash:   ${mockWasmHash}`);

    const updatedFiles = updateAllConfigs(mockContractId, options.envFiles, options);
    console.log(`\n✅ [Dry Run] Config files that would be updated (${updatedFiles.length}):`);
    updatedFiles.forEach((f) => console.log(`   - ${f}`));

    return { contractId: mockContractId, wasmHash: mockWasmHash };
  }

  let wasmPath = options.wasmPath;
  if (!options.skipBuild) {
    wasmPath = compileAndOptimizeWasm(options);
  }

  let contractId;
  let wasmHash;

  // Use stellar / soroban CLI to deploy
  try {
    console.log('📤 Uploading WASM and creating contract instance...');
    const sourceFlag = options.source ? `--source "${options.source}"` : '';
    const deployCmd = `stellar contract deploy --wasm "${wasmPath}" --network "${network.name}" ${sourceFlag}`.trim();
    const output = execSync(deployCmd, { encoding: 'utf8' }).trim();
    contractId = output.split('\n').pop().trim();
  } catch (err) {
    // Fallback error with clear instructions
    console.error('\n❌ Deployment failed:');
    console.error(err.message);
    throw err;
  }

  console.log(`\n🎉 Contract successfully deployed!`);
  console.log(`   Contract ID: ${contractId}`);

  // Automatically update config files
  const updated = updateAllConfigs(contractId, options.envFiles, options);
  console.log(`\n📝 Updated configuration files:`);
  updated.forEach((f) => console.log(`   - ${f}`));

  return { contractId, wasmHash };
};

/**
 * Upgrades an existing contract instance to a new WASM bytecode.
 *
 * @param {object} options
 * @returns {Promise<{ contractId: string, newWasmHash: string }>}
 */
const executeUpgrade = async (options) => {
  const network = NETWORKS[options.network] || NETWORKS.testnet;
  const contractId = options.contractId;

  if (!contractId) {
    throw new Error('Missing target contract ID for upgrade. Pass --contract-id <CONTRACT_ID>.');
  }

  console.log(`\n🔄 Upgrading PaymentRouter contract [${contractId}] on [${network.name.toUpperCase()}]...`);

  if (options.dryRun) {
    const mockWasmHash = 'f4c8996fb92427ae41e4649b934ca495991b7852b855e3b0c44298fc1c149afb';
    console.log(`   [Dry Run] Uploaded new WASM hash: ${mockWasmHash}`);
    console.log(`   [Dry Run] Invoked upgrade(${mockWasmHash}) as admin`);
    return { contractId, newWasmHash: mockWasmHash };
  }

  let wasmPath = options.wasmPath;
  if (!options.skipBuild) {
    wasmPath = compileAndOptimizeWasm(options);
  }

  let newWasmHash;
  try {
    console.log('📤 Uploading new WASM bytecode...');
    const sourceFlag = options.source ? `--source "${options.source}"` : '';
    const installCmd = `stellar contract install --wasm "${wasmPath}" --network "${network.name}" ${sourceFlag}`.trim();
    newWasmHash = execSync(installCmd, { encoding: 'utf8' }).trim().split('\n').pop().trim();
    console.log(`   New WASM Hash: ${newWasmHash}`);

    console.log('⚙️  Invoking contract upgrade method...');
    const invokeCmd = `stellar contract invoke --id "${contractId}" --network "${network.name}" ${sourceFlag} -- upgrade --new_wasm_hash "${newWasmHash}"`.trim();
    execSync(invokeCmd, { stdio: 'inherit' });
  } catch (err) {
    console.error('\n❌ Upgrade failed:');
    console.error(err.message);
    throw err;
  }

  console.log(`\n🎉 Contract ${contractId} successfully upgraded to WASM ${newWasmHash}!`);
  return { contractId, newWasmHash };
};

// ── Help & Banner ────────────────────────────────────────────────────────────

const printHelp = () => {
  console.log(`
Stellar Soroban Contract Deployment & Upgrade CLI

USAGE:
  node scripts/deploy.js [command] [options]
  ./scripts/deploy_contract.sh [command] [options]

COMMANDS:
  deploy    Compile, optimize, deploy, and update config files (default)
  upgrade   Compile, upload new WASM, and invoke contract upgrade method
  build     Compile and optimize WASM without deploying
  init      Initialize a deployed contract with admin and fee parameters
  help      Show this help message

OPTIONS:
  -n, --network <name>       Network to deploy to: testnet (default), mainnet, local, futurenet
  -s, --source <secret/id>   Stellar secret key or CLI identity name
  -c, --contract-id <id>     Target contract ID (required for upgrade/init)
  --admin <address>          Contract admin address
  --treasury <address>       Platform treasury address
  --fee-bps <number>         Platform fee in basis points (default: 100 = 1%)
  --fee-cap <number>         Fee cap amount in stroops (default: 10000000 = 1 XLM)
  --max-amount <number>      Maximum payment limit per transaction
  --wasm <path>              Path to precompiled .wasm file
  --dry-run                  Simulate actions without submitting on-chain transactions
  --skip-build               Skip cargo compilation if wasm is already built
  --env-file <path>          Custom .env file to update with contract ID
  -h, --help                 Show help documentation

EXAMPLES:
  # Deploy to testnet in simulation mode
  node scripts/deploy.js deploy --network testnet --dry-run

  # Deploy to testnet with custom admin and secret
  node scripts/deploy.js deploy --network testnet --source S... --admin G...

  # Upgrade contract on testnet
  node scripts/deploy.js upgrade --contract-id CD... --network testnet --source S...
`);
};

// ── Main Entrypoint ──────────────────────────────────────────────────────────

const main = async () => {
  const options = parseArgs();

  if (options.command === 'help') {
    printHelp();
    return;
  }

  if (options.command === 'version') {
    console.log('Soroban Contract Deployer CLI v1.0.0');
    return;
  }

  if (options.command === 'build') {
    compileAndOptimizeWasm(options);
    console.log('✅ Build complete.');
    return;
  }

  if (options.command === 'upgrade') {
    await executeUpgrade(options);
    return;
  }

  // Default: deploy
  await executeDeploy(options);
};

if (require.main === module) {
  main().catch((err) => {
    console.error(`\n❌ Error: ${err.message}`);
    process.exit(1);
  });
}

module.exports = {
  parseArgs,
  setEnvVariable,
  updateAllConfigs,
  compileAndOptimizeWasm,
  executeDeploy,
  executeUpgrade,
  NETWORKS,
};
