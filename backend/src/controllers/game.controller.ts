import { Request, Response } from 'express';
import { GameService } from '../services/game.service.js';
import { IBetItem } from '../models/game.model.js';

export class GameController {
  // Get current round info
  static async getCurrentRound(_req: Request, res: Response): Promise<void> {
    try {
      const round = await GameService.getCurrentRound();
      res.json({ success: true, data: round });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      res.status(500).json({ success: false, error: message });
    }
  }

  // Place bets - returns invoice for payment
  static async placeBets(req: Request, res: Response): Promise<void> {
    try {
      const { userNametag, bets } = req.body as {
        userNametag: string;
        bets: IBetItem[];
      };

      if (!userNametag || !bets) {
        res.status(400).json({
          success: false,
          error: 'Missing required fields: userNametag, bets',
        });
        return;
      }

      const result = await GameService.placeBets(userNametag, bets);
      res.json({ success: true, data: result });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      res.status(400).json({ success: false, error: message });
    }
  }

  // Confirm payment (webhook from Nostr or manual)
  static async confirmPayment(req: Request, res: Response): Promise<void> {
    try {
      const { invoiceId, txId } = req.body as { invoiceId: string; txId: string };

      if (!invoiceId || !txId) {
        res.status(400).json({
          success: false,
          error: 'Missing required fields: invoiceId, txId',
        });
        return;
      }

      const bet = await GameService.confirmPayment(invoiceId, txId);
      res.json({ success: true, data: bet });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      res.status(400).json({ success: false, error: message });
    }
  }

  // Close round (admin only)
  static async closeRound(req: Request, res: Response): Promise<void> {
    try {
      const roundId = req.params.roundId as string;
      const round = await GameService.closeRound(roundId);
      res.json({ success: true, data: round });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      res.status(400).json({ success: false, error: message });
    }
  }

  // Draw winner (admin only)
  static async drawWinner(req: Request, res: Response): Promise<void> {
    try {
      const roundId = req.params.roundId as string;
      const round = await GameService.drawWinner(roundId);
      res.json({ success: true, data: round });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      res.status(400).json({ success: false, error: message });
    }
  }

  // Process payouts (admin/cron)
  static async processPayouts(req: Request, res: Response): Promise<void> {
    try {
      const roundId = req.params.roundId as string;
      const result = await GameService.processPayouts(roundId);
      res.json({ success: true, data: result });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      res.status(500).json({ success: false, error: message });
    }
  }

  // Get round history
  static async getRoundHistory(req: Request, res: Response): Promise<void> {
    try {
      const limitParam = req.query.limit;
      const limit = typeof limitParam === 'string' ? parseInt(limitParam, 10) : 10;
      const rounds = await GameService.getRoundHistory(limit);
      res.json({ success: true, data: rounds });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      res.status(500).json({ success: false, error: message });
    }
  }

  // Get user bet history
  static async getUserBets(req: Request, res: Response): Promise<void> {
    try {
      const userNametag = req.params.userNametag as string;
      const limitParam = req.query.limit;
      const limit = typeof limitParam === 'string' ? parseInt(limitParam, 10) : 20;
      const bets = await GameService.getUserBets(userNametag, limit);
      res.json({ success: true, data: bets });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      res.status(500).json({ success: false, error: message });
    }
  }

  // Get bets for a specific round
  static async getRoundBets(req: Request, res: Response): Promise<void> {
    try {
      const roundId = req.params.roundId as string;
      const bets = await GameService.getRoundBets(roundId);
      res.json({ success: true, data: bets });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      res.status(500).json({ success: false, error: message });
    }
  }
}
