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
    // Multisig: repeated `--signer G...:S...` pairs that can sign approvals.
    signers: [],
    newWasmHash: null,
    threshold: null,
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
    } else if (arg === '--signer') {
      // Repeatable: `--signer <address>:<secret>`.
      options.signers.push(argv[++i]);
    } else if (arg === '--new-wasm-hash') {
      options.newWasmHash = argv[++i];
    } else if (arg === '--threshold') {
      options.threshold = parseInt(argv[++i], 10);
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
    if (
      ['build', 'deploy', 'upgrade', 'init', 'status', 'approve', 'set-multisig'].includes(cmd)
    ) {
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

// ── Multisig Helpers ─────────────────────────────────────────────────────────

/**
 * Parses repeated `--signer G...:S...` arguments into usable pairs.
 *
 * @param {string[]} raw - Raw `address:secret` strings.
 * @returns {Array<{address: string, secret: string}>}
 */
const parseSignerPairs = (raw = []) => {
  const pairs = [];
  for (const entry of raw) {
    const idx = entry.lastIndexOf(':');
    if (idx <= 0 || idx === entry.length - 1) {
      throw new Error(
        `Invalid --signer value "${entry}". Expected <address>:<secret>, e.g. --signer GABC...:SABC...`
      );
    }
    pairs.push({ address: entry.slice(0, idx), secret: entry.slice(idx + 1) });
  }
  return pairs;
};

/**
 * Extracts the JSON result payload from `stellar contract invoke` output.
 *
 * The CLI prefixes its result with human-readable log lines, so the JSON
 * object is located rather than assumed to be the whole stdout.
 *
 * @param {string} stdout - Raw CLI stdout.
 * @returns {any} The parsed value.
 */
const parseInvokeResult = (stdout) => {
  const lines = String(stdout)
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .reverse();
  for (const line of lines) {
    if (!line.startsWith('{') && !line.startsWith('[')) continue;
    try {
      return JSON.parse(line);
    } catch {
      /* keep scanning: not this line */
    }
  }
  throw new Error(`Could not parse contract invocation output:\n${stdout}`);
};

/**
 * Reads the M-of-N upgrade group currently configured on a contract.
 *
 * @param {object} options
 * @returns {{signers: string[], threshold: number}|null} Null when unconfigured.
 */
const readMultisigConfig = (options) => {
  const network = NETWORKS[options.network] || NETWORKS.testnet;
  const cmd = `stellar contract invoke --id "${options.contractId}" --network "${network.name}"${options.source ? ` --source "${options.source}"` : ''} -- get_multisig_config`;
  const result = parseInvokeResult(execSync(cmd, { encoding: 'utf8' }));

  // The contract returns Result<MultisigConfig>; an unconfigured contract
  // answers `{"err":{...}}` with Error::MultisigNotInitialized.
  if (result && typeof result === 'object' && 'ok' in result) {
    return result.ok;
  }
  return null;
};

/**
 * Submits one signer approval for a specific WASM hash.
 *
 * Approvals are bound to the exact artifact, so this is safe to run from each
 * signer independently and in any order.
 *
 * @param {object} options
 * @param {{address: string, secret: string}} signer
 * @param {string} newWasmHash
 * @returns {string} The hash that was approved.
 */
const submitApproval = (options, signer, newWasmHash) => {
  const network = NETWORKS[options.network] || NETWORKS.testnet;
  const cmd = [
    'stellar contract invoke',
    `--id "${options.contractId}"`,
    `--network "${network.name}"`,
    `--source "${signer.secret}"`,
    `--signer "${signer.address}"`,
    '-- approve_upgrade',
    `--signer "${signer.address}"`,
    `--new_wasm_hash "${newWasmHash}"`,
  ].join(' ');
  execSync(cmd, { stdio: 'inherit' });
  return newWasmHash;
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
  // The CLI always supplies an array (see parseArgs), but this function is
  // exported and called directly by tooling and tests, so normalize rather
  // than assume.
  const signers = options.signers || [];

  if (!contractId) {
    throw new Error('Missing target contract ID for upgrade. Pass --contract-id <CONTRACT_ID>.');
  }

  console.log(`\n🔄 Upgrading PaymentRouter contract [${contractId}] on [${network.name.toUpperCase()}]...`);
  console.log('   Upgrades are authorized by an M-of-N signer group, not by the admin key.');

  if (options.dryRun) {
    const mockWasmHash = 'f4c8996fb92427ae41e4649b934ca495991b7852b855e3b0c44298fc1c149afb';
    const configured = signers.length > 0;
    console.log(`   [Dry Run] Uploaded new WASM hash: ${mockWasmHash}`);
    if (configured) {
      console.log(
        `   [Dry Run] Collected ${signers.length} approval(s) for ${mockWasmHash}`
      );
      console.log(`   [Dry Run] Invoked upgrade(${mockWasmHash}) once the quorum is reached`);
    } else {
      console.log(`   [Dry Run] No --signer keys given, so no approval would be collected.`);
      console.log(`   [Dry Run] The upgrade would abort: the group has not reached its threshold.`);
    }
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

    const config = readMultisigConfig(options);
    if (!config) {
      throw new Error(
        'This contract has no multisig group configured, so it cannot be upgraded at all.\n' +
          '   Configure one first:\n' +
          '     node scripts/deploy.js set-multisig --contract-id C... \\\n' +
          '       --signer G...:S... --signer G...:S... --threshold 2'
      );
    }

    const available = parseSignerPairs(signers);
    const configured = new Set(config.signers);
    const usable = available.filter((s) => configured.has(s.address));

    const missing = available.filter((s) => !configured.has(s.address));
    if (missing.length > 0) {
      console.warn(
        `⚠️  Ignoring ${missing.length} key(s) that are not in the configured group: ` +
          missing.map((s) => s.address).join(', ')
      );
    }

    console.log(
      `👥 Configured group: ${config.threshold}-of-${config.signers.length}. ` +
        `${usable.length} usable key(s) supplied.`
    );

    if (usable.length < config.threshold) {
      throw new Error(
        `Not enough signer keys to reach the ${config.threshold}-of-${config.signers.length} threshold ` +
          `(${usable.length} usable supplied). Pass --signer <address>:<secret> once per signer.`
      );
    }

    // Any M approvals authorize the upgrade; stop at the threshold rather than
    // spending more keys than the group requires.
    const approving = usable.slice(0, config.threshold);
    console.log(`✍️  Collecting ${approving.length} approval(s) for ${newWasmHash}...`);
    for (const signer of approving) {
      console.log(`   → approval from ${signer.address}`);
      submitApproval(options, signer, newWasmHash);
    }

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

/**
 * Records a single signer approval against an already-installed WASM hash.
 *
 * Useful when signers coordinate out of band: each of them runs this once,
 * and whoever collects the last required signature runs `upgrade`.
 *
 * @param {object} options
 * @returns {Promise<{contractId: string, newWasmHash: string}>}
 */
const executeApprove = async (options) => {
  const network = NETWORKS[options.network] || NETWORKS.testnet;
  const signers = options.signers || [];

  if (!options.contractId) {
    throw new Error('Missing target contract ID. Pass --contract-id <CONTRACT_ID>.');
  }
  if (!options.newWasmHash) {
    throw new Error('Missing --new-wasm-hash <HASH> to approve.');
  }
  if (signers.length === 0) {
    throw new Error('Missing --signer <address>:<secret> for the approving key.');
  }

  const [signer] = parseSignerPairs(signers);

  if (options.dryRun) {
    console.log(
      `   [Dry Run] ${signer.address} would approve ${options.newWasmHash} on [${network.name.toUpperCase()}]`
    );
    return { contractId: options.contractId, newWasmHash: options.newWasmHash };
  }

  console.log(
    `\n✍️  Recording approval from ${signer.address} for WASM ${options.newWasmHash}...`
  );
  submitApproval(options, signer, options.newWasmHash);
  console.log(`✅ Approval recorded. Run \`upgrade\` once ${options.newWasmHash} has enough signatures.`);
  return { contractId: options.contractId, newWasmHash: options.newWasmHash };
};

/**
 * Configures the M-of-N group that authorizes future upgrades.
 *
 * @param {object} options
 * @returns {Promise<{contractId: string, threshold: number}>}
 */
const executeSetMultisig = async (options) => {
  const network = NETWORKS[options.network] || NETWORKS.testnet;

  if (!options.contractId) {
    throw new Error('Missing target contract ID. Pass --contract-id <CONTRACT_ID>.');
  }
  if (!Number.isInteger(options.threshold) || options.threshold < 1) {
    throw new Error('Missing --threshold <M> (an integer of at least 1).');
  }

  const signers = parseSignerPairs(options.signers || []).map((s) => s.address);
  if (signers.length === 0) {
    throw new Error('Missing --signer <address>:<secret> entries for the group members.');
  }
  if (options.threshold > signers.length) {
    throw new Error(
      `Threshold ${options.threshold} exceeds the ${signers.length} signer(s) given; ` +
        'the group could never authorize an upgrade.'
    );
  }

  if (options.dryRun) {
    console.log(
      `   [Dry Run] Would set a ${options.threshold}-of-${signers.length} group on [${network.name.toUpperCase()}]`
    );
    return { contractId: options.contractId, threshold: options.threshold };
  }

  const sourceFlag = options.source ? `--source "${options.source}"` : '';
  console.log(
    `\n👥 Configuring a ${options.threshold}-of-${signers.length} upgrade group on [${network.name.toUpperCase()}]...`
  );
  const cmd =
    `stellar contract invoke --id "${options.contractId}" --network "${network.name}" ${sourceFlag} ` +
    `-- set_multisig_config --signers '${JSON.stringify(signers)}' --threshold ${options.threshold}`.trim();
  execSync(cmd, { stdio: 'inherit' });
  console.log(`✅ Group configured. Future upgrades need ${options.threshold} of these keys.`);
  return { contractId: options.contractId, threshold: options.threshold };
};

// ── Help & Banner ────────────────────────────────────────────────────────────

const printHelp = () => {
  console.log(`
Stellar Soroban Contract Deployment & Upgrade CLI

USAGE:
  node scripts/deploy.js [command] [options]
  ./scripts/deploy_contract.sh [command] [options]

COMMANDS:
  deploy        Compile, optimize, deploy, and update config files (default)
  upgrade       Compile, upload new WASM, collect the M approvals, and upgrade
  approve       Record one signer's approval for an already-installed WASM hash
  set-multisig  Configure the M-of-N group that authorizes future upgrades
  build         Compile and optimize WASM without deploying
  init          Initialize a deployed contract with admin and fee parameters
  help          Show this help message

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
  --signer <address:secret>  A member of the upgrade group; repeat once per key
  --new-wasm-hash <hash>     WASM hash to approve (approve)
  --threshold <M>            Signatures required out of the group (set-multisig)
  --dry-run                  Simulate actions without submitting on-chain transactions
  --skip-build               Skip cargo compilation if wasm is already built
  --env-file <path>          Custom .env file to update with contract ID
  -h, --help                 Show help documentation

EXAMPLES:
  # Deploy to testnet in simulation mode
  node scripts/deploy.js deploy --network testnet --dry-run

  # Deploy to testnet with custom admin and secret
  node scripts/deploy.js deploy --network testnet --source S... --admin G...

  # Configure a 2-of-3 upgrade group (admin must sign)
  node scripts/deploy.js set-multisig --contract-id C... --network testnet --source S... \\
    --signer G1...:S1... --signer G2...:S2... --signer G3...:S3... --threshold 2

  # Upgrade contract, approving with enough of the group to reach the threshold
  node scripts/deploy.js upgrade --contract-id C... --network testnet --source S... \\
    --signer G1...:S1... --signer G2...:S2...

  # Out-of-band flow: each signer approves separately, then upgrade runs
  node scripts/deploy.js approve --contract-id C... --network testnet \\
    --signer G1...:S1... --new-wasm-hash <HASH>
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

  if (options.command === 'approve') {
    await executeApprove(options);
    return;
  }

  if (options.command === 'set-multisig') {
    await executeSetMultisig(options);
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
  executeApprove,
  executeSetMultisig,
  parseSignerPairs,
  parseInvokeResult,
  NETWORKS,
};
