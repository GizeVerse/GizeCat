#!/usr/bin/env node
// Runs the Android app's Gradle build (android/, guide in android/README.md) with JAVA_HOME and
// ANDROID_HOME set for the Gradle process only (never user- or machine-wide), after putting the
// production web bundle into the app (scripts/build-web-app.mjs). Heavy: run it under
// scripts/with-lock.mjs on a shared machine (the npm scripts android:apk/aab/trial do).
//
// Usage: node scripts/android-gradle.mjs <gradle tasks and options...> [--no-web] [--no-collect]
//   --no-web      skip build-web-app (android/app/src/main/assets must already hold the bundle)
//   --no-collect  leave the outputs in android/app/build/outputs instead of also copying them to
//                 release/<version>/android/ with SHA256SUMS-android.txt
// Examples: node scripts/android-gradle.mjs :app:assembleRelease
//           node scripts/android-gradle.mjs :app:bundleRelease :app:assembleTrial
//
// Signing is Gradle's (android/app/build.gradle.kts, docs/platforms/android-signing.md). This script
// never reads or prints a signing value; it only names what came out, by looking at the outputs:
//   GizeCat-<version>-android.apk/.aab            signed with the configured release key
//   GizeCat-<version>-android-unsigned.apk/.aab   no release key was configured
//   GizeCat-<version>-android-trial-debugsigned.apk   the trial build, signed with the SDK debug key
//
// What gets collected follows the tasks requested (assembleRelease, bundleRelease, assembleTrial),
// so a run Gradle found UP-TO-DATE still collects, and a requested output that is missing stops
// with an error. Collecting a release APK or AAB first removes both the signed and the unsigned copy
// of that kind, so the folder never holds an old build of one signing state beside a new one.
//
// JAVA_HOME: the environment's, if it holds a JDK 17+; otherwise Android Studio's bundled JBR.
// ANDROID_HOME: the environment's ANDROID_HOME or ANDROID_SDK_ROOT; otherwise the Android Studio
// default SDK folder. The SDK needs platforms/android-36.
import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const androidDir = path.join(root, 'android');
const win = process.platform === 'win32';
const argv = process.argv.slice(2);
const noWeb = argv.includes('--no-web');
const noCollect = argv.includes('--no-collect');
const gradleArgs = argv.filter((a) => a !== '--no-web' && a !== '--no-collect');
// The tasks this run asks for: options and the value of -x are not, and a dry run builds nothing.
const tasks = gradleArgs.filter((a, i) => !a.startsWith('-') && !['-x', '--exclude-task'].includes(gradleArgs[i - 1]));
const dryRun = gradleArgs.includes('--dry-run') || gradleArgs.includes('-m');
const asked = (task) => !dryRun && tasks.some((t) => t === task || t.endsWith(`:${task}`));

function fail(message) {
  console.error(`android-gradle: ${message}`);
  process.exit(1);
}

if (gradleArgs.length === 0) fail('usage: node scripts/android-gradle.mjs <gradle tasks...> [--no-web] [--no-collect]');

const javaExe = (home) => path.join(home, 'bin', win ? 'java.exe' : 'java');

/** The JDK's major version, or 0 when it cannot be read. */
function javaMajor(home) {
  const r = spawnSync(javaExe(home), ['-version'], { encoding: 'utf8' });
  const m = /version "(\d+)(?:\.(\d+))?/.exec(`${r.stderr ?? ''}${r.stdout ?? ''}`);
  if (!m) return 0;
  const major = Number(m[1]);
  return major === 1 ? Number(m[2]) : major;
}

