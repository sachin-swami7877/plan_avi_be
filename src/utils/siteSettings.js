const AdminSettings = require('../models/AdminSettings');

// Each website keeps its own settings document:
//   rushkroludo → key 'main' (the original doc), 101dream → key '101dream'
const keyForSite = (siteType) => (siteType === '101dream' ? '101dream' : 'main');

const getSiteSettings = async (siteType) => {
  const key = keyForSite(siteType);
  let s = await AdminSettings.findOne({ key });
  if (!s) s = await AdminSettings.create({ key });
  return s;
};

// Resolve the site a request is talking about (query/body `siteType` or `type`)
const siteFromReq = (req) => {
  const t = req.query?.siteType || req.query?.type || req.body?.siteType || req.body?.type;
  return t === '101dream' ? '101dream' : 'rushkroludo';
};

module.exports = { getSiteSettings, keyForSite, siteFromReq };
