const crypto = require('node:crypto');
const JobLock = require('../models/JobLock');

const instanceId = `${process.pid}-${crypto.randomBytes(4).toString('hex')}`;

// Acquire the named lease for `ttlMs`. Returns a release function, or null when anyone (including another run
// in this same process) holds it. Every acquisition has its own token, so leases are not re-entrant.
async function acquireLease(name, ttlMs) {
  const now = new Date();
  const token = `${instanceId}:${crypto.randomBytes(4).toString('hex')}`;
  try {
    const lock = await JobLock.findOneAndUpdate(
      { name, lockedUntil: { $lte: now } },
      { $set: { owner: token, lockedUntil: new Date(now.getTime() + ttlMs) } },
      { upsert: true, new: true },
    );
    if (lock.owner !== token) return null;
  } catch (error) {
    if (error.code === 11000) return null; // a live lease exists (the upsert collided with its row)
    throw error;
  }
  return async () => { await JobLock.updateOne({ name, owner: token }, { $set: { lockedUntil: new Date(0) } }).catch(() => undefined); };
}

module.exports = { acquireLease, instanceId };
