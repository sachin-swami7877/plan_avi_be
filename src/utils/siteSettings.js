const AdminSettings = require('../models/AdminSettings');
const { isSiteType, DEFAULT_SITE } = require('../config/sites');

// Each website keeps its own settings document:
//   rushkroludo → key 'main' (the original doc), 101dream → '101dream', vk → 'vk'
const keyForSite = (siteType) => (isSiteType(siteType) && siteType !== DEFAULT_SITE ? siteType : 'main');

// Per-site defaults for a brand-new settings document. Only vk has any: both
// support channels start ON (schema default) with this number.
const DEFAULT_SUPPORT_NUMBER = { vk: '+91 92568 51247' };
const siteDefaults = (siteType) => {
  const number = DEFAULT_SUPPORT_NUMBER[siteType];
  return number ? { supportWhatsApp: number, supportTelegram: number } : {};
};

const getSiteSettings = async (siteType) => {
  const key = keyForSite(siteType);
  const defaults = siteDefaults(siteType);
  let s = await AdminSettings.findOne({ key });
  if (!s) {
    s = await AdminSettings.create({ key, ...defaults });
  } else if (defaults.supportWhatsApp && !s.supportPhone && !s.supportWhatsApp && !s.supportTelegram) {
    // Document predates the defaults and no number has ever been set — fill them in once.
    // (To hide support, admins switch the channels off rather than blanking every number.)
    Object.assign(s, defaults);
    await s.save();
  }
  return s;
};

// Resolve the site a request is talking about: an explicit query/body `siteType`
// or `type` wins, otherwise the site the request was authenticated for
// (req.siteType, set by middleware/siteContext.js from the token).
const siteFromReq = (req) => {
  const hint = req.query?.siteType || req.query?.type || req.body?.siteType || req.body?.type;
  if (isSiteType(hint)) return hint;
  return req.siteType || DEFAULT_SITE;
};

// ── Read-only cache ──────────────────────────────────────────────────────────
// Settings are read on almost every request (Ludo on/off, commission tiers,
// support numbers, payment info…). Each read was a round trip to Atlas. Readers
// that never modify the document use readSiteSettings() and get a plain object
// from this short-lived cache instead; writers keep using getSiteSettings(),
// which always returns a live Mongoose document, and invalidate afterwards.
const CACHE_TTL_MS = 30 * 1000;
const cache = new Map(); // settings key -> { at, value }

const readSiteSettings = async (siteType) => {
  const key = keyForSite(siteType);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value;

  const doc = await getSiteSettings(siteType);
  const value = typeof doc.toObject === 'function' ? doc.toObject() : doc;
  cache.set(key, { at: Date.now(), value });
  return value;
};

// Call after saving a settings document so the next read is fresh
const invalidateSiteSettings = (siteType) => cache.delete(keyForSite(siteType));

module.exports = { getSiteSettings, readSiteSettings, invalidateSiteSettings, keyForSite, siteFromReq };
