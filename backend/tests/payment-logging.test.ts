import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import mongoose from 'mongoose';

// Mock nostrService with sentAmounts support
vi.mock('../src/services/index.js', () => ({
  nostrService: {
    createInvoice: vi.fn().mockImplementation(async (_userNametag: string, amount: number) => ({
      invoiceId: `invoice-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      amount,
      recipientNametag: 'test-agent',
      status: 'pending',
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 120000),
    })),
    sendTokens: vi.fn().mockImplementation(async (toNametag: string, amount: number) => ({
      transferId: `transfer-${Date.now()}`,
      toNametag,
      amount,
      status: 'confirmed',
      createdAt: new Date(),
      transactionCount: amount > 5 ? 2 : 1, // Simulate split for amounts > 5
      sentAmounts: amount > 5 ? [5, amount - 5] : [amount], // Simulate split amounts
    })),
  },
}));

import { GameService } from '../src/services/game.service.js';
import { Round, Bet, PaymentLog } from '../src/models/game.model.js';

describe('Payment Logging', () => {
  beforeAll(async () => {
    await mongoose.connect('mongodb://localhost:27017/lottery-test-payment-logging');
  });

  afterAll(async () => {
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  });

  beforeEach(async () => {
    await Round.deleteMany({});
    await Bet.deleteMany({});
    await PaymentLog.deleteMany({});
  });

  describe('confirmPayment with receivedAmounts', () => {
    it('should accept receivedAmounts parameter', async () => {
      const { invoice } = await GameService.placeBets('alice', [{ digit: 5, amount: 10 }]);

      const result = await GameService.confirmPayment(
        invoice.invoiceId,
        'tx-123',
        2, // tokenCount
        [5, 5] // receivedAmounts
      );

      expect(result.accepted).toBe(true);
      expect(result.bet.paymentStatus).toBe('paid');
    });

    it('should log payment with receivedAmounts in metadata', async () => {
      const { invoice } = await GameService.placeBets('bob', [{ digit: 3, amount: 10 }]);

      await GameService.confirmPayment(invoice.invoiceId, 'tx-456', 3, [3, 3, 4]);

      const log = await PaymentLog.findOne({ txId: 'tx-456' });
      expect(log).not.toBeNull();
      expect(log!.metadata.tokenCount).toBe(3);
      expect(log!.metadata.wasSplit).toBe(true);
      expect(log!.metadata.receivedAmounts).toEqual([3, 3, 4]);
    });

    it('should log single token payment correctly', async () => {
      const { invoice } = await GameService.placeBets('carol', [{ digit: 7, amount: 5 }]);

      await GameService.confirmPayment(invoice.invoiceId, 'tx-single', 1, [5]);

      const log = await PaymentLog.findOne({ txId: 'tx-single' });
      expect(log).not.toBeNull();
      expect(log!.metadata.tokenCount).toBe(1);
      expect(log!.metadata.wasSplit).toBe(false);
      expect(log!.metadata.receivedAmounts).toEqual([5]);
    });

    it('should default receivedAmounts to totalAmount when not provided', async () => {
      const { invoice } = await GameService.placeBets('dave', [{ digit: 1, amount: 8 }]);

      await GameService.confirmPayment(invoice.invoiceId, 'tx-default');

      const log = await PaymentLog.findOne({ txId: 'tx-default' });
      expect(log).not.toBeNull();
      expect(log!.metadata.receivedAmounts).toEqual([8]);
    });

    it('should log rejected payment with receivedAmounts', async () => {
      // Create and close round first
      const round = await GameService.createRound();
      const { invoice } = await GameService.placeBets('eve', [{ digit: 2, amount: 15 }]);
      await GameService.closeRound(round._id.toString());

      // Now payment should be rejected (round closed)
      const result = await GameService.confirmPayment(invoice.invoiceId, 'tx-rejected', 2, [10, 5]);

      expect(result.accepted).toBe(false);
      expect(result.refundReason).toContain('closed');

      const log = await PaymentLog.findOne({ txId: 'tx-rejected' });
      expect(log).not.toBeNull();
      expect(log!.metadata.rejected).toBe(true);
      expect(log!.metadata.receivedAmounts).toEqual([10, 5]);
      expect(log!.metadata.refundReason).toBeDefined();
    });
  });

  describe('Payout logging with sentAmounts', () => {
    it('should log payout with sentAmounts in metadata', async () => {
      // Setup: Create round with a winning bet
      const round = await GameService.createRound();
      const { invoice } = await GameService.placeBets('frank', [{ digit: 0, amount: 10 }]);
      await GameService.confirmPayment(invoice.invoiceId, 'tx-bet');

      // Close and draw winner (force digit 0)
      await GameService.closeRound(round._id.toString());

      // Manually set winning digit to 0 for deterministic test
      await Round.findByIdAndUpdate(round._id, {
        status: 'drawing',
        winningDigit: 0,
        drawTime: new Date(),
      });

      // Calculate winnings
      const updatedRound = (await Round.findById(round._id))!;
      await GameService.calculateWinnings(updatedRound as any);

      await Round.findByIdAndUpdate(round._id, { status: 'paying' });

      // Process payouts
      await GameService.processPayouts(round._id.toString());

      // Check payout log
      const payoutLog = await PaymentLog.findOne({ purpose: 'payout' });
      expect(payoutLog).not.toBeNull();
      expect(payoutLog!.type).toBe('outgoing');
      expect(payoutLog!.metadata.sentAmounts).toBeDefined();
      expect(Array.isArray(payoutLog!.metadata.sentAmounts)).toBe(true);
    });
  });

  describe('Payment log structure', () => {
    it('should create incoming log for bet payment', async () => {
      const { invoice } = await GameService.placeBets('grace', [
        { digit: 5, amount: 3 },
        { digit: 8, amount: 7 },
      ]);

      await GameService.confirmPayment(invoice.invoiceId, 'tx-grace', 1, [10]);

      const log = await PaymentLog.findOne({ txId: 'tx-grace' });
      expect(log).not.toBeNull();
      expect(log!.type).toBe('incoming');
      expect(log!.amount).toBe(10);
      expect(log!.purpose).toBe('bet_payment');
      expect(log!.fromNametag).toBe('grace');
      expect(log!.metadata.bets).toHaveLength(2);
    });

    it('should include round number in metadata', async () => {
      const round = await GameService.getCurrentRound();
      const { invoice } = await GameService.placeBets('henry', [{ digit: 1, amount: 5 }]);

      await GameService.confirmPayment(invoice.invoiceId, 'tx-henry');

      const log = await PaymentLog.findOne({ txId: 'tx-henry' });
      expect(log!.metadata.roundNumber).toBe(round.roundNumber);
    });
  });
});
