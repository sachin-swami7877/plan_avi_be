const AdminSettings = require('../models/AdminSettings');
const { isSiteType, DEFAULT_SITE } = require('../config/sites');

// Each website keeps its own settings document:
//   rushkroludo → key 'main' (the original doc), 101dream → '101dream', vk → 'vk'
const keyForSite = (siteType) => (isSiteType(siteType) && siteType !== DEFAULT_SITE ? siteType : 'main');

const getSiteSettings = async (siteType) => {
  const key = keyForSite(siteType);
  let s = await AdminSettings.findOne({ key });
  if (!s) s = await AdminSettings.create({ key });
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
