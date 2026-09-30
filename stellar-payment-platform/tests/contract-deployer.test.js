'use strict';

/**
 * tests/contract-deployer.test.js
 *
 * Tests for Soroban Contract Deployment & Upgrade CLI Tool (issue #525).
 */

const fs = require('fs');
const path = require('path');
const {
  parseArgs,
  setEnvVariable,
  updateAllConfigs,
  compileAndOptimizeWasm,
  executeDeploy,
  executeUpgrade,
  NETWORKS,
} = require('../../scripts/deploy');

describe('Soroban Contract Deployer CLI', () => {
  const tmpDir = path.join(__dirname, '..', 'scratch', 'deployer-test');
  const tmpEnvFile = path.join(tmpDir, '.env');
  const tmpSharedJs = path.join(tmpDir, 'shared.js');

  beforeAll(() => {
    if (!fs.existsSync(tmpDir)) {
      fs.mkdirSync(tmpDir, { recursive: true });
    }
  });

  afterAll(() => {
    if (fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  describe('parseArgs', () => {
    it('parses default options correctly', () => {
      const options = parseArgs([]);
      expect(options.command).toBe('deploy');
      expect(options.network).toBe('testnet');
      expect(options.dryRun).toBe(false);
      expect(options.feeBps).toBe(100);
      expect(options.feeCap).toBe('10000000');
    });

    it('parses custom flags and subcommands', () => {
      const argv = [
        'upgrade',
        '--network', 'mainnet',
        '--source', 'SSECRET123',
        '--admin', 'GADMIN123',
        '--treasury', 'GTREASURY123',
        '--fee-bps', '250',
        '--fee-cap', '5000000',
        '--contract-id', 'CCONTRACT123',
        '--dry-run',
        '--skip-build',
      ];
      const options = parseArgs(argv);

      expect(options.command).toBe('upgrade');
      expect(options.network).toBe('mainnet');
      expect(options.source).toBe('SSECRET123');
      expect(options.admin).toBe('GADMIN123');
      expect(options.treasury).toBe('GTREASURY123');
      expect(options.feeBps).toBe(250);
      expect(options.feeCap).toBe('5000000');
      expect(options.contractId).toBe('CCONTRACT123');
      expect(options.dryRun).toBe(true);
      expect(options.skipBuild).toBe(true);
    });

    it('parses help and version commands', () => {
      expect(parseArgs(['--help']).command).toBe('help');
      expect(parseArgs(['-h']).command).toBe('help');
      expect(parseArgs(['--version']).command).toBe('version');
    });
  });

  describe('setEnvVariable', () => {
    it('creates a new .env file and sets key=value', () => {
      if (fs.existsSync(tmpEnvFile)) fs.unlinkSync(tmpEnvFile);

      const success = setEnvVariable(tmpEnvFile, 'CONTRACT_ID', 'CDTEST123');
      expect(success).toBe(true);

      const content = fs.readFileSync(tmpEnvFile, 'utf8');
      expect(content).toContain('CONTRACT_ID="CDTEST123"');
    });

    it('updates existing key without deleting other variables', () => {
      fs.writeFileSync(
        tmpEnvFile,
        'PORT=5000\nCONTRACT_ID="OLD_ID"\nDATABASE_URL="postgres://..."\n',
        'utf8'
      );

      const success = setEnvVariable(tmpEnvFile, 'CONTRACT_ID', 'NEW_ID');
      expect(success).toBe(true);

      const content = fs.readFileSync(tmpEnvFile, 'utf8');
      expect(content).toContain('PORT=5000');
      expect(content).toContain('CONTRACT_ID="NEW_ID"');
      expect(content).toContain('DATABASE_URL="postgres://..."');
      expect(content).not.toContain('OLD_ID');
    });
  });

  describe('updateAllConfigs', () => {
    it('updates multiple env files and shared.js if present', () => {
      const env1 = path.join(tmpDir, '.env.platform');
      const env2 = path.join(tmpDir, '.env.dashboard');
      fs.writeFileSync(env1, 'PORT=5000\n', 'utf8');
      fs.writeFileSync(env2, 'VITE_API_BASE=http://localhost:5000\n', 'utf8');

      // Create a mock shared.js in tmpDir
      const mockViewsDir = path.join(tmpDir, 'payment-dashboard', 'src', 'views');
      fs.mkdirSync(mockViewsDir, { recursive: true });
      const mockShared = path.join(mockViewsDir, 'shared.js');
      fs.writeFileSync(mockShared, "export const CONTRACT_ID = 'OLD_CONTRACT_ID';", 'utf8');

      const updated = updateAllConfigs('CNEWCONTRACTID789', [env1, env2], { rootDir: tmpDir });

      expect(updated).toContain(env1);
      expect(updated).toContain(env2);
      expect(updated).toContain(mockShared);

      const content1 = fs.readFileSync(env1, 'utf8');
      const content2 = fs.readFileSync(env2, 'utf8');
      const contentShared = fs.readFileSync(mockShared, 'utf8');

      expect(content1).toContain('PAYMENT_ROUTER_CONTRACT_ID="CNEWCONTRACTID789"');
      expect(content2).toContain('PAYMENT_ROUTER_CONTRACT_ID="CNEWCONTRACTID789"');
      expect(content2).toContain('VITE_CONTRACT_ID="CNEWCONTRACTID789"');
      expect(contentShared).toContain("export const CONTRACT_ID = 'CNEWCONTRACTID789';");
    });
  });

  describe('compileAndOptimizeWasm (dry-run)', () => {
    it('returns default path in dry-run mode', () => {
      const wasmPath = compileAndOptimizeWasm({ dryRun: true });
      expect(wasmPath).toMatch(/payment_router\.optimized\.wasm/);
    });

    it('returns custom wasm path if provided and exists', () => {
      const mockWasm = path.join(tmpDir, 'mock.wasm');
      fs.writeFileSync(mockWasm, 'wasm-bytes', 'utf8');

      const wasmPath = compileAndOptimizeWasm({ wasmPath: mockWasm });
      expect(wasmPath).toBe(mockWasm);
    });
  });

  describe('executeDeploy (dry-run)', () => {
    it('simulates deployment and updates config files', async () => {
      const testEnv = path.join(tmpDir, '.env.deploytest');
      fs.writeFileSync(testEnv, '', 'utf8');

      const result = await executeDeploy({
        network: 'testnet',
        dryRun: true,
        envFiles: [testEnv],
        updateSharedJs: false,
      });

      expect(result).toHaveProperty('contractId');
      expect(result).toHaveProperty('wasmHash');
      expect(result.contractId).toMatch(/^CA7Q/);

      const content = fs.readFileSync(testEnv, 'utf8');
      expect(content).toContain(`CONTRACT_ID="${result.contractId}"`);
    });
  });

  describe('executeUpgrade (dry-run)', () => {
    it('simulates contract upgrade with target contract ID', async () => {
      const result = await executeUpgrade({
        contractId: 'CDTARGETCONTRACT12345',
        network: 'testnet',
        dryRun: true,
      });

      expect(result).toHaveProperty('contractId', 'CDTARGETCONTRACT12345');
      expect(result).toHaveProperty('newWasmHash');
    });

    it('throws error when contractId is missing for upgrade', async () => {
      await expect(
        executeUpgrade({
          network: 'testnet',
          dryRun: true,
        })
      ).rejects.toThrow(/Missing target contract ID/);
    });
  });

  describe('NETWORKS definition', () => {
    it('defines testnet, mainnet, futurenet, and local networks', () => {
      expect(NETWORKS).toHaveProperty('testnet');
      expect(NETWORKS).toHaveProperty('mainnet');
      expect(NETWORKS).toHaveProperty('futurenet');
      expect(NETWORKS).toHaveProperty('local');

      expect(NETWORKS.testnet.rpcUrl).toContain('soroban-testnet.stellar.org');
      expect(NETWORKS.mainnet.rpcUrl).toContain('mainnet.sorobanrpc.com');
      expect(NETWORKS.testnet.networkPassphrase).toContain('Test SDF Network');
      expect(NETWORKS.mainnet.networkPassphrase).toContain('Public Global Stellar Network');
    });
  });
});
