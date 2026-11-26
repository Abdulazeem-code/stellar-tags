import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

export function amountToStroops(value) {
  if (typeof value !== "string" || !/^(?:0|[1-9]\d*)(?:\.\d{1,7})?$/.test(value)) {
    return null;
  }
  const [whole, fraction = ""] = value.split(".");
  return BigInt(whole) * 10_000_000n + BigInt(fraction.padEnd(7, "0"));
}

export function paymentMatchesOrder(order, { memo, amount }) {
  const expected = amountToStroops(order.amount);
  const received = amountToStroops(amount);
  return memo === order.memo && expected !== null && received === expected;
}

export class JsonOrderStore {
  constructor(filePath) {
    this.filePath = filePath;
  }

  readAll() {
    try {
      const orders = JSON.parse(readFileSync(this.filePath, "utf8"));
      if (!Array.isArray(orders)) throw new Error("Order store must contain a JSON array");
      return orders;
    } catch (error) {
      if (error.code === "ENOENT") return [];
      throw error;
    }
  }

  writeAll(orders) {
    mkdirSync(dirname(this.filePath), { recursive: true });
    const temporaryPath = `${this.filePath}.${randomUUID()}.tmp`;
    writeFileSync(temporaryPath, JSON.stringify(orders, null, 2), { mode: 0o600 });
    renameSync(temporaryPath, this.filePath);
  }

  create(order) {
    const orders = this.readAll();
    if (orders.some((existing) => existing.id === order.id || existing.memo === order.memo)) {
      throw new Error("Order ID or memo already exists");
    }
    orders.push(order);
    this.writeAll(orders);
    return order;
  }

  get(id) {
    return this.readAll().find((order) => order.id === id) ?? null;
  }

  markPaidIfMatching({ memo, amount, paymentId }) {
    const orders = this.readAll();
    const order = orders.find((candidate) => candidate.memo === memo);
    if (!order || !paymentMatchesOrder(order, { memo, amount })) {
      return { matched: false, paid: false };
    }
    if (order.status === "paid") {
      return { matched: true, paid: true, alreadyPaid: true };
    }
    order.status = "paid";
    order.paidAt = new Date().toISOString();
    order.paymentId = paymentId;
    this.writeAll(orders);
    return { matched: true, paid: true, alreadyPaid: false };
  }
}
