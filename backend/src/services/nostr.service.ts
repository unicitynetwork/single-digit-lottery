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
import { DECIMALS_MULTIPLIER } from '../utils/currency.js';

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

      // Validate payment amount before processing
      const amountValidation = await this.validatePaymentAmount(payloadObj, pending.amount);
      if (!amountValidation.valid) {
        // eslint-disable-next-line no-console
        console.error(
          `[NostrService] Payment amount mismatch: expected ${pending.amount} UCT, got ${amountValidation.receivedAmount} UCT`
        );
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

  /**
   * Validate that the received token amount matches the expected payment amount
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async validatePaymentAmount(
    payloadObj: Record<string, any>,
    expectedAmount: number
  ): Promise<{ valid: boolean; receivedAmount: number }> {
    try {
      let sourceTokenInput = payloadObj['sourceToken'];
      if (typeof sourceTokenInput === 'string') {
        sourceTokenInput = JSON.parse(sourceTokenInput);
      }

      if (!sourceTokenInput) {
        return { valid: false, receivedAmount: 0 };
      }

      const sourceToken = await Token.fromJSON(sourceTokenInput);
      const coinId = CoinId.fromJSON(this.config.coinId);

      if (!sourceToken.coins) {
        return { valid: false, receivedAmount: 0 };
      }

      const balance = sourceToken.coins.get(coinId);
      if (!balance) {
        return { valid: false, receivedAmount: 0 };
      }

      const receivedAmount = Number(balance / DECIMALS_MULTIPLIER);
      const expectedWithDecimals = BigInt(Math.round(expectedAmount * 10000)) * 10n ** 14n;

      // Allow small tolerance for rounding (0.0001 UCT)
      const tolerance = 10n ** 14n; // 0.0001 UCT
      const valid = balance >= expectedWithDecimals - tolerance;

      return { valid, receivedAmount };
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error('[NostrService] Error validating payment amount:', error);
      return { valid: false, receivedAmount: 0 };
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

    // Convert amount to token units (18 decimals), supports decimals up to 0.0001
    const amountWithDecimals = BigInt(Math.round(amount * 10000)) * 10n ** 14n;

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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
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

    const amountWithDecimals = BigInt(Math.round(amount * 10000)) * 10n ** 14n;
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
    console.log(`[NostrService] Sending ${amount} tokens to @${toNametag}...`);

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

    const amountWithDecimals = BigInt(Math.round(amount * 10000)) * 10n ** 14n;
    const coinId = CoinId.fromJSON(this.config.coinId);

    // Collect tokens with balances, sorted by balance (largest first)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tokensWithBalances: { token: Token<any>; balance: bigint; filePath: string }[] = [];
    for (const item of tokens) {
      if (!item.token.coins) continue;
      const balance = item.token.coins.get(coinId);
      if (balance && balance > 0n) {
        tokensWithBalances.push({ token: item.token, balance, filePath: item.filePath });
      }
    }
    tokensWithBalances.sort((a, b) => (b.balance > a.balance ? 1 : -1));

    // Calculate total available balance
    const totalBalance = tokensWithBalances.reduce((sum, t) => sum + t.balance, 0n);
    if (totalBalance < amountWithDecimals) {
      // Use proper decimal conversion (divide to 4 decimal places)
      const totalUCT = Number(totalBalance / (10n ** 14n)) / 10000;
      throw new Error(`Insufficient balance. Need ${amount} UCT, have ${totalUCT} UCT`);
    }

    // Check if single token is enough
    const singleToken = tokensWithBalances.find((t) => t.balance >= amountWithDecimals);
    if (singleToken) {
      // eslint-disable-next-line no-console
      console.log(
        `[NostrService] Found token with ${singleToken.balance / DECIMALS_MULTIPLIER} UCT`
      );

      // If exact match, transfer whole token directly
      if (singleToken.balance === amountWithDecimals) {
        // eslint-disable-next-line no-console
        console.log(`[NostrService] Exact match - transferring whole token`);
        const transferId = await this.sendSingleToken(
          singleToken.token,
          toNametag,
          recipientPubkey,
          amount
        );
        return { transferId, toNametag, amount, status: 'sent', createdAt: new Date() };
      }

      // Token is larger than needed - must SPLIT
      // eslint-disable-next-line no-console
      console.log(`[NostrService] Token larger than needed - splitting...`);

      const recipientAddress = await ProxyAddress.fromNameTag(toNametag);
      const remainderAmount = singleToken.balance - amountWithDecimals;

      // eslint-disable-next-line no-console
      console.log(
        `[NostrService] Split: ${amount} UCT to recipient, ${Number(remainderAmount) / Number(DECIMALS_MULTIPLIER)} UCT as change`
      );

      const splitExecutor = new TokenSplitExecutor({
        stateTransitionClient: this.identityService.getStateTransitionClient(),
        trustBase: this.identityService.getRootTrustBase(),
        signingService: this.identityService.getSigningService(),
      });

      const splitResult = await splitExecutor.executeSplit(
        singleToken.token,
        amountWithDecimals,
        remainderAmount,
        this.config.coinId,
        recipientAddress
      );

      // CRITICAL: Save the change token FIRST before any other operations
      // This ensures we don't lose funds if subsequent steps fail
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

      // Now safe to delete the original token file (already burned on-chain)
      fs.unlinkSync(singleToken.filePath);
      // eslint-disable-next-line no-console
      console.log(`[NostrService] Deleted burned token file: ${singleToken.filePath}`);

      // Send the recipient token via Nostr
      const transferPayload = JSON.stringify({
        sourceToken: splitResult.tokenForRecipient.toJSON(),
        transferTx: splitResult.recipientTransferTx.toJSON(),
      });

      const transferEvent = await TokenTransferProtocol.createTokenTransferEvent(
        this.keyManager,
        recipientPubkey,
        transferPayload,
        { amount: amountWithDecimals, symbol: 'UCT' }
      );

      await this.client.publishEvent(transferEvent);

      // eslint-disable-next-line no-console
      console.log(`[NostrService] Split transfer complete: ${transferEvent.id.slice(0, 16)}...`);

      return { transferId: transferEvent.id, toNametag, amount, status: 'sent', createdAt: new Date() };
    }

    // Need multiple tokens - for now, throw error (complex case)
    // TODO: Implement multi-token combining with splits
    throw new Error(
      `No single token large enough for ${amount} UCT. Multi-token combining not yet supported.`
    );
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
