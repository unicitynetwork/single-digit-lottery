/**
 * Token Split Executor
 *
 * Executes token split operations using the SDK's TokenSplitBuilder.
 * A split operation:
 * 1. Burns the original token
 * 2. Mints two new tokens (recipient + change)
 * 3. Transfers the recipient token to them
 * 4. Keeps the change token for the sender
 *
 * Based on Sphere's implementation.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
import crypto from 'crypto';
import { Buffer } from 'buffer';
import { Token as SdkToken } from '@unicitylabs/state-transition-sdk/lib/token/Token.js';
import { TokenId } from '@unicitylabs/state-transition-sdk/lib/token/TokenId.js';
import { TokenState } from '@unicitylabs/state-transition-sdk/lib/token/TokenState.js';
import { CoinId } from '@unicitylabs/state-transition-sdk/lib/token/fungible/CoinId.js';
import { TokenCoinData } from '@unicitylabs/state-transition-sdk/lib/token/fungible/TokenCoinData.js';
import { TokenSplitBuilder } from '@unicitylabs/state-transition-sdk/lib/transaction/split/TokenSplitBuilder.js';
import { HashAlgorithm } from '@unicitylabs/state-transition-sdk/lib/hash/HashAlgorithm.js';
import { UnmaskedPredicate } from '@unicitylabs/state-transition-sdk/lib/predicate/embedded/UnmaskedPredicate.js';
import { UnmaskedPredicateReference } from '@unicitylabs/state-transition-sdk/lib/predicate/embedded/UnmaskedPredicateReference.js';
import { TransferCommitment } from '@unicitylabs/state-transition-sdk/lib/transaction/TransferCommitment.js';
import { waitInclusionProof } from '@unicitylabs/state-transition-sdk/lib/util/InclusionProofUtils.js';
import type { IAddress } from '@unicitylabs/state-transition-sdk/lib/address/IAddress.js';
import type { SigningService } from '@unicitylabs/state-transition-sdk/lib/sign/SigningService.js';
import type { StateTransitionClient } from '@unicitylabs/state-transition-sdk/lib/StateTransitionClient.js';
import type { RootTrustBase } from '@unicitylabs/state-transition-sdk/lib/bft/RootTrustBase.js';
import type { TransferTransaction } from '@unicitylabs/state-transition-sdk/lib/transaction/TransferTransaction.js';

/**
 * Result of a single token split operation
 */
export interface SplitTokenResult {
  tokenForRecipient: SdkToken<any>;
  tokenForSender: SdkToken<any>;
  recipientTransferTx: TransferTransaction;
}

/**
 * Configuration for TokenSplitExecutor
 */
export interface TokenSplitExecutorConfig {
  stateTransitionClient: StateTransitionClient;
  trustBase: RootTrustBase;
  signingService: SigningService;
}

/**
 * SHA-256 hash function
 */
async function sha256(input: string | Uint8Array): Promise<Uint8Array> {
  const data = typeof input === 'string' ? Buffer.from(input) : input;
  const hash = crypto.createHash('sha256').update(data).digest();
  return new Uint8Array(hash);
}

export class TokenSplitExecutor {
  private client: StateTransitionClient;
  private trustBase: RootTrustBase;
  private signingService: SigningService;

  constructor(config: TokenSplitExecutorConfig) {
    this.client = config.stateTransitionClient;
    this.trustBase = config.trustBase;
    this.signingService = config.signingService;
  }

