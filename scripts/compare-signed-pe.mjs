#!/usr/bin/env node
// Checks that a signed Windows PE file (installer or executable) is the unsigned build plus an
// Authenticode signature and nothing else. It reads both files and runs neither.
//
// Signing a PE file changes exactly three things (PE/COFF specification, "The Attribute Certificate
// Table"): the 4-byte CheckSum field of the optional header, the 8-byte Certificate Table entry of
// the data directories, and the end of the file, where the signature is appended at an 8-byte
// aligned offset after zero padding. Every other byte must be identical. This proves that a remote
// signer (SignPath) or a local signtool run signed the very file this build produced.
//
// It proves nothing about the signature itself: scripts/verify-windows-signature.ps1 checks
// validity, the certificate chain, the SHA-256 digest and the RFC 3161 timestamp.
//
// Usage: node scripts/compare-signed-pe.mjs <unsigned-file> <signed-file> [<unsigned> <signed> ...]
// Exit code 0 only when every pair matches. Prints one JSON line per pair.
import { readFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/** Offsets of the fields that signing rewrites, read from the PE headers. */
export function peLayout(buf) {
  if (buf.length < 0x40 || buf.readUInt16LE(0) !== 0x5a4d) throw new Error('not a PE file (no MZ header)');
  const pe = buf.readUInt32LE(0x3c);
  if (pe + 24 > buf.length || buf.readUInt32BE(pe) !== 0x50450000) throw new Error('not a PE file (no PE signature)');
  const sizeOfOptional = buf.readUInt16LE(pe + 20);
  const opt = pe + 24;
  if (opt + sizeOfOptional > buf.length) throw new Error('truncated optional header');
  const magic = buf.readUInt16LE(opt);
  let rvaCountAt;
  let dirs;
  if (magic === 0x10b) {
    rvaCountAt = opt + 92; // PE32
    dirs = opt + 96;
  } else if (magic === 0x20b) {
    rvaCountAt = opt + 108; // PE32+
    dirs = opt + 112;
  } else {
    throw new Error(`unknown optional header magic 0x${magic.toString(16)}`);
  }
  if (buf.readUInt32LE(rvaCountAt) < 5) throw new Error('the PE file has no certificate table directory entry');
  const certEntry = dirs + 4 * 8; // IMAGE_DIRECTORY_ENTRY_SECURITY
  if (certEntry + 8 > opt + sizeOfOptional) throw new Error('certificate table entry lies outside the optional header');
  return {
    checksumAt: opt + 64,
    certEntry,
    // For this entry the "virtual address" is a file offset.
    certOffset: buf.readUInt32LE(certEntry),
    certSize: buf.readUInt32LE(certEntry + 4),
  };
}

/** Returns a list of problems; an empty list means the signed file is the unsigned one plus a signature. */
export function compareSignedPe(unsigned, signed) {
  const u = peLayout(unsigned);
  const s = peLayout(signed);
  const problems = [];
  if (u.certOffset !== 0 || u.certSize !== 0) problems.push('the reference file already has a certificate table, so it is not an unsigned build');
  if (u.checksumAt !== s.checksumAt || u.certEntry !== s.certEntry) problems.push('the PE header layouts differ');
  if (s.certOffset === 0 || s.certSize === 0) problems.push('the signed file has no certificate table');
  if (signed.length <= unsigned.length) problems.push('the signed file is not larger than the unsigned file');
  if (problems.length) return problems;

  const pad = s.certOffset - unsigned.length;
  if (pad < 0 || pad > 7) {
    problems.push(`the certificate table starts at byte ${s.certOffset}, not directly after the unsigned content (${unsigned.length} bytes)`);
  } else if (s.certOffset % 8 !== 0) {
    problems.push(`the certificate table offset ${s.certOffset} is not 8-byte aligned`);
  } else if (!signed.subarray(unsigned.length, s.certOffset).every((b) => b === 0)) {
    problems.push('the padding before the certificate table is not zero');
  }
  if (s.certOffset + s.certSize !== signed.length) {
    problems.push(`the certificate table (${s.certOffset} + ${s.certSize}) does not end at the end of the signed file (${signed.length})`);
  }

  // Every byte of the unsigned file except the two rewritten header fields must be unchanged.
  const masked = [
    [u.checksumAt, u.checksumAt + 4],
    [u.certEntry, u.certEntry + 8],
  ].sort((a, b) => a[0] - b[0]);
  let at = 0;
  for (const [from, to] of masked) {
    if (!unsigned.subarray(at, from).equals(signed.subarray(at, from))) problems.push(`bytes ${at}..${from} differ`);
    at = to;
  }
  if (!unsigned.subarray(at).equals(signed.subarray(at, unsigned.length))) problems.push(`bytes ${at}..${unsigned.length} differ`);
  return problems;
}

function main(argv) {
  if (argv.length === 0 || argv.length % 2 !== 0) {
    console.error('usage: node scripts/compare-signed-pe.mjs <unsigned-file> <signed-file> [<unsigned> <signed> ...]');
    return 2;
  }
  let failed = 0;
  for (let i = 0; i < argv.length; i += 2) {
    const [unsignedPath, signedPath] = [argv[i], argv[i + 1]];
    let problems;
    try {
      problems = compareSignedPe(readFileSync(unsignedPath), readFileSync(signedPath));
    } catch (e) {
      problems = [e instanceof Error ? e.message : String(e)];
    }
    if (problems.length) failed++;
    console.log(JSON.stringify({ unsigned: basename(unsignedPath), signed: basename(signedPath), ok: problems.length === 0, problems }));
  }
  return failed ? 1 : 0;
}

const invoked = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';
if (invoked.toLowerCase() === import.meta.url.toLowerCase()) process.exitCode = main(process.argv.slice(2));
