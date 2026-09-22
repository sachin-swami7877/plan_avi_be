const { normalizeSite } = require('../config/sites');

/*
 * Site-scoped broadcasts.
 *
 * One backend serves three websites. A plain io.emit() reaches EVERY connected
 * socket on all of them, and the Ludo pages refetch their lists on those events —
 * so one match on one site used to make every user of every site refire six API
 * calls. These helpers send the event only to the room of the site it belongs to
 * (sockets join `site_<siteType>` on connect).
 */
const emitToSite = (io, siteType, event, payload) => {
  if (!io) return;
  const room = `site_${normalizeSite(siteType)}`;
  if (payload === undefined) io.to(room).emit(event);
  else io.to(room).emit(event, payload);
};

// The two events every Ludo list screen listens to, sent together
const emitLudoUpdate = (io, siteType, { matchLive } = {}) => {
  if (!io) return;
  emitToSite(io, siteType, 'ludo:match-live', matchLive);
  emitToSite(io, siteType, 'ludo:waiting-updated');
};

module.exports = { emitToSite, emitLudoUpdate };
