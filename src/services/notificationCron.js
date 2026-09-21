const Notification = require('../models/Notification');
const { runWithSite, distinctDbSites } = require('../config/db');

const CRON_INTERVAL_MS = 6 * 60 * 60 * 1000; // every 6 hours
const DELETE_AFTER_DAYS = 10;

async function cleanupReadNotifications() {
  try {
    const cutoff = new Date(Date.now() - DELETE_AFTER_DAYS * 24 * 60 * 60 * 1000);
    const result = await Notification.deleteMany({
      read: true,
      createdAt: { $lt: cutoff },
    });
    if (result.deletedCount > 0) {
      console.log(`[Notification Cron] Deleted ${result.deletedCount} read notifications older than ${DELETE_AFTER_DAYS} days`);
    }
  } catch (err) {
    console.error('[Notification Cron] cleanupReadNotifications error:', err);
  }
}

// Runs once per database — sites with their own database (vk) have their own notifications
async function cleanupAllDatabases() {
  for (const site of distinctDbSites()) {
    await runWithSite(site, cleanupReadNotifications);
  }
}

function startNotificationCron() {
  cleanupAllDatabases();
  setInterval(cleanupAllDatabases, CRON_INTERVAL_MS);
  console.log(`[Notification Cron] Started (cleanup read notifications > ${DELETE_AFTER_DAYS} days, every 6h)`);
}

module.exports = { startNotificationCron, cleanupReadNotifications };
