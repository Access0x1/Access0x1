#!/usr/bin/env node
// retarget-sharp — make a Next.js standalone tree carry the sharp binary of the
// machine that RUNS it, not the machine that built it.
//
//   node scripts/retarget-sharp.mjs <standalone-dir> [platform]
//   platform: sharp's name for it (default: $RELEASE_PLATFORM, else linux-x64)
//
// WHY. Next traces sharp's native engine from the BUILD machine. Fleet releases
// are built on an arm64 Mac, so every release shipped @img/sharp-darwin-arm64
// and the box (Ubuntu 22.04, x86_64, glibc) could not load it. Next then answers
// /_next/image for an image with its full-size ORIGINAL (image-optimizer.js
// catch branch: "fallback to the original image", nothing logged) and for
// anything else with a 500 instead of a 400. A release that also carries
// @img/sharp-wasm32 loads that instead when it can resolve it: slow, heap-hungry.
//
// WHAT. For EVERY node_modules/sharp in the tree (nested apps/<app>/..., flat,
// node_modules/next/node_modules/sharp, ...), read that sharp's own
// optionalDependencies pins for @img/sharp-<platform> and
// @img/sharp-libvips-<platform>, fetch exactly those versions from the npm
// registry (npm pack: integrity-checked, no install scripts, no os/cpu gate),
// place them in that sharp's sibling node_modules/@img, then delete every other
// platform's sharp binaries (darwin, wasm32, other linux) anywhere in the tree,
// so exactly one engine ships. Finally verify every shipped engine: the .node
// and libvips are ELF of the target machine and the versions equal the pins.
// Any doubt fails the build; nothing here degrades quietly.
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, openSync, readSync, closeSync, readdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const die = (msg) => { console.error(`✗ retarget-sharp: ${msg}`); process.exit(1); };

const root = process.argv[2];
const platform = (process.argv[3] || process.env.RELEASE_PLATFORM || "linux-x64").trim();
if (!root || !existsSync(root)) die(`usage: retarget-sharp.mjs <standalone-dir> [platform] (got "${root ?? ""}")`);
const m = /^(linux|linuxmusl|darwin)-(x64|arm64)$/.exec(platform);
if (!m) die(`platform "${platform}" is not one of linux-x64, linux-arm64, linuxmusl-x64, linuxmusl-arm64, darwin-x64, darwin-arm64`);
const [, targetOs, targetCpu] = m;
const ROOT = realpathSync(root);
const ENGINE = `sharp-${platform}`;
const LIBVIPS = `sharp-libvips-${platform}`;
const rel = (p) => path.relative(ROOT, p) || ".";

