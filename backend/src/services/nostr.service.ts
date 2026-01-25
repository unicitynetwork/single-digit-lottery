import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
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
import { TransferCommitment } from '@unicitylabs/state-transition-sdk/lib/transaction/TransferCommitment.js';
import { AddressScheme } from '@unicitylabs/state-transition-sdk/lib/address/AddressScheme.js';
import { UnmaskedPredicate } from '@unicitylabs/state-transition-sdk/lib/predicate/embedded/UnmaskedPredicate.js';
import { HashAlgorithm } from '@unicitylabs/state-transition-sdk/lib/hash/HashAlgorithm.js';
import { TokenState } from '@unicitylabs/state-transition-sdk/lib/token/TokenState.js';
import { ProxyAddress } from '@unicitylabs/state-transition-sdk/lib/address/ProxyAddress.js';
import { CoinId } from '@unicitylabs/state-transition-sdk/lib/token/fungible/CoinId.js';
import { waitInclusionProof } from '@unicitylabs/state-transition-sdk/lib/util/InclusionProofUtils.js';
import type { IdentityService } from './identity.service.js';
import { TokenSplitExecutor } from '../utils/token-split-executor.js';
import { TokenSplitCalculator, type StoredToken } from '../utils/token-split-calculator.js';

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

export interface BetDetail {
  digit: number;
  amount: number;
}

export interface TokenTransfer {
  transferId: string;
  toNametag: string;
  amount: number;
  status: 'pending' | 'sent' | 'confirmed' | 'failed';
  createdAt: Date;
  transactionCount: number; // Number of transactions (> 1 means split)
  sentAmounts: number[]; // Individual amounts of each transaction
}

export interface PendingPayment {
  eventId: string;
  invoiceId: string;
  userNametag: string;
  userPubkey: string;
  amount: number;
  createdAt: number;
  resolve: (result: { success: boolean; txId?: string }) => void;
  // For multi-token payments (stored in smallest units - 18 decimals)
  receivedAmountRaw: bigint;
  receivedTxIds: string[];
  receivedAmounts: number[]; // Individual token amounts for logging
  // Flag to prevent double confirmation
  confirmed: boolean;
}

export interface PaymentInfo {
  invoiceId: string;
  txId: string;
  tokenCount: number; // Number of tokens received (> 1 means split payment)
  totalAmount: number;
  receivedAmounts: number[]; // Individual amounts of each token
}

