/* Shared by the service and its drivers. Nothing here comes from Vigie: the house
 * service must run alone on another machine. */

// A device or a cloud that fails (unreachable, refused command, bad credentials) is
// expected: the service turns it into an unreachable state or a 502, never a crash.
class DeviceError extends Error {}

// fetch() with a timeout, any failure as a DeviceError. `who` names the source in the message.
async function request(who, url, { timeout = 8000, ...opts } = {}, fetchImpl = fetch) {
  let res, text;
  try {
    res = await fetchImpl(url, { ...opts, signal: AbortSignal.timeout(timeout) });
    text = await res.text();
  } catch (e) {
    throw new DeviceError(`${who}: ${e.name === 'TimeoutError' ? 'timeout' : e.message}`);
  }
  return { status: res.status, ok: res.ok, text, headers: res.headers };
}

function parseJson(who, text) {
  try { return JSON.parse(text); } catch { throw new DeviceError(`${who}: invalid JSON`); }
}

const clamp = (v, min, max) => Math.min(max, Math.max(min, v));

module.exports = { DeviceError, request, parseJson, clamp };
