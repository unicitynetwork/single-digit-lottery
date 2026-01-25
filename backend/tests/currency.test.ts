import { describe, it, expect } from 'vitest';
import { CurrencyUtils, TOKEN_DECIMALS, DECIMALS_MULTIPLIER } from '../src/utils/currency.js';

describe('CurrencyUtils', () => {
  describe('constants', () => {
    it('should have correct TOKEN_DECIMALS', () => {
      expect(TOKEN_DECIMALS).toBe(18);
    });

    it('should have correct DECIMALS_MULTIPLIER', () => {
      expect(DECIMALS_MULTIPLIER).toBe(10n ** 18n);
    });
  });

  describe('toSmallestUnit', () => {
    it('should convert integer amount', () => {
      expect(CurrencyUtils.toSmallestUnit(1)).toBe(1000000000000000000n);
      expect(CurrencyUtils.toSmallestUnit(10)).toBe(10000000000000000000n);
      expect(CurrencyUtils.toSmallestUnit(100)).toBe(100000000000000000000n);
    });

    it('should convert decimal amount', () => {
      expect(CurrencyUtils.toSmallestUnit(0.5)).toBe(500000000000000000n);
      expect(CurrencyUtils.toSmallestUnit(1.5)).toBe(1500000000000000000n);
      expect(CurrencyUtils.toSmallestUnit(9.5)).toBe(9500000000000000000n);
    });

    it('should convert string amount', () => {
      expect(CurrencyUtils.toSmallestUnit('1')).toBe(1000000000000000000n);
      expect(CurrencyUtils.toSmallestUnit('0.5')).toBe(500000000000000000n);
      expect(CurrencyUtils.toSmallestUnit('9.5')).toBe(9500000000000000000n);
    });

    it('should handle small decimal amounts', () => {
      expect(CurrencyUtils.toSmallestUnit(0.0001)).toBe(100000000000000n);
      expect(CurrencyUtils.toSmallestUnit('0.0001')).toBe(100000000000000n);
    });

    it('should handle amounts with many decimal places', () => {
      // Should truncate to 18 decimals
      expect(CurrencyUtils.toSmallestUnit('1.123456789012345678')).toBe(1123456789012345678n);
    });

    it('should handle zero', () => {
      expect(CurrencyUtils.toSmallestUnit(0)).toBe(0n);
      expect(CurrencyUtils.toSmallestUnit('0')).toBe(0n);
    });

    it('should handle empty string', () => {
      expect(CurrencyUtils.toSmallestUnit('')).toBe(0n);
    });

    it('should use custom decimals', () => {
      expect(CurrencyUtils.toSmallestUnit(1, 6)).toBe(1000000n);
      expect(CurrencyUtils.toSmallestUnit(0.5, 6)).toBe(500000n);
    });
  });

  describe('toHumanReadable', () => {
    it('should convert bigint to string with decimals', () => {
      expect(CurrencyUtils.toHumanReadable(1000000000000000000n)).toBe('1');
      expect(CurrencyUtils.toHumanReadable(500000000000000000n)).toBe('0.5');
      expect(CurrencyUtils.toHumanReadable(9500000000000000000n)).toBe('9.5');
    });

    it('should handle amounts less than 1', () => {
      expect(CurrencyUtils.toHumanReadable(100000000000000000n)).toBe('0.1');
      expect(CurrencyUtils.toHumanReadable(10000000000000000n)).toBe('0.01');
      expect(CurrencyUtils.toHumanReadable(100000000000000n)).toBe('0.0001');
    });

    it('should strip trailing zeros', () => {
      expect(CurrencyUtils.toHumanReadable(1500000000000000000n)).toBe('1.5');
      expect(CurrencyUtils.toHumanReadable(10000000000000000000n)).toBe('10');
    });

    it('should handle zero', () => {
      expect(CurrencyUtils.toHumanReadable(0n)).toBe('0');
    });

    it('should handle string input', () => {
      expect(CurrencyUtils.toHumanReadable('1000000000000000000')).toBe('1');
      expect(CurrencyUtils.toHumanReadable('500000000000000000')).toBe('0.5');
    });

    it('should use custom decimals', () => {
      expect(CurrencyUtils.toHumanReadable(1000000n, 6)).toBe('1');
      expect(CurrencyUtils.toHumanReadable(500000n, 6)).toBe('0.5');
    });

    it('should preserve precision for complex amounts', () => {
      expect(CurrencyUtils.toHumanReadable(8500000000000000000n)).toBe('8.5');
      expect(CurrencyUtils.toHumanReadable(1234567890000000000n)).toBe('1.23456789');
    });
  });

  describe('round', () => {
    it('should round to 4 decimal places by default', () => {
      expect(CurrencyUtils.round(1.23456789)).toBe(1.2346);
      expect(CurrencyUtils.round(9.5)).toBe(9.5);
      expect(CurrencyUtils.round(0.00001)).toBe(0);
    });

    it('should round to custom decimal places', () => {
      expect(CurrencyUtils.round(1.23456789, 2)).toBe(1.23);
      expect(CurrencyUtils.round(1.23456789, 6)).toBe(1.234568);
    });

    it('should handle edge cases', () => {
      expect(CurrencyUtils.round(0)).toBe(0);
      expect(CurrencyUtils.round(0.00005, 4)).toBe(0.0001);
      expect(CurrencyUtils.round(0.00004, 4)).toBe(0);
    });

    it('should handle negative numbers', () => {
      expect(CurrencyUtils.round(-1.23456789, 2)).toBe(-1.23);
    });
  });

  describe('round-trip conversion', () => {
    it('should preserve value through conversion', () => {
      const amounts = [1, 0.5, 9.5, 10, 0.0001, 100.123456];

      for (const amount of amounts) {
        const raw = CurrencyUtils.toSmallestUnit(amount);
        const back = parseFloat(CurrencyUtils.toHumanReadable(raw));
        expect(back).toBe(amount);
      }
    });
  });
});
