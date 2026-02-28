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
 */
async function recordWalletTx(userId, type, category, amount, description, balanceBefore, balanceAfter, refId = null) {
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
    });
  } catch (err) {
    console.error('[WalletTx] Failed to record transaction:', err.message);
  }
}

module.exports = { recordWalletTx };
