const { createFraudScorer } = require('../src/fraudDetection');

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