// ── 1) find every sharp package and every @img/sharp-* directory ─────────────
// lstat walk: symlinks are not followed (turbopack's .next/node_modules/<name>-<hash>
// links point back into this same tree, so the real directory is found anyway).
const sharps = new Set();      // real paths of node_modules/<x> dirs whose package.json name is "sharp"
const imgPkgs = [];            // node_modules/@img/sharp-* directories
const walk = (dir) => {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isSymbolicLink()) {
      if (path.basename(dir) === "node_modules" || path.basename(path.dirname(dir)) === "node_modules") {
        try {
          const real = realpathSync(p);
          if (real.startsWith(ROOT + path.sep) && isSharp(real)) sharps.add(real);
        } catch { /* dangling link: not ours to judge here */ }
      }
      continue;
    }
    if (!e.isDirectory()) continue;
    if (path.basename(dir) === "@img" && path.basename(path.dirname(dir)) === "node_modules" && /^sharp-/.test(e.name)) imgPkgs.push(p);
    if (path.basename(dir) === "node_modules" && isSharp(p)) sharps.add(p);
    walk(p);
  }
};
function isSharp(dir) {
  try { return JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8")).name === "sharp"; } catch { return false; }
}
walk(ROOT);

if (sharps.size === 0) {
  if (imgPkgs.length) die(`no sharp package but ${imgPkgs.length} @img/sharp-* dirs (${imgPkgs.map(rel).join(", ")}) — refusing to guess`);
  console.log("  retarget-sharp: this release ships no sharp (nothing to do)");
  process.exit(0);
}

// ── 2) fetch each pinned engine once, from npm, integrity-checked ────────────
const cacheDir = mkdtempSync(path.join(tmpdir(), "fleet-sharp-"));
process.on("exit", () => rmSync(cacheDir, { recursive: true, force: true })); // also when die() exits
const fetched = new Map();     // "name@version" -> extracted package dir
const fetchPkg = (name, version) => {
  const key = `${name}@${version}`;
  if (fetched.has(key)) return fetched.get(key);
  if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) die(`${key}: the pin is not an exact version`);
  const out = execFileSync("npm", ["pack", key, "--prefer-offline", "--pack-destination", cacheDir, "--json", "--silent"], { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
  const [info] = JSON.parse(out);
  const dest = path.join(cacheDir, key.replace(/[@/]/g, "_"));
  mkdirSync(dest, { recursive: true });
  execFileSync("tar", ["-xzf", path.join(cacheDir, info.filename), "-C", dest, "--strip-components=1"]);
  const pj = JSON.parse(readFileSync(path.join(dest, "package.json"), "utf8"));
  if (pj.name !== name || pj.version !== version) die(`npm returned ${pj.name}@${pj.version} for ${key}`);
  console.log(`  fetched ${key}  ${info.integrity}`);
  fetched.set(key, dest);
  return dest;
};

// ── 3) place the pinned engine next to every sharp ───────────────────────────
const keep = new Set();        // @img dirs that must survive the sweep
const plan = [];
for (const s of sharps) {
  const pj = JSON.parse(readFileSync(path.join(s, "package.json"), "utf8"));
  const pins = pj.optionalDependencies || {};
  const vEngine = pins[`@img/${ENGINE}`];
  const vLibvips = pins[`@img/${LIBVIPS}`];
  if (!vEngine || !vLibvips) die(`${rel(s)} (sharp ${pj.version}) pins no @img/${ENGINE} + @img/${LIBVIPS}: sharp < 0.33 or an unsupported platform`);
  const imgDir = path.join(path.dirname(s), "@img");
  mkdirSync(imgDir, { recursive: true });
  for (const [name, version] of [[ENGINE, vEngine], [LIBVIPS, vLibvips]]) {
    const src = fetchPkg(`@img/${name}`, version);
    const dst = path.join(imgDir, name);
    rmSync(dst, { recursive: true, force: true });
    cpSync(src, dst, { recursive: true });
    keep.add(dst);
  }
  // A from-source build (sharp/src/build/Release/*.node) is tried BEFORE @img:
  // it can only be the build machine's, so it goes.
  const fromSource = path.join(s, "src", "build");
  if (existsSync(fromSource)) { rmSync(fromSource, { recursive: true, force: true }); console.log(`  removed ${rel(fromSource)} (a from-source build is tried before @img)`); }
  plan.push({ s, version: pj.version, imgDir, vEngine, vLibvips });
}

// ── 4) exactly one engine: every other platform's binaries go ────────────────
for (const d of imgPkgs) {
  if (keep.has(d)) continue;
  rmSync(d, { recursive: true, force: true });
  console.log(`  removed ${rel(d)}`);
}
rmSync(cacheDir, { recursive: true, force: true });

// ── 5) verify what will ship ─────────────────────────────────────────────────
const ELF_MACHINE = { x64: 0x3e, arm64: 0xb7 };
const kind = (file) => {
  const fd = openSync(file, "r"); const b = Buffer.alloc(20); readSync(fd, b, 0, 20, 0); closeSync(fd);
  if (b.readUInt32BE(0) === 0x7f454c46) return { elf: true, bits: b[4] === 2 ? 64 : 32, machine: b.readUInt16LE(18) };
  if (b.readUInt32BE(0) === 0xcffaedfe) return { macho: true, cpu: b.readUInt32LE(4) };
  return {};
};
const okBinary = (file) => {
  const k = kind(file);
  if (targetOs === "darwin") return k.macho && k.cpu === (targetCpu === "arm64" ? 0x0100000c : 0x01000007);
  return k.elf && k.bits === 64 && k.machine === ELF_MACHINE[targetCpu];
};
for (const { s, version, imgDir, vEngine, vLibvips } of plan) {
  const e = JSON.parse(readFileSync(path.join(imgDir, ENGINE, "package.json"), "utf8"));
  const l = JSON.parse(readFileSync(path.join(imgDir, LIBVIPS, "package.json"), "utf8"));
  if (e.version !== vEngine || l.version !== vLibvips) die(`${rel(s)}: shipped ${ENGINE}@${e.version} + ${LIBVIPS}@${l.version}, sharp ${version} pins ${vEngine} + ${vLibvips}`);
  if ((e.optionalDependencies || {})[`@img/${LIBVIPS}`] !== vLibvips) die(`${rel(s)}: @img/${ENGINE}@${e.version} wants ${LIBVIPS}@${(e.optionalDependencies || {})[`@img/${LIBVIPS}`]}, sharp pins ${vLibvips}`);
  const nodes = readdirSync(path.join(imgDir, ENGINE, "lib")).filter((f) => f.endsWith(".node"));
  if (nodes.length !== 1 || !okBinary(path.join(imgDir, ENGINE, "lib", nodes[0]))) die(`${rel(s)}: ${ENGINE}/lib does not hold exactly one ${platform} binary (${nodes.join(", ") || "none"})`);
  const libs = readdirSync(path.join(imgDir, LIBVIPS, "lib")).filter((f) => /^libvips-cpp\./.test(f));
  if (libs.length !== 1 || !okBinary(path.join(imgDir, LIBVIPS, "lib", libs[0]))) die(`${rel(s)}: ${LIBVIPS}/lib does not hold exactly one ${platform} libvips (${libs.join(", ") || "none"})`);
  console.log(`  ✓ ${rel(s)} sharp ${version} → @img/${ENGINE}@${e.version} + @img/${LIBVIPS}@${l.version} (${platform} binaries verified)`);
}
// Nothing of another platform may remain under any @img dir.
const stray = [];
const scan = (dir) => {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) scan(p);
    else if (e.isFile() && /\.(node|dylib|dll|wasm)$|\.so(\.\d+)*$/.test(e.name) && p.includes(`${path.sep}@img${path.sep}`) && !okBinary(p)) stray.push(rel(p));
  }
};
scan(ROOT);
if (stray.length) die(`binaries for another platform remain: ${stray.join(", ")}`);
