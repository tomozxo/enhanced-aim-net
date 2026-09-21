// Hardware lock for license keys. A web page can't read a real hardware ID,
// but it can read the next best thing: which graphics card the browser is
// rendering on, plus CPU core count, memory size, screen and OS. The browser
// sends those (public/js/fingerprint.js), and a key is locked to them on
// first activation, alongside the browser cookie. Copying the cookie to a
// friend's PC doesn't get past this: their graphics card and screen won't
// match.
//
// Only hashes are stored, never the raw values.
//
// Matching tolerates normal changes. The graphics card has to match, since
// it's the part that really identifies the machine. Of the other four (CPU
// cores, memory, screen, OS) any two can change - a new monitor, Windows
// display scaling, browser zoom - without locking anyone out. A laptop that
// switches between two graphics chips can register a second one, but only
// from the same browser (cookie) with nearly everything else matching.

const crypto = require('crypto');

const OTHER_PARTS = ['cores', 'memory', 'screen', 'platform'];
const PARTS = ['gpu', ...OTHER_PARTS];
const MAX_GPUS = 2;
const UNKNOWN_GPU = hash('unknown');

function hash(value) {
  return crypto.createHash('sha256').update(`enhanced-aim:${value}`).digest('hex').slice(0, 32);
}

/** Cleans what the browser sent into { gpu, cores, memory, screen, platform }
 * hashes. Anything missing or odd becomes "unknown" rather than an error, so
 * an unusual browser still gets a (weaker) lock instead of no access. */
function fromClient(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const out = {};
  for (const part of PARTS) {
    const v = typeof src[part] === 'string' ? src[part].trim().slice(0, 200) : '';
    out[part] = hash(v || 'unknown');
  }
  return out;
}

/** What gets saved on the key: every part, with room for a second GPU. */
function toLock(fp) {
  return { gpus: [fp.gpu], cores: fp.cores, memory: fp.memory, screen: fp.screen, platform: fp.platform };
}

/**
 * Compares a browser's fingerprint with a key's lock.
 * Returns { ok: true, lock } with the lock to save (updated so gradual
 * changes don't pile up into a lockout later), or { ok: false }.
 * A key activated before hardware locking existed has no lock yet; it's
 * locked to this machine now.
 */
function check(lock, fp, { sameBrowser }) {
  if (!lock || !Array.isArray(lock.gpus)) return { ok: true, lock: toLock(fp) };

  const othersMatching = OTHER_PARTS.filter((p) => lock[p] === fp[p]).length;
  const gpuKnown = !lock.gpus.includes(UNKNOWN_GPU);
  let gpus = lock.gpus;

  if (gpuKnown && !gpus.includes(fp.gpu)) {
    // A second graphics chip (hybrid-graphics laptop) is only accepted from
    // the same browser with at least three of the other four parts matching.
    const canLearn = sameBrowser && othersMatching >= 3 && gpus.length < MAX_GPUS;
    if (!canLearn) return { ok: false };
    gpus = [...gpus, fp.gpu];
  }

  // With no usable GPU reading to go on, lean harder on the rest.
  if (othersMatching < (gpuKnown ? 2 : 3)) return { ok: false };

  return { ok: true, lock: { gpus, cores: fp.cores, memory: fp.memory, screen: fp.screen, platform: fp.platform } };
}

module.exports = { fromClient, check };
