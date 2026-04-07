require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const mongoose = require('mongoose');
const User = require('../models/User');
const WalletTransaction = require('../models/WalletTransaction');
const Bet = require('../models/Bet');
const LudoMatch = require('../models/LudoMatch');
const SpinnerRecord = require('../models/SpinnerRecord');

const PHONE = '7877166351';

async function run() {
  await mongoose.connect(process.env.MONGODB_URI);
  console.log('Connected\n');

  const user = await User.findOne({ phone: PHONE });
  if (!user) { console.log('User not found'); process.exit(1); }

  console.log('═══════════════════════════════════════════');
  console.log(`  USER: ${user.name} (${user.phone})`);
  console.log(`  Current balance: ₹${user.walletBalance}`);
  console.log(`  Deposit: ₹${user.depositBalance} | Earnings: ₹${user.earningsBalance}`);
  console.log('═══════════════════════════════════════════\n');

  // Get ALL wallet transactions for this user, sorted by time
  const txns = await WalletTransaction.find({ userId: user._id }).sort({ createdAt: -1 });

  console.log(`Total wallet transactions: ${txns.length}\n`);

  // Find any debit around ₹1051 (+/- 100)
  const suspiciousTxns = txns.filter(tx =>
    tx.type === 'debit' && tx.amount >= 950 && tx.amount <= 1150
  );

  if (suspiciousTxns.length > 0) {
    console.log('═══ DEBITS AROUND ₹1051 ═══');
    for (const tx of suspiciousTxns) {
      console.log(`  ${tx.createdAt.toISOString().slice(0, 19)} | -₹${tx.amount} | ${tx.category} | ${tx.description}`);
      console.log(`    Balance: ₹${tx.balanceBefore} → ₹${tx.balanceAfter}`);
    }
    console.log('');
  } else {
    console.log('No single debit around ₹1051 found. Checking for multiple debits...\n');
  }

  // Show last 30 transactions to see the pattern
  console.log('═══ LAST 40 TRANSACTIONS (newest first) ═══');
  for (const tx of txns.slice(0, 40)) {
    const sign = tx.type === 'credit' ? '+' : '-';
    const bal = tx.balanceBefore != null ? `₹${tx.balanceBefore} → ₹${tx.balanceAfter}` : '';
    console.log(`  ${tx.createdAt.toISOString().slice(0, 19)} | ${sign}₹${tx.amount.toString().padStart(6)} | ${tx.category.padEnd(16)} | ${tx.description} | ${bal}`);
  }

  // Check for any balance drops of ~1051 by looking at consecutive transactions
  console.log('\n═══ BALANCE DROPS > ₹500 ═══');
  for (let i = 0; i < txns.length - 1; i++) {
    const curr = txns[i];
    const prev = txns[i + 1]; // prev in time (txns sorted newest first)
    if (prev.balanceAfter != null && curr.balanceBefore != null) {
      // balanceAfter of older tx should equal balanceBefore of newer tx
      // If there's a gap, something happened outside wallet transactions
      const gap = prev.balanceAfter - curr.balanceBefore;
      if (Math.abs(gap) > 1) {
        console.log(`  GAP between txns: ₹${prev.balanceAfter} (after ${prev.createdAt.toISOString().slice(0,19)}) → ₹${curr.balanceBefore} (before ${curr.createdAt.toISOString().slice(0,19)}) = ${gap > 0 ? '-' : '+'}₹${Math.abs(gap).toFixed(2)} UNEXPLAINED`);
      }
    }
  }

  // Check ludo matches — look for double-deductions or missing refunds
  console.log('\n═══ RECENT LUDO MATCHES (last 20) ═══');
  const ludoMatches = await LudoMatch.find({
    $or: [{ creatorId: user._id }, { 'players.userId': user._id }]
  }).sort({ createdAt: -1 }).limit(20);

  for (const m of ludoMatches) {
    const myPlayer = m.players.find(p => p.userId?.toString() === user._id.toString());
    const isWinner = m.winnerId?.toString() === user._id.toString();
    console.log(`  ${m.createdAt.toISOString().slice(0,19)} | ₹${m.entryAmount} | ${m.status.padEnd(12)} | ${isWinner ? 'WON' : m.winnerId ? 'LOST' : '—'} | paid: ₹${myPlayer?.amountPaid ?? '?'} | ${m._id}`);
  }

  // Check aviator bets
  console.log('\n═══ RECENT AVIATOR BETS (last 20) ═══');
  const bets = await Bet.find({ userId: user._id }).sort({ createdAt: -1 }).limit(20);
  for (const b of bets) {
    console.log(`  ${b.createdAt.toISOString().slice(0,19)} | ₹${b.amount} | ${b.status.padEnd(8)} | profit: ₹${b.profit || 0} | cashout: ${b.cashOutMultiplier || '—'}`);
  }

  // Check spinner
  console.log('\n═══ RECENT SPINNER (last 10) ═══');
  const spins = await SpinnerRecord.find({ userId: user._id }).sort({ createdAt: -1 }).limit(10);
  for (const s of spins) {
    console.log(`  ${s.createdAt.toISOString().slice(0,19)} | cost: ₹${s.cost || 50} | won: ₹${s.winAmount || 0} | ${s.result || ''}`);
  }

  await mongoose.disconnect();
  console.log('\nDone');
}

run().catch(err => { console.error(err); process.exit(1); });
