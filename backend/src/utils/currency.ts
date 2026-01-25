/**
 * Currency Utilities
 *
 * Handles conversion between human-readable token amounts
 * and blockchain units (18 decimals for UCT).
 */

// UCT has 18 decimals
export const TOKEN_DECIMALS = 18;
export const DECIMALS_MULTIPLIER = 10n ** BigInt(TOKEN_DECIMALS);

export const CurrencyUtils = {
  /**
   * Convert human-readable amount to smallest unit (bigint)
   * e.g., "9.5" with 18 decimals -> 9500000000000000000n
   */
  toSmallestUnit: (amount: number | string, decimals: number = TOKEN_DECIMALS): bigint => {
    const amountStr = typeof amount === 'number' ? amount.toString() : amount;
    if (!amountStr) return 0n;

    try {
      const [integer, fraction = ''] = amountStr.split('.');
      const paddedFraction = fraction.padEnd(decimals, '0').slice(0, decimals);
      return BigInt(integer + paddedFraction);
    } catch {
      console.error('Invalid amount format:', amount);
      return 0n;
    }
  },

  /**
   * Convert smallest unit (bigint) to human-readable string
   * e.g., 9500000000000000000n with 18 decimals -> "9.5"
   */
  toHumanReadable: (amount: bigint | string, decimals: number = TOKEN_DECIMALS): string => {
    const str = amount.toString().padStart(decimals + 1, '0');
    const integer = str.slice(0, -decimals);
    const fraction = str.slice(-decimals).replace(/0+$/, '');

    return fraction ? `${integer}.${fraction}` : integer;
  },

  /**
   * Round to specific decimal places (for display/calculations)
   */
  round: (amount: number, decimals: number = 4): number => {
    const multiplier = Math.pow(10, decimals);
    return Math.round(amount * multiplier) / multiplier;
  },
};
