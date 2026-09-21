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

module.exports = { getSiteSettings, keyForSite, siteFromReq };
