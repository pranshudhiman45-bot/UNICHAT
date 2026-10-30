// Error logging that cannot leak user data. Mongoose validation/cast errors embed the offending field values
// (message text, ids, emails) in their message, so those are reduced to their name and the paths involved.
function describeError(error) {
  if (!error) return 'Unknown error';
  if (error.name === 'ValidationError' || error.name === 'CastError' || error.name === 'StrictModeError') {
    const paths = error.errors ? Object.keys(error.errors).join(',') : error.path || '';
    return `${error.name}${paths ? ` (fields: ${paths})` : ''}`;
  }
  const message = String(error.message || error).replace(/\s+/g, ' ').slice(0, 300);
  return `${error.name || 'Error'}: ${message}${error.code ? ` [${error.code}]` : ''}`;
}
module.exports = { describeError };
