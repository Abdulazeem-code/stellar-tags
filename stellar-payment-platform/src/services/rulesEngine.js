'use strict';

// Authorized Protocol Quality Assurance & Deterministic Rules Engine
// Sandboxed AST / JSON Rules Engine for Dynamic Payment Routing.
//
// Design Invariants:
// 1. Sandboxed & Hermetic: Zero eval, new Function, or prototype access.
// 2. Prototype Pollution Proof: Strictly forbids `__proto__`, `constructor`, `prototype`.
// 3. ReDoS & Loop Protected: Recursion depth capped at 10; safe regex execution with length bounds.
// 4. Deterministic Type Normalization: Numbers in string form (e.g. "500.00") automatically coerce
//    safely for mathematical comparisons.

const FORBIDDEN_PROPERTIES = new Set(['__proto__', 'constructor', 'prototype']);
const MAX_RECURSION_DEPTH = 10;
const MAX_REGEX_INPUT_LENGTH = 1000;

/**
 * Safely resolves a nested dot-separated path on a target object.
 * Returns undefined if path does not exist or targets forbidden properties.
 */
function safeGet(obj, path) {
  if (obj === null || obj === undefined || typeof path !== 'string') {
    return undefined;
  }
  const parts = path.split('.');
  let current = obj;

  for (const part of parts) {
    if (current === null || current === undefined) {
      return undefined;
    }
    const cleanPart = part.trim();
    if (FORBIDDEN_PROPERTIES.has(cleanPart)) {
      return undefined;
    }
    if (typeof current !== 'object') {
      return undefined;
    }
    current = current[cleanPart];
  }
  return current;
}

/**
 * Normalizes values for deterministic comparison.
 * If both values can be represented as numbers, coerces them to floats.
 */
function normalizeComparable(val) {
  if (typeof val === 'number') return val;
  if (typeof val === 'string') {
    const trimmed = val.trim();
    if (trimmed !== '' && !isNaN(Number(trimmed))) {
      return parseFloat(trimmed);
    }
  }
  return val;
}

/**
 * Compares two values using standard mathematical and string operators.
 */
function compareValues(op, actual, expected) {
  const normActual = normalizeComparable(actual);
  const normExpected = normalizeComparable(expected);

  switch (op.toLowerCase()) {
    case 'eq':
    case '==':
      return normActual === normExpected;
    case 'neq':
    case '!=':
      return normActual !== normExpected;
    case 'gt':
    case '>':
      return typeof normActual === 'number' && typeof normExpected === 'number'
        ? normActual > normExpected
        : false;
    case 'gte':
    case '>=':
      return typeof normActual === 'number' && typeof normExpected === 'number'
        ? normActual >= normExpected
        : false;
    case 'lt':
    case '<':
      return typeof normActual === 'number' && typeof normExpected === 'number'
        ? normActual < normExpected
        : false;
    case 'lte':
    case '<=':
      return typeof normActual === 'number' && typeof normExpected === 'number'
        ? normActual <= normExpected
        : false;
    case 'in':
      if (Array.isArray(expected)) {
        return expected.some((expItem) => normalizeComparable(expItem) === normActual);
      }
      return false;
    case 'not_in':
      if (Array.isArray(expected)) {
        return !expected.some((expItem) => normalizeComparable(expItem) === normActual);
      }
      return true;
    case 'contains':
      if (typeof actual === 'string' && typeof expected === 'string') {
        return actual.includes(expected);
      }
      if (Array.isArray(actual)) {
        return actual.some((item) => normalizeComparable(item) === normExpected);
      }
      return false;
    case 'startswith':
      return typeof actual === 'string' && typeof expected === 'string'
        ? actual.startsWith(expected)
        : false;
    case 'endswith':
      return typeof actual === 'string' && typeof expected === 'string'
        ? actual.endsWith(expected)
        : false;
    case 'exists': {
      const shouldExist = Boolean(expected);
      const isPresent = actual !== null && actual !== undefined;
      return shouldExist ? isPresent : !isPresent;
    }
    case 'regex':
      if (typeof actual !== 'string' || typeof expected !== 'string') {
        return false;
      }
      if (actual.length > MAX_REGEX_INPUT_LENGTH || expected.length > 100) {
        return false;
      }
      try {
        const re = new RegExp(expected);
        return re.test(actual);
      } catch {
        return false;
      }
    default:
      return false;
  }
}

/**
 * Sandboxed evaluation of an AST node against a context dictionary.
 * Supports composite operators (and, or, not) and atomic condition nodes.
 */
