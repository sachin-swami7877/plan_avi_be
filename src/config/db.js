const mongoose = require('mongoose');

const connectDB = async () => {
  try {
    const conn = await mongoose.connect(process.env.MONGODB_URI, {
      maxPoolSize: 15,
      minPoolSize: 5,
      serverSelectionTimeoutMS: 5000,
      socketTimeoutMS: 45000,
      retryWrites: true,
    });
    console.log(`MongoDB Connected: ${conn.connection.host}`);

    // Drop stale indexes so Mongoose can recreate them with the correct definition
    try {
      const collection = conn.connection.db.collection('users');
      const indexes = await collection.indexes();

      for (const name of ['phone_1', 'email_1']) {
        if (indexes.find(i => i.name === name)) {
          await collection.dropIndex(name);
          console.log(`Dropped stale index: ${name}`);
        }
      }

      // One-time: tag existing users with the default siteType so site-scoped
      // login queries ({ email, siteType }) keep matching them
      const tagged = await collection.updateMany(
        { siteType: { $exists: false } },
        { $set: { siteType: 'rushkroludo' } }
      );
      if (tagged.modifiedCount > 0) {
        console.log(`Tagged ${tagged.modifiedCount} existing users with siteType=rushkroludo`);
      }
      // Same for every collection that is now queried per site
      for (const name of ['walletrequests', 'bets', 'spinnerrecords', 'ludomatches']) {
        const r = await conn.connection.db.collection(name).updateMany(
          { siteType: { $exists: false } },
          { $set: { siteType: 'rushkroludo' } }
        );
        if (r.modifiedCount > 0) {
          console.log(`Tagged ${r.modifiedCount} ${name} with siteType=rushkroludo`);
        }
      }
    } catch (indexErr) {
      // Ignore if index doesn't exist
    }
  } catch (error) {
    console.error(`Error: ${error.message}`);
    process.exit(1);
  }
};

module.exports = connectDB;
