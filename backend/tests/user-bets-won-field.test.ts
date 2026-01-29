import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import request from 'supertest';
import { Application } from 'express';
import { createTestApp, connectTestDB, disconnectTestDB, clearTestDB } from './setup.js';
import mongoose from 'mongoose';

// Mock sphereService with sentAmounts
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
  identityService: {
    initialize: vi.fn(),
    getNametag: vi.fn().mockReturnValue('test-agent'),
  },
  roundScheduler: {
    start: vi.fn(),
    stop: vi.fn(),
  },
  initializeServices: vi.fn(),
}));

import { GameService } from '../src/services/game.service.js';
import { Round, Bet } from '../src/models/game.model.js';

let app: Application;

describe('getUserBets with won field', () => {
  beforeAll(async () => {
    await mongoose.connect('mongodb://localhost:27017/lottery-test-won-field');
    app = await createTestApp();
  });

  afterAll(async () => {
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  });

  beforeEach(async () => {
    await Round.deleteMany({});
    await Bet.deleteMany({});
  });

  describe('GET /api/game/bets/:userNametag', () => {
    it('should return won: null for pending bet (round not completed)', async () => {
      // Place a bet but don't complete the round
      const { invoice } = await GameService.placeBets('alice', [{ digit: 5, amount: 10 }]);
      await GameService.confirmPayment(invoice.invoiceId, 'tx-1');

      const res = await request(app).get('/api/game/bets/alice');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toHaveLength(1);
      expect(res.body.data[0].won).toBeNull();
    });

    it('should return won: true for winning bet', async () => {
      // Create round and place bet on digit 3
      const round = await GameService.createRound();
      const { invoice } = await GameService.placeBets('bob', [{ digit: 3, amount: 10 }]);
      await GameService.confirmPayment(invoice.invoiceId, 'tx-2');

      // Close round and set winning digit to 3
      await GameService.closeRound(round._id.toString());
      await Round.findByIdAndUpdate(round._id, {
        status: 'completed',
        winningDigit: 3,
        drawTime: new Date(),
      });

      // Set winnings for the bet
      await Bet.findOneAndUpdate({ invoiceId: invoice.invoiceId }, { winnings: 9.5 });

      const res = await request(app).get('/api/game/bets/bob');

      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(1);
      expect(res.body.data[0].won).toBe(true);
      expect(res.body.data[0].winnings).toBe(9.5);
    });

    it('should return won: false for losing bet', async () => {
      // Create round and place bet on digit 5
      const round = await GameService.createRound();
      const { invoice } = await GameService.placeBets('carol', [{ digit: 5, amount: 10 }]);
      await GameService.confirmPayment(invoice.invoiceId, 'tx-3');

      // Close round and set winning digit to 7 (different from bet)
      await GameService.closeRound(round._id.toString());
      await Round.findByIdAndUpdate(round._id, {
        status: 'completed',
        winningDigit: 7, // Different from bet digit (5)
        drawTime: new Date(),
      });

      const res = await request(app).get('/api/game/bets/carol');

      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(1);
      expect(res.body.data[0].won).toBe(false);
      expect(res.body.data[0].winnings).toBe(0);
    });

    it('should return won: null for unpaid bet', async () => {
      // Place bet but don't confirm payment
      await GameService.placeBets('dave', [{ digit: 1, amount: 5 }]);

      const res = await request(app).get('/api/game/bets/dave');

      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(1);
      expect(res.body.data[0].paymentStatus).toBe('pending');
      expect(res.body.data[0].won).toBeNull();
    });

    it('should return multiple bets with mixed results', async () => {
      // Round 1 - bet on 5, wins with 5
      const round1 = await GameService.createRound();
      const { invoice: inv1 } = await GameService.placeBets('eve', [{ digit: 5, amount: 10 }]);
      await GameService.confirmPayment(inv1.invoiceId, 'tx-4');
      await GameService.closeRound(round1._id.toString());
      await Round.findByIdAndUpdate(round1._id, {
        status: 'completed',
        winningDigit: 5,
      });
      await Bet.findOneAndUpdate({ invoiceId: inv1.invoiceId }, { winnings: 9.5 });

      // Round 2 - bet on 3, loses with 8
      const round2 = await GameService.createRound();
      const { invoice: inv2 } = await GameService.placeBets('eve', [{ digit: 3, amount: 5 }]);
      await GameService.confirmPayment(inv2.invoiceId, 'tx-5');
      await GameService.closeRound(round2._id.toString());
      await Round.findByIdAndUpdate(round2._id, {
        status: 'completed',
        winningDigit: 8,
      });

      // Round 3 - pending bet
      await GameService.createRound();
      const { invoice: inv3 } = await GameService.placeBets('eve', [{ digit: 0, amount: 7 }]);
      await GameService.confirmPayment(inv3.invoiceId, 'tx-6');

      const res = await request(app).get('/api/game/bets/eve?limit=10');

      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(3);

      // Results are ordered by createdAt DESC (newest first)
      const results = res.body.data;

      // Find each bet by amount for deterministic assertions
      const winningBet = results.find((b: any) => b.totalAmount === 10);
      const losingBet = results.find((b: any) => b.totalAmount === 5);
      const pendingBet = results.find((b: any) => b.totalAmount === 7);

      expect(winningBet.won).toBe(true);
      expect(losingBet.won).toBe(false);
      expect(pendingBet.won).toBeNull();
    });

    it('should return empty array for user with no bets', async () => {
      const res = await request(app).get('/api/game/bets/nobody');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toEqual([]);
    });

    it('should respect limit parameter', async () => {
      // Create 5 bets
      for (let i = 0; i < 5; i++) {
        const { invoice } = await GameService.placeBets('frank', [{ digit: i, amount: 1 }]);
        await GameService.confirmPayment(invoice.invoiceId, `tx-limit-${i}`);
      }

      const res = await request(app).get('/api/game/bets/frank?limit=3');

      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(3);
    });

    it('should populate round information', async () => {
      const round = await GameService.createRound();
      const { invoice } = await GameService.placeBets('grace', [{ digit: 9, amount: 20 }]);
      await GameService.confirmPayment(invoice.invoiceId, 'tx-grace');
      await GameService.closeRound(round._id.toString());
      await Round.findByIdAndUpdate(round._id, {
        status: 'completed',
        winningDigit: 9,
      });
      await Bet.findOneAndUpdate({ invoiceId: invoice.invoiceId }, { winnings: 19 });

      const res = await request(app).get('/api/game/bets/grace');

      expect(res.status).toBe(200);
      const bet = res.body.data[0];

      // roundId should be populated with round details
      expect(bet.roundId).toBeDefined();
      expect(typeof bet.roundId).toBe('object');
      expect(bet.roundId.roundNumber).toBe(round.roundNumber);
      expect(bet.roundId.winningDigit).toBe(9);
      expect(bet.won).toBe(true);
    });
  });
});
