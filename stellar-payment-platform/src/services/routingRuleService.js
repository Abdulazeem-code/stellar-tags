'use strict';

// Authorized Protocol Quality Assurance & Database Routing Service
// Service layer managing database persistence and execution of Dynamic Payment Routing Rules.

const { prisma } = require('../../prismaClient');
const { evaluateRules, validateConditions } = require('./rulesEngine');
const { logger } = require('../logger');

class RoutingRuleService {
  /**
   * Creates and persists a new routing rule in the database.
   */
  async createRule({ name, description, priority = 0, clientOrg = null, conditions, actions, metadata = null }) {
    if (!name || typeof name !== 'string') {
      const err = new Error('Rule name is required');
      err.statusCode = 400;
      throw err;
    }

    validateConditions(conditions);

    if (!actions || typeof actions !== 'object') {
      const err = new Error('Rule actions must be a non-empty object');
      err.statusCode = 400;
      throw err;
    }

    try {
      const rule = await prisma.routingRule.create({
        data: {
          name: name.trim(),
          description: description ? description.trim() : null,
          priority: Number(priority) || 0,
          active: true,
          clientOrg: clientOrg ? clientOrg.trim() : null,
          conditions,
          actions,
          metadata: metadata || {},
        },
      });

      logger.info(`[RoutingRuleService] Created rule ${rule.id} ("${rule.name}") with priority ${rule.priority}`);
      return rule;
    } catch (err) {
      logger.error('[RoutingRuleService] Failed to create routing rule:', err);
      throw err;
    }
  }

  /**
   * Retrieves routing rules with optional client organization filtering.
   */
  async getRules({ clientOrg = null, activeOnly = true, limit = 50, offset = 0 } = {}) {
    const where = {};
    if (activeOnly) {
      where.active = true;
    }
    if (clientOrg) {
      where.OR = [
        { clientOrg },
        { clientOrg: null }, // Global rules apply across all organizations
      ];
    }

    return prisma.routingRule.findMany({
      where,
      orderBy: [
        { priority: 'desc' },
        { createdAt: 'asc' },
      ],
      take: Math.min(limit, 100),
      skip: Math.max(offset, 0),
    });
  }

  /**
   * Retrieves a single rule by ID.
   */
  async getRuleById(id) {
    const rule = await prisma.routingRule.findUnique({
      where: { id },
    });
    if (!rule) {
      const err = new Error(`Routing rule ${id} not found`);
      err.statusCode = 404;
      throw err;
    }
    return rule;
  }

  /**
   * Updates an existing routing rule.
   */
  async updateRule(id, updates) {
    await this.getRuleById(id);

    const data = {};
    if (updates.name !== undefined) data.name = updates.name.trim();
    if (updates.description !== undefined) data.description = updates.description;
    if (updates.priority !== undefined) data.priority = Number(updates.priority);
    if (updates.active !== undefined) data.active = Boolean(updates.active);
    if (updates.clientOrg !== undefined) data.clientOrg = updates.clientOrg;
    if (updates.conditions !== undefined) {
      validateConditions(updates.conditions);
      data.conditions = updates.conditions;
    }
    if (updates.actions !== undefined) {
      if (!updates.actions || typeof updates.actions !== 'object') {
        const err = new Error('Rule actions must be a non-empty object');
        err.statusCode = 400;
        throw err;
      }
      data.actions = updates.actions;
    }
    if (updates.metadata !== undefined) data.metadata = updates.metadata;

    return prisma.routingRule.update({
      where: { id },
      data,
    });
  }

  /**
   * Deletes a routing rule.
   */
  async deleteRule(id) {
    await this.getRuleById(id);
    return prisma.routingRule.delete({
      where: { id },
    });
  }

  /**
   * Dynamically evaluates a payment intent through active database rules.
   */
  async routePayment(paymentContext, clientOrg = null) {
    const rules = await this.getRules({ clientOrg, activeOnly: true });
    return evaluateRules(rules, paymentContext);
  }
}

module.exports = new RoutingRuleService();