function studioJbrCandidates() {
  if (win) return [path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Android', 'Android Studio', 'jbr')];
  if (process.platform === 'darwin') return ['/Applications/Android Studio.app/Contents/jbr/Contents/Home'];
  return ['/opt/android-studio/jbr', path.join(os.homedir(), 'android-studio', 'jbr')];
}

function resolveJavaHome() {
  const candidates = [process.env.JAVA_HOME, ...studioJbrCandidates()].filter(Boolean);
  for (const home of candidates) {
    if (fs.existsSync(javaExe(home)) && javaMajor(home) >= 17) return home;
  }
  fail(`no JDK 17+ found (tried ${candidates.join(', ')}): install Android Studio or set JAVA_HOME`);
}

function sdkDefault() {
  if (win) return path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'Android', 'Sdk');
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Android', 'sdk');
  return path.join(os.homedir(), 'Android', 'Sdk');
}

function resolveAndroidHome() {
  const home = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT || sdkDefault();
  if (!fs.existsSync(path.join(home, 'platforms', 'android-36'))) {
    fail(`the Android SDK at ${home} has no platforms/android-36: install it with the SDK Manager, or set ANDROID_HOME`);
  }
  return home;
}

const javaHome = resolveJavaHome();
const androidHome = resolveAndroidHome();

if (!noWeb) {
  const r = spawnSync(process.execPath, [path.join(root, 'scripts', 'build-web-app.mjs')], { cwd: root, stdio: 'inherit' });
  if (r.status !== 0) fail('build-web-app failed');
}

const env = { ...process.env, JAVA_HOME: javaHome, ANDROID_HOME: androidHome };
delete env.ANDROID_SDK_ROOT;
const args = ['-p', 'android', '--no-daemon', ...gradleArgs];
console.log(`android-gradle: JAVA_HOME=${javaHome}`);
console.log(`android-gradle: ANDROID_HOME=${androidHome}`);
console.log(`android-gradle: gradlew ${args.join(' ')}`);

// On Windows gradlew.bat needs a shell; pass one pre-quoted command line (as scripts/with-lock.mjs does).
const quote = (s) => (/^[\w@%+=:,./\\-]+$/.test(s) ? s : `"${s.replace(/"/g, '\\"')}"`);
const child = win
  ? spawn([path.join('android', 'gradlew.bat'), ...args].map(quote).join(' '), { cwd: root, stdio: 'inherit', shell: true, env })
  : spawn('sh', [path.join('android', 'gradlew'), ...args], { cwd: root, stdio: 'inherit', env });
child.on('error', (e) => fail(`could not start Gradle: ${e.message}`));
child.on('close', (code, signal) => {
  if (code !== 0) {
    console.error(`android-gradle: Gradle failed (${code ?? signal})`);
    process.exit(code || 1);
  }
  const outputs = requestedOutputs();
  report(outputs);
  if (!noCollect) collect(outputs);
});

/**
 * Whether a zip holds a JAR signature block (META-INF/<name>.RSA, .DSA or .EC), which is how an AAB
 * is signed. Reads the central directory only; anything it cannot read counts as unsigned.
 */
