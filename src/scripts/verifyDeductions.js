require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const mongoose = require('mongoose');
const User = require('../models/User');
const WalletTransaction = require('../models/WalletTransaction');

async function run() {
  await mongoose.connect(process.env.MONGODB_URI);
  console.log('Connected\n');

  // ═══════════════════════════════════════════════════════
  // 1. Sachin Kumar Swami — check admin_credit transactions
  // ═══════════════════════════════════════════════════════
  console.log('═══════════════════════════════════════════');
  console.log('  SACHIN KUMAR SWAMI (7877722306) — admin credits');
  console.log('═══════════════════════════════════════════');
  const sachin = await User.findOne({ phone: '7877722306' });
  if (sachin) {
    const adminCredits = await WalletTransaction.find({
      userId: sachin._id,
      category: { $in: ['admin_credit', 'admin_debit'] },
    }).sort({ createdAt: -1 });
    for (const tx of adminCredits) {
      console.log(`  ${tx.createdAt.toISOString().slice(0, 19)} | ${tx.type} | ₹${tx.amount} | ${tx.category} | ${tx.description}`);
    }
    if (adminCredits.length === 0) console.log('  No admin credit/debit transactions found');
  }

  // ═══════════════════════════════════════════════════════
  // 2. Double-refund users — check if admin_debit was done to recover
  // ═══════════════════════════════════════════════════════
  console.log('\n═══════════════════════════════════════════');
  console.log('  DOUBLE-REFUND USERS — recovery check');
  console.log('═══════════════════════════════════════════');

  const users = [
    { name: 'GhbJK', phone: '6377259171', leaked: 29200 },
    { name: 'Superb', phone: '9116371247', leaked: 12050 },
    { name: 'King', phone: '9166821247', leaked: 8200 },
    { name: 'Rahul', phone: '9660259432', leaked: 3600 },
    { name: 'Akhtar', phone: '7849960572', leaked: 1700 },
    { name: 'Jai Mahakal', phone: '9057490598', leaked: 1000 },
    { name: 'Hansraj', phone: '7877534624', leaked: 50 },
  ];

  let totalLeaked = 0;
  let totalRecovered = 0;

  for (const u of users) {
    const user = await User.findOne({ phone: u.phone });
    if (!user) { console.log(`\n  ❌ ${u.name} (${u.phone}) — NOT FOUND`); continue; }

    // Check admin debits (manual deductions to recover leaked money)
    const adminDebits = await WalletTransaction.find({
      userId: user._id,
      category: 'admin_debit',
    }).sort({ createdAt: -1 });

    const totalAdminDebit = adminDebits.reduce((s, tx) => s + tx.amount, 0);

    // Check admin credits
    const adminCredits = await WalletTransaction.find({
      userId: user._id,
      category: 'admin_credit',
    }).sort({ createdAt: -1 });
    const totalAdminCredit = adminCredits.reduce((s, tx) => s + tx.amount, 0);

    // Check balance subtracted via admin (set operation doesn't always create admin_debit tx)
    // So also check all debit transactions around Mar 19
    const mar19Start = new Date('2026-03-19T00:00:00Z');
    const mar19End = new Date('2026-03-20T23:59:59Z');
    const debitsAroundLeak = await WalletTransaction.find({
      userId: user._id,
      type: 'debit',
      createdAt: { $gte: mar19Start, $lte: mar19End },
    }).sort({ createdAt: 1 });

    console.log(`\n  ${u.name} (${u.phone}) — Leaked: ₹${u.leaked} | Current balance: ₹${user.walletBalance}`);
    console.log(`  deposit: ₹${user.depositBalance} | earnings: ₹${user.earningsBalance}`);

    if (adminDebits.length > 0) {
      console.log(`  Admin debits: ₹${totalAdminDebit} in ${adminDebits.length} txns`);
      for (const tx of adminDebits) {
        console.log(`    ${tx.createdAt.toISOString().slice(0, 19)} | -₹${tx.amount} | ${tx.description}`);
      }
    } else {
      console.log(`  Admin debits: NONE`);
    }

    if (adminCredits.length > 0) {
      console.log(`  Admin credits: ₹${totalAdminCredit} in ${adminCredits.length} txns`);
    }

    totalLeaked += u.leaked;
    totalRecovered += totalAdminDebit;
  }

  console.log('\n═══════════════════════════════════════════');
  console.log('  SUMMARY');
  console.log('═══════════════════════════════════════════');
  console.log(`  Total leaked: ₹${totalLeaked}`);
  console.log(`  Total recovered (admin_debit): ₹${totalRecovered}`);
  console.log(`  Unrecovered: ₹${totalLeaked - totalRecovered}`);

  // ═══════════════════════════════════════════════════════
  // 3. Jai Mahakal — investigate the ₹10 crore
  // ═══════════════════════════════════════════════════════
  console.log('\n═══════════════════════════════════════════');
  console.log('  JAI MAHAKAL (9057490598) — ₹10 crore investigation');
  console.log('═══════════════════════════════════════════');
  const jai = await User.findOne({ phone: '9057490598' });
  if (jai) {
    console.log(`  Current balance: ₹${jai.walletBalance}`);
    console.log(`  deposit: ₹${jai.depositBalance} | earnings: ₹${jai.earningsBalance}`);

    // Get ALL credits sorted by amount descending
    const bigCredits = await WalletTransaction.find({
      userId: jai._id,
      type: 'credit',
    }).sort({ amount: -1 }).limit(15);

    console.log('\n  Top 15 credits (by amount):');
    for (const tx of bigCredits) {
      console.log(`    ${tx.createdAt.toISOString().slice(0, 19)} | +₹${tx.amount} | ${tx.category} | ${tx.description}`);
    }
  }

  await mongoose.disconnect();
  console.log('\n✅ Done');
}

run().catch((err) => { console.error(err); process.exit(1); });
