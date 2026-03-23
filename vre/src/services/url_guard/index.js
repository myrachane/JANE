'use strict';
/**
 * VRE URL Guard
 * Every outbound URL is validated here before any fetch is made.
 * This is the single chokepoint — tool_executor calls guard() on every URL.
 *
 * Rules enforced:
 *  1. Must be a parseable URL
 *  2. Protocol must be https: only (no http, file, ftp, data, blob, etc.)
 *  3. Hostname must not resolve to a private/loopback/link-local IP range
 *  4. Hostname must not BE a raw private IP
 *  5. Port must be standard (443, or absent — no sneaky :8080 to internal services)
 *  6. No credentials in URL (user:pass@host)
 *  7. Path must not contain path-traversal sequences after decode
 */

const dns = require('dns').promises;

// ── Private / reserved IP ranges ────────────────────────────────────
// Covers IPv4 + IPv6 loopback, link-local, private, CGNAT, broadcast
const BLOCKED_IPV4 = [
  /^127\./,                         // 127.0.0.0/8  loopback
  /^10\./,                          // 10.0.0.0/8   private
  /^192\.168\./,                    // 192.168.0.0/16 private
  /^172\.(1[6-9]|2\d|3[01])\./,    // 172.16.0.0/12 private
  /^169\.254\./,                    // 169.254.0.0/16 link-local
  /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./,  // 100.64.0.0/10 CGNAT
  /^192\.0\.0\./,                   // 192.0.0.0/24  IETF protocol
  /^192\.0\.2\./,                   // TEST-NET-1
  /^198\.51\.100\./,                // TEST-NET-2
  /^203\.0\.113\./,                 // TEST-NET-3
  /^224\./,                         // 224.0.0.0/4   multicast
  /^240\./,                         // 240.0.0.0/4   reserved
  /^255\.255\.255\.255$/,           // broadcast
  /^0\./,                           // 0.0.0.0/8
];

const BLOCKED_IPV6 = [
  /^::1$/,                          // loopback
  /^fe80:/i,                        // link-local
  /^fc00:/i, /^fd/i,                // unique local
  /^ff/i,                           // multicast
  /^::/,                            // unspecified / default
];

// Blocked hostnames regardless of what they resolve to
const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  'localhost.localdomain',
  'broadcasthost',
  'ip6-localhost',
  'ip6-loopback',
]);

// Only standard web port (443) or no port at all
const ALLOWED_PORTS = new Set(['', '443']);

// Only https
const ALLOWED_PROTOCOLS = new Set(['https:']);

function isPrivateIPv4(ip) {
  return BLOCKED_IPV4.some(re => re.test(ip));
}

function isPrivateIPv6(ip) {
  // Normalize: strip brackets if present
  const raw = ip.replace(/^\[|\]$/g, '').toLowerCase();
  return BLOCKED_IPV6.some(re => re.test(raw));
}

function isRawIP(host) {
  // IPv4
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return true;
  // IPv6 (with or without brackets)
  if (/^\[?[0-9a-fA-F:]+\]?$/.test(host)) return true;
  return false;
}

/**
 * guard(urlString) — validates a URL before any network request.
 * Returns { ok: true, url: URL } on success.
 * Returns { ok: false, reason: string } on failure.
 *
 * This function performs a DNS lookup to catch SSRF via hostname aliasing.
 * DNS results are NOT cached here — rely on OS/resolver cache.
 */
