import { Router } from 'express';
import { GameController } from '../controllers/game.controller.js';

const router = Router();

// GET /api/game/round - Get current round
router.get('/round', GameController.getCurrentRound);

// POST /api/game/bet - Place bets (returns invoice)
router.post('/bet', GameController.placeBets);

// POST /api/game/payment/confirm - Confirm payment
router.post('/payment/confirm', GameController.confirmPayment);

// POST /api/game/round/:roundId/close - Close round (admin)
router.post('/round/:roundId/close', GameController.closeRound);

// POST /api/game/round/:roundId/draw - Draw winner (admin)
router.post('/round/:roundId/draw', GameController.drawWinner);

// POST /api/game/round/:roundId/payout - Process payouts (admin/cron)
router.post('/round/:roundId/payout', GameController.processPayouts);

// GET /api/game/round/:roundId/bets - Get bets for a round
router.get('/round/:roundId/bets', GameController.getRoundBets);

// GET /api/game/history - Get round history
router.get('/history', GameController.getRoundHistory);

// GET /api/game/bets/:userNametag - Get user bet history
router.get('/bets/:userNametag', GameController.getUserBets);

export default router;