export type PaymentConfirmedCallback = (paymentInfo: PaymentInfo) => void;

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

      // Get token amount (full precision bigint)
      const tokenAmountRaw = await this.getTokenAmount(payloadObj);

      // Process and save the token regardless of amount
      const success = await this.processTokenTransfer(payloadObj);

      if (!success) {
        // eslint-disable-next-line no-console
        console.error('[NostrService] Failed to process token transfer');
        return; // Don't delete pending - user might send another token
      }

      // Accumulate received amount (in raw units - 18 decimals)
      pending.receivedAmountRaw += tokenAmountRaw;
      pending.receivedTxIds.push(event.id);
      pending.receivedAmounts.push(parseFloat(this.rawToDisplay(tokenAmountRaw)));

      // Convert expected amount to raw (18 decimals)
      const expectedAmountRaw = BigInt(Math.round(pending.amount * 1e18));

      // eslint-disable-next-line no-console
      console.log(
        `[NostrService] Received ${this.rawToDisplay(tokenAmountRaw)} UCT (total: ${this.rawToDisplay(pending.receivedAmountRaw)}/${pending.amount} UCT)`
      );

      // Check if we have enough (allow tiny tolerance for rounding - 0.0001 UCT)
      const tolerance = 10n ** 14n;
      if (pending.receivedAmountRaw >= expectedAmountRaw - tolerance) {
        // Prevent double confirmation (race condition with multiple tokens)
        if (pending.confirmed) {
          // eslint-disable-next-line no-console
          console.log(
            `[NostrService] Payment already confirmed for invoice ${pending.invoiceId}, skipping`
          );
          return;
        }
        pending.confirmed = true;

        const tokenCount = pending.receivedTxIds.length;
        // eslint-disable-next-line no-console
        console.log(
          `[NostrService] Payment confirmed for invoice ${pending.invoiceId} (${tokenCount} token${tokenCount > 1 ? 's' : ''})`
        );

        if (this.onPaymentConfirmed) {
          this.onPaymentConfirmed({
            invoiceId: pending.invoiceId,
            txId: pending.receivedTxIds.join(','),
            tokenCount,
            totalAmount: pending.amount,
            receivedAmounts: pending.receivedAmounts,
          });
        }
        pending.resolve({ success: true, txId: pending.receivedTxIds.join(',') });
        this.pendingPayments.delete(pendingKey);
      } else {
        const needed = expectedAmountRaw - pending.receivedAmountRaw;
        // eslint-disable-next-line no-console
        console.log(
          `[NostrService] Waiting for more tokens... need ${this.rawToDisplay(needed)} more UCT`
        );
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[NostrService] Error processing transfer:', err);
    }
  }

  /**
   * Get the token amount from payload (returns raw bigint for full precision)
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async getTokenAmount(payloadObj: Record<string, any>): Promise<bigint> {
    try {
      let sourceTokenInput = payloadObj['sourceToken'];
      if (typeof sourceTokenInput === 'string') {
        sourceTokenInput = JSON.parse(sourceTokenInput);
      }

      if (!sourceTokenInput) {
        return 0n;
      }

      const sourceToken = await Token.fromJSON(sourceTokenInput);
      const coinId = CoinId.fromJSON(this.config.coinId);

      if (!sourceToken.coins) {
        return 0n;
      }

      const balance = sourceToken.coins.get(coinId);
      return balance ?? 0n;
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error('[NostrService] Error getting token amount:', error);
      return 0n;
    }
  }

  /**
   * Convert raw amount (18 decimals) to human readable string (max 4 decimal places)
   */
  private rawToDisplay(raw: bigint): string {
    const str = raw.toString().padStart(19, '0');
    const integer = str.slice(0, -18) || '0';
    // Take first 4 decimal places, remove trailing zeros
    const fraction = str.slice(-18, -14).replace(/0+$/, '');
    return fraction ? `${integer}.${fraction}` : integer;
  }

  /**
   * Convert human readable amount to raw (18 decimals)
   */
  private parseAmountToRaw(amount: number): bigint {
    const str = amount.toString();
    const [integer, fraction = ''] = str.split('.');
    const paddedFraction = fraction.padEnd(18, '0').slice(0, 18);
    return BigInt(integer + paddedFraction);
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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
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
    // eslint-disable-next-line no-console
    console.log(`[NostrService] Resolving nametag: @${cleanId}...`);

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const pubkey = await this.client.queryPubkeyByNametag(cleanId);
        if (pubkey) {
          // eslint-disable-next-line no-console
          console.log(`[NostrService] Resolved @${cleanId} -> ${pubkey.slice(0, 16)}...`);
          return pubkey;
        }
        // eslint-disable-next-line no-console
        console.log(
          `[NostrService] Nametag @${cleanId} not found (attempt ${attempt}/${maxRetries})`
        );
      } catch (error) {
        // eslint-disable-next-line no-console
        console.error(`[NostrService] Error resolving nametag (attempt ${attempt}):`, error);
      }

      if (attempt < maxRetries) {
        await new Promise((resolve) => setTimeout(resolve, 1000 * attempt));
      }
    }

    return null;
  }

  // Public method to validate nametag exists
  async validateNametag(
    nametag: string
  ): Promise<{ valid: boolean; pubkey?: string; error?: string }> {
    if (!this.connected || !this.client) {
      return { valid: false, error: 'Nostr service not connected' };
    }

    const pubkey = await this.resolvePubkey(nametag, 2);
    if (pubkey) {
      return { valid: true, pubkey };
    }
    return {
      valid: false,
      error: `Nametag @${nametag} not found. Make sure it exists and has Nostr binding.`,
    };
  }

  async createInvoice(
    userNametag: string,
    amount: number,
    bets: BetDetail[],
    roundNumber: number
  ): Promise<Invoice> {
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
      throw new Error('Nostr client not connected. Check relay connection.');
    }

    // eslint-disable-next-line no-console
    console.log(
      `[NostrService] Creating invoice for @${userNametag}, amount: ${amount}, round #${roundNumber}`
    );

    // Resolve user's pubkey
    const userPubkey = await this.resolvePubkey(userNametag);
    if (!userPubkey) {
      throw new Error(
        `Nametag @${userNametag} not found. Make sure it exists and has Nostr binding published.`
      );
    }

    // Send payment request to user
    // eslint-disable-next-line no-console
    console.log(`[NostrService] Sending payment request to ${userPubkey.slice(0, 16)}...`);

    // Convert amount to token units (full 18 decimal precision)
    const amountWithDecimals = this.parseAmountToRaw(amount);

    // Format bet details for message (includes round number for validation)
    const betsStr = bets.map((b) => `#${b.digit}:${b.amount}`).join(', ');

    const eventId = await this.client.sendPaymentRequest(userPubkey, {
      amount: amountWithDecimals,
      coinId: this.config.coinId,
      recipientNametag,
      message: `Lottery Round #${roundNumber} - Bets: ${betsStr}`,
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
      receivedAmountRaw: 0n,
      receivedTxIds: [],
      receivedAmounts: [],
      confirmed: false,
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

  // Load all tokens from storage with file paths
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async loadTokensFromStorage(): Promise<{ token: Token<any>; filePath: string }[]> {
    const tokensDir = path.join(this.config.dataDir, 'tokens');
    if (!fs.existsSync(tokensDir)) {
      return [];
    }

    const files = fs.readdirSync(tokensDir).filter((f) => f.endsWith('.json'));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tokens: { token: Token<any>; filePath: string }[] = [];

    for (const file of files) {
      const filePath = path.join(tokensDir, file);
      try {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        const token = await Token.fromJSON(data.token);
        tokens.push({ token, filePath });
      } catch (error) {
        // eslint-disable-next-line no-console
        console.error(`[NostrService] Failed to load token ${file}:`, error);
      }
    }

    return tokens;
  }

  // Delete token file after successful transfer
  private deleteTokenFile(tokenIdHex: string): void {
    const tokensDir = path.join(this.config.dataDir, 'tokens');
    if (!fs.existsSync(tokensDir)) return;

    const files = fs.readdirSync(tokensDir);
    for (const file of files) {
      if (file.includes(tokenIdHex.slice(0, 16))) {
        try {
          fs.unlinkSync(path.join(tokensDir, file));
          // eslint-disable-next-line no-console
          console.log(`[NostrService] Deleted spent token file: ${file}`);
        } catch {
          // Ignore deletion errors
        }
        break;
      }
    }
  }

  // Send a single token (internal helper)

  private async sendSingleToken(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    token: Token<any>,
    toNametag: string,
    recipientPubkey: string,
    amount: number
  ): Promise<string> {
    if (!this.client || !this.keyManager) {
      throw new Error('Nostr client not connected');
    }

    const amountWithDecimals = this.parseAmountToRaw(amount);
    const recipientAddress = await ProxyAddress.fromNameTag(toNametag);
    const signingService = this.identityService.getSigningService();
    const stateTransitionClient = this.identityService.getStateTransitionClient();
    const rootTrustBase = this.identityService.getRootTrustBase();

    const salt = crypto.randomBytes(32);

    // eslint-disable-next-line no-console
    console.log(`[NostrService] Creating transfer commitment for ${amount} UCT...`);

    const commitment = await TransferCommitment.create(
      token,
      recipientAddress,
      salt,
      null,
      null,
      signingService
    );

    // eslint-disable-next-line no-console
    console.log(`[NostrService] Submitting commitment to aggregator...`);

    const response = await stateTransitionClient.submitTransferCommitment(commitment);
    if (response.status !== 'SUCCESS' && response.status !== 'REQUEST_ID_EXISTS') {
      throw new Error(`Transfer commitment rejected: ${response.status}`);
    }
    if (response.status === 'REQUEST_ID_EXISTS') {
      // eslint-disable-next-line no-console
      console.log(`[NostrService] Commitment already exists, continuing...`);
    }

    // eslint-disable-next-line no-console
    console.log(`[NostrService] Waiting for inclusion proof...`);

    const inclusionProof = await waitInclusionProof(
      rootTrustBase,
      stateTransitionClient,
      commitment
    );

    const transferTx = commitment.toTransaction(inclusionProof);
    const transferPayload = JSON.stringify({
      sourceToken: token.toJSON(),
      transferTx: transferTx.toJSON(),
    });

    // eslint-disable-next-line no-console
    console.log(`[NostrService] Sending ${amount} UCT via Nostr...`);

    const transferEvent = await TokenTransferProtocol.createTokenTransferEvent(
      this.keyManager,
      recipientPubkey,
      transferPayload,
      { amount: amountWithDecimals, symbol: 'UCT' }
    );

    await this.client.publishEvent(transferEvent);

    // Delete spent token file
    const tokenIdHex = Buffer.from(token.id.bytes).toString('hex');
    this.deleteTokenFile(tokenIdHex);

    // eslint-disable-next-line no-console
    console.log(`[NostrService] Transfer sent: ${transferEvent.id.slice(0, 16)}...`);

    return transferEvent.id;
  }

  async sendTokens(toNametag: string, amount: number): Promise<TokenTransfer> {
    if (!this.client || !this.keyManager) {
      throw new Error('Nostr client not connected');
    }

    // eslint-disable-next-line no-console
    console.log(`[NostrService] Sending ${amount} UCT to @${toNametag}...`);

    // Resolve recipient's pubkey
    const recipientPubkey = await this.resolvePubkey(toNametag);
    if (!recipientPubkey) {
      throw new Error(`Cannot resolve pubkey for nametag: ${toNametag}`);
    }

    // Load tokens from storage
    const tokens = await this.loadTokensFromStorage();
    if (tokens.length === 0) {
      throw new Error('No tokens available in wallet');
    }

    // eslint-disable-next-line no-console
    console.log(`[NostrService] Loaded ${tokens.length} tokens from storage`);

    // Convert to StoredToken format for calculator
    const storedTokens: StoredToken[] = tokens.map((t) => ({
      filePath: t.filePath,
      sdkToken: t.token,
    }));

    // Calculate optimal split plan
    const calculator = new TokenSplitCalculator();
    const targetAmount = this.parseAmountToRaw(amount);
    const plan = await calculator.calculateOptimalSplit(
      storedTokens,
      targetAmount,
      this.config.coinId
    );

    if (!plan) {
      throw new Error(`Insufficient balance for ${amount} UCT`);
    }

    // eslint-disable-next-line no-console
    console.log(
      `[NostrService] Plan: ${plan.tokensToTransferDirectly.length} direct transfers, split: ${plan.requiresSplit}`
    );

    const transferIds: string[] = [];
    const sentAmounts: number[] = [];

    // Step 1: Transfer whole tokens directly
    for (const item of plan.tokensToTransferDirectly) {
      const tokenAmount = parseFloat(this.rawToDisplay(item.amount));
      // eslint-disable-next-line no-console
      console.log(`[NostrService] Transferring whole token: ${tokenAmount} UCT`);

      const transferId = await this.sendSingleToken(
        item.sdkToken,
        toNametag,
        recipientPubkey,
        tokenAmount
      );

      // Delete the token file after successful transfer
      try {
        fs.unlinkSync(item.filePath);
        // eslint-disable-next-line no-console
        console.log(`[NostrService] Deleted transferred token: ${item.filePath}`);
      } catch {
        // Ignore deletion errors
      }

      transferIds.push(transferId);
      sentAmounts.push(tokenAmount);
    }

    // Step 2: Split token if needed
    if (plan.requiresSplit && plan.tokenToSplit && plan.splitAmount && plan.remainderAmount) {
      // eslint-disable-next-line no-console
      console.log(
        `[NostrService] Splitting token: ${this.rawToDisplay(plan.splitAmount)} UCT to recipient, ${this.rawToDisplay(plan.remainderAmount)} UCT as change`
      );

      const recipientAddress = await ProxyAddress.fromNameTag(toNametag);

      const splitExecutor = new TokenSplitExecutor({
        stateTransitionClient: this.identityService.getStateTransitionClient(),
        trustBase: this.identityService.getRootTrustBase(),
        signingService: this.identityService.getSigningService(),
      });

      const splitResult = await splitExecutor.executeSplit(
        plan.tokenToSplit.sdkToken,
        plan.splitAmount,
        plan.remainderAmount,
        this.config.coinId,
        recipientAddress
      );

      // CRITICAL: Save the change token FIRST
      const changeTokenIdHex = Buffer.from(splitResult.tokenForSender.id.bytes).toString('hex');
      const changeTokenPath = path.join(
        this.config.dataDir,
        'tokens',
        `token-${changeTokenIdHex.slice(0, 16)}-${Date.now()}.json`
      );
      fs.writeFileSync(
        changeTokenPath,
        JSON.stringify({ token: splitResult.tokenForSender.toJSON() }, null, 2)
      );
      // eslint-disable-next-line no-console
      console.log(`[NostrService] Saved change token: ${changeTokenPath}`);

      // Delete the original token file
      fs.unlinkSync(plan.tokenToSplit.filePath);
      // eslint-disable-next-line no-console
      console.log(`[NostrService] Deleted burned token: ${plan.tokenToSplit.filePath}`);

      // Send recipient token via Nostr
      const transferPayload = JSON.stringify({
        sourceToken: splitResult.tokenForRecipient.toJSON(),
        transferTx: splitResult.recipientTransferTx.toJSON(),
      });

      const transferEvent = await TokenTransferProtocol.createTokenTransferEvent(
        this.keyManager,
        recipientPubkey,
        transferPayload,
        { amount: plan.splitAmount, symbol: 'UCT' }
      );

      await this.client.publishEvent(transferEvent);
      transferIds.push(transferEvent.id);
      sentAmounts.push(parseFloat(this.rawToDisplay(plan.splitAmount)));

      // eslint-disable-next-line no-console
      console.log(`[NostrService] Split transfer complete: ${transferEvent.id.slice(0, 16)}...`);
    }

    // eslint-disable-next-line no-console
    console.log(
      `[NostrService] All transfers complete: ${transferIds.length} transactions (${sentAmounts.join(' + ')} UCT)`
    );

    return {
      transferId: transferIds.join(','),
      toNametag,
      amount,
      status: 'sent',
      createdAt: new Date(),
      transactionCount: transferIds.length,
      sentAmounts,
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
