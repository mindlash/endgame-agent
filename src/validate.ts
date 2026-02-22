/**
 * EndGame Agent -- Claim Validation / Dry-Run
 *
 * Verifies the claim mechanism works correctly WITHOUT submitting a transaction.
 * Checks PDA derivation, on-chain accounts, API connectivity, and tx building.
 *
 * Usage: npm run validate
 */

import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
} from '@solana/web3.js';
import {
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountInstruction,
  TOKEN_2022_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
} from '@solana/spl-token';

// ── Constants ──────────────────────────────────────────────────────

const RPC_ENDPOINTS = [
  'https://api.mainnet-beta.solana.com',
  'https://shy-magical-gadget.solana-mainnet.quiknode.pro/b85de90502f455a0dbed7f0e4c4b5ef3c2f41687/',
  'https://mainnet.helius-rpc.com/?api-key=0bab371e-2aae-4bc1-8a31-cde10e271382',
];
const API_BASE = 'https://api.endgame.cash';
const API_HEADERS = {
  Accept: 'application/json',
  Origin: 'https://endgame.cash',
  Referer: 'https://endgame.cash/',
};

const PROGRAM_ID = new PublicKey('pjMUjMjHTHot5bYrBu9qd4cRaNKdK1eTR8iVYouQzDo');
const TOKEN_MINT = new PublicKey('2B8LYcPoGn1SmigGtvUSCTDtmGRZxZXVEouYu4RyfEDb');
const EXPECTED_GAME_STATE_PDA = new PublicKey('Ee8StbWk4TxcbUM1XZRJ18RgxyycGBZhdCFrPDuV62P1');
const VAULT_ADDRESS = new PublicKey('9JuE3Pip7gnA4vVRWNNMzidsKkUJ5LRbnaUWToswVpNF');

let passed = 0;
let failed = 0;

function pass(msg: string): void {
  console.log(`  \x1b[32m\u2713\x1b[0m ${msg}`);
  passed++;
}

function fail(msg: string): void {
  console.log(`  \x1b[31m\u2717\x1b[0m ${msg}`);
  failed++;
}

function deriveRoundPda(roundId: number): PublicKey {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(BigInt(roundId), 0);
  const [pda] = PublicKey.findProgramAddressSync([Buffer.from('round'), buf], PROGRAM_ID);
  return pda;
}

function buildClaimDiscriminator(): Buffer {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(3n, 0);
  return buf;
}

