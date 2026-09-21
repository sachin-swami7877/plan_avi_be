require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const { connectDB, runWithSite, disconnectAll, distinctDbSites } = require('../config/db');
const { SITE_TYPES, DEFAULT_SITE } = require('../config/sites');
const User = require('../models/User');

const SUPER_ADMIN_PHONES = ['9166821247', '7877722306'];
// Sites where these phones must be superadmins. Outside rushkroludo the account is
// created if it doesn't exist yet (each site has its own user space — 101dream shares
// the main database, vk has its own when VK_MONGODB_URI is set).
const SITES = SITE_TYPES;

async function run() {
  // Same startup work the server does: connects every database, drops the old
  // single-field unique indexes and tags untagged docs with each database's default site
  await connectDB();
  console.log('Connected\n');

  for (const site of distinctDbSites()) {
    await runWithSite(site, () => User.syncIndexes());
  }

  for (const phone of SUPER_ADMIN_PHONES) {
    // Name to reuse when creating the account on another site
    const source = await runWithSite(DEFAULT_SITE, () => User.findOne({ phone, siteType: DEFAULT_SITE }));

    for (const siteType of SITES) {
      await runWithSite(siteType, async () => {
        let user = await User.findOne({ phone, siteType });

        if (!user && siteType !== DEFAULT_SITE) {
          user = new User({ phone, siteType, name: source?.name || null });
          console.log(`Creating ${siteType} account for ${phone}`);
        }

        if (!user) {
          console.log(`User ${phone} (${siteType}) not found — skipping`);
          return;
        }

        user.role = 'superadmin';
        await user.save();
        console.log(`${user.name || phone} (${phone}, ${siteType}) → role: superadmin, isAdmin: ${user.isAdmin}, isSuperAdmin: ${user.isSuperAdmin}`);
      });
    }
  }

  await disconnectAll();
  console.log('\nDone');
}

run().catch(err => { console.error(err); process.exit(1); });
