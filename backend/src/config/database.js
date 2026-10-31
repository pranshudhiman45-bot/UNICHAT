const mongoose = require('mongoose');

const connectDB = async () => {
  const mongoUri = process.env.MONGODB_URI || process.env.MONGO_URI;
  if (!mongoUri) {
    throw new Error('MONGODB_URI is required');
  }

  const conn = await mongoose.connect(mongoUri, {
    // Atlas (mongodb+srv://) needs DNS + TLS + replica-set discovery; a cold connection from a sleeping host can take
    // several seconds, so allow more than the local default.
    serverSelectionTimeoutMS: Number(process.env.MONGODB_SERVER_SELECTION_TIMEOUT_MS) || 15000,
    // Lets an Atlas URI without a path (".../?retryWrites=true") still pick the right database.
    ...(process.env.MONGODB_DB_NAME ? { dbName: process.env.MONGODB_DB_NAME } : {}),
  });

  console.log(`MongoDB connected: ${conn.connection.name}`);
  if (conn.connection.name === 'test') {
    console.warn('WARNING: connected to the default "test" database. Add a database name to MONGODB_URI (".../unichat?...") or set MONGODB_DB_NAME.');
  }
  return conn;
};

module.exports = connectDB;
