const admin = require('firebase-admin');

let messaging = null;

function initFirebase() {
  if (admin.apps.length) {
    messaging = admin.messaging();
    return;
  }

  const serviceAccount = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (!serviceAccount) {
    console.warn('[Firebase] FIREBASE_SERVICE_ACCOUNT_JSON not set — push notifications disabled');
    return;
  }

  try {
    const parsed = JSON.parse(serviceAccount);
    admin.initializeApp({
      credential: admin.credential.cert(parsed),
    });
    messaging = admin.messaging();
    console.log('[Firebase] Initialized successfully');
  } catch (err) {
    console.error('[Firebase] Init failed:', err.message);
  }
}

const SITE_URL = 'https://rushkroludo.com';

/**
 * Send push notification to an array of FCM tokens.
 * Silently removes invalid/expired tokens from the user's DB record.
 */
async function sendPushNotification(userId, tokens, title, body, data = {}) {
  if (!messaging) {
    console.warn('[Firebase] messaging not initialized');
    return { successCount: 0, failureCount: 0, error: 'Firebase not initialized' };
  }
  if (!tokens || tokens.length === 0) {
    return { successCount: 0, failureCount: 0, error: 'No tokens provided' };
  }

  // Stringify all data values (FCM requires string values)
  const stringData = Object.fromEntries(
    Object.entries({ ...data, title, body }).map(([k, v]) => [k, String(v ?? '')])
  );

  const linkUrl = data.websiteUrl || data.link || SITE_URL;

  const message = {
    // Top-level notification — required for FCM to display the notification
    // automatically when the page is in background (works without SW intervention).
    notification: {
      title,
      body,
    },
    data: stringData,
    webpush: {
      headers: {
        // Make notification persist until user interacts with it (urgent priority)
        Urgency: 'high',
        TTL: '86400',
      },
      notification: {
        title,
        body,
        icon: `${SITE_URL}/icon-192.png`,
        badge: `${SITE_URL}/icon-192.png`,
        tag: data.type || 'general',
        renotify: true,
        requireInteraction: true,
        vibrate: [200, 100, 200],
        ...(data.imageUrl && { image: data.imageUrl }),
      },
      fcm_options: {
        link: linkUrl,
      },
    },
  };

  let successCount = 0;
  let failureCount = 0;
  const allInvalidTokens = [];

  // FCM sendEachForMulticast supports max 500 tokens per call — chunk to be safe
  const CHUNK_SIZE = 500;
  for (let i = 0; i < tokens.length; i += CHUNK_SIZE) {
    const chunk = tokens.slice(i, i + CHUNK_SIZE);
    try {
      const response = await messaging.sendEachForMulticast({
        tokens: chunk,
        ...message,
      });

      successCount += response.successCount;
      failureCount += response.failureCount;

      response.responses.forEach((resp, idx) => {
        if (!resp.success) {
          const code = resp.error?.code;
          console.warn(`[Firebase] Token failed: ${code} — ${resp.error?.message}`);
          if (code === 'messaging/invalid-registration-token' ||
              code === 'messaging/registration-token-not-registered') {
            allInvalidTokens.push(chunk[idx]);
          }
        }
      });
    } catch (err) {
      console.error('[Firebase] Push chunk failed:', err.message);
      failureCount += chunk.length;
    }
  }

  // Remove invalid tokens from all users (broadcast case)
  if (allInvalidTokens.length > 0) {
    const User = require('../models/User');
    if (userId) {
      await User.findByIdAndUpdate(userId, {
        $pull: { fcmTokens: { $in: allInvalidTokens } },
      });
    } else {
      await User.updateMany(
        { fcmTokens: { $in: allInvalidTokens } },
        { $pull: { fcmTokens: { $in: allInvalidTokens } } }
      );
    }
  }

  return { successCount, failureCount, invalidCount: allInvalidTokens.length };
}

/**
 * Send push to all admin users.
 */
async function sendPushToAdmins(title, body, data = {}) {
  if (!messaging) return;
  const User = require('../models/User');
  const admins = await User.find({
    $or: [{ isAdmin: true }, { isSubAdmin: true }],
    fcmTokens: { $exists: true, $ne: [] },
  }).select('_id fcmTokens');

  for (const admin of admins) {
    await sendPushNotification(admin._id, admin.fcmTokens, title, body, data);
  }
}

module.exports = { initFirebase, sendPushNotification, sendPushToAdmins };
