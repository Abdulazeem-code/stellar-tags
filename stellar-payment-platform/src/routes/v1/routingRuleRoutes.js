'use strict';

// Authorized Protocol Quality Assurance & Routing Rules API
// Express router exposing dynamic payment routing rules management and simulation endpoints.

const express = require('express');
const { asyncHandler } = require('../../middleware/asyncHandler');
const { requireJson } = require('../../middleware/requireJson');
const routingRuleService = require('../../services/routingRuleService');
const { evaluateRules } = require('../../services/rulesEngine');

module.exports = () => {
  const router = express.Router();

  /**
   * POST /routing/rules
   * Creates a new JSON-defined routing rule in the database.
   */
  router.post('/routing/rules', requireJson, asyncHandler(async (req, res) => {
    const { name, description, priority, clientOrg, conditions, actions, metadata } = req.body;

    const rule = await routingRuleService.createRule({
      name,
      description,
      priority,
      clientOrg,
      conditions,
      actions,
      metadata,
    });

    return res.status(201).json({
      ok: true,
      data: rule,
    });
  }));

  /**
   * GET /routing/rules
   * Retrieves active routing rules ordered by priority.
   */
  router.get('/routing/rules', asyncHandler(async (req, res) => {
    const { clientOrg, active, limit, offset } = req.query;

    const rules = await routingRuleService.getRules({
      clientOrg: clientOrg || null,
      activeOnly: active !== 'false',
      limit: limit ? parseInt(limit, 10) : 50,
      offset: offset ? parseInt(offset, 10) : 0,
    });

    return res.status(200).json({
      ok: true,
      count: rules.length,
      data: rules,
    });
  }));

  /**
   * GET /routing/rules/:id
   * Retrieves a single routing rule by ID.
   */
  router.get('/routing/rules/:id', asyncHandler(async (req, res) => {
    const rule = await routingRuleService.getRuleById(req.params.id);
    return res.status(200).json({
      ok: true,
      data: rule,
    });
  }));

  /**
   * PATCH /routing/rules/:id
   * Updates an existing routing rule.
   */
  router.patch('/routing/rules/:id', requireJson, asyncHandler(async (req, res) => {
    const updated = await routingRuleService.updateRule(req.params.id, req.body);
    return res.status(200).json({
      ok: true,
      data: updated,
    });
  }));

  /**
   * DELETE /routing/rules/:id
   * Removes a routing rule from the database.
   */
  router.delete('/routing/rules/:id', asyncHandler(async (req, res) => {
    await routingRuleService.deleteRule(req.params.id);
    return res.status(200).json({
      ok: true,
      message: `Routing rule ${req.params.id} successfully deleted`,
    });
  }));

  /**
   * POST /routing/evaluate
   * Safely evaluates payment context against rules (either active database rules or provided inline rules).
   */
  router.post('/routing/evaluate', requireJson, asyncHandler(async (req, res) => {
    const { payment, rules: inlineRules, clientOrg } = req.body;

    if (!payment || typeof payment !== 'object') {
      const err = new Error('Payment context is required');
      err.statusCode = 400;
      throw err;
    }

    let result;
    if (Array.isArray(inlineRules)) {
      result = evaluateRules(inlineRules, payment);
    } else {
      result = await routingRuleService.routePayment(payment, clientOrg);
    }

    return res.status(200).json({
      ok: true,
      ...result,
    });
  }));

  /**
   * POST /payments/route
   * Convenience route to evaluate and obtain the resolved dynamic payment route.
   */
  router.post('/payments/route', requireJson, asyncHandler(async (req, res) => {
    const { clientOrg, ...paymentData } = req.body;

    if (!paymentData || Object.keys(paymentData).length === 0) {
      const err = new Error('Payment payload is required');
      err.statusCode = 400;
      throw err;
    }

    const evaluation = await routingRuleService.routePayment(paymentData, clientOrg);

    return res.status(200).json({
      ok: true,
      route: evaluation.routingResult.route,
      targetAddress: evaluation.routingResult.to,
      fee: evaluation.routingResult.fee,
      priorityTier: evaluation.routingResult.priorityTier,
      appliedRule: evaluation.appliedRule,
      fullResult: evaluation.routingResult,
    });
  }));

  return router;
};
