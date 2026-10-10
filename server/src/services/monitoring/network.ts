import { Resolver } from 'node:dns/promises';
import net from 'node:net';
import tls from 'node:tls';
import ipaddr from 'ipaddr.js';
import type { MonitoringCheck } from '../../types/monitoring.js';

export class ProbeError extends Error {
  constructor(message: string, readonly details: Record<string, unknown> = {}, readonly warning = false) { super(message); }
}

export interface ProbeTiming {
  connectionStartedAt: number | null;
  dnsTimeMs: number;
}

export function permittedAddress(address: string, allowPrivate: boolean): boolean {
  try {
    const parsed = ipaddr.process(address);
    const range = parsed.range();
    if (parsed.toString() === 'fd00:ec2::254') return false;
    return range === 'unicast' || (allowPrivate && ['private', 'uniqueLocal', 'loopback'].includes(range));
  } catch { return false; }
}

interface ResolvedProbeHost {
  addresses: string[];
  fallbackFamily: 'A' | 'AAAA' | null;
}

const IPV4_PREFERENCE_DELAY_MS = 50;

export async function resolveProbeHost(host: string, allowPrivate: boolean, signal: AbortSignal, deadline: number, timing: ProbeTiming): Promise<ResolvedProbeHost> {
  signal.throwIfAborted();
  if (net.isIP(host)) {
    if (!permittedAddress(host, allowPrivate)) throw new ProbeError('Target address is not permitted');
    return { addresses: [host], fallbackFamily: null };
  }
  const started = Date.now();
  const remaining = deadline - started;
  if (remaining <= 0) throw new ProbeError('Probe timed out');
  const resolver = new Resolver({ timeout: Math.max(1, Math.floor(remaining)), tries: 1 });
  const cancel = () => resolver.cancel();
  signal.addEventListener('abort', cancel, { once: true });
  try {
    const ipv4Lookup = resolver.resolve4(host).catch(() => []);
    const ipv6Lookup = resolver.resolve6(host).catch(() => []);
    const first = await Promise.race([
      ipv4Lookup.then(addresses => ({ family: 'A' as const, addresses })),
      ipv6Lookup.then(addresses => ({ family: 'AAAA' as const, addresses })),
    ]);
    signal.throwIfAborted();

    let selected: string[];
    if (first.family === 'A') selected = first.addresses.length ? first.addresses : await ipv6Lookup;
    else if (!first.addresses.length) selected = await ipv4Lookup;
    else {
      const preferred = await Promise.race([
        ipv4Lookup.then(addresses => ({ addresses, completed: true as const })),
        new Promise<{ addresses: string[]; completed: false }>(resolve => setTimeout(
          () => resolve({ addresses: [], completed: false }),
          Math.min(IPV4_PREFERENCE_DELAY_MS, Math.max(0, deadline - Date.now())),
        )),
      ]);
      selected = preferred.completed && preferred.addresses.length ? preferred.addresses : first.addresses;
    }
    signal.throwIfAborted();
    if (!selected.length) throw new ProbeError('Target DNS resolution failed');
    if (selected.length > 128 || selected.some(address => !permittedAddress(address, allowPrivate))) {
      throw new ProbeError('Target address is not permitted');
    }
    const family = net.isIP(selected[0]!);
    return { addresses: selected, fallbackFamily: family === 4 ? 'AAAA' : 'A' };
  } finally {
    timing.dnsTimeMs += Date.now() - started;
    signal.removeEventListener('abort', cancel);
    resolver.cancel();
  }
}

export async function connectProbe(check: MonitoringCheck, host: string, port: number, useTls: boolean, signal: AbortSignal, deadline: number, timing: ProbeTiming): Promise<{ socket: net.Socket; details: Record<string, unknown>; warning: string | null }> {
  const resolved = await resolveProbeHost(host, check.allowPrivate, signal, deadline, timing);
  signal.throwIfAborted();
  timing.connectionStartedAt ??= Date.now();
  let lastError: unknown;
  const attempts = async (addresses: string[], attemptSignal = signal) => {
    for (const address of addresses) {
      attemptSignal.throwIfAborted();
      try { return await connectProbeAddress(check, host, address, port, useTls, attemptSignal); }
      catch (error) {
        lastError = error;
        if (error instanceof ProbeError || !(error && typeof error === 'object' && 'code' in error)) throw error;
      }
    }
    return null;
  };

  const hasFallback = Boolean(resolved.fallbackFamily && !net.isIP(host));
  let connected;
  if (hasFallback) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new ProbeError('Probe timed out');
    const familyController = new AbortController();
    const abortFamily = () => familyController.abort(signal.reason);
    signal.addEventListener('abort', abortFamily, { once: true });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      familyController.abort(new ProbeError('Connection attempt timed out'));
    }, Math.max(1, Math.min(remaining / 2, 3000)));
    try {
      connected = await attempts(resolved.addresses, familyController.signal);
    } catch (error) {
      if (!timedOut || signal.aborted) throw error;
      lastError = error;
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', abortFamily);
    }
  } else connected = await attempts(resolved.addresses);
  if (connected) return connected;
  if (hasFallback && resolved.fallbackFamily) {
    let fallback: string[];
    try { fallback = await resolveProbeFamily(host, resolved.fallbackFamily, check.allowPrivate, signal, deadline, timing); }
    catch (error) {
      if (error instanceof ProbeError && error.message === 'Target DNS resolution failed') throw lastError;
      throw error;
    }
    const connectedFallback = await attempts(fallback);
    if (connectedFallback) return connectedFallback;
  }
  throw lastError instanceof Error ? lastError : new ProbeError('Target connection failed');
}

