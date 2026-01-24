import { Router } from 'express';
import { GameController } from '../controllers/game.controller.js';

const router = Router();

// GET /api/game/round - Get current round
router.get('/round', GameController.getCurrentRound);

// POST /api/game/bet - Place bets (payment request sent via Nostr)
router.post('/bet', GameController.placeBets);

// GET /api/game/round/:roundId/bets - Get bets for a round
router.get('/round/:roundId/bets', GameController.getRoundBets);

// GET /api/game/history - Get round history
router.get('/history', GameController.getRoundHistory);

// GET /api/game/bets/:userNametag - Get user bet history
router.get('/bets/:userNametag', GameController.getUserBets);

export default router;
