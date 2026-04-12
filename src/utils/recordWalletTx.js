const WalletTransaction = require('../models/WalletTransaction');

/**
 * Record a wallet transaction. Non-fatal — logs error but never throws.
 *
 * @param {string|ObjectId} userId
 * @param {'credit'|'debit'} type
 * @param {string} category  - see WalletTransaction model enum
 * @param {number} amount
 * @param {string} description
 * @param {number} balanceBefore
 * @param {number} balanceAfter
 * @param {string|null} refId  - optional reference (matchId, requestId, betId…)
 * @param {string|null} adminId - admin who performed the action (for admin_credit/admin_debit)
 */
async function recordWalletTx(userId, type, category, amount, description, balanceBefore, balanceAfter, refId = null, adminId = null) {
  try {
    await WalletTransaction.create({
      userId,
      type,
      category,
      amount,
      description,
      balanceBefore,
      balanceAfter,
      refId: refId ? String(refId) : null,
      adminId: adminId || null,
    });
  } catch (err) {
    console.error('[WalletTx] Failed to record transaction:', err.message);
  }
}

module.exports = { recordWalletTx };
