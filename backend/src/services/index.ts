import path from 'path';
import { IdentityService, IdentityConfig } from './identity.service.js';
import { NostrService, NostrConfig } from './nostr.service.js';

// Configuration from environment
const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), 'data');
const RELAY_URL = process.env.NOSTR_RELAY_URL || 'wss://nostr-relay.testnet.unicity.network';
const AGGREGATOR_URL = process.env.AGGREGATOR_URL || 'https://aggregator-test.unicity.network';
const AGGREGATOR_API_KEY = process.env.AGGREGATOR_API_KEY || 'sk_06365a9c44654841a366068bcfc68986';

const identityConfig: IdentityConfig = {
  dataDir: DATA_DIR,
  nametag: process.env.AGENT_NAMETAG || 'lottery-agent',
  aggregatorUrl: AGGREGATOR_URL,
  aggregatorApiKey: AGGREGATOR_API_KEY,
  relayUrl: RELAY_URL,
  privateKeyHex: process.env.AGENT_PRIVATE_KEY || undefined,
};

const nostrConfig: NostrConfig = {
  relayUrl: RELAY_URL,
  dataDir: DATA_DIR,
  paymentTimeoutSeconds: parseInt(process.env.PAYMENT_TIMEOUT_SECONDS || '120', 10),
  coinId: process.env.COIN_ID || '',
};

// Create service instances
export const identityService = new IdentityService(identityConfig);
export const nostrService = new NostrService(nostrConfig, identityService);

// Initialize services
export async function initializeServices(): Promise<void> {
  await identityService.initialize();
  await nostrService.initialize();

  // Set up payment confirmation callback
  nostrService.setPaymentConfirmedCallback((invoiceId, txId) => {
    // eslint-disable-next-line no-console
    console.log(`[Services] Payment confirmed: ${invoiceId}, txId: ${txId}`);
    // This will be handled by the game service via confirmPayment endpoint
  });
}

export { IdentityService, NostrService };
