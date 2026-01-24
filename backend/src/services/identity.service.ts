import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { Token } from '@unicitylabs/state-transition-sdk/lib/token/Token.js';
import { TokenId } from '@unicitylabs/state-transition-sdk/lib/token/TokenId.js';
import { TokenType } from '@unicitylabs/state-transition-sdk/lib/token/TokenType.js';
import { TokenState } from '@unicitylabs/state-transition-sdk/lib/token/TokenState.js';
import { SigningService } from '@unicitylabs/state-transition-sdk/lib/sign/SigningService.js';
import { MintCommitment } from '@unicitylabs/state-transition-sdk/lib/transaction/MintCommitment.js';
import { MintTransactionData } from '@unicitylabs/state-transition-sdk/lib/transaction/MintTransactionData.js';
import { UnmaskedPredicate } from '@unicitylabs/state-transition-sdk/lib/predicate/embedded/UnmaskedPredicate.js';
import { UnmaskedPredicateReference } from '@unicitylabs/state-transition-sdk/lib/predicate/embedded/UnmaskedPredicateReference.js';
import { HashAlgorithm } from '@unicitylabs/state-transition-sdk/lib/hash/HashAlgorithm.js';
import { StateTransitionClient } from '@unicitylabs/state-transition-sdk/lib/StateTransitionClient.js';
import { AggregatorClient } from '@unicitylabs/state-transition-sdk/lib/api/AggregatorClient.js';
import { RootTrustBase } from '@unicitylabs/state-transition-sdk/lib/bft/RootTrustBase.js';
import { ProxyAddress } from '@unicitylabs/state-transition-sdk/lib/address/ProxyAddress.js';
import { waitInclusionProof } from '@unicitylabs/state-transition-sdk/lib/util/InclusionProofUtils.js';
import { NostrKeyManager, NostrClient } from '@unicitylabs/nostr-js-sdk';
import type { DirectAddress } from '@unicitylabs/state-transition-sdk/lib/address/DirectAddress.js';
import trustbaseJson from '../trustbase-testnet.json' with { type: 'json' };

const UNICITY_TOKEN_TYPE_HEX = 'f8aa13834268d29355ff12183066f0cb902003629bbc5eb9ef0efbe397867509';

export interface IdentityConfig {
  dataDir: string;
  nametag: string;
  aggregatorUrl: string;
  aggregatorApiKey: string;
  relayUrl: string;
  privateKeyHex?: string;
}

export interface IdentityData {
  privateKeyHex: string;
  publicKeyHex: string;
  nametag: string;
  walletAddress: string;
}

export class IdentityService {
  private config: IdentityConfig;
  private aggregatorClient: AggregatorClient;
  private stateTransitionClient: StateTransitionClient;
  private rootTrustBase: RootTrustBase;
  private identity: IdentityData | null = null;
  private signingService: SigningService | null = null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private nametagToken: Token<any> | null = null;
  private initialized = false;

  constructor(config: IdentityConfig) {
    this.config = config;
    this.aggregatorClient = new AggregatorClient(config.aggregatorUrl, config.aggregatorApiKey);
    this.stateTransitionClient = new StateTransitionClient(this.aggregatorClient);
    this.rootTrustBase = RootTrustBase.fromJSON(trustbaseJson);
    this.ensureDataDir();
  }

  private ensureDataDir(): void {
    if (!fs.existsSync(this.config.dataDir)) {
      fs.mkdirSync(this.config.dataDir, { recursive: true });
    }
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;

    // eslint-disable-next-line no-console
    console.log('[IdentityService] Initializing...');

    // Load or create identity
    const privateKeyHex = this.loadOrCreateIdentity();

    // Create signing service from private key
    const secret = Buffer.from(privateKeyHex, 'hex');
    this.signingService = await SigningService.createFromSecret(secret);
    const publicKeyHex = Buffer.from(this.signingService.publicKey).toString('hex');

    // Derive wallet address
    const walletAddress = await this.deriveWalletAddress();

    this.identity = {
      privateKeyHex,
      publicKeyHex,
      nametag: this.config.nametag,
      walletAddress,
    };

    // eslint-disable-next-line no-console
    console.log(`[IdentityService] Nametag: @${this.config.nametag}`);
    // eslint-disable-next-line no-console
    console.log(`[IdentityService] Public Key: ${publicKeyHex.slice(0, 16)}...`);

    // Ensure nametag exists
    await this.ensureNametag();

    // Ensure Nostr binding is published
    await this.ensureNostrBinding();

    this.initialized = true;
    // eslint-disable-next-line no-console
    console.log('[IdentityService] Initialization complete');
  }

