import { config } from '../env.js';
import { IdentityService, IdentityConfig } from './identity.service.js';
import { NostrService, NostrConfig } from './nostr.service.js';
import { RoundScheduler } from './round-scheduler.service.js';

// eslint-disable-next-line no-console
console.log(
  `[Config] MOCK_MODE: ${config.mockMode}, ROUND_DURATION: ${config.roundDurationSeconds}s`
);

const identityConfig: IdentityConfig = {
  dataDir: config.dataDir,
  nametag: config.agentNametag,
  aggregatorUrl: config.aggregatorUrl,
  aggregatorApiKey: config.aggregatorApiKey,
  relayUrl: config.nostrRelayUrl,
  privateKeyHex: config.agentPrivateKey || undefined,
};

const nostrConfig: NostrConfig = {
  relayUrl: config.nostrRelayUrl,
  dataDir: config.dataDir,
  paymentTimeoutSeconds: config.paymentTimeoutSeconds,
  coinId: config.coinId,
  mockMode: config.mockMode,
};

// Create service instances
export const identityService = new IdentityService(identityConfig);
export const nostrService = new NostrService(nostrConfig, identityService);
export const roundScheduler = new RoundScheduler(config.roundDurationSeconds);

// Initialize services
export async function initializeServices(): Promise<void> {
  await identityService.initialize();
  await nostrService.initialize();

  // Set up payment confirmation callback - auto-confirm payments via Nostr
  nostrService.setPaymentConfirmedCallback(async (invoiceId, txId) => {
    // eslint-disable-next-line no-console
    console.log(`[Services] Payment received via Nostr: ${invoiceId}, txId: ${txId}`);

    // Dynamically import to avoid circular dependency
    const { GameService } = await import('./game.service.js');

    try {
      const result = await GameService.confirmPayment(invoiceId, txId);

      if (result.accepted) {
        // eslint-disable-next-line no-console
        console.log(`[Services] Payment accepted for invoice: ${invoiceId}`);
      } else {
        // eslint-disable-next-line no-console
        console.log(
          `[Services] Payment rejected for invoice: ${invoiceId} - ${result.refundReason}`
        );
      }
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error(`[Services] Failed to process payment:`, error);
    }
  });

  // Start round scheduler
  await roundScheduler.start();
}

export { IdentityService, NostrService, RoundScheduler };