  /**
   * Execute a single token split
   *
   * @param tokenToSplit - The token to split
   * @param splitAmount - Amount to transfer to recipient
   * @param remainderAmount - Amount to keep (change)
   * @param coinIdHex - Coin ID hex string
   * @param recipientAddress - Recipient's address
   * @returns Split result with new tokens and transfer transaction
   */
  async executeSplit(
    tokenToSplit: SdkToken<any>,
    splitAmount: bigint,
    remainderAmount: bigint,
    coinIdHex: string,
    recipientAddress: IAddress
  ): Promise<SplitTokenResult> {
    const tokenIdHex = Buffer.from(tokenToSplit.id.bytes).toString('hex');
    // eslint-disable-next-line no-console
    console.log(`[TokenSplitExecutor] Splitting token ${tokenIdHex.slice(0, 8)}...`);

    const coinId = new CoinId(Buffer.from(coinIdHex, 'hex'));

    // Create deterministic seed for reproducible IDs
    const seedString = `${tokenIdHex}_${splitAmount.toString()}_${remainderAmount.toString()}`;

    // Generate deterministic IDs and salts
    const recipientTokenId = new TokenId(await sha256(seedString));
    const senderTokenId = new TokenId(await sha256(seedString + '_sender'));
    const recipientSalt = await sha256(seedString + '_recipient_salt');
    const senderSalt = await sha256(seedString + '_sender_salt');

    // Create sender address
    const senderAddressRef = await UnmaskedPredicateReference.create(
      tokenToSplit.type,
      this.signingService.algorithm,
      this.signingService.publicKey,
      HashAlgorithm.SHA256
    );
    const senderAddress = await senderAddressRef.toAddress();

    // Build split using TokenSplitBuilder
    const builder = new TokenSplitBuilder();

    // Create recipient token
    const coinDataA = TokenCoinData.create([[coinId, splitAmount]]);
    builder.createToken(
      recipientTokenId,
      tokenToSplit.type,
      new Uint8Array(0),
      coinDataA,
      senderAddress, // Initially owned by sender (will be transferred)
      recipientSalt,
      null
    );

    // Create sender change token
    const coinDataB = TokenCoinData.create([[coinId, remainderAmount]]);
    builder.createToken(
      senderTokenId,
      tokenToSplit.type,
      new Uint8Array(0),
      coinDataB,
      senderAddress,
      senderSalt,
      null
    );

    // Build the split object
    const split = await builder.build(tokenToSplit);

    // === STEP 1: BURN ORIGINAL TOKEN ===
    // eslint-disable-next-line no-console
    console.log('[TokenSplitExecutor] Step 1: Burning original token...');

    const burnSalt = await sha256(seedString + '_burn_salt');
    const burnCommitment = await split.createBurnCommitment(burnSalt, this.signingService);

    const burnResponse = await this.client.submitTransferCommitment(burnCommitment);
    if (burnResponse.status !== 'SUCCESS' && burnResponse.status !== 'REQUEST_ID_EXISTS') {
      throw new Error(`Burn failed: ${burnResponse.status}`);
    }

    const burnInclusionProof = await waitInclusionProof(this.trustBase, this.client, burnCommitment);
    const burnTransaction = burnCommitment.toTransaction(burnInclusionProof);

    // eslint-disable-next-line no-console
    console.log('[TokenSplitExecutor] Original token burned.');

    // === STEP 2: MINT SPLIT TOKENS ===
    // eslint-disable-next-line no-console
    console.log('[TokenSplitExecutor] Step 2: Minting split tokens...');

    const mintCommitments = await split.createSplitMintCommitments(this.trustBase, burnTransaction);

    interface MintedTokenInfo {
      commitment: any;
      inclusionProof: any;
      isForRecipient: boolean;
      tokenId: TokenId;
      salt: Uint8Array;
    }

    const mintedTokensInfo: MintedTokenInfo[] = [];

    for (const commitment of mintCommitments) {
      const res = await this.client.submitMintCommitment(commitment);
      if (res.status !== 'SUCCESS' && res.status !== 'REQUEST_ID_EXISTS') {
        throw new Error(`Mint split token failed: ${res.status}`);
      }

      const proof = await waitInclusionProof(this.trustBase, this.client, commitment);

      const commTokenIdHex = Buffer.from(commitment.transactionData.tokenId.bytes).toString('hex');
      const recipientIdHex = Buffer.from(recipientTokenId.bytes).toString('hex');
      const isForRecipient = commTokenIdHex === recipientIdHex;

      mintedTokensInfo.push({
        commitment,
        inclusionProof: proof,
        isForRecipient,
        tokenId: commitment.transactionData.tokenId,
        salt: commitment.transactionData.salt,
      });
    }

    // eslint-disable-next-line no-console
    console.log('[TokenSplitExecutor] Split tokens minted.');

    // === STEP 3: RECONSTRUCT TOKEN OBJECTS ===
    const recipientInfo = mintedTokensInfo.find((t) => t.isForRecipient);
    const senderInfo = mintedTokensInfo.find((t) => !t.isForRecipient);

    if (!recipientInfo || !senderInfo) {
      throw new Error('Failed to identify split tokens');
    }

    const recipientTokenBeforeTransfer = await this.createAndVerifyToken(
      recipientInfo,
      tokenToSplit.type,
      'Recipient'
    );

    const senderToken = await this.createAndVerifyToken(senderInfo, tokenToSplit.type, 'Sender (Change)');

    // === STEP 4: TRANSFER TO RECIPIENT ===
    // eslint-disable-next-line no-console
    console.log('[TokenSplitExecutor] Step 3: Transferring to recipient...');

    const transferSalt = await sha256(seedString + '_transfer_salt');

    const transferCommitment = await TransferCommitment.create(
      recipientTokenBeforeTransfer,
      recipientAddress,
      transferSalt,
      null,
      null,
      this.signingService
    );

    const transferRes = await this.client.submitTransferCommitment(transferCommitment);
    if (transferRes.status !== 'SUCCESS' && transferRes.status !== 'REQUEST_ID_EXISTS') {
      throw new Error(`Transfer failed: ${transferRes.status}`);
    }

    const transferProof = await waitInclusionProof(this.trustBase, this.client, transferCommitment);
    const transferTx = transferCommitment.toTransaction(transferProof);

    // eslint-disable-next-line no-console
    console.log('[TokenSplitExecutor] Split transfer complete!');

    return {
      tokenForRecipient: recipientTokenBeforeTransfer,
      tokenForSender: senderToken,
      recipientTransferTx: transferTx,
    };
  }

  /**
   * Reconstruct and verify a token from mint info
   */
  private async createAndVerifyToken(
    info: { commitment: any; inclusionProof: any; tokenId: TokenId; salt: Uint8Array },
    tokenType: any,
    label: string
  ): Promise<SdkToken<any>> {
    // 1. Recreate Predicate
    const predicate = await UnmaskedPredicate.create(
      info.tokenId,
      tokenType,
      this.signingService,
      HashAlgorithm.SHA256,
      info.salt
    );

    // 2. Recreate State
    const state = new TokenState(predicate, null);

    // 3. Create Token
    const token = await SdkToken.mint(this.trustBase, state, info.commitment.toTransaction(info.inclusionProof));

    // 4. Verify
    const verification = await token.verify(this.trustBase);
    if (!verification.isSuccessful) {
      // eslint-disable-next-line no-console
      console.error(`[TokenSplitExecutor] Verification failed for ${label}`, verification);
      throw new Error(`Token verification failed: ${label}`);
    }

    return token;
  }
}