  private loadOrCreateIdentity(): string {
    const identityPath = path.join(this.config.dataDir, 'identity.json');

    if (fs.existsSync(identityPath)) {
      const data = JSON.parse(fs.readFileSync(identityPath, 'utf-8'));
      // eslint-disable-next-line no-console
      console.log('[IdentityService] Loaded existing identity');
      return data.privateKey;
    }

    // Check if provided via config
    if (this.config.privateKeyHex) {
      const data = {
        privateKey: this.config.privateKeyHex,
        nametag: this.config.nametag,
        createdAt: new Date().toISOString(),
      };
      fs.writeFileSync(identityPath, JSON.stringify(data, null, 2));
      // eslint-disable-next-line no-console
      console.log('[IdentityService] Saved identity from config');
      return this.config.privateKeyHex;
    }

    // Generate new keypair
    const privateKeyHex = crypto.randomBytes(32).toString('hex');
    const data = {
      privateKey: privateKeyHex,
      nametag: this.config.nametag,
      createdAt: new Date().toISOString(),
    };

    fs.writeFileSync(identityPath, JSON.stringify(data, null, 2));
    // eslint-disable-next-line no-console
    console.log('[IdentityService] Created new identity');

    return privateKeyHex;
  }

  private async deriveWalletAddress(): Promise<string> {
    if (!this.signingService) {
      throw new Error('Signing service not initialized');
    }

    const tokenType = new TokenType(Buffer.from(UNICITY_TOKEN_TYPE_HEX, 'hex'));
    const predicateRef = UnmaskedPredicateReference.create(
      tokenType,
      this.signingService.algorithm,
      this.signingService.publicKey,
      HashAlgorithm.SHA256
    );

    const address = await (await predicateRef).toAddress();
    return address.toString();
  }

  private async getOwnerAddress(): Promise<DirectAddress> {
    if (!this.signingService) {
      throw new Error('Signing service not initialized');
    }

    const tokenType = new TokenType(Buffer.from(UNICITY_TOKEN_TYPE_HEX, 'hex'));
    const predicateRef = UnmaskedPredicateReference.create(
      tokenType,
      this.signingService.algorithm,
      this.signingService.publicKey,
      HashAlgorithm.SHA256
    );

    return (await predicateRef).toAddress();
  }

  private async ensureNametag(): Promise<void> {
    const storedToken = await this.loadNametagFromStorage();
    if (storedToken) {
      // eslint-disable-next-line no-console
      console.log('[IdentityService] Loaded existing nametag token');
      this.nametagToken = storedToken;
      return;
    }

    // eslint-disable-next-line no-console
    console.log(`[IdentityService] Minting nametag @${this.config.nametag}...`);
    await this.mintNametag();
  }

