// check-sharp — run INSIDE a staged release, AS the service's own user, before
// the flip:   cd <release>/apps/<app> && node check-sharp.cjs [platform]
//
// Passes only when the sharp that Next's image optimizer will require() loads
// sharp's NATIVE engine for this machine (default: this machine's platform,
// e.g. linux-x64) AND encodes an image. The wasm32 fallback, another
// platform's binary, or no sharp at all FAILS: with those /_next/image answers
// an image with its full-size original (or resizes slowly in WebAssembly) and
// logs nothing, so this is the only place it is caught before users see it.
// A release built with images.unoptimized (the optimizer off: /_next/image is
// a 404) needs no sharp and passes as "not-needed".
// Prints SHARP_OK ... or SHARP_GUARD_FAIL ...; exit status says the same.
"use strict";
const path = require("path");

const libc = process.platform === "linux" && !(process.report && process.report.getReport().header.glibcVersionRuntime) ? "musl" : "";
const want = `sharp-${process.argv[2] || `${process.platform}${libc}-${process.arch}`}`;
const fail = (msg) => { console.log(`SHARP_GUARD_FAIL ${msg}`); process.exit(1); };

// The optimizer switched off: nothing will require() sharp.
try {
  const { config } = JSON.parse(require("fs").readFileSync(path.join(process.cwd(), ".next", "required-server-files.json"), "utf8"));
  if (config && config.images && config.images.unoptimized === true) {
    console.log("SHARP_OK not-needed (images.unoptimized: the image optimizer is off)");
    process.exit(0);
  }
} catch { /* no readable config: judge the engine below */ }

let from, sharpPath, sharp;
try {
  // Resolve sharp exactly as next/dist/server/image-optimizer.js does: require('sharp') from its own directory.
  from = path.dirname(require.resolve("next/dist/server/image-optimizer", { paths: [process.cwd()] }));
} catch (e) { fail(`next is not resolvable from ${process.cwd()}`); }
try { sharpPath = require.resolve("sharp", { paths: [from] }); } catch (e) { fail(`sharp is not resolvable from ${from}`); }
try { sharp = require(sharpPath); } catch (e) { fail(`load ${path.relative(process.cwd(), sharpPath)}: ${String(e.message).split("\n")[0]}`); }

const engines = [...new Set(Object.keys(require.cache)
  .map((k) => (/[\\/]@img[\\/](sharp-(?!libvips-)[^\\/]+)[\\/]/.exec(k) || [])[1])
  .filter(Boolean))];
if (engines.length !== 1 || engines[0] !== want) fail(`engine=${engines.join(",") || "none"} want=${want}`);

sharp({ create: { width: 64, height: 64, channels: 3, background: "#c33" } })
  .resize(16).webp().toBuffer({ resolveWithObject: true })
  .then(({ data, info }) => {
    if (data.subarray(0, 4).toString() !== "RIFF" || info.format !== "webp" || info.width !== 16) fail(`encode produced ${info.format} ${info.width}px`);
    console.log(`SHARP_OK engine=${want} sharp=${sharp.versions.sharp} vips=${sharp.versions.vips} from=${path.relative(process.cwd(), sharpPath)}`);
  })
  .catch((e) => fail(`encode: ${String(e.message).split("\n")[0]}`));
