const jwt = require('jsonwebtoken');
const { runWithSite } = require('../config/db');
const { isSiteType, DEFAULT_SITE } = require('../config/sites');

// Which site (and therefore which database) a request belongs to:
//   1. A valid signed token — `siteType` is embedded at login, so an authenticated
//      caller can't point a request at another site's database by editing a
//      body/query field. Tokens issued before siteType existed → default site.
//   2. Login / public routes — the `type` or `siteType` the frontend sends.
//   3. Otherwise the default site.
const siteFromRequest = (req) => {
  const header = req.headers.authorization || '';
  if (header.startsWith('Bearer ')) {
    try {
      const decoded = jwt.verify(header.slice(7), process.env.JWT_SECRET);
      return isSiteType(decoded.siteType) ? decoded.siteType : DEFAULT_SITE;
    } catch (_) {
      // Invalid/expired token — protect() will reject it; fall through so
      // public routes with a stale token still resolve normally
    }
  }
  const hint = req.body?.type || req.body?.siteType || req.query?.type || req.query?.siteType;
  return isSiteType(hint) ? hint : DEFAULT_SITE;
};

// Must be mounted after express.json() and before the routes. Everything the
// route handlers await afterwards runs against this site's database.
const siteContextMiddleware = (req, res, next) => {
  req.siteType = siteFromRequest(req);
  runWithSite(req.siteType, () => next());
};

/*
 * Re-enter this request's site context after a middleware that reads the
 * request body stream (multer and friends).
 *
 * The site is carried in an AsyncLocalStorage store. That store follows
 * promises, but NOT callbacks fired from the incoming request stream: that
 * stream's async resource was created when the connection arrived, before our
 * middleware ran, so anything continuing from its 'end' event runs outside our
 * store. Multer finishes exactly that way, so without this wrapper every
 * multipart route (deposit screenshots, KYC, Ludo results, admin uploads) fell
 * back to the default site and wrote to the wrong database.
 */
const keepSiteContext = (mw) => (req, res, next) =>
  mw(req, res, (err) => runWithSite(req.siteType, () => next(err)));

module.exports = { siteContextMiddleware, siteFromRequest, keepSiteContext };