async function resolveProbeFamily(host: string, family: 'A' | 'AAAA', allowPrivate: boolean, signal: AbortSignal, deadline: number, timing: ProbeTiming): Promise<string[]> {
  signal.throwIfAborted();
  const started = Date.now();
  const remaining = deadline - started;
  if (remaining <= 0) throw new ProbeError('Probe timed out');
  const resolver = new Resolver({ timeout: Math.max(1, Math.floor(remaining)), tries: 1 });
  const cancel = () => resolver.cancel();
  signal.addEventListener('abort', cancel, { once: true });
  try {
    const addresses = await (family === 'A' ? resolver.resolve4(host) : resolver.resolve6(host)).catch(() => []);
    signal.throwIfAborted();
    if (!addresses.length) throw new ProbeError('Target DNS resolution failed');
    if (addresses.length > 128 || addresses.some(address => !permittedAddress(address, allowPrivate))) {
      throw new ProbeError('Target address is not permitted');
    }
    return addresses;
  } finally {
    timing.dnsTimeMs += Date.now() - started;
    signal.removeEventListener('abort', cancel);
    resolver.cancel();
  }
}

function connectProbeAddress(check: MonitoringCheck, host: string, address: string, port: number, useTls: boolean, signal: AbortSignal): Promise<{ socket: net.Socket; details: Record<string, unknown>; warning: string | null }> {
  return new Promise((resolve, reject) => {
    const socket = useTls
      ? tls.connect({ host: address, port, servername: net.isIP(host) ? undefined : host, rejectUnauthorized: false })
      : net.connect({ host: address, port });
    const abort = () => socket.destroy(signal.reason instanceof Error ? signal.reason : new ProbeError('Probe timed out'));
    signal.addEventListener('abort', abort, { once: true });
    socket.once('close', () => signal.removeEventListener('abort', abort));
    socket.on('error', () => {});
    const failed = (error: Error) => { socket.destroy(); reject(error); };
    socket.once('error', failed);
    socket.once(useTls ? 'secureConnect' : 'connect', () => {
      try {
        const inspected = useTls ? inspectProbeTls(check, host, socket as tls.TLSSocket) : { details: {}, warning: null };
        socket.removeListener('error', failed);
        resolve({ socket, ...inspected });
      } catch (error) { failed(error instanceof Error ? error : new Error('TLS certificate verification failed')); }
    });
  });
}

export function upgradeProbeTls(check: MonitoringCheck, host: string, socket: net.Socket, signal: AbortSignal): Promise<{ socket: tls.TLSSocket; details: Record<string, unknown>; warning: string | null }> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const secure = tls.connect({ socket, servername: net.isIP(host) ? undefined : host, rejectUnauthorized: false });
    const abort = () => secure.destroy(new ProbeError('Probe timed out'));
    signal.addEventListener('abort', abort, { once: true });
    secure.once('close', () => signal.removeEventListener('abort', abort));
    secure.on('error', () => {});
    const failed = (error: Error) => { secure.destroy(); reject(error); };
    secure.once('error', failed);
    secure.once('secureConnect', () => {
      try {
        const inspected = inspectProbeTls(check, host, secure);
        secure.removeListener('error', failed);
        resolve({ socket: secure, ...inspected });
      } catch (error) { failed(error instanceof Error ? error : new Error('TLS certificate verification failed')); }
    });
  });
}

function inspectProbeTls(check: MonitoringCheck, host: string, secure: tls.TLSSocket): { details: Record<string, unknown>; warning: string | null } {
  const cert = secure.getPeerCertificate();
  const expiration = Date.parse(cert.valid_to);
  const days = Number.isFinite(expiration) ? Math.floor((expiration - Date.now()) / 86400000) : null;
  const authorization = String(secure.authorizationError ?? '');
  const selfSigned = check.tlsMode === 'allow_self_signed' && ['DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY'].includes(authorization);
  const details = { tlsAuthorized: secure.authorized, tlsTrustedLocalCertificate: selfSigned, certDaysRemaining: days, certValidTo: Number.isFinite(expiration) ? new Date(expiration).toISOString() : null };
  const certificateFailure = (message: string) => new ProbeError(message, { ...details, certificateError: true }, check.certificateErrorMode === 'warning');
  if (!Object.keys(cert).length) throw certificateFailure('TLS certificate is missing');
  if (tls.checkServerIdentity(host, cert)) throw certificateFailure('TLS certificate hostname does not match target');
  if (!Number.isFinite(expiration) || expiration <= Date.now() || Date.parse(cert.valid_from) > Date.now()) throw certificateFailure('TLS certificate is expired or not yet valid');
  if (!secure.authorized && !selfSigned) throw certificateFailure('TLS certificate verification failed');
  return { details, warning: check.certExpiryDays !== null && days !== null && days <= check.certExpiryDays ? `Certificate expires in ${days} days` : null };
}
