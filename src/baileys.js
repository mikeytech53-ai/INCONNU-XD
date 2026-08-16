const requested = process.env.BAILEYS_PACKAGE || '@vansnowi/baileys';
let baileys;
let packageName = requested;

try {
  baileys = require(requested);
} catch (firstError) {
  if (requested !== '@vansnowi/baileys') {
    try {
      packageName = '@vansnowi/baileys';
      baileys = require(packageName);
      console.warn(`[baileys] ${requested} is unavailable; falling back to ${packageName}.`);
    } catch (fallbackError) {
      const err = new Error(
        `Unable to load Baileys package "${requested}". Install the fork or set BAILEYS_PACKAGE to a compatible package. ` +
        `Fallback also failed: ${fallbackError.message}`
      );
      err.cause = firstError;
      throw err;
    }
  } else {
    throw firstError;
  }
}

module.exports = { ...baileys, packageName };
