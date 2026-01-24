import path from 'path';
import { IdentityService, IdentityConfig } from './identity.service.js';
import { NostrService, NostrConfig } from './nostr.service.js';
import { RoundScheduler } from './round-scheduler.service.js';

// Configuration from environment
const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), 'data');
const ROUND_DURATION_SECONDS = parseInt(process.env.ROUND_DURATION_SECONDS || '300', 10); // default 5 min
const RELAY_URL = process.env.NOSTR_RELAY_URL || 'wss://nostr-relay.testnet.unicity.network';
const AGGREGATOR_URL = process.env.AGGREGATOR_URL || 'https://goggregator-test.unicity.network';
const AGGREGATOR_API_KEY = process.env.AGGREGATOR_API_KEY || 'sk_06365a9c44654841a366068bcfc68986';

const identityConfig: IdentityConfig = {
  dataDir: DATA_DIR,
  nametag: process.env.AGENT_NAMETAG || 'lottery-agent',
  aggregatorUrl: AGGREGATOR_URL,
  aggregatorApiKey: AGGREGATOR_API_KEY,
  relayUrl: RELAY_URL,
  privateKeyHex: process.env.AGENT_PRIVATE_KEY || undefined,
};

const mockMode = process.env.MOCK_MODE === 'true';
console.log(`[Config] MOCK_MODE env: "${process.env.MOCK_MODE}", parsed: ${mockMode}`);

const nostrConfig: NostrConfig = {
  relayUrl: RELAY_URL,
  dataDir: DATA_DIR,
  paymentTimeoutSeconds: parseInt(process.env.PAYMENT_TIMEOUT_SECONDS || '120', 10),
  coinId: process.env.COIN_ID || '',
  mockMode,
};

// Create service instances
export const identityService = new IdentityService(identityConfig);
export const nostrService = new NostrService(nostrConfig, identityService);
export const roundScheduler = new RoundScheduler(ROUND_DURATION_SECONDS);

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
      await GameService.confirmPayment(invoiceId, txId);
      // eslint-disable-next-line no-console
      console.log(`[Services] Payment auto-confirmed for invoice: ${invoiceId}`);
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error(`[Services] Failed to auto-confirm payment:`, error);
    }
  });

  // Start round scheduler
  await roundScheduler.start();
}

export { IdentityService, NostrService, RoundScheduler };
