import { Request, Response } from 'express';
import { User } from '../models/user.model.js';

export class UserController {
  // Register or get user by nametag
  static async getOrCreateUser(req: Request, res: Response): Promise<void> {
    try {
      const { nametag } = req.body as { nametag: string };

      if (!nametag) {
        res.status(400).json({
          success: false,
          error: 'Missing nametag',
        });
        return;
      }

      let user = await User.findOne({ nametag });

      if (!user) {
        user = new User({ nametag });
        await user.save();
      }

      res.json({ success: true, data: user });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      res.status(500).json({ success: false, error: message });
    }
  }

  // Get user by nametag
  static async getUser(req: Request, res: Response): Promise<void> {
    try {
      const nametag = req.params.nametag as string;
      const user = await User.findOne({ nametag });

      if (!user) {
        res.status(404).json({ success: false, error: 'User not found' });
        return;
      }

      res.json({ success: true, data: user });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      res.status(500).json({ success: false, error: message });
    }
  }
}
