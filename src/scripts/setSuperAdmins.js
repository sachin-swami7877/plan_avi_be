require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const mongoose = require('mongoose');
const User = require('../models/User');

const SUPER_ADMIN_PHONES = ['9166821247', '7877722306'];
// Sites where these phones must be superadmins. For 101dream the account is
// created if it doesn't exist yet (each site has its own user space).
const SITES = ['rushkroludo', '101dream'];

async function run() {
  await mongoose.connect(process.env.MONGODB_URI);
  console.log('Connected\n');

  // Same migration the server runs at startup — needed here in case the new
  // backend hasn't been restarted yet (old single-field unique indexes would
  // block creating the same phone in the 101dream space)
  const col = mongoose.connection.db.collection('users');
  const indexes = await col.indexes();
  for (const name of ['phone_1', 'email_1']) {
    if (indexes.find(i => i.name === name)) {
      await col.dropIndex(name);
      console.log(`Dropped stale index: ${name}`);
    }
  }
  const tagged = await col.updateMany({ siteType: { $exists: false } }, { $set: { siteType: 'rushkroludo' } });
  if (tagged.modifiedCount > 0) console.log(`Tagged ${tagged.modifiedCount} users with siteType=rushkroludo`);
  await User.syncIndexes();

  for (const phone of SUPER_ADMIN_PHONES) {
    for (const siteType of SITES) {
      let user = await User.findOne({ phone, siteType });

      if (!user && siteType === '101dream') {
        // Reuse name/email from the rushkroludo account if present
        const source = await User.findOne({ phone, siteType: 'rushkroludo' });
        user = new User({
          phone,
          siteType,
          name: source?.name || null,
        });
        console.log(`Creating 101dream account for ${phone}`);
      }

      if (!user) {
        console.log(`User ${phone} (${siteType}) not found — skipping`);
        continue;
      }

      user.role = 'superadmin';
      await user.save();
      console.log(`${user.name || phone} (${phone}, ${siteType}) → role: superadmin, isAdmin: ${user.isAdmin}, isSuperAdmin: ${user.isSuperAdmin}`);
    }
  }

  await mongoose.disconnect();
  console.log('\nDone');
}

run().catch(err => { console.error(err); process.exit(1); });
