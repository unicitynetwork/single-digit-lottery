import fs from 'fs';
import path from 'path';
import {
  NostrClient,
  NostrKeyManager,
  Filter,
  EventKinds,
  TokenTransferProtocol,
} from '@unicitylabs/nostr-js-sdk';
import type { Event } from '@unicitylabs/nostr-js-sdk';
import { Token } from '@unicitylabs/state-transition-sdk/lib/token/Token.js';
import { TransferTransaction } from '@unicitylabs/state-transition-sdk/lib/transaction/TransferTransaction.js';
import { AddressScheme } from '@unicitylabs/state-transition-sdk/lib/address/AddressScheme.js';
import { UnmaskedPredicate } from '@unicitylabs/state-transition-sdk/lib/predicate/embedded/UnmaskedPredicate.js';
import { HashAlgorithm } from '@unicitylabs/state-transition-sdk/lib/hash/HashAlgorithm.js';
import { TokenState } from '@unicitylabs/state-transition-sdk/lib/token/TokenState.js';
import type { IdentityService } from './identity.service.js';

export interface NostrConfig {
  relayUrl: string;
  dataDir: string;
  paymentTimeoutSeconds: number;
  coinId: string;
  mockMode?: boolean;
}

export interface Invoice {
  invoiceId: string;
  amount: number;
  recipientNametag: string;
  status: 'pending' | 'paid' | 'expired';
  createdAt: Date;
  expiresAt: Date;
}

export interface TokenTransfer {
  transferId: string;
  toNametag: string;
  amount: number;
  status: 'pending' | 'sent' | 'confirmed' | 'failed';
  createdAt: Date;
}

export interface PendingPayment {
  eventId: string;
  invoiceId: string;
  userNametag: string;
  userPubkey: string;
  amount: number;
  createdAt: number;
  resolve: (result: { success: boolean; txId?: string }) => void;
}

export type PaymentConfirmedCallback = (invoiceId: string, txId: string) => void;

export class NostrService {
  private client: NostrClient | null = null;
  private keyManager: NostrKeyManager | null = null;
  private config: NostrConfig;
  private identityService: IdentityService;
  private pendingPayments: Map<string, PendingPayment> = new Map();
  private connected = false;
  private onPaymentConfirmed: PaymentConfirmedCallback | null = null;

  constructor(config: NostrConfig, identityService: IdentityService) {
    this.config = config;
    this.identityService = identityService;
  }

  setPaymentConfirmedCallback(callback: PaymentConfirmedCallback): void {
    this.onPaymentConfirmed = callback;
  }

  async initialize(): Promise<void> {
    if (this.connected) return;

    // eslint-disable-next-line no-console
    console.log(`[NostrService] Connecting to ${this.config.relayUrl}...`);

    const identity = this.identityService.getIdentity();
    const secretKey = Buffer.from(identity.privateKeyHex, 'hex');
    this.keyManager = NostrKeyManager.fromPrivateKey(secretKey);

    this.client = new NostrClient(this.keyManager, {
      queryTimeoutMs: 15000,
      autoReconnect: true,
      pingIntervalMs: 30000,
    });

    this.client.addConnectionListener({
      onConnect: (url): void => {
        // eslint-disable-next-line no-console
        console.log(`[NostrService] Connected to ${url}`);
      },
      onDisconnect: (url, reason): void => {
        // eslint-disable-next-line no-console
        console.log(`[NostrService] Disconnected from ${url}: ${reason}`);
      },
      onReconnecting: (url, attempt): void => {
        // eslint-disable-next-line no-console
        console.log(`[NostrService] Reconnecting to ${url} (attempt ${attempt})...`);
      },
      onReconnected: (url): void => {
        // eslint-disable-next-line no-console
        console.log(`[NostrService] Reconnected to ${url}`);
        this.subscribeToPayments();
      },
    });

    await this.client.connect(this.config.relayUrl);
    this.connected = true;

    // Subscribe to incoming token transfers
    this.subscribeToPayments();

    // eslint-disable-next-line no-console
    console.log('[NostrService] Ready');
    // eslint-disable-next-line no-console
    console.log(`[NostrService] Pubkey: ${this.keyManager.getPublicKeyHex().slice(0, 16)}...`);
  }

  private subscribeToPayments(): void {
    if (!this.client || !this.keyManager) return;

    const myPubkey = this.keyManager.getPublicKeyHex();

    // Listen for token transfers addressed to us
    const filter = Filter.builder().kinds(EventKinds.TOKEN_TRANSFER).pTags(myPubkey).build();

    this.client.subscribe(filter, {
      onEvent: (event: Event): void => {
        this.handleIncomingTransfer(event).catch((err) => {
          // eslint-disable-next-line no-console
          console.error('[NostrService] Error handling transfer:', err);
        });
      },
      onEndOfStoredEvents: (): void => {
        // eslint-disable-next-line no-console
        console.log('[NostrService] Payment subscription ready');
      },
    });
  }

