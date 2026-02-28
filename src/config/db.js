const mongoose = require('mongoose');

const connectDB = async () => {
  try {
    const conn = await mongoose.connect(process.env.MONGODB_URI);
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
    } catch (indexErr) {
      // Ignore if index doesn't exist
    }
  } catch (error) {
    console.error(`Error: ${error.message}`);
    process.exit(1);
  }
};

module.exports = connectDB;
