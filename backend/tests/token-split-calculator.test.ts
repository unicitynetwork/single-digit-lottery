import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the SDK modules
vi.mock('@unicitylabs/state-transition-sdk/lib/token/Token.js', () => ({
  Token: class MockToken {
    coins: Map<any, bigint>;
    constructor() {
      this.coins = new Map();
    }
  },
}));

vi.mock('@unicitylabs/state-transition-sdk/lib/token/fungible/CoinId.js', () => ({
  CoinId: {
    fromJSON: vi.fn().mockImplementation((hex: string) => ({ hex })),
  },
}));

import { TokenSplitCalculator, StoredToken, TokenWithAmount } from '../src/utils/token-split-calculator.js';

// Helper to create mock tokens
function createMockToken(amount: bigint, coinIdHex: string): any {
  const coinId = { hex: coinIdHex };
  const coins = new Map();
  coins.set(coinId, amount);
  return {
    coins: {
      get: (id: any) => (id.hex === coinIdHex ? amount : undefined),
    },
  };
}

function createStoredToken(amount: bigint, coinIdHex: string, filePath: string): StoredToken {
  return {
    filePath,
    sdkToken: createMockToken(amount, coinIdHex),
  };
}

describe('TokenSplitCalculator', () => {
  let calculator: TokenSplitCalculator;
  const testCoinId = 'abc123';

  beforeEach(() => {
    calculator = new TokenSplitCalculator();
    vi.clearAllMocks();
  });

  describe('calculateOptimalSplit', () => {
    it('should return null when no tokens available', async () => {
      const result = await calculator.calculateOptimalSplit([], 1000n, testCoinId);
      expect(result).toBeNull();
    });

    it('should return null when insufficient funds', async () => {
      const tokens = [createStoredToken(500n, testCoinId, '/path/token1.json')];

      const result = await calculator.calculateOptimalSplit(tokens, 1000n, testCoinId);
      expect(result).toBeNull();
    });

    it('should find exact match single token', async () => {
      const tokens = [
        createStoredToken(500n, testCoinId, '/path/token1.json'),
        createStoredToken(1000n, testCoinId, '/path/token2.json'),
        createStoredToken(200n, testCoinId, '/path/token3.json'),
      ];

      const result = await calculator.calculateOptimalSplit(tokens, 1000n, testCoinId);

      expect(result).not.toBeNull();
      expect(result!.requiresSplit).toBe(false);
      expect(result!.tokensToTransferDirectly).toHaveLength(1);
      expect(result!.tokensToTransferDirectly[0].amount).toBe(1000n);
      expect(result!.totalTransferAmount).toBe(1000n);
    });

    it('should find exact combination of 2 tokens', async () => {
      const tokens = [
        createStoredToken(300n, testCoinId, '/path/token1.json'),
        createStoredToken(700n, testCoinId, '/path/token2.json'),
        createStoredToken(500n, testCoinId, '/path/token3.json'),
      ];

      const result = await calculator.calculateOptimalSplit(tokens, 1000n, testCoinId);

      expect(result).not.toBeNull();
      expect(result!.requiresSplit).toBe(false);
      expect(result!.tokensToTransferDirectly).toHaveLength(2);

      const totalDirect = result!.tokensToTransferDirectly.reduce((sum, t) => sum + t.amount, 0n);
      expect(totalDirect).toBe(1000n);
    });

    it('should find exact combination of 3 tokens', async () => {
      const tokens = [
        createStoredToken(200n, testCoinId, '/path/token1.json'),
        createStoredToken(300n, testCoinId, '/path/token2.json'),
        createStoredToken(500n, testCoinId, '/path/token3.json'),
        createStoredToken(100n, testCoinId, '/path/token4.json'),
      ];

      const result = await calculator.calculateOptimalSplit(tokens, 600n, testCoinId);

      expect(result).not.toBeNull();
      expect(result!.requiresSplit).toBe(false);

      const totalDirect = result!.tokensToTransferDirectly.reduce((sum, t) => sum + t.amount, 0n);
      expect(totalDirect).toBe(600n);
    });

    it('should use split when no exact combination exists', async () => {
      const tokens = [
        createStoredToken(100n, testCoinId, '/path/token1.json'),
        createStoredToken(200n, testCoinId, '/path/token2.json'),
        createStoredToken(1000n, testCoinId, '/path/token3.json'),
      ];

      const result = await calculator.calculateOptimalSplit(tokens, 550n, testCoinId);

      expect(result).not.toBeNull();
      expect(result!.requiresSplit).toBe(true);
      expect(result!.tokenToSplit).not.toBeNull();
      expect(result!.splitAmount).toBe(250n); // 550 - 100 - 200 = 250
      expect(result!.remainderAmount).toBe(750n); // 1000 - 250 = 750
    });

    it('should greedy select smaller tokens first', async () => {
      const tokens = [
        createStoredToken(1000n, testCoinId, '/path/large.json'),
        createStoredToken(100n, testCoinId, '/path/small1.json'),
        createStoredToken(200n, testCoinId, '/path/small2.json'),
      ];

      const result = await calculator.calculateOptimalSplit(tokens, 500n, testCoinId);

      expect(result).not.toBeNull();
      expect(result!.requiresSplit).toBe(true);
      // Should use 100 + 200 directly and split from 1000
      expect(result!.tokensToTransferDirectly.map((t) => t.amount).sort()).toEqual([100n, 200n]);
      expect(result!.splitAmount).toBe(200n); // 500 - 100 - 200 = 200
    });

    it('should handle single token that needs split', async () => {
      const tokens = [createStoredToken(1000n, testCoinId, '/path/token.json')];

      const result = await calculator.calculateOptimalSplit(tokens, 300n, testCoinId);

      expect(result).not.toBeNull();
      expect(result!.requiresSplit).toBe(true);
      expect(result!.tokensToTransferDirectly).toHaveLength(0);
      expect(result!.tokenToSplit!.amount).toBe(1000n);
      expect(result!.splitAmount).toBe(300n);
      expect(result!.remainderAmount).toBe(700n);
    });

    it('should ignore tokens with zero balance for target coinId', async () => {
      const differentCoinId = 'xyz789';
      const tokens = [
        createStoredToken(1000n, differentCoinId, '/path/wrong-coin.json'),
        createStoredToken(500n, testCoinId, '/path/right-coin.json'),
      ];

      const result = await calculator.calculateOptimalSplit(tokens, 500n, testCoinId);

      expect(result).not.toBeNull();
      expect(result!.requiresSplit).toBe(false);
      expect(result!.tokensToTransferDirectly).toHaveLength(1);
    });

    it('should return correct coinId in result', async () => {
      const tokens = [createStoredToken(1000n, testCoinId, '/path/token.json')];

      const result = await calculator.calculateOptimalSplit(tokens, 500n, testCoinId);

      expect(result).not.toBeNull();
      expect(result!.coinId).toBe(testCoinId);
    });
  });

  describe('real-world scenarios', () => {
    // Using 18 decimal precision like UCT - use string conversion for precision
    const UCT = (amount: number) => {
      const [int, frac = ''] = amount.toString().split('.');
      const paddedFrac = frac.padEnd(18, '0').slice(0, 18);
      return BigInt(int + paddedFrac);
    };

    it('should handle 9.5 UCT payout with multiple tokens', async () => {
      const tokens = [
        createStoredToken(UCT(0.5), testCoinId, '/path/token1.json'),
        createStoredToken(UCT(0.5), testCoinId, '/path/token2.json'),
        createStoredToken(UCT(8.5), testCoinId, '/path/token3.json'),
      ];

      const result = await calculator.calculateOptimalSplit(tokens, UCT(9.5), testCoinId);

      expect(result).not.toBeNull();
      expect(result!.requiresSplit).toBe(false);
      expect(result!.tokensToTransferDirectly).toHaveLength(3);
      expect(result!.totalTransferAmount).toBe(UCT(9.5));
    });

    it('should handle split for 7.3 UCT when only larger tokens available', async () => {
      const tokens = [
        createStoredToken(UCT(5), testCoinId, '/path/token1.json'),
        createStoredToken(UCT(10), testCoinId, '/path/token2.json'),
      ];

      const result = await calculator.calculateOptimalSplit(tokens, UCT(7.3), testCoinId);

      expect(result).not.toBeNull();
      expect(result!.requiresSplit).toBe(true);
      expect(result!.tokensToTransferDirectly).toHaveLength(1);
      expect(result!.tokensToTransferDirectly[0].amount).toBe(UCT(5));
      expect(result!.splitAmount).toBe(UCT(2.3));
      expect(result!.remainderAmount).toBe(UCT(7.7));
    });
  });
});
