import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import { Application } from 'express';
import { createTestApp, connectTestDB, disconnectTestDB, clearTestDB } from './setup.js';
import { vi } from 'vitest';

// Mock sphereService
vi.mock('../src/services/index.js', () => ({
  sphereService: {
    createInvoice: vi.fn().mockImplementation(async (_userNametag: string, amount: number) => ({
      invoiceId: `test-invoice-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      amount,
      recipientNametag: 'test-agent',
      status: 'pending',
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 120000),
    })),
    sendTokens: vi.fn().mockImplementation(async (toNametag: string, amount: number) => ({
      transferId: `test-transfer-${Date.now()}`,
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

// Helper functions
async function simulateNostrPayment(invoiceId: string, txId: string) {
  const { GameService } = await import('../src/services/game.service.js');
  const result = await GameService.confirmPayment(invoiceId, txId);
  return result.bet;
}

async function simulateRoundEnd(roundId: string) {
  const { GameService } = await import('../src/services/game.service.js');
  await GameService.closeRound(roundId);
  await GameService.drawWinner(roundId);
  await GameService.processPayouts(roundId);
}

let app: Application;

describe('API Integration Tests', () => {
  beforeAll(async () => {
    await connectTestDB();
    app = await createTestApp();
  });

  afterAll(async () => {
    await disconnectTestDB();
  });

  beforeEach(async () => {
    await clearTestDB();
  });

  // ==================== HEALTH CHECK ====================
  describe('GET /health', () => {
    it('should return 200 with status ok', async () => {
      const res = await request(app).get('/health');

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('ok');
    });
  });

  // ==================== ROUND ENDPOINTS ====================
  describe('GET /api/game/round', () => {
    it('should return current open round', async () => {
      const res = await request(app).get('/api/game/round');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.status).toBe('open');
      expect(res.body.data.roundNumber).toBe(1);
      expect(res.body.data.totalPool).toBe(0);
    });

    it('should return same round on subsequent calls', async () => {
      const res1 = await request(app).get('/api/game/round');
      const res2 = await request(app).get('/api/game/round');

      expect(res1.body.data._id).toBe(res2.body.data._id);
      expect(res1.body.data.roundNumber).toBe(res2.body.data.roundNumber);
    });

    it('should include startTime', async () => {
      const res = await request(app).get('/api/game/round');

      expect(res.body.data.startTime).toBeDefined();
      expect(new Date(res.body.data.startTime).getTime()).toBeLessThanOrEqual(Date.now());
    });
  });

  // ==================== BET ENDPOINTS ====================
  describe('POST /api/game/bet', () => {
    it('should create bet and return invoice', async () => {
      const res = await request(app)
        .post('/api/game/bet')
        .send({
          userNametag: 'player1',
          bets: [{ digit: 7, amount: 100 }],
        });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.bet).toBeDefined();
      expect(res.body.data.bet.userNametag).toBe('player1');
      expect(res.body.data.bet.totalAmount).toBe(100);
      expect(res.body.data.bet.paymentStatus).toBe('pending');
      expect(res.body.data.invoice).toBeDefined();
      expect(res.body.data.invoice.invoiceId).toBeDefined();
      expect(res.body.data.invoice.amount).toBe(100);
    });

    it('should accept multiple digit bets', async () => {
      const res = await request(app)
        .post('/api/game/bet')
        .send({
          userNametag: 'multi-bettor',
          bets: [
            { digit: 0, amount: 10 },
            { digit: 5, amount: 50 },
            { digit: 9, amount: 40 },
          ],
        });

      expect(res.status).toBe(200);
      expect(res.body.data.bet.bets).toHaveLength(3);
      expect(res.body.data.bet.totalAmount).toBe(100);
    });

    it('should return 400 for missing userNametag', async () => {
      const res = await request(app)
        .post('/api/game/bet')
        .send({ bets: [{ digit: 5, amount: 100 }] });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toContain('Missing required fields');
    });

    it('should return 400 for missing bets', async () => {
      const res = await request(app)
        .post('/api/game/bet')
        .send({ userNametag: 'player' });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
    });

    it('should return 400 for empty bets array', async () => {
      const res = await request(app)
        .post('/api/game/bet')
        .send({ userNametag: 'player', bets: [] });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
    });

    it('should return 400 for invalid digit (>9)', async () => {
      const res = await request(app)
        .post('/api/game/bet')
        .send({
          userNametag: 'player',
          bets: [{ digit: 10, amount: 100 }],
        });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('Digit must be between 0 and 9');
    });

    it('should return 400 for invalid digit (<0)', async () => {
      const res = await request(app)
        .post('/api/game/bet')
        .send({
          userNametag: 'player',
          bets: [{ digit: -1, amount: 100 }],
        });

      expect(res.status).toBe(400);
    });

    it('should return 400 for zero amount', async () => {
      const res = await request(app)
        .post('/api/game/bet')
        .send({
          userNametag: 'player',
          bets: [{ digit: 5, amount: 0 }],
        });

      expect(res.status).toBe(400);
    });

    it('should return 400 for negative amount', async () => {
      const res = await request(app)
        .post('/api/game/bet')
        .send({
          userNametag: 'player',
          bets: [{ digit: 5, amount: -100 }],
        });

      expect(res.status).toBe(400);
    });
  });

  // ==================== ROUND BETS ENDPOINT ====================
  describe('GET /api/game/round/:roundId/bets', () => {
    it('should return paid bets for round', async () => {
      const roundRes = await request(app).get('/api/game/round');
      const roundId = roundRes.body.data._id;

      // Create and pay bet
      const betRes = await request(app)
        .post('/api/game/bet')
        .send({ userNametag: 'bettor', bets: [{ digit: 3, amount: 100 }] });

      await simulateNostrPayment(betRes.body.data.invoice.invoiceId, 'tx-1');

      const res = await request(app).get(`/api/game/round/${roundId}/bets`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toHaveLength(1);
      expect(res.body.data[0].userNametag).toBe('bettor');
      expect(res.body.data[0].paymentStatus).toBe('paid');
    });

    it('should not return unpaid bets', async () => {
      const roundRes = await request(app).get('/api/game/round');
      const roundId = roundRes.body.data._id;

      // Create bet but don't pay
      await request(app)
        .post('/api/game/bet')
        .send({ userNametag: 'unpaid', bets: [{ digit: 1, amount: 50 }] });

      const res = await request(app).get(`/api/game/round/${roundId}/bets`);

      expect(res.body.data).toHaveLength(0);
    });

    it('should return 500 for invalid round ID', async () => {
      const res = await request(app).get('/api/game/round/invalid-id/bets');

      expect(res.status).toBe(500);
    });
  });

  // ==================== HISTORY ENDPOINT ====================
  describe('GET /api/game/history', () => {
    it('should return empty array when no completed rounds', async () => {
      const res = await request(app).get('/api/game/history');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toEqual([]);
    });

    it('should return completed rounds', async () => {
      // Complete a round
      const roundRes = await request(app).get('/api/game/round');
      await simulateRoundEnd(roundRes.body.data._id);

      const res = await request(app).get('/api/game/history');

      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(1);
      expect(res.body.data[0].status).toBe('completed');
      expect(res.body.data[0].winningDigit).toBeGreaterThanOrEqual(0);
      expect(res.body.data[0].winningDigit).toBeLessThanOrEqual(9);
    });

    it('should respect limit parameter', async () => {
      // Complete 3 rounds
      for (let i = 0; i < 3; i++) {
        const roundRes = await request(app).get('/api/game/round');
        await simulateRoundEnd(roundRes.body.data._id);
      }

      const res = await request(app).get('/api/game/history?limit=2');

      expect(res.body.data).toHaveLength(2);
    });

    it('should return newest first', async () => {
      // Complete 2 rounds
      const round1Res = await request(app).get('/api/game/round');
      await simulateRoundEnd(round1Res.body.data._id);

      const round2Res = await request(app).get('/api/game/round');
      await simulateRoundEnd(round2Res.body.data._id);

      const res = await request(app).get('/api/game/history');

      expect(res.body.data[0].roundNumber).toBe(2);
      expect(res.body.data[1].roundNumber).toBe(1);
    });
  });

  // ==================== USER BETS ENDPOINT ====================
  describe('GET /api/game/bets/:userNametag', () => {
    it('should return bets for specific user', async () => {
      // Create bet for target user
      const bet1 = await request(app)
        .post('/api/game/bet')
        .send({ userNametag: 'alice', bets: [{ digit: 5, amount: 100 }] });
      await simulateNostrPayment(bet1.body.data.invoice.invoiceId, 'tx-alice');

      // Create bet for other user
      const bet2 = await request(app)
        .post('/api/game/bet')
        .send({ userNametag: 'bob', bets: [{ digit: 3, amount: 50 }] });
      await simulateNostrPayment(bet2.body.data.invoice.invoiceId, 'tx-bob');

      const res = await request(app).get('/api/game/bets/alice');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toHaveLength(1);
      expect(res.body.data[0].userNametag).toBe('alice');
    });

    it('should return empty array for user with no bets', async () => {
      const res = await request(app).get('/api/game/bets/nobody');

      expect(res.status).toBe(200);
      expect(res.body.data).toEqual([]);
    });

    it('should include round info in response', async () => {
      const betRes = await request(app)
        .post('/api/game/bet')
        .send({ userNametag: 'charlie', bets: [{ digit: 7, amount: 200 }] });
      await simulateNostrPayment(betRes.body.data.invoice.invoiceId, 'tx-charlie');

      const res = await request(app).get('/api/game/bets/charlie');

      expect(res.body.data[0].roundId).toBeDefined();
      expect(res.body.data[0].roundId.roundNumber).toBeDefined();
    });

    it('should respect limit parameter', async () => {
      // Create 3 bets for same user across different rounds
      for (let i = 0; i < 3; i++) {
        const betRes = await request(app)
          .post('/api/game/bet')
          .send({ userNametag: 'frequent', bets: [{ digit: i, amount: 10 }] });
        await simulateNostrPayment(betRes.body.data.invoice.invoiceId, `tx-${i}`);

        // Complete round to get new one
        if (i < 2) {
          const roundRes = await request(app).get('/api/game/round');
          await simulateRoundEnd(roundRes.body.data._id);
        }
      }

      const res = await request(app).get('/api/game/bets/frequent?limit=2');

      expect(res.body.data).toHaveLength(2);
    });
  });

  // ==================== PAYMENT FLOW ====================
  describe('Payment Flow via Nostr', () => {
    it('should update bet status when payment confirmed', async () => {
      const betRes = await request(app)
        .post('/api/game/bet')
        .send({ userNametag: 'payer', bets: [{ digit: 4, amount: 150 }] });

      const invoiceId = betRes.body.data.invoice.invoiceId;

      // Simulate Nostr payment
      const confirmed = await simulateNostrPayment(invoiceId, 'nostr-tx-123');

      expect(confirmed.paymentStatus).toBe('paid');
      expect(confirmed.paymentTxId).toBe('nostr-tx-123');
    });

    it('should update round pool on payment', async () => {
      const roundRes = await request(app).get('/api/game/round');
      const initialPool = roundRes.body.data.totalPool;

      const betRes = await request(app)
        .post('/api/game/bet')
        .send({ userNametag: 'pool-contributor', bets: [{ digit: 8, amount: 500 }] });

      await simulateNostrPayment(betRes.body.data.invoice.invoiceId, 'tx-pool');

      const updatedRoundRes = await request(app).get('/api/game/round');
      expect(updatedRoundRes.body.data.totalPool).toBe(initialPool + 500);
    });
  });

  // ==================== FULL GAME CYCLE ====================
  describe('Full Game Cycle', () => {
    it('should complete full game with multiple players', async () => {
      // 1. Get round
      const roundRes = await request(app).get('/api/game/round');
      const roundId = roundRes.body.data._id;
      expect(roundRes.body.data.roundNumber).toBe(1);

      // 2. Multiple players place bets
      const players = [
        { name: 'alice', digit: 3, amount: 100 },
        { name: 'bob', digit: 5, amount: 200 },
        { name: 'charlie', digit: 7, amount: 150 },
        { name: 'dave', digit: 3, amount: 50 }, // Same digit as alice
      ];

      const invoices: string[] = [];

      for (const player of players) {
        const betRes = await request(app)
          .post('/api/game/bet')
          .send({ userNametag: player.name, bets: [{ digit: player.digit, amount: player.amount }] });

        expect(betRes.status).toBe(200);
        invoices.push(betRes.body.data.invoice.invoiceId);
      }

      // 3. Confirm all payments
      for (let i = 0; i < invoices.length; i++) {
        await simulateNostrPayment(invoices[i], `tx-player-${i}`);
      }

      // 4. Verify pool
      const poolRes = await request(app).get('/api/game/round');
      expect(poolRes.body.data.totalPool).toBe(500); // 100 + 200 + 150 + 50

      // 5. Complete round (simulating scheduler)
      await simulateRoundEnd(roundId);

      // 6. Verify history
      const historyRes = await request(app).get('/api/game/history');
      expect(historyRes.body.data).toHaveLength(1);
      expect(historyRes.body.data[0].status).toBe('completed');
      expect(historyRes.body.data[0].winningDigit).toBeDefined();

      // 7. New round should exist
      const newRoundRes = await request(app).get('/api/game/round');
      expect(newRoundRes.body.data.roundNumber).toBe(2);
      expect(newRoundRes.body.data.totalPool).toBe(0);

      // 8. Verify player bets are recorded
      const aliceBets = await request(app).get('/api/game/bets/alice');
      expect(aliceBets.body.data).toHaveLength(1);
    });
  });
});