function evaluateNode(node, context, depth = 0) {
  if (depth > MAX_RECURSION_DEPTH) {
    throw new Error(`Rules engine maximum recursion depth of ${MAX_RECURSION_DEPTH} exceeded`);
  }
  if (!node || typeof node !== 'object') {
    return false;
  }

  // Composite logical operators
  if (Array.isArray(node.and)) {
    return node.and.every((child) => evaluateNode(child, context, depth + 1));
  }
  if (Array.isArray(node.or)) {
    return node.or.some((child) => evaluateNode(child, context, depth + 1));
  }
  if (node.not) {
    return !evaluateNode(node.not, context, depth + 1);
  }

  // Atomic condition node: { field, operator, value } or { path, op, val }
  const fieldPath = node.field || node.path;
  const operator = node.operator || node.op;
  const expectedValue = Object.prototype.hasOwnProperty.call(node, 'value') ? node.value : node.val;

  if (typeof fieldPath !== 'string' || typeof operator !== 'string') {
    return false;
  }

  const actualValue = safeGet(context, fieldPath);
  return compareValues(operator, actualValue, expectedValue);
}

/**
 * Applies rule actions to a payment intent context dynamically.
 */
function applyRuleActions(actions, context) {
  if (!actions || typeof actions !== 'object') {
    return { ...context };
  }

  const routed = {
    from: context.from,
    to: actions.targetAddress || context.to,
    originalTo: context.to,
    amount: context.amount,
    asset: context.asset || 'XLM',
    memo: actions.memoOverride || (actions.memoPrefix ? `${actions.memoPrefix}${context.memo || ''}` : context.memo),
    memoType: actions.memoType || context.memoType,
    route: actions.route || 'default-stellar-direct',
    priorityTier: actions.priorityTier || 'standard',
    fee: typeof actions.feeOverride === 'number' ? actions.feeOverride : (context.fee || 0),
    metadata: {
      ...(context.metadata || {}),
      ...(actions.enrichMetadata || {}),
      routingEngine: {
        applied: true,
        route: actions.route || 'default-stellar-direct',
        timestamp: new Date().toISOString(),
      },
    },
  };

  return routed;
}

/**
 * Validates condition JSON syntax to ensure safe persistence.
 */
function validateConditions(node, depth = 0) {
  if (depth > MAX_RECURSION_DEPTH) {
    throw new Error('Conditions exceed maximum nesting depth');
  }
  if (!node || typeof node !== 'object') {
    throw new Error('Condition must be a JSON object');
  }

  if (node.and) {
    if (!Array.isArray(node.and) || node.and.length === 0) {
      throw new Error('"and" condition must be a non-empty array of conditions');
    }
    node.and.forEach((child) => validateConditions(child, depth + 1));
    return true;
  }

  if (node.or) {
    if (!Array.isArray(node.or) || node.or.length === 0) {
      throw new Error('"or" condition must be a non-empty array of conditions');
    }
    node.or.forEach((child) => validateConditions(child, depth + 1));
    return true;
  }

  if (node.not) {
    validateConditions(node.not, depth + 1);
    return true;
  }

  const field = node.field || node.path;
  const op = node.operator || node.op;
  if (!field || typeof field !== 'string') {
    throw new Error('Condition node must specify a string "field"');
  }
  if (!op || typeof op !== 'string') {
    throw new Error('Condition node must specify a string "operator"');
  }

  // Disallow forbidden prototype keys in field paths
  for (const part of field.split('.')) {
    if (FORBIDDEN_PROPERTIES.has(part.trim())) {
      throw new Error(`Forbidden field property access: ${part}`);
    }
  }

  return true;
}

/**
 * Evaluates a set of database rules against a payment context.
 * Rules must be sorted by priority DESC before evaluation.
 */
function evaluateRules(rules, paymentContext) {
  const startTime = process.hrtime.bigint();
  const auditLog = [];

  for (const rule of rules) {
    if (!rule.active) {
      continue;
    }

    try {
      const isMatch = evaluateNode(rule.conditions, paymentContext);
      auditLog.push({
        ruleId: rule.id,
        ruleName: rule.name,
        priority: rule.priority,
        matched: isMatch,
      });

      if (isMatch) {
        const routedContext = applyRuleActions(rule.actions, paymentContext);
        const endTime = process.hrtime.bigint();
        const durationMs = Number(endTime - startTime) / 1e6;

        return {
          matched: true,
          appliedRule: {
            id: rule.id,
            name: rule.name,
            priority: rule.priority,
            actions: rule.actions,
          },
          routingResult: routedContext,
          auditLog,
          durationMs: parseFloat(durationMs.toFixed(3)),
        };
      }
    } catch (err) {
      auditLog.push({
        ruleId: rule.id,
        ruleName: rule.name,
        error: err.message,
        matched: false,
      });
    }
  }

  const endTime = process.hrtime.bigint();
  const durationMs = Number(endTime - startTime) / 1e6;

  // No rule matched; return unmodified context on default route
  return {
    matched: false,
    appliedRule: null,
    routingResult: {
      ...paymentContext,
      route: 'default-stellar-direct',
      priorityTier: 'standard',
      metadata: {
        ...(paymentContext.metadata || {}),
        routingEngine: { applied: false, route: 'default-stellar-direct' },
      },
    },
    auditLog,
    durationMs: parseFloat(durationMs.toFixed(3)),
  };
}

module.exports = {
  safeGet,
  evaluateNode,
  compareValues,
  evaluateRules,
  applyRuleActions,
  validateConditions,
};