// ── Main ───────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('\n=== EndGame Agent \u2014 Claim Validation ===\n');

  // Find a working RPC endpoint
  let connection!: Connection;
  for (const rpc of RPC_ENDPOINTS) {
    try {
      const conn = new Connection(rpc, 'confirmed');
      await conn.getSlot();
      connection = conn;
      console.log(`RPC: ${new URL(rpc).hostname}\n`);
      break;
    } catch {
      // Try next endpoint
    }
  }
  if (!connection) {
    console.log('  \x1b[31m\u2717\x1b[0m Could not connect to any Solana RPC endpoint\n');
    process.exit(2);
  }

  // [1/5] PDA derivation
  console.log('[1/5] PDA derivation...');
  try {
    const [derived] = PublicKey.findProgramAddressSync([Buffer.from('game_state')], PROGRAM_ID);
    if (derived.equals(EXPECTED_GAME_STATE_PDA)) {
      pass(`Game State PDA matches (${derived.toBase58().slice(0, 8)}...)`);
    } else {
      fail(`PDA mismatch: expected ${EXPECTED_GAME_STATE_PDA.toBase58()}, got ${derived.toBase58()}`);
    }
  } catch (e) {
    fail(`PDA derivation error: ${e instanceof Error ? e.message : String(e)}`);
  }

  // [2/5] On-chain accounts
  console.log('[2/5] On-chain accounts...');
  try {
    const [gameStateInfo, vaultInfo, mintInfo] = await Promise.all([
      connection.getAccountInfo(EXPECTED_GAME_STATE_PDA),
      connection.getAccountInfo(VAULT_ADDRESS),
      connection.getAccountInfo(TOKEN_MINT),
    ]);

    if (gameStateInfo) {
      pass(`Game State exists (owner: ${gameStateInfo.owner.toBase58().slice(0, 8)}..., ${gameStateInfo.data.length} bytes)`);
    } else {
      fail('Game State account not found on-chain');
    }

    if (vaultInfo) {
      pass(`Vault exists (owner: ${vaultInfo.owner.toBase58().slice(0, 8)}..., ${vaultInfo.data.length} bytes)`);
    } else {
      fail('Vault account not found on-chain');
    }

    if (mintInfo) {
      const isToken2022 = mintInfo.owner.equals(TOKEN_2022_PROGRAM_ID);
      pass(`Token Mint exists (${isToken2022 ? 'Token-2022' : 'owner: ' + mintInfo.owner.toBase58().slice(0, 8) + '...'})`);
    } else {
      fail('Token Mint account not found on-chain');
    }
  } catch (e) {
    fail(`On-chain account check error: ${e instanceof Error ? e.message : String(e)}`);
  }

  // [3/5] API connectivity
  console.log('[3/5] API connectivity...');
  let roundId = 0;
  let hasWinner = false;
  try {
    const res = await fetch(`${API_BASE}/api/game/status`, { headers: API_HEADERS });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json() as Record<string, unknown>;
    roundId = Number(data.round_id ?? data.current_round ?? 0);
    const status = String(data.status ?? 'unknown');
    hasWinner = Boolean(data.winner && String(data.winner).length > 10);
    pass(`Round ${roundId}, status: ${status}${hasWinner ? ', winner: ' + String(data.winner).slice(0, 8) + '...' : ''}`);
  } catch (e) {
    fail(`API error: ${e instanceof Error ? e.message : String(e)}`);
  }

  // [4/5] Round PDA verification
  console.log('[4/5] Round PDA...');
  if (roundId > 0) {
    try {
      const roundPda = deriveRoundPda(roundId);
      const roundInfo = await connection.getAccountInfo(roundPda);
      if (roundInfo) {
        pass(`Round PDA for #${roundId} exists on-chain (${roundPda.toBase58().slice(0, 8)}..., ${roundInfo.data.length} bytes)`);
      } else {
        // Current round PDA might not be created yet; try previous round
        const prevPda = deriveRoundPda(roundId - 1);
        const prevInfo = await connection.getAccountInfo(prevPda);
        if (prevInfo) {
          pass(`Round PDA for #${roundId - 1} (prev) exists on-chain (${prevPda.toBase58().slice(0, 8)}..., ${prevInfo.data.length} bytes)`);
        } else {
          fail(`Neither round #${roundId} nor #${roundId - 1} PDA found on-chain`);
        }
      }
    } catch (e) {
      fail(`Round PDA check error: ${e instanceof Error ? e.message : String(e)}`);
    }
  } else {
    fail('Skipped -- no round ID from API');
  }

  // [5/5] Mock transaction build
  console.log('[5/5] Transaction build...');
  try {
    const dummyWallet = Keypair.generate();
    const roundPda = deriveRoundPda(roundId > 0 ? roundId : 1);

    const winnerAta = getAssociatedTokenAddressSync(
      TOKEN_MINT,
      dummyWallet.publicKey,
      false,
      TOKEN_2022_PROGRAM_ID,
    );

    const tx = new Transaction();

    // Add ATA creation (dummy wallet won't have one)
    tx.add(
      createAssociatedTokenAccountInstruction(
        dummyWallet.publicKey,
        winnerAta,
        dummyWallet.publicKey,
        TOKEN_MINT,
        TOKEN_2022_PROGRAM_ID,
        ASSOCIATED_TOKEN_PROGRAM_ID,
      ),
    );

    // Add claim instruction
    tx.add(
      new TransactionInstruction({
        programId: PROGRAM_ID,
        keys: [
          { pubkey: EXPECTED_GAME_STATE_PDA, isSigner: false, isWritable: true },
          { pubkey: roundPda, isSigner: false, isWritable: true },
          { pubkey: VAULT_ADDRESS, isSigner: false, isWritable: true },
          { pubkey: winnerAta, isSigner: false, isWritable: true },
          { pubkey: dummyWallet.publicKey, isSigner: true, isWritable: false },
          { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false },
          { pubkey: TOKEN_MINT, isSigner: false, isWritable: false },
        ],
        data: buildClaimDiscriminator(),
      }),
    );

    // Set blockhash so we can serialize
    const { blockhash } = await connection.getLatestBlockhash('confirmed');
    tx.recentBlockhash = blockhash;
    tx.feePayer = dummyWallet.publicKey;

    // Sign with dummy key to verify serialization works
    tx.sign(dummyWallet);
    const raw = tx.serialize();
    pass(`Mock claim tx built and signed (${raw.length} bytes, ${tx.instructions.length} instructions)`);
  } catch (e) {
    fail(`Transaction build error: ${e instanceof Error ? e.message : String(e)}`);
  }

  // ── Summary ────────────────────────────────────────────────────────
  const total = passed + failed;
  console.log(`\n${'='.repeat(46)}`);
  if (failed === 0) {
    console.log(`\x1b[32mAll ${total} checks passed.\x1b[0m Claim executor is correctly configured.`);
  } else {
    console.log(`\x1b[31m${failed}/${total} checks failed.\x1b[0m Review errors above.`);
  }
  console.log();

  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(2);
});
