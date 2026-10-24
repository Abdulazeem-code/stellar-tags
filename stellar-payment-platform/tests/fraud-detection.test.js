const {
  createFraudScorer,
  DEFAULT_MAX_TRACKED_SENDERS,
} = require('../src/fraudDetection');

describe('fraud detection scorer', () => {
  test('flags an unusually large payment after a normal baseline', () => {
    const score = createFraudScorer();
    for (let i = 0; i < 8; i += 1) score({ from: 'Gsender', amount: 1, to: 'Grecipient' });
    const result = score({ from: 'Gsender', amount: 100, to: 'Grecipient' });
    expect(result.score).toBeGreaterThan(0.8);
    expect(result.reason).toContain('amount=');
  });

  test('does not flag a first normal payment', () => {
    const result = createFraudScorer()({ from: 'Gsender', amount: 10, to: 'Grecipient' });
    expect(result.score).toBeLessThan(0.8);
  });
});

describe('fraud detection scorer memory bounds (#683)', () => {
  test('keeps internal state bounded across many unique senders', () => {
    const scorer = createFraudScorer({ maxTrackedSenders: 100 });

    for (let i = 0; i < 5_000; i += 1) {
      scorer({ from: `Gsender${i}`, amount: 1, to: 'Grecipient' });
    }

    const { trackedSenders, amountWindow } = scorer.stats();
    expect(trackedSenders).toBeLessThanOrEqual(100);
    expect(amountWindow).toBeLessThanOrEqual(100);
  });

  test('drops senders whose burst window has expired', () => {
    const scorer = createFraudScorer({ maxTrackedSenders: 10 });
    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(1_000_000);

    for (let i = 0; i < 10; i += 1) {
      scorer({ from: `Gsender${i}`, amount: 1 });
    }
    expect(scorer.stats().trackedSenders).toBe(10);

    // Move beyond the burst window; the stale senders are reclaimable.
    nowSpy.mockReturnValue(1_000_000 + 61_000);
    scorer({ from: 'Gfresh', amount: 1 });

    expect(scorer.stats().trackedSenders).toBe(1);
    nowSpy.mockRestore();
  });

  test('exposes a finite default sender cap', () => {
    expect(Number.isFinite(DEFAULT_MAX_TRACKED_SENDERS)).toBe(true);
    expect(DEFAULT_MAX_TRACKED_SENDERS).toBeGreaterThan(0);
  });
});
