/* Sun elevation for the horizon instrument, from the USNO approximations: about one
   degree of error, far below what the eye notices on a 24 h curve. */

const RAD = Math.PI / 180;

// Elevation of the sun above the horizon, in degrees, at a given instant and place.
export function solarElevation(ms, lat, lon) {
  const d = (ms - Date.UTC(2000, 0, 1, 12)) / 86400000;      // days since J2000.0
  const g = (357.529 + 0.98560028 * d) * RAD;                 // mean anomaly
  const q = 280.459 + 0.98564736 * d;                         // mean longitude
  const L = (q + 1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g)) * RAD;
  const e = (23.439 - 0.00000036 * d) * RAD;                  // obliquity of the ecliptic
  const ra = Math.atan2(Math.cos(e) * Math.sin(L), Math.cos(L));
  const dec = Math.asin(Math.sin(e) * Math.sin(L));
  const gmst = 18.697374558 + 24.06570982441908 * d;          // hours
  const ha = (gmst * 15 + lon) * RAD - ra;                    // hour angle
  const el = Math.asin(Math.sin(lat * RAD) * Math.sin(dec) + Math.cos(lat * RAD) * Math.cos(dec) * Math.cos(ha));
  return el / RAD;
}

// Elevation every `stepMin` minutes over one local day, starting at local midnight
// (given as a UTC timestamp).
export function sunPath(midnightMs, lat, lon, stepMin = 10) {
  const out = [];
  for (let m = 0; m <= 1440; m += stepMin) out.push({ m, el: solarElevation(midnightMs + m * 60000, lat, lon) });
  return out;
}

// Golden hour (sun between -4 and +6 degrees) and blue hour (between -6 and -4), the
// photographers' usual bounds. Built from 5 minute steps rather than crossing times,
// so a band that never closes (far north in summer) still comes out right.
export function lightBands(midnightMs, lat, lon) {
  const bands = [];
  for (const p of sunPath(midnightMs, lat, lon, 5)) {
    const kind = p.el >= -4 && p.el <= 6 ? "golden" : p.el >= -6 && p.el < -4 ? "blue" : null;
    const last = bands[bands.length - 1];
    if (kind && last && last.kind === kind && last.to === p.m - 5) last.to = p.m;
    else if (kind) bands.push({ kind, from: p.m, to: p.m });
  }
  return bands;
}
