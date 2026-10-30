const mongoose = require('mongoose');

// A lease, not a mutex: if the holder crashes, the lease simply expires and another instance takes over.
const schema = new mongoose.Schema({
  name: { type: String, required: true, unique: true },
  owner: { type: String, required: true },
  lockedUntil: { type: Date, required: true },
});
module.exports = mongoose.model('JobLock', schema);
