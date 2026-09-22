const { readSiteSettings } = require('./siteSettings');
const { currentSite } = require('../config/db');

// Default tiers (fallback if settings not found)
const DEFAULTS = {
  ludoCommTier1Max: 250,
  ludoCommTier1Pct: 10,
  ludoCommTier2Max: 600,
  ludoCommTier2Pct: 8,
  ludoCommTier3Pct: 5,
};

/**
 * Commission tiers for the site this request belongs to. Reading the 'main'
 * document meant the vk and 101dream admins' tiers were silently ignored.
 */
async function getCommissionTiers(siteType) {
  const s = await readSiteSettings(siteType || currentSite());
  return {
    tier1Max: s?.ludoCommTier1Max ?? DEFAULTS.ludoCommTier1Max,
    tier1Pct: s?.ludoCommTier1Pct ?? DEFAULTS.ludoCommTier1Pct,
    tier2Max: s?.ludoCommTier2Max ?? DEFAULTS.ludoCommTier2Max,
    tier2Pct: s?.ludoCommTier2Pct ?? DEFAULTS.ludoCommTier2Pct,
    tier3Pct: s?.ludoCommTier3Pct ?? DEFAULTS.ludoCommTier3Pct,
  };
}

/**
 * Calculate commission for a ludo match.
 * @param {number} pool - Total pool (sum of all players' amountPaid)
 * @param {number} entryAmount - Single player's entry amount
 * @param {object} [tiers] - Optional pre-fetched tiers object
 * @returns {Promise<{commission: number, winnerAmount: number}>}
 */
async function calcLudoCommission(pool, entryAmount, tiers) {
  const t = tiers || await getCommissionTiers();
  let commission;

  if (entryAmount <= t.tier1Max) {
    commission = Math.round((pool * t.tier1Pct) / 100);
  } else if (entryAmount <= t.tier2Max) {
    commission = Math.round((pool * t.tier2Pct) / 100);
  } else {
    commission = Math.round((pool * t.tier3Pct) / 100);
  }

  const winnerAmount = pool - commission;
  return { commission, winnerAmount };
}

module.exports = { getCommissionTiers, calcLudoCommission };