function hasJarSignature(file) {
  const zip = fs.readFileSync(file);
  // The end-of-central-directory record is searched from the end: a zip comment may follow it.
  let eocd = -1;
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 22 - 0xffff); i -= 1) {
    if (zip.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return false;
  let entry = zip.readUInt32LE(eocd + 16);
  for (let n = zip.readUInt16LE(eocd + 10); n > 0; n -= 1) {
    if (entry + 46 > zip.length || zip.readUInt32LE(entry) !== 0x02014b50) return false;
    const nameLength = zip.readUInt16LE(entry + 28);
    if (/^META-INF\/[^/]+\.(RSA|DSA|EC)$/i.test(zip.toString('utf8', entry + 46, entry + 46 + nameLength))) return true;
    entry += 46 + nameLength + zip.readUInt16LE(entry + 30) + zip.readUInt16LE(entry + 32);
  }
  return false;
}

/** Stops the script when a requested output is not there; otherwise returns its path. */
function requireOutput(file) {
  if (!fs.existsSync(file)) fail(`Gradle succeeded but ${path.relative(root, file)} is missing`);
  return file;
}

/** The file name Gradle recorded for the APK in `dir`: an older signed or unsigned sibling can still be there. */
function recordedApkName(dir) {
  const metadata = requireOutput(path.join(dir, 'output-metadata.json'));
  let name;
  try {
    name = JSON.parse(fs.readFileSync(metadata, 'utf8')).elements?.[0]?.outputFile;
  } catch (e) {
    fail(`cannot read ${path.relative(root, metadata)}: ${e.message}`);
  }
  if (typeof name !== 'string') fail(`${path.relative(root, metadata)} names no output file`);
  return name;
}

/**
 * The outputs of the tasks this run asked for, with the release/<version>/android name of each and
 * the names it replaces there. Decided from the tasks, so a run Gradle found UP-TO-DATE yields them
 * too; a requested output that is missing stops the script before release/ is touched. The name
 * reports the output, not the configuration: Gradle calls an unsigned APK app-release-unsigned.apk,
 * while an AAB is app-release.aab either way, so its signature is read. The trial replaces nothing
 * but its own file, so a trial built after a release leaves the release APK alone.
 */
function requestedOutputs() {
  const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
  const out = path.join(androidDir, 'app', 'build', 'outputs');
  const files = [];
  if (asked('assembleRelease')) {
    const dir = path.join(out, 'apk', 'release');
    const apkNames = {
      'app-release-unsigned.apk': `GizeCat-${version}-android-unsigned.apk`,
      'app-release.apk': `GizeCat-${version}-android.apk`,
    };
    const built = recordedApkName(dir);
    if (!Object.hasOwn(apkNames, built)) fail(`unexpected release APK name in output-metadata.json: ${built}`);
    files.push({ file: requireOutput(path.join(dir, built)), name: apkNames[built], replaces: Object.values(apkNames) });
  }
  if (asked('bundleRelease')) {
    const aab = requireOutput(path.join(out, 'bundle', 'release', 'app-release.aab'));
    const aabSigned = hasJarSignature(aab);
    files.push({
      file: aab,
      name: `GizeCat-${version}-android${aabSigned ? '' : '-unsigned'}.aab`,
      replaces: [`GizeCat-${version}-android.aab`, `GizeCat-${version}-android-unsigned.aab`],
    });
  }
  if (asked('assembleTrial')) {
    files.push({
      file: requireOutput(path.join(out, 'apk', 'trial', 'app-trial.apk')),
      name: `GizeCat-${version}-android-trial-debugsigned.apk`,
      replaces: [],
    });
  }
  return { version, files };
}

function report({ files }) {
  for (const { file, name } of files) {
    console.log(`android-gradle: output ${path.relative(root, file)} (${fs.statSync(file).size} bytes): ${name}`);
  }
}

function collect({ version, files }) {
  if (files.length === 0) {
    console.log('android-gradle: nothing to collect: no assembleRelease, bundleRelease or assembleTrial task was requested');
    return;
  }
  const dest = path.join(root, 'release', version, 'android');
  fs.mkdirSync(dest, { recursive: true });
  for (const { file, name, replaces } of files) {
    for (const old of replaces) fs.rmSync(path.join(dest, old), { force: true });
    fs.copyFileSync(file, path.join(dest, name));
  }
  const prefix = `GizeCat-${version}-android`;
  const lines = fs
    .readdirSync(dest)
    .filter((n) => n.startsWith(prefix) && /\.(apk|aab)$/.test(n))
    .sort()
    .map((n) => `${crypto.createHash('sha256').update(fs.readFileSync(path.join(dest, n))).digest('hex')}  ${n}`);
  fs.writeFileSync(path.join(dest, 'SHA256SUMS-android.txt'), `${lines.join('\n')}\n`);
  console.log(`android-gradle: copied ${files.map(({ name }) => name).join(', ')} to release/${version}/android (SHA256SUMS-android.txt updated)`);
}
