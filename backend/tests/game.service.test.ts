import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import { vi } from 'vitest';

// Mock sphereService before importing GameService
vi.mock('../src/services/index.js', () => ({
  sphereService: {
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
      transactionCount: 1,
      sentAmounts: [amount],
    })),
  },
}));

import { GameService } from '../src/services/game.service.js';
import { Round, Bet } from '../src/models/game.model.js';

describe('GameService', () => {
  beforeAll(async () => {
    await mongoose.connect('mongodb://localhost:27017/lottery-test-game-service');
  });

  afterAll(async () => {
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  });

  beforeEach(async () => {
    await Round.deleteMany({});
    await Bet.deleteMany({});
  });

  describe('generateWinningDigit', () => {
    it('should generate a digit between 0 and 9', () => {
      for (let i = 0; i < 100; i++) {
        const digit = GameService.generateWinningDigit();
        expect(digit).toBeGreaterThanOrEqual(0);
        expect(digit).toBeLessThanOrEqual(9);
        expect(Number.isInteger(digit)).toBe(true);
      }
    });
  });

  describe('createRound', () => {
    it('should create first round with number 1', async () => {
      const round = await GameService.createRound();

      expect(round.roundNumber).toBe(1);
      expect(round.status).toBe('open');
      expect(round.totalPool).toBe(0);
      expect(round.winningDigit).toBeNull();
    });

    it('should increment round number', async () => {
      await GameService.createRound();
      const round2 = await GameService.createRound();

      expect(round2.roundNumber).toBe(2);
    });
  });

  describe('getCurrentRound', () => {
    it('should create new round if none exists', async () => {
      const round = await GameService.getCurrentRound();

      expect(round).toBeDefined();
      expect(round.status).toBe('open');
    });

    it('should return existing open round', async () => {
      const created = await GameService.createRound();
      const current = await GameService.getCurrentRound();

      expect(current._id.toString()).toBe(created._id.toString());
    });

    it('should not return closed rounds', async () => {
      const round1 = await GameService.createRound();
      await GameService.closeRound(round1._id.toString());

      const current = await GameService.getCurrentRound();

      expect(current._id.toString()).not.toBe(round1._id.toString());
      expect(current.roundNumber).toBe(2);
    });
  });

  describe('placeBets', () => {
    it('should create bet with invoice', async () => {
      const result = await GameService.placeBets('alice', [{ digit: 5, amount: 100 }]);

      expect(result.bet.userNametag).toBe('alice');
      expect(result.bet.totalAmount).toBe(100);
      expect(result.bet.paymentStatus).toBe('pending');
      expect(result.invoice).toBeDefined();
      expect(result.invoice.amount).toBe(100);
    });

    it('should handle multiple bets in single call', async () => {
      const result = await GameService.placeBets('bob', [
        { digit: 1, amount: 50 },
        { digit: 7, amount: 100 },
        { digit: 9, amount: 25 },
      ]);

      expect(result.bet.bets).toHaveLength(3);
      expect(result.bet.totalAmount).toBe(175);
    });

    it('should reject empty bets array', async () => {
      await expect(GameService.placeBets('charlie', [])).rejects.toThrow('At least one bet required');
    });

    it('should reject invalid digit > 9', async () => {
      await expect(GameService.placeBets('dave', [{ digit: 10, amount: 100 }])).rejects.toThrow(
        'Digit must be between 0 and 9'
      );
    });

    it('should reject invalid digit < 0', async () => {
      await expect(GameService.placeBets('eve', [{ digit: -1, amount: 100 }])).rejects.toThrow(
        'Digit must be between 0 and 9'
      );
    });

    it('should reject zero amount', async () => {
      await expect(GameService.placeBets('frank', [{ digit: 5, amount: 0 }])).rejects.toThrow(
        'Amount must be positive'
      );
    });

    it('should reject negative amount', async () => {
      await expect(GameService.placeBets('grace', [{ digit: 5, amount: -50 }])).rejects.toThrow(
        'Amount must be positive'
      );
    });

    it('should create new round when previous is closed', async () => {
      // Create and close first round
      const round1 = await GameService.createRound();
      await GameService.closeRound(round1._id.toString());

      // placeBets calls getCurrentRound which creates a new round if none is open
      const result = await GameService.placeBets('henry', [{ digit: 3, amount: 100 }]);

      // Bet should be on a new round (round 2)
      const round2 = await GameService.getCurrentRound();
      expect(round2.roundNumber).toBe(2);
      expect(result.bet.roundId.toString()).toBe(round2._id.toString());
    });
  });

  describe('confirmPayment', () => {
    it('should confirm payment and update bet status', async () => {
      const { bet, invoice } = await GameService.placeBets('ivan', [{ digit: 2, amount: 200 }]);

      const result = await GameService.confirmPayment(invoice.invoiceId, 'tx-123');

      expect(result.accepted).toBe(true);
      expect(result.bet.paymentStatus).toBe('paid');
      expect(result.bet.paymentTxId).toBe('tx-123');
    });

    it('should update round pool on payment', async () => {
      const round = await GameService.getCurrentRound();
      const { invoice } = await GameService.placeBets('julia', [{ digit: 4, amount: 300 }]);

      await GameService.confirmPayment(invoice.invoiceId, 'tx-456');

      const updatedRound = await Round.findById(round._id);
      expect(updatedRound!.totalPool).toBe(300);
    });

    it('should accumulate pool from multiple payments', async () => {
      const { invoice: inv1 } = await GameService.placeBets('kate', [{ digit: 1, amount: 100 }]);
      const { invoice: inv2 } = await GameService.placeBets('leo', [{ digit: 2, amount: 200 }]);

      await GameService.confirmPayment(inv1.invoiceId, 'tx-1');
      await GameService.confirmPayment(inv2.invoiceId, 'tx-2');

      const round = await GameService.getCurrentRound();
      expect(round.totalPool).toBe(300);
    });

    it('should be idempotent (double confirm returns same result)', async () => {
      const { invoice } = await GameService.placeBets('mike', [{ digit: 6, amount: 150 }]);

      const first = await GameService.confirmPayment(invoice.invoiceId, 'tx-first');
      const second = await GameService.confirmPayment(invoice.invoiceId, 'tx-second');

      expect(first.bet.paymentTxId).toBe('tx-first');
      expect(second.bet.paymentTxId).toBe('tx-first'); // Should not change
    });

    it('should throw on unknown invoice', async () => {
      await expect(GameService.confirmPayment('unknown-invoice', 'tx-xxx')).rejects.toThrow(
        'Bet not found'
      );
    });
  });

  describe('closeRound', () => {
    it('should close open round', async () => {
      const round = await GameService.createRound();

      const closed = await GameService.closeRound(round._id.toString());

      expect(closed.status).toBe('closed');
      expect(closed.endTime).toBeDefined();
    });

    it('should throw on non-existent round', async () => {
      const fakeId = new mongoose.Types.ObjectId().toString();
      await expect(GameService.closeRound(fakeId)).rejects.toThrow('Round not found');
    });

    it('should throw on already closed round', async () => {
      const round = await GameService.createRound();
      await GameService.closeRound(round._id.toString());

      await expect(GameService.closeRound(round._id.toString())).rejects.toThrow(
        'Round not found or not open'
      );
    });
  });

  describe('drawWinner', () => {
    it('should draw winning digit', async () => {
      const round = await GameService.createRound();
      await GameService.closeRound(round._id.toString());

      const drawn = await GameService.drawWinner(round._id.toString());

      expect(drawn.status).toBe('paying');
      expect(drawn.winningDigit).toBeGreaterThanOrEqual(0);
      expect(drawn.winningDigit).toBeLessThanOrEqual(9);
      expect(drawn.drawTime).toBeDefined();
    });

    it('should calculate winnings for winners (pari-mutuel pool)', async () => {
      const round = await GameService.createRound();

      // Place and pay bets
      const { invoice } = await GameService.placeBets('winner', [{ digit: 5, amount: 100 }]);
      await GameService.confirmPayment(invoice.invoiceId, 'tx-win');

      await GameService.closeRound(round._id.toString());

      // Mock winning digit to 5
      vi.spyOn(GameService, 'generateWinningDigit').mockReturnValueOnce(5);

      await GameService.drawWinner(round._id.toString());

      const bet = await Bet.findOne({ userNametag: 'winner' });
      // Pari-mutuel: winner gets pool minus house fee (5%)
      // Pool is 100, house fee is 5, so winner gets 95
      expect(bet!.winnings).toBe(95);
      expect(bet!.payoutStatus).toBe('pending');
    });

    it('should not award winnings to losers', async () => {
      const round = await GameService.createRound();

      const { invoice } = await GameService.placeBets('loser', [{ digit: 3, amount: 100 }]);
      await GameService.confirmPayment(invoice.invoiceId, 'tx-lose');

      await GameService.closeRound(round._id.toString());

      // Mock winning digit to 7 (not 3)
      vi.spyOn(GameService, 'generateWinningDigit').mockReturnValueOnce(7);

      await GameService.drawWinner(round._id.toString());

      const bet = await Bet.findOne({ userNametag: 'loser' });
      expect(bet!.winnings).toBe(0);
      expect(bet!.payoutStatus).toBe('none');
    });

    it('should throw on open round', async () => {
      const round = await GameService.createRound();

      await expect(GameService.drawWinner(round._id.toString())).rejects.toThrow(
        'Round not found or not closed'
      );
    });
  });

  describe('processPayouts', () => {
    it('should process payouts for winners', async () => {
      const round = await GameService.createRound();

      const { invoice } = await GameService.placeBets('payout-winner', [{ digit: 8, amount: 50 }]);
      await GameService.confirmPayment(invoice.invoiceId, 'tx-pw');

      await GameService.closeRound(round._id.toString());
      vi.spyOn(GameService, 'generateWinningDigit').mockReturnValueOnce(8);
      await GameService.drawWinner(round._id.toString());

      const result = await GameService.processPayouts(round._id.toString());

      expect(result.processed).toBe(1);
      expect(result.failed).toBe(0);

      const bet = await Bet.findOne({ userNametag: 'payout-winner' });
      expect(bet!.payoutStatus).toBe('confirmed');
    });

    it('should complete round after all payouts', async () => {
      const round = await GameService.createRound();

      const { invoice } = await GameService.placeBets('completer', [{ digit: 0, amount: 100 }]);
      await GameService.confirmPayment(invoice.invoiceId, 'tx-complete');

      await GameService.closeRound(round._id.toString());
      vi.spyOn(GameService, 'generateWinningDigit').mockReturnValueOnce(0);
      await GameService.drawWinner(round._id.toString());
      await GameService.processPayouts(round._id.toString());

      const completedRound = await Round.findById(round._id);
      expect(completedRound!.status).toBe('completed');
    });

    it('should handle round with no winners', async () => {
      const round = await GameService.createRound();

      const { invoice } = await GameService.placeBets('no-win', [{ digit: 1, amount: 100 }]);
      await GameService.confirmPayment(invoice.invoiceId, 'tx-nw');

      await GameService.closeRound(round._id.toString());
      vi.spyOn(GameService, 'generateWinningDigit').mockReturnValueOnce(9); // Different digit
      await GameService.drawWinner(round._id.toString());

      const result = await GameService.processPayouts(round._id.toString());

      expect(result.processed).toBe(0);
      expect(result.failed).toBe(0);

      const completedRound = await Round.findById(round._id);
      expect(completedRound!.status).toBe('completed');
    });
  });

  describe('getRoundHistory', () => {
    it('should return completed rounds', async () => {
      // Create and complete a round
      const round = await GameService.createRound();
      await GameService.closeRound(round._id.toString());
      await GameService.drawWinner(round._id.toString());
      await GameService.processPayouts(round._id.toString());

      const history = await GameService.getRoundHistory();

      expect(history).toHaveLength(1);
      expect(history[0].status).toBe('completed');
    });

    it('should respect limit parameter', async () => {
      // Create 3 completed rounds
      for (let i = 0; i < 3; i++) {
        const round = await GameService.createRound();
        await GameService.closeRound(round._id.toString());
        await GameService.drawWinner(round._id.toString());
        await GameService.processPayouts(round._id.toString());
      }

      const history = await GameService.getRoundHistory(2);

      expect(history).toHaveLength(2);
    });

    it('should return newest first', async () => {
      for (let i = 0; i < 3; i++) {
        const round = await GameService.createRound();
        await GameService.closeRound(round._id.toString());
        await GameService.drawWinner(round._id.toString());
        await GameService.processPayouts(round._id.toString());
      }

      const history = await GameService.getRoundHistory();

      expect(history[0].roundNumber).toBeGreaterThan(history[1].roundNumber);
    });
  });

  describe('getUserBets', () => {
    it('should return bets for specific user', async () => {
      const { invoice } = await GameService.placeBets('specific-user', [{ digit: 5, amount: 100 }]);
      await GameService.confirmPayment(invoice.invoiceId, 'tx-su');

      // Another user's bet
      const { invoice: inv2 } = await GameService.placeBets('other-user', [{ digit: 3, amount: 50 }]);
      await GameService.confirmPayment(inv2.invoiceId, 'tx-ou');

      const bets = await GameService.getUserBets('specific-user');

      expect(bets).toHaveLength(1);
      expect(bets[0].userNametag).toBe('specific-user');
    });

    it('should populate round info', async () => {
      const { invoice } = await GameService.placeBets('populated-user', [{ digit: 2, amount: 75 }]);
      await GameService.confirmPayment(invoice.invoiceId, 'tx-pop');

      const bets = await GameService.getUserBets('populated-user');

      expect(bets[0].roundId).toBeDefined();
      expect((bets[0].roundId as any).roundNumber).toBeDefined();
    });
  });

  describe('getRoundBets', () => {
    it('should return only paid bets for round', async () => {
      const round = await GameService.getCurrentRound();

      // Paid bet
      const { invoice: paidInv } = await GameService.placeBets('paid-user', [{ digit: 1, amount: 100 }]);
      await GameService.confirmPayment(paidInv.invoiceId, 'tx-paid');

      // Unpaid bet
      await GameService.placeBets('unpaid-user', [{ digit: 2, amount: 100 }]);

      const bets = await GameService.getRoundBets(round._id.toString());

      expect(bets).toHaveLength(1);
      expect(bets[0].userNametag).toBe('paid-user');
    });
  });
});
