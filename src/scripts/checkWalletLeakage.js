require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const mongoose = require('mongoose');
const User = require('../models/User');
const WalletTransaction = require('../models/WalletTransaction');
const WalletRequest = require('../models/WalletRequest');
const LudoMatch = require('../models/LudoMatch');
const LudoResultRequest = require('../models/LudoResultRequest');

async function run() {
  await mongoose.connect(process.env.MONGODB_URI);
  console.log('Connected to MongoDB\n');

  const fiveDaysAgo = new Date();
  fiveDaysAgo.setDate(fiveDaysAgo.getDate() - 5);

  // ═══════════════════════════════════════════════════════
  // 1. Check user 9351253162
  // ═══════════════════════════════════════════════════════
  console.log('═══════════════════════════════════════════');
  console.log('  USER 9351253162');
  console.log('═══════════════════════════════════════════');
  const targetUser = await User.findOne({ phone: '9351253162' });
  if (targetUser) {
    console.log(`Name: ${targetUser.name}`);
    console.log(`walletBalance: ₹${targetUser.walletBalance}`);
    console.log(`depositBalance: ₹${targetUser.depositBalance}`);
    console.log(`earningsBalance: ₹${targetUser.earningsBalance}`);
    console.log(`SUM check: ${targetUser.depositBalance} + ${targetUser.earningsBalance} = ${targetUser.depositBalance + targetUser.earningsBalance} (wallet=${targetUser.walletBalance}) ${(targetUser.depositBalance + targetUser.earningsBalance) === targetUser.walletBalance ? '✅ MATCH' : '❌ MISMATCH!'}`);

    // Recent credits
    const recentTx = await WalletTransaction.find({
      userId: targetUser._id,
      type: 'credit',
      createdAt: { $gte: fiveDaysAgo },
    }).sort({ createdAt: -1 });

    console.log(`\nCredits in last 5 days: ${recentTx.length} transactions`);
    let totalCredited = 0;
    for (const tx of recentTx) {
      totalCredited += tx.amount;
      console.log(`  ${tx.createdAt.toISOString().slice(0, 19)} | +₹${tx.amount} | ${tx.category} | ${tx.description}`);
    }
    console.log(`  TOTAL CREDITED: ₹${totalCredited}`);

    // Recent debits
    const recentDebits = await WalletTransaction.find({
      userId: targetUser._id,
      type: 'debit',
      createdAt: { $gte: fiveDaysAgo },
    }).sort({ createdAt: -1 });
    let totalDebited = 0;
    for (const tx of recentDebits) totalDebited += tx.amount;
    console.log(`  TOTAL DEBITED: ₹${totalDebited}`);
    console.log(`  NET CHANGE: ₹${totalCredited - totalDebited}`);
  } else {
    console.log('User not found with phone 9351253162');
  }

  // ═══════════════════════════════════════════════════════
  // 2. Find DUPLICATE credits (same refId = double credit bug)
  // ═══════════════════════════════════════════════════════
  console.log('\n═══════════════════════════════════════════');
  console.log('  DUPLICATE CREDITS (same refId) — last 5 days');
  console.log('═══════════════════════════════════════════');

  const dupes = await WalletTransaction.aggregate([
    { $match: { type: 'credit', createdAt: { $gte: fiveDaysAgo }, refId: { $ne: null } } },
    { $group: { _id: { refId: '$refId', category: '$category', userId: '$userId' }, count: { $sum: 1 }, totalAmount: { $sum: '$amount' }, docs: { $push: { _id: '$_id', createdAt: '$createdAt', amount: '$amount' } } } },
    { $match: { count: { $gt: 1 } } },
    { $sort: { count: -1 } },
  ]);

  if (dupes.length === 0) {
    console.log('✅ No duplicate credits found');
  } else {
    console.log(`❌ Found ${dupes.length} duplicate credit groups:`);
    for (const d of dupes) {
      const user = await User.findById(d._id.userId).select('name phone');
      console.log(`\n  User: ${user?.name || '?'} (${user?.phone || '?'})`);
      console.log(`  Category: ${d._id.category} | RefId: ${d._id.refId}`);
      console.log(`  Count: ${d.count} times | Total: ₹${d.totalAmount}`);
      for (const doc of d.docs) {
        console.log(`    ${doc.createdAt.toISOString().slice(0, 19)} | ₹${doc.amount}`);
      }
    }
  }

  // ═══════════════════════════════════════════════════════
  // 3. Find users with balance mismatch (deposit+earnings != wallet)
  // ═══════════════════════════════════════════════════════
  console.log('\n═══════════════════════════════════════════');
  console.log('  BALANCE MISMATCH (deposit+earnings != wallet)');
  console.log('═══════════════════════════════════════════');

  const allUsers = await User.find({ walletBalance: { $gt: 0 } }).select('name phone walletBalance depositBalance earningsBalance');
  let mismatchCount = 0;
  for (const u of allUsers) {
    const sum = (u.depositBalance || 0) + (u.earningsBalance || 0);
    const diff = Math.abs(u.walletBalance - sum);
    if (diff > 0.01) {
      mismatchCount++;
      console.log(`  ❌ ${u.name || '?'} (${u.phone || '?'}) — wallet: ₹${u.walletBalance}, deposit+earnings: ₹${sum}, DIFF: ₹${(u.walletBalance - sum).toFixed(2)}`);
    }
  }
  if (mismatchCount === 0) console.log('✅ All balances in sync');

  // ═══════════════════════════════════════════════════════
  // 4. Find suspicious automatic credits (non-game, non-admin) in last 5 days
  // ═══════════════════════════════════════════════════════
  console.log('\n═══════════════════════════════════════════');
  console.log('  USERS WITH MOST CREDITS (last 5 days)');
  console.log('═══════════════════════════════════════════');

  const topCredits = await WalletTransaction.aggregate([
    { $match: { type: 'credit', createdAt: { $gte: fiveDaysAgo } } },
    { $group: { _id: '$userId', totalCredited: { $sum: '$amount' }, txCount: { $sum: 1 } } },
    { $sort: { totalCredited: -1 } },
    { $limit: 15 },
  ]);

  for (const row of topCredits) {
    const user = await User.findById(row._id).select('name phone walletBalance');
    console.log(`  ${user?.name || '?'} (${user?.phone || '?'}) — ₹${row.totalCredited} credited in ${row.txCount} txns | current balance: ₹${user?.walletBalance || 0}`);
  }

  // ═══════════════════════════════════════════════════════
  // 5. Ludo: double-win check (same match credited twice)
  // ═══════════════════════════════════════════════════════
  console.log('\n═══════════════════════════════════════════');
  console.log('  LUDO DOUBLE-WIN CHECK (last 5 days)');
  console.log('═══════════════════════════════════════════');

  const ludoWinDupes = await WalletTransaction.aggregate([
    { $match: { category: 'ludo_win', createdAt: { $gte: fiveDaysAgo }, refId: { $ne: null } } },
    { $group: { _id: '$refId', count: { $sum: 1 }, totalAmount: { $sum: '$amount' }, users: { $push: '$userId' } } },
    { $match: { count: { $gt: 1 } } },
  ]);

  if (ludoWinDupes.length === 0) {
    console.log('✅ No double ludo wins found');
  } else {
    console.log(`❌ Found ${ludoWinDupes.length} double-win matches:`);
    for (const d of ludoWinDupes) {
      console.log(`  MatchId: ${d._id} | ${d.count} credits | Total: ₹${d.totalAmount}`);
      for (const uid of d.users) {
        const u = await User.findById(uid).select('name phone');
        console.log(`    → ${u?.name || '?'} (${u?.phone || '?'})`);
      }
    }
  }

  // ═══════════════════════════════════════════════════════
  // 6. Deposit: double-approval check (same request approved twice)
  // ═══════════════════════════════════════════════════════
  console.log('\n═══════════════════════════════════════════');
  console.log('  DEPOSIT DOUBLE-APPROVAL CHECK (last 5 days)');
  console.log('═══════════════════════════════════════════');

  const depositDupes = await WalletTransaction.aggregate([
    { $match: { category: 'deposit', createdAt: { $gte: fiveDaysAgo }, refId: { $ne: null } } },
    { $group: { _id: '$refId', count: { $sum: 1 }, totalAmount: { $sum: '$amount' }, users: { $push: '$userId' } } },
    { $match: { count: { $gt: 1 } } },
  ]);

  if (depositDupes.length === 0) {
    console.log('✅ No double deposit approvals found');
  } else {
    console.log(`❌ Found ${depositDupes.length} double-approved deposits:`);
    for (const d of depositDupes) {
      const u = await User.findById(d.users[0]).select('name phone');
      console.log(`  RequestId: ${d._id} | ${d.count} credits | Total: ₹${d.totalAmount} | User: ${u?.name} (${u?.phone})`);
    }
  }

  // ═══════════════════════════════════════════════════════
  // 7. Ludo refund check — excessive refunds for same user
  // ═══════════════════════════════════════════════════════
  console.log('\n═══════════════════════════════════════════');
  console.log('  LUDO REFUNDS — top users (last 5 days)');
  console.log('═══════════════════════════════════════════');

  const topRefunds = await WalletTransaction.aggregate([
    { $match: { category: 'ludo_refund', createdAt: { $gte: fiveDaysAgo } } },
    { $group: { _id: '$userId', totalRefunded: { $sum: '$amount' }, txCount: { $sum: 1 } } },
    { $sort: { totalRefunded: -1 } },
    { $limit: 10 },
  ]);

  for (const row of topRefunds) {
    const user = await User.findById(row._id).select('name phone');
    console.log(`  ${user?.name || '?'} (${user?.phone || '?'}) — ₹${row.totalRefunded} refunded in ${row.txCount} txns`);
  }

  // ═══════════════════════════════════════════════════════
  // 8. Ludo refund double check — same match refunded twice to same user
  // ═══════════════════════════════════════════════════════
  console.log('\n═══════════════════════════════════════════');
  console.log('  LUDO DOUBLE-REFUND CHECK (same match, same user)');
  console.log('═══════════════════════════════════════════');

  const refundDupes = await WalletTransaction.aggregate([
    { $match: { category: 'ludo_refund', createdAt: { $gte: fiveDaysAgo }, refId: { $ne: null } } },
    { $group: { _id: { refId: '$refId', userId: '$userId' }, count: { $sum: 1 }, totalAmount: { $sum: '$amount' } } },
    { $match: { count: { $gt: 1 } } },
  ]);

  if (refundDupes.length === 0) {
    console.log('✅ No double ludo refunds found');
  } else {
    console.log(`❌ Found ${refundDupes.length} double-refund cases:`);
    for (const d of refundDupes) {
      const u = await User.findById(d._id.userId).select('name phone');
      console.log(`  MatchId: ${d._id.refId} | User: ${u?.name} (${u?.phone}) | ${d.count} refunds | Total: ₹${d.totalAmount}`);
    }
  }

  await mongoose.disconnect();
  console.log('\n✅ Done');
}

run().catch((err) => { console.error(err); process.exit(1); });
