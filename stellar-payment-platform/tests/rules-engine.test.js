'use strict';

// Authorized Protocol Quality Assurance & Rules Engine Unit Test Suite

const {
  safeGet,
  compareValues,
  evaluateNode,
  applyRuleActions,
  validateConditions,
  evaluateRules,
} = require('../src/services/rulesEngine');

describe('Custom Dynamic Rules Engine (AST Evaluator)', () => {
  describe('safeGet & Prototype Pollution Protection', () => {
    test('safely retrieves nested property', () => {
      const obj = { payment: { metadata: { tier: 'enterprise', risk: 10 } } };
      expect(safeGet(obj, 'payment.metadata.tier')).toBe('enterprise');
      expect(safeGet(obj, 'payment.metadata.risk')).toBe(10);
      expect(safeGet(obj, 'payment.nonExistent')).toBeUndefined();
    });

    test('blocks prototype pollution attempts', () => {
      const obj = { standard: 'ok' };
      expect(safeGet(obj, '__proto__.polluted')).toBeUndefined();
      expect(safeGet(obj, 'constructor.prototype.polluted')).toBeUndefined();
      expect(safeGet(obj, 'prototype')).toBeUndefined();
    });

    test('handles null and undefined target objects cleanly', () => {
      expect(safeGet(null, 'foo.bar')).toBeUndefined();
      expect(safeGet(undefined, 'foo.bar')).toBeUndefined();
      expect(safeGet({}, null)).toBeUndefined();
    });
  });

  describe('compareValues Operator Logic', () => {
    test('numeric comparisons with string type coercion', () => {
      expect(compareValues('gt', '1500.50', 1000)).toBe(true);
      expect(compareValues('gte', 1000, '1000')).toBe(true);
      expect(compareValues('lt', '50.25', 100)).toBe(true);
      expect(compareValues('lte', 100, 100)).toBe(true);
      expect(compareValues('eq', '500', 500)).toBe(true);
      expect(compareValues('neq', 500, 600)).toBe(true);
    });

    test('membership & string matching operators', () => {
      expect(compareValues('in', 'USDC', ['USDC', 'EURC', 'XLM'])).toBe(true);
      expect(compareValues('in', 'BTC', ['USDC', 'EURC', 'XLM'])).toBe(false);
      expect(compareValues('not_in', 'BTC', ['USDC', 'EURC'])).toBe(true);
      expect(compareValues('contains', 'INV-2026-XYZ', '2026')).toBe(true);
      expect(compareValues('startsWith', 'GACCOUNT123', 'GACCOUNT')).toBe(true);
      expect(compareValues('endsWith', 'GACCOUNT123', '123')).toBe(true);
      expect(compareValues('exists', 'some-value', true)).toBe(true);
      expect(compareValues('exists', null, true)).toBe(false);
    });

    test('regex pattern matching with safety guards', () => {
      expect(compareValues('regex', 'ENTERPRISE_ORG_123', '^ENTERPRISE_')).toBe(true);
      expect(compareValues('regex', 'RETAIL_456', '^ENTERPRISE_')).toBe(false);
      // Malformed regex should return false, never throw
      expect(compareValues('regex', 'input', '[unclosed')).toBe(false);
    });
  });

  describe('evaluateNode Composite AST Evaluation', () => {
    const paymentContext = {
      from: 'GSOURCE1234567890',
      to: 'GDEFAULT_DESTINATION',
      amount: '7500.00',
      asset: 'USDC',
      memo: 'PAY-CORP-99',
      metadata: {
        clientTier: 'enterprise',
        country: 'US',
        riskScore: 5,
      },
    };

    test('evaluates simple atomic condition', () => {
      const condition = {
        field: 'amount',
        operator: '>=',
        value: 5000,
      };
      expect(evaluateNode(condition, paymentContext)).toBe(true);
    });

    test('evaluates nested AND condition', () => {
      const condition = {
        and: [
          { field: 'amount', operator: '>=', value: 5000 },
          { field: 'asset', operator: '==', value: 'USDC' },
          { field: 'metadata.clientTier', operator: '==', value: 'enterprise' },
        ],
      };
      expect(evaluateNode(condition, paymentContext)).toBe(true);
    });

    test('evaluates nested OR condition', () => {
      const condition = {
        or: [
          { field: 'asset', operator: '==', value: 'EURC' },
          { field: 'metadata.country', operator: '==', value: 'US' },
        ],
      };
      expect(evaluateNode(condition, paymentContext)).toBe(true);
    });

    test('evaluates NOT condition', () => {
      const condition = {
        not: {
          field: 'metadata.riskScore',
          operator: '>',
          value: 50,
        },
      };
      expect(evaluateNode(condition, paymentContext)).toBe(true);
    });

    test('complex multi-level AST logic', () => {
      const condition = {
        and: [
          {
            or: [
              { field: 'asset', operator: 'in', value: ['USDC', 'EURC'] },
              { field: 'amount', operator: '>=', value: 10000 },
            ],
          },
          {
            not: {
              field: 'metadata.riskScore',
              operator: '>=',
              value: 80,
            },
          },
        ],
      };
      expect(evaluateNode(condition, paymentContext)).toBe(true);
    });
  });

  describe('applyRuleActions & evaluateRules', () => {
    const payment = {
      from: 'GSOURCE123',
      to: 'GORIGINAL_DEST',
      amount: '12000.00',
      asset: 'USDC',
      memo: 'INVOICE-001',
    };

    const rules = [
      {
        id: 'rule-high-value',
        name: 'High-Value Enterprise Route',
        priority: 100,
        active: true,
        conditions: {
          and: [
            { field: 'amount', operator: '>=', value: 10000 },
            { field: 'asset', operator: '==', value: 'USDC' },
          ],
        },
        actions: {
          route: 'enterprise-liquidity-anchor-alpha',
          targetAddress: 'GHIGH_VALUE_SETTLEMENT_VAULT',
          priorityTier: 'instant',
          feeOverride: 0.0005,
          memoPrefix: 'VIP-',
          enrichMetadata: {
            routingTier: 'enterprise-high-value',
            complianceCheck: 'auto-cleared',
          },
        },
      },
      {
        id: 'rule-standard-usdc',
        name: 'Standard USDC Route',
        priority: 50,
        active: true,
        conditions: {
          field: 'asset',
          operator: '==',
          value: 'USDC',
        },
        actions: {
          route: 'standard-usdc-corridor',
        },
      },
    ];

    test('applies highest-priority matching rule and dynamically alters routing path', () => {
      const result = evaluateRules(rules, payment);
      expect(result.matched).toBe(true);
      expect(result.appliedRule.id).toBe('rule-high-value');
      expect(result.routingResult.to).toBe('GHIGH_VALUE_SETTLEMENT_VAULT');
      expect(result.routingResult.originalTo).toBe('GORIGINAL_DEST');
      expect(result.routingResult.route).toBe('enterprise-liquidity-anchor-alpha');
      expect(result.routingResult.priorityTier).toBe('instant');
      expect(result.routingResult.memo).toBe('VIP-INVOICE-001');
      expect(result.routingResult.fee).toBe(0.0005);
      expect(result.routingResult.metadata.complianceCheck).toBe('auto-cleared');
      expect(result.durationMs).toBeLessThan(10);
    });

    test('falls back to default direct route when no rules match', () => {
      const nonMatchingPayment = {
        from: 'GSOURCE123',
        to: 'GORIGINAL_DEST',
        amount: '10.00',
        asset: 'XLM',
      };
      const result = evaluateRules(rules, nonMatchingPayment);
      expect(result.matched).toBe(false);
      expect(result.appliedRule).toBeNull();
      expect(result.routingResult.route).toBe('default-stellar-direct');
      expect(result.routingResult.to).toBe('GORIGINAL_DEST');
    });

    test('skips inactive rules', () => {
      const inactiveRules = [
        {
          ...rules[0],
          active: false,
        },
        rules[1],
      ];
      const result = evaluateRules(inactiveRules, payment);
      expect(result.matched).toBe(true);
      expect(result.appliedRule.id).toBe('rule-standard-usdc');
      expect(result.routingResult.route).toBe('standard-usdc-corridor');
    });
  });

  describe('validateConditions Safety Gate', () => {
    test('validates correct conditions', () => {
      const valid = {
        and: [
          { field: 'amount', operator: '>', value: 100 },
          { field: 'asset', operator: '==', value: 'USDC' },
        ],
      };
      expect(validateConditions(valid)).toBe(true);
    });

    test('rejects missing field or operator', () => {
      expect(() => validateConditions({ operator: '>' })).toThrow('must specify a string "field"');
      expect(() => validateConditions({ field: 'amount' })).toThrow('must specify a string "operator"');
    });

    test('rejects prototype pollution attempts in conditions', () => {
      expect(() => validateConditions({ field: '__proto__.evil', operator: '==' })).toThrow('Forbidden field property access');
      expect(() => validateConditions({ field: 'constructor.prototype.evil', operator: '==' })).toThrow('Forbidden field property access');
    });
  });
});
