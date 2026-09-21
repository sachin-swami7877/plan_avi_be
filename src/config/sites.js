// Every website this backend serves. Users, wallet requests, bets, spins and
// ludo matches carry one of these in `siteType`.
//
//   rushkroludo — original site, main database
//   101dream    — shares the main database (separated by the siteType field)
//   vk          — VK Adda; lives in its OWN database when VK_MONGODB_URI is set
//                 (falls back to the main database, separated by siteType, when it isn't)
const SITE_TYPES = ['rushkroludo', '101dream', 'vk'];
const DEFAULT_SITE = 'rushkroludo';

const isSiteType = (value) => SITE_TYPES.includes(value);

// Anything that isn't a known site becomes the default (keeps old clients/tokens working)
const normalizeSite = (value) => (isSiteType(value) ? value : DEFAULT_SITE);

module.exports = { SITE_TYPES, DEFAULT_SITE, isSiteType, normalizeSite };
