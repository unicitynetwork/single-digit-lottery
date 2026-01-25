/**
 * Token Split Calculator
 *
 * Calculates optimal token selection and splitting for transfers.
 * Based on Sphere's implementation.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
import { Token as SdkToken } from '@unicitylabs/state-transition-sdk/lib/token/Token.js';
import { CoinId } from '@unicitylabs/state-transition-sdk/lib/token/fungible/CoinId.js';

/**
 * Token with parsed amount
 */
export interface TokenWithAmount {
  sdkToken: SdkToken<any>;
  amount: bigint;
  filePath: string;
}

/**
 * Split plan result
 */
export interface SplitPlan {
  /** Tokens that can be transferred directly without splitting */
  tokensToTransferDirectly: TokenWithAmount[];
  /** Token that needs to be split (if any) */
  tokenToSplit: TokenWithAmount | null;
  /** Amount to split off for transfer */
  splitAmount: bigint | null;
  /** Amount remaining after split (change) */
  remainderAmount: bigint | null;
  /** Total amount being transferred */
  totalTransferAmount: bigint;
  /** Coin ID for the transfer */
  coinId: string;
  /** Whether a split operation is required */
  requiresSplit: boolean;
}

/**
 * Token data loaded from storage
 */
export interface StoredToken {
  filePath: string;
  sdkToken: SdkToken<any>;
}

export class TokenSplitCalculator {
  /**
   * Calculate optimal split plan for a transfer
   */
  async calculateOptimalSplit(
    storedTokens: StoredToken[],
    targetAmount: bigint,
    coinIdHex: string
  ): Promise<SplitPlan | null> {
    // eslint-disable-next-line no-console
    console.log(
      `[TokenSplitCalculator] Calculating split for ${targetAmount} of ${coinIdHex.slice(0, 8)}...`
    );

    const coinId = CoinId.fromJSON(coinIdHex);
    const candidates: TokenWithAmount[] = [];

    // Extract amounts from tokens
    for (const stored of storedTokens) {
      const balance = this.getTokenBalance(stored.sdkToken, coinId);
      if (balance > 0n) {
        candidates.push({
          sdkToken: stored.sdkToken,
          amount: balance,
          filePath: stored.filePath,
        });
      }
    }

    // Sort by amount (smallest first for optimal combination)
    candidates.sort((a, b) => (a.amount < b.amount ? -1 : 1));

    const totalAvailable = candidates.reduce((sum, t) => sum + t.amount, 0n);
    if (totalAvailable < targetAmount) {
      // eslint-disable-next-line no-console
      console.error(
        `[TokenSplitCalculator] Insufficient funds. Available: ${totalAvailable}, Required: ${targetAmount}`
      );
      return null;
    }

    // Strategy 1: Find exact match
    const exactMatch = candidates.find((t) => t.amount === targetAmount);
    if (exactMatch) {
      // eslint-disable-next-line no-console
      console.log('[TokenSplitCalculator] Found exact match token');
      return this.createDirectPlan([exactMatch], targetAmount, coinIdHex);
    }

    // Strategy 2: Try to find exact combination of 2-5 tokens
    const maxCombinationSize = Math.min(5, candidates.length);
    for (let size = 2; size <= maxCombinationSize; size++) {
      const combo = this.findCombinationOfSize(candidates, targetAmount, size);
      if (combo) {
        // eslint-disable-next-line no-console
        console.log(`[TokenSplitCalculator] Found exact combination of ${size} tokens`);
        return this.createDirectPlan(combo, targetAmount, coinIdHex);
      }
    }

    // Strategy 3: Greedy selection with split
    const toTransfer: TokenWithAmount[] = [];
    let currentSum = 0n;

    // eslint-disable-next-line no-console
    console.log(`[TokenSplitCalculator] Target amount (raw): ${targetAmount}`);

    for (const candidate of candidates) {
      // eslint-disable-next-line no-console
      console.log(`[TokenSplitCalculator] Candidate token: ${candidate.amount} (raw)`);

      const newSum = currentSum + candidate.amount;

      if (newSum === targetAmount) {
        toTransfer.push(candidate);
        return this.createDirectPlan(toTransfer, targetAmount, coinIdHex);
      } else if (newSum < targetAmount) {
        toTransfer.push(candidate);
        currentSum = newSum;
        // eslint-disable-next-line no-console
        console.log(`[TokenSplitCalculator] Added to direct transfers. CurrentSum: ${currentSum}`);
      } else {
        // This token is larger than what we need - split it
        const neededFromThisToken = targetAmount - currentSum;
        const remainderForMe = candidate.amount - neededFromThisToken;

        // eslint-disable-next-line no-console
        console.log(
          `[TokenSplitCalculator] Split required. CurrentSum: ${currentSum}, Need: ${neededFromThisToken}, Remainder: ${remainderForMe}`
        );

        return {
          tokensToTransferDirectly: toTransfer,
          tokenToSplit: candidate,
          splitAmount: neededFromThisToken,
          remainderAmount: remainderForMe,
          totalTransferAmount: targetAmount,
          coinId: coinIdHex,
          requiresSplit: true,
        };
      }
    }

    return null;
  }

  /**
   * Get balance of a specific coin from token
   */
  private getTokenBalance(sdkToken: SdkToken<any>, coinId: CoinId): bigint {
    try {
      if (!sdkToken.coins) return 0n;
      const balance = sdkToken.coins.get(coinId);
      return balance ?? 0n;
    } catch {
      return 0n;
    }
  }

  private createDirectPlan(tokens: TokenWithAmount[], total: bigint, coinId: string): SplitPlan {
    return {
      tokensToTransferDirectly: tokens,
      tokenToSplit: null,
      splitAmount: null,
      remainderAmount: null,
      totalTransferAmount: total,
      coinId: coinId,
      requiresSplit: false,
    };
  }

  private findCombinationOfSize(
    tokens: TokenWithAmount[],
    targetAmount: bigint,
    size: number
  ): TokenWithAmount[] | null {
    const generator = this.generateCombinations(tokens, size);

    for (const combo of generator) {
      const sum = combo.reduce((acc, t) => acc + t.amount, 0n);
      if (sum === targetAmount) {
        return combo;
      }
    }
    return null;
  }

  private *generateCombinations(
    tokens: TokenWithAmount[],
    k: number,
    start: number = 0,
    current: TokenWithAmount[] = []
  ): Generator<TokenWithAmount[]> {
    if (k === 0) {
      yield current;
      return;
    }

    for (let i = start; i < tokens.length; i++) {
      yield* this.generateCombinations(tokens, k - 1, i + 1, [...current, tokens[i]]);
    }
  }
}