  private async handleIncomingTransfer(event: Event): Promise<void> {
    if (!this.keyManager) return;

    // eslint-disable-next-line no-console
    console.log(`[NostrService] Incoming transfer event: ${event.id.slice(0, 16)}...`);

    try {
      if (!TokenTransferProtocol.isTokenTransfer(event)) {
        return;
      }

      const senderPubkey = TokenTransferProtocol.getSender(event);
      const replyToEventId = TokenTransferProtocol.getReplyToEventId(event);

      // Find matching pending payment
      let pending: PendingPayment | undefined;
      let pendingKey: string | undefined;

      // Match by replyToEventId (preferred)
      if (replyToEventId) {
        pending = this.pendingPayments.get(replyToEventId);
        if (pending) {
          pendingKey = replyToEventId;
        }
      }

      // Fallback: match by sender pubkey
      if (!pending) {
        for (const [key, p] of this.pendingPayments) {
          if (p.userPubkey === senderPubkey) {
            pending = p;
            pendingKey = key;
            break;
          }
        }
      }

      if (!pending || !pendingKey) {
        // eslint-disable-next-line no-console
        console.log('[NostrService] No matching pending payment');
        return;
      }

      // Decrypt and process the token transfer
      const tokenJson = await TokenTransferProtocol.parseTokenTransfer(event, this.keyManager);

      if (!tokenJson.startsWith('{') || !tokenJson.includes('sourceToken')) {
        pending.resolve({ success: false });
        this.pendingPayments.delete(pendingKey);
        return;
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let payloadObj: Record<string, any>;
      try {
        payloadObj = JSON.parse(tokenJson);
      } catch {
        pending.resolve({ success: false });
        this.pendingPayments.delete(pendingKey);
        return;
      }

      // Process and finalize the token
      const success = await this.processTokenTransfer(payloadObj);

      if (success) {
        // eslint-disable-next-line no-console
        console.log(`[NostrService] Payment confirmed for invoice ${pending.invoiceId}`);

        if (this.onPaymentConfirmed) {
          this.onPaymentConfirmed(pending.invoiceId, event.id);
        }
        pending.resolve({ success: true, txId: event.id });
      } else {
        pending.resolve({ success: false });
      }

      this.pendingPayments.delete(pendingKey);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[NostrService] Error processing transfer:', err);
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async processTokenTransfer(payloadObj: Record<string, any>): Promise<boolean> {
    try {
      let sourceTokenInput = payloadObj['sourceToken'];
      let transferTxInput = payloadObj['transferTx'];

      if (typeof sourceTokenInput === 'string') {
        sourceTokenInput = JSON.parse(sourceTokenInput);
      }
      if (typeof transferTxInput === 'string') {
        transferTxInput = JSON.parse(transferTxInput);
      }

      if (!sourceTokenInput || !transferTxInput) {
        return false;
      }

      const sourceToken = await Token.fromJSON(sourceTokenInput);
      const transferTx = await TransferTransaction.fromJSON(transferTxInput);

      return await this.finalizeTransfer(sourceToken, transferTx);
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error('[NostrService] Error processing token:', error);
      return false;
    }
  }

  private async finalizeTransfer(
    sourceToken: Token<any>,
    transferTx: TransferTransaction
  ): Promise<boolean> {
    try {
      const recipientAddress = transferTx.data.recipient;
      const addressScheme = recipientAddress.scheme;

      if (addressScheme === AddressScheme.PROXY) {
        // Transfer to PROXY address (nametag) - needs finalization
        const nametagToken = this.identityService.getNametagToken();
        if (!nametagToken) {
          // eslint-disable-next-line no-console
          console.error('[NostrService] No nametag token for finalization');
          return false;
        }

        const signingService = this.identityService.getSigningService();
        const transferSalt = transferTx.data.salt;

        const recipientPredicate = await UnmaskedPredicate.create(
          sourceToken.id,
          sourceToken.type,
          signingService,
          HashAlgorithm.SHA256,
          transferSalt
        );

        const recipientState = new TokenState(recipientPredicate, null);

        const client = this.identityService.getStateTransitionClient();
        const rootTrustBase = this.identityService.getRootTrustBase();

        const finalizedToken = await client.finalizeTransaction(
          rootTrustBase,
          sourceToken,
          recipientState,
          transferTx,
          [nametagToken]
        );

        this.saveReceivedToken(finalizedToken);
        return true;
      } else {
        // Direct address - save without finalization
        this.saveReceivedToken(sourceToken);
        return true;
      }
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error('[NostrService] Error finalizing transfer:', error);
      return false;
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private saveReceivedToken(token: Token<any>): void {
    try {
      const tokensDir = path.join(this.config.dataDir, 'tokens');
      if (!fs.existsSync(tokensDir)) {
        fs.mkdirSync(tokensDir, { recursive: true });
      }

      const tokenIdHex = Buffer.from(token.id.bytes).toString('hex').slice(0, 16);
      const filename = `token-${tokenIdHex}-${Date.now()}.json`;
      const tokenPath = path.join(tokensDir, filename);

      const tokenData = {
        token: token.toJSON(),
        receivedAt: Date.now(),
      };

      fs.writeFileSync(tokenPath, JSON.stringify(tokenData, null, 2));
      // eslint-disable-next-line no-console
      console.log(`[NostrService] Token saved: ${filename}`);
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error('[NostrService] Error saving token:', error);
    }
  }

  async resolvePubkey(nametag: string, maxRetries = 3): Promise<string | null> {
    if (!this.client) {
      throw new Error('Nostr client not connected');
    }

    const cleanId = nametag.replace('@unicity', '').replace('@', '').trim();

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      const pubkey = await this.client.queryPubkeyByNametag(cleanId);
      if (pubkey) {
        return pubkey;
      }

      if (attempt < maxRetries) {
        await new Promise((resolve) => setTimeout(resolve, 1000 * attempt));
      }
    }

    return null;
  }

  async createInvoice(userNametag: string, amount: number): Promise<Invoice> {
    const recipientNametag = this.identityService.getNametag();

    // Mock mode for development
    if (this.config.mockMode) {
      const mockId = `mock-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      // eslint-disable-next-line no-console
      console.log(`[NostrService] MOCK: Invoice created for @${userNametag}: ${mockId}`);
      return {
        invoiceId: mockId,
        amount,
        recipientNametag,
        status: 'pending',
        createdAt: new Date(),
        expiresAt: new Date(Date.now() + this.config.paymentTimeoutSeconds * 1000),
      };
    }

    if (!this.client) {
      throw new Error('Nostr client not connected');
    }

    // Resolve user's pubkey
    const userPubkey = await this.resolvePubkey(userNametag);
    if (!userPubkey) {
      throw new Error(`Cannot resolve pubkey for nametag: ${userNametag}`);
    }

    // Send payment request to user
    const eventId = await this.client.sendPaymentRequest(userPubkey, {
      amount: BigInt(amount),
      coinId: this.config.coinId,
      recipientNametag,
      message: `Lottery bet: ${amount} tokens`,
    });

    // eslint-disable-next-line no-console
    console.log(`[NostrService] Payment request sent: ${eventId.slice(0, 16)}...`);

    // Create pending payment tracking
    let resolvePayment: (result: { success: boolean; txId?: string }) => void = () => {};

    new Promise<{ success: boolean; txId?: string }>((resolve) => {
      resolvePayment = resolve;
    });

    const pending: PendingPayment = {
      eventId,
      invoiceId: eventId,
      userNametag,
      userPubkey,
      amount,
      createdAt: Date.now(),
      resolve: resolvePayment,
    };

    this.pendingPayments.set(eventId, pending);

    // Set up timeout
    setTimeout(() => {
      if (this.pendingPayments.has(eventId)) {
        this.pendingPayments.delete(eventId);
        resolvePayment({ success: false });
      }
    }, this.config.paymentTimeoutSeconds * 1000);

    return {
      invoiceId: eventId,
      amount,
      recipientNametag,
      status: 'pending',
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + this.config.paymentTimeoutSeconds * 1000),
    };
  }

  async waitForPayment(invoiceId: string): Promise<{ paid: boolean; txId?: string }> {
    const pending = this.pendingPayments.get(invoiceId);
    if (!pending) {
      return { paid: false };
    }

    return new Promise((resolve) => {
      const originalResolve = pending.resolve;
      pending.resolve = (result): void => {
        originalResolve(result);
        resolve({ paid: result.success, txId: result.txId });
      };
    });
  }

  async sendTokens(toNametag: string, amount: number): Promise<TokenTransfer> {
    if (!this.client) {
      throw new Error('Nostr client not connected');
    }

    // Resolve recipient's pubkey
    const recipientPubkey = await this.resolvePubkey(toNametag);
    if (!recipientPubkey) {
      throw new Error(`Cannot resolve pubkey for nametag: ${toNametag}`);
    }

    // TODO: Implement actual token transfer
    // This requires:
    // 1. Load tokens from wallet
    // 2. Create TransferTransaction
    // 3. Sign and send via Nostr
    // eslint-disable-next-line no-console
    console.log(`[NostrService] TODO: Send ${amount} tokens to @${toNametag}`);

    const transferId = `transfer-${Date.now()}-${Math.random().toString(36).slice(2)}`;

    return {
      transferId,
      toNametag,
      amount,
      status: 'pending',
      createdAt: new Date(),
    };
  }

  getPublicKey(): string {
    if (!this.keyManager) {
      throw new Error('Key manager not initialized');
    }
    return this.keyManager.getPublicKeyHex();
  }

  getPendingPayment(invoiceId: string): PendingPayment | undefined {
    return this.pendingPayments.get(invoiceId);
  }

  disconnect(): void {
    if (this.client) {
      this.client.disconnect();
    }
    this.connected = false;
  }

  isConnected(): boolean {
    return this.connected;
  }
}