  private async mintNametag(): Promise<void> {
    if (!this.signingService) {
      throw new Error('Signing service not initialized');
    }

    const nametag = this.config.nametag;
    const ownerAddress = await this.getOwnerAddress();
    const nametagTokenType = new TokenType(Buffer.from(UNICITY_TOKEN_TYPE_HEX, 'hex'));

    const MAX_RETRIES = 3;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let commitment: MintCommitment<any> | null = null;

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        const salt = crypto.randomBytes(32);

        const mintData = await MintTransactionData.createFromNametag(
          nametag,
          nametagTokenType,
          ownerAddress,
          salt,
          ownerAddress
        );

        commitment = await MintCommitment.create(mintData);

        // eslint-disable-next-line no-console
        console.log(`[IdentityService] Submitting mint commitment (attempt ${attempt})...`);
        const response = await this.stateTransitionClient.submitMintCommitment(commitment);

        if (response.status === 'SUCCESS') {
          // eslint-disable-next-line no-console
          console.log('[IdentityService] Commitment accepted!');
          break;
        } else {
          // eslint-disable-next-line no-console
          console.log(`[IdentityService] Commitment failed: ${response.status}`);
          if (attempt === MAX_RETRIES) {
            throw new Error(`Failed after ${MAX_RETRIES} attempts: ${response.status}`);
          }
          await this.sleep(1000 * attempt);
        }
      } catch (error) {
        // eslint-disable-next-line no-console
        console.error(`[IdentityService] Attempt ${attempt} error:`, error);
        if (attempt === MAX_RETRIES) throw error;
        await this.sleep(1000 * attempt);
      }
    }

    if (!commitment) {
      throw new Error('Failed to create commitment');
    }

    // eslint-disable-next-line no-console
    console.log('[IdentityService] Waiting for inclusion proof...');
    const inclusionProof = await waitInclusionProof(
      this.rootTrustBase,
      this.stateTransitionClient,
      commitment
    );

    const genesisTransaction = commitment.toTransaction(inclusionProof);
    const txData = commitment.transactionData;
    const mintSalt = txData.salt;

    const nametagTokenId = await TokenId.fromNameTag(nametag);
    const nametagPredicate = await UnmaskedPredicate.create(
      nametagTokenId,
      nametagTokenType,
      this.signingService,
      HashAlgorithm.SHA256,
      mintSalt
    );

    const token = await Token.mint(
      this.rootTrustBase,
      new TokenState(nametagPredicate, null),
      genesisTransaction
    );

    // eslint-disable-next-line no-console
    console.log(`[IdentityService] Nametag @${nametag} minted successfully!`);

    this.nametagToken = token;
    this.saveNametagToStorage(token);
  }

  private async ensureNostrBinding(): Promise<void> {
    // eslint-disable-next-line no-console
    console.log('[IdentityService] Checking Nostr binding...');

    if (!this.identity) {
      throw new Error('Identity not initialized');
    }

    const secretKey = Buffer.from(this.identity.privateKeyHex, 'hex');
    const keyManager = NostrKeyManager.fromPrivateKey(secretKey);
    const client = new NostrClient(keyManager);

    try {
      await client.connect(this.config.relayUrl);

      // Check if binding already exists
      const existingPubkey = await client.queryPubkeyByNametag(this.config.nametag);

      if (existingPubkey === keyManager.getPublicKeyHex()) {
        // eslint-disable-next-line no-console
        console.log('[IdentityService] Nostr binding already exists');
        client.disconnect();
        return;
      }

      // Publish binding
      const proxyAddress = await ProxyAddress.fromNameTag(this.config.nametag);
      // eslint-disable-next-line no-console
      console.log(`[IdentityService] Publishing Nostr binding for @${this.config.nametag}...`);

      const published = await client.publishNametagBinding(
        this.config.nametag,
        proxyAddress.address
      );

      if (published) {
        // eslint-disable-next-line no-console
        console.log('[IdentityService] Nostr binding published!');
      }

      client.disconnect();
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error('[IdentityService] Error ensuring Nostr binding:', error);
      try {
        client.disconnect();
      } catch {
        // Ignore disconnect errors
      }
      throw error;
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async loadNametagFromStorage(): Promise<Token<any> | null> {
    const nametagPath = path.join(this.config.dataDir, `nametag-${this.config.nametag}.json`);
    if (!fs.existsSync(nametagPath)) {
      return null;
    }

    try {
      const data = fs.readFileSync(nametagPath, 'utf-8');
      const json = JSON.parse(data);
      const token = await Token.fromJSON(json.token);
      return token;
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error('[IdentityService] Failed to load nametag:', error);
      return null;
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private saveNametagToStorage(token: Token<any>): void {
    const nametagPath = path.join(this.config.dataDir, `nametag-${this.config.nametag}.json`);
    const data = {
      nametag: this.config.nametag,
      token: token.toJSON(),
      timestamp: Date.now(),
    };
    fs.writeFileSync(nametagPath, JSON.stringify(data, null, 2));
    // eslint-disable-next-line no-console
    console.log(`[IdentityService] Nametag saved to ${nametagPath}`);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  getIdentity(): IdentityData {
    if (!this.identity) {
      throw new Error('Identity not initialized');
    }
    return this.identity;
  }

  getNametag(): string {
    return this.config.nametag;
  }

  getPublicKeyHex(): string {
    if (!this.identity) {
      throw new Error('Identity not initialized');
    }
    return this.identity.publicKeyHex;
  }

  getPrivateKeyHex(): string {
    if (!this.identity) {
      throw new Error('Identity not initialized');
    }
    return this.identity.privateKeyHex;
  }

  getSigningService(): SigningService {
    if (!this.signingService) {
      throw new Error('Signing service not initialized');
    }
    return this.signingService;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  getNametagToken(): Token<any> | null {
    return this.nametagToken;
  }

  getStateTransitionClient(): StateTransitionClient {
    return this.stateTransitionClient;
  }

  getRootTrustBase(): RootTrustBase {
    return this.rootTrustBase;
  }

  isInitialized(): boolean {
    return this.initialized;
  }
}