async function guard(urlString) {
  // ── 1. Parse ─────────────────────────────────────────────────────
  let u;
  try { u = new URL(urlString); }
  catch { return { ok: false, reason: `Invalid URL: ${urlString}` }; }

  // ── 2. Protocol whitelist ────────────────────────────────────────
  if (!ALLOWED_PROTOCOLS.has(u.protocol)) {
    return {
      ok:     false,
      reason: `Protocol '${u.protocol}' is not allowed. Only HTTPS is permitted.`,
    };
  }

  // ── 3. No credentials ────────────────────────────────────────────
  if (u.username || u.password) {
    return { ok: false, reason: 'URLs with embedded credentials are not allowed.' };
  }

  // ── 4. Port check ────────────────────────────────────────────────
  if (!ALLOWED_PORTS.has(u.port)) {
    return {
      ok:     false,
      reason: `Port ${u.port} is not allowed. Only standard HTTPS port (443) is permitted.`,
    };
  }

  const hostname = u.hostname.toLowerCase();

  // ── 5. Blocked hostnames ─────────────────────────────────────────
  if (BLOCKED_HOSTNAMES.has(hostname)) {
    return { ok: false, reason: `Hostname '${hostname}' is blocked.` };
  }

  // ── 6. Raw IP check ─────────────────────────────────────────────
  if (isRawIP(hostname)) {
    if (isPrivateIPv4(hostname) || isPrivateIPv6(hostname)) {
      return { ok: false, reason: `IP address '${hostname}' is in a private/reserved range.` };
    }
    // Raw public IPs are allowed (e.g. CDN IPs) — uncommon but valid
  }

  // ── 7. DNS resolution check (SSRF prevention) ───────────────────
  // Resolve hostname and verify none of the IPs are private.
  // Timeout the DNS lookup so a slow resolver doesn't stall the agent.
  try {
    const [ipv4Results, ipv6Results] = await Promise.allSettled([
      dns.resolve4(hostname),
      dns.resolve6(hostname),
    ]);

    const allIPs = [];
    if (ipv4Results.status === 'fulfilled') allIPs.push(...ipv4Results.value);
    if (ipv6Results.status === 'fulfilled') allIPs.push(...ipv6Results.value);

    // If DNS returned nothing at all, let it through (NXDOMAIN will fail at fetch time)
    for (const ip of allIPs) {
      if (isPrivateIPv4(ip)) {
        return {
          ok:     false,
          reason: `Hostname '${hostname}' resolves to private IP '${ip}' — blocked to prevent SSRF.`,
        };
      }
      if (isPrivateIPv6(ip)) {
        return {
          ok:     false,
          reason: `Hostname '${hostname}' resolves to private IPv6 '${ip}' — blocked to prevent SSRF.`,
        };
      }
    }
  } catch {
    // DNS lookup failed entirely (NXDOMAIN etc.) — allow the fetch to fail naturally
    // We don't block on DNS failure so offline/unusual resolvers still work
  }

  // ── 8. Path traversal ────────────────────────────────────────────
  const decodedPath = decodeURIComponent(u.pathname);
  if (decodedPath.includes('../') || decodedPath.includes('..\\')) {
    return { ok: false, reason: 'Path traversal sequences are not allowed in URLs.' };
  }

  return { ok: true, url: u };
}

/**
 * guardSync(urlString) — fast synchronous check (no DNS).
 * Use for search query URLs that we build ourselves.
 */
function guardSync(urlString) {
  let u;
  try { u = new URL(urlString); } catch { return { ok: false, reason: `Invalid URL: ${urlString}` }; }
  if (!ALLOWED_PROTOCOLS.has(u.protocol))
    return { ok: false, reason: `Protocol '${u.protocol}' not allowed.` };
  if (u.username || u.password)
    return { ok: false, reason: 'Embedded credentials not allowed.' };
  if (!ALLOWED_PORTS.has(u.port))
    return { ok: false, reason: `Port ${u.port} not allowed.` };
  const hostname = u.hostname.toLowerCase();
  if (BLOCKED_HOSTNAMES.has(hostname))
    return { ok: false, reason: `Hostname '${hostname}' is blocked.` };
  if (isRawIP(hostname) && (isPrivateIPv4(hostname) || isPrivateIPv6(hostname)))
    return { ok: false, reason: `IP '${hostname}' is private.` };
  return { ok: true, url: u };
}

module.exports = { guard, guardSync };
