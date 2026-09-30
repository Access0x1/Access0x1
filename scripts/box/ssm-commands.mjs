#!/usr/bin/env node
// ssm-commands — the root shell commands scripts/deploy-web-box.sh sends to the
// box over SSM (AWS-RunShellScript), one phase at a time. Pure functions, so the
// test suite reads exactly what runs on the box (web/__tests__/deploy-web-box.test.ts).
//
//   node scripts/box/ssm-commands.mjs stage  <json-args>   -> {"commands":[...]}
//   node scripts/box/ssm-commands.mjs flip   <json-args>
//   node scripts/box/ssm-commands.mjs prune  <json-args>
//
// The live service is never touched before the flip: stage unpacks into a new
// release dir, proves the image engine as the unit's user, and boots a
// throwaway canary unit on its own port with the live env file.
import { readFileSync, realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const SHA = /^[0-9a-f]{7,40}$/
const NAME = /^[a-z][a-z0-9-]{0,38}$/
const ABS = /^\/[A-Za-z0-9._/-]+$/

function need(cond, what) {
  if (!cond) throw new Error(`ssm-commands: refusing, bad ${what}`)
}

// Poll a loopback URL until it answers 200 AND the body holds every marker.
// Leaves $ok (1/0) and $code set; the body lands in `out`.
function poll(url, out, markers, seconds) {
  const hits = markers.map((m) => `grep -qF '${m}' ${out}`).join(' && ')
  return (
    `ok=0; code=000; for i in $(seq 1 ${seconds}); do sleep 1; ` +
    `code=$(curl -s -o ${out} -w '%{http_code}' ${url} || true); ` +
    `if [ "$code" = 200 ] && ${hits}; then ok=1; break; fi; done`
  )
}

/**
 * Stage a release and prove it on a canary, live service untouched.
 * @param {{url:string, rel:string, slot:string, canaryPort:number, sha:string,
 *   envFile:string, requireStore:string, check:string}} a
 */
export function stageCommands(a) {
  need(SHA.test(a.sha), 'sha')
  need(NAME.test(a.slot), 'slot')
  need(a.rel === `/opt/${a.slot}/releases/${a.sha}`, 'release path')
  need(ABS.test(a.envFile), 'env file')
  need(Number.isInteger(a.canaryPort) && a.canaryPort > 1024, 'canary port')
  need(/^https:\/\/[^'\s]+$/.test(a.url), 'artifact url')
  need(/^[a-z]+$/.test(a.requireStore), 'store')
  need(!a.check.includes('BOXSHARP'), 'guard (holds the heredoc delimiter)')
  const { rel, slot, sha, envFile } = a
  const cp = a.canaryPort
  const tgz = `/tmp/${slot}-web-${sha}.tgz`
  const health = [`"commit":"${sha}"`, '"ok":true', `"store":"${a.requireStore}"`]
  return [
    'set -e',
    // systemd: EnvironmentFile= OVERRIDES Environment=/--setenv. A PORT, HOSTNAME
    // or BUILD_ID in the env file would silently move the canary onto the live
    // port or make the live build stamp lie, so the stage refuses instead.
    `if grep -qE '^(PORT|HOSTNAME|BUILD_ID)=' ${envFile}; then echo ENV_FILE_OVERRIDES_UNIT; exit 5; fi`,
    // Never unpack over the release that is serving (a redeploy of the same commit).
    `if [ "$(readlink -f /opt/${slot}/current)" = ${rel} ]; then echo RELEASE_IS_LIVE; exit 6; fi`,
    `curl -fsSL -o ${tgz} '${a.url}'`,
    `systemctl stop ${slot}-canary 2>/dev/null || true; systemctl reset-failed ${slot}-canary 2>/dev/null || true`,
    // Owned by, and canary-booted as, the user the live unit runs as.
    `U=$(systemctl show ${slot} -p User --value); U=\${U:-ubuntu}; G=$(id -gn "$U"); echo CANARY_USER=$U`,
    `rm -rf ${rel} && mkdir -p ${rel} && tar -xzf ${tgz} -C ${rel} && rm -f ${tgz}`,
    // scripts/box/check-sharp.cjs, shipped verbatim: inside the new release, as
    // the unit's user, the sharp that Next's image optimizer requires must load
    // the NATIVE engine for this machine and encode a WebP.
    `cat > ${rel}/.check-sharp.cjs <<'BOXSHARP'\n${a.check}\nBOXSHARP`,
    `chown -R "$U:$G" ${rel}`,
    `( cd ${rel} && runuser -u "$U" -g "$G" -- /usr/bin/node ${rel}/.check-sharp.cjs ) || { echo SHARP_GUARD_FAILED; exit 4; }`,
    `rm -f ${rel}/.check-sharp.cjs`,
    `systemd-run --uid="$U" --gid="$G" -p EnvironmentFile=${envFile} --setenv=PORT=${cp} --setenv=HOSTNAME=127.0.0.1 ` +
      `--setenv=NODE_ENV=production --setenv=BUILD_ID=${sha} -p WorkingDirectory=${rel} --unit=${slot}-canary /usr/bin/node ${rel}/server.js`,
    poll(`http://127.0.0.1:${cp}/api/health`, '/tmp/canary.json', health, 60),
    `systemctl stop ${slot}-canary 2>/dev/null || true; systemctl reset-failed ${slot}-canary 2>/dev/null || true`,
    'if [ $ok = 1 ]; then echo CANARY_OK; cat /tmp/canary.json; echo; else echo CANARY_FAILED code=$code; head -c 400 /tmp/canary.json; echo; fi',
  ]
}

/**
 * Move the live symlink, stamp BUILD_ID, restart, and require health AND a real
 * optimized image from the running process; otherwise put everything back.
 * @param {{rel:string, slot:string, port:number, sha:string, imagePath:string}} a
 */
export function flipCommands(a) {
  need(SHA.test(a.sha), 'sha')
  need(NAME.test(a.slot), 'slot')
  need(a.rel === `/opt/${a.slot}/releases/${a.sha}`, 'release path')
  need(Number.isInteger(a.port) && a.port > 1024, 'port')
  need(/^\/[A-Za-z0-9._/-]+\.(png|jpe?g)$/.test(a.imagePath), 'image path')
  const { rel, slot, sha, port } = a
  const d = `/etc/systemd/system/${slot}.service.d/40-build-id.conf`
  const cur = `/opt/${slot}/current`
  const img = `http://127.0.0.1:${port}/_next/image?url=${encodeURIComponent(a.imagePath)}&w=64&q=75`
  return [
    'set +e',
    // GNU readlink -f prints a path even for a MISSING link, so test the link first.
    `if [ -L ${cur} ]; then OLD=$(readlink -f ${cur}); else OLD=NONE; fi; echo PRIOR_RELEASE=$OLD`,
    `if [ -f ${d} ]; then PRIOR_BID=$(grep -oE 'BUILD_ID=[0-9a-fA-F]+' ${d} | head -1 | cut -d= -f2); else PRIOR_BID=NONE; fi; echo PRIOR_BUILD_ID=$PRIOR_BID`,
    `ln -sfn ${rel} ${cur} && mkdir -p $(dirname ${d}) && printf '[Service]\\nEnvironment="BUILD_ID=${sha}"\\n' > ${d} && systemctl daemon-reload && systemctl restart ${slot}`,
    poll(`http://127.0.0.1:${port}/api/health`, '/tmp/live.json', [`"commit":"${sha}"`, '"ok":true'], 60),
    // The optimizer, through the RUNNING process: 200 image/webp or it is not done.
    `img=0; if [ $ok = 1 ]; then ctype=$(curl -s -o /tmp/live-img.bin -w '%{http_code} %{content_type}' -H 'Accept: image/webp' '${img}' || true); ` +
      `echo IMAGE=$ctype bytes=$(stat -c %s /tmp/live-img.bin 2>/dev/null); [ "$ctype" = "200 image/webp" ] && img=1; fi`,
    'if [ $ok = 1 ] && [ $img = 1 ]; then echo FLIP_OK; cat /tmp/live.json; echo; systemctl is-active ' + slot + '; else echo FLIP_FAILED code=$code img=$img; ' +
      `if [ "$OLD" != NONE ]; then ln -sfn $OLD ${cur}; else rm -f ${cur}; fi; ` +
      `if [ "$PRIOR_BID" != NONE ]; then printf '[Service]\\nEnvironment="BUILD_ID='$PRIOR_BID'"\\n' > ${d}; else rm -f ${d}; fi; ` +
      `systemctl daemon-reload; systemctl restart ${slot}; sleep 5; ` +
      `rcode=$(curl -s -o /tmp/rb.json -w '%{http_code}' http://127.0.0.1:${port}/api/health || true); ` +
      `if grep -qF '"commit":"${sha}"' /tmp/rb.json; then echo ROLLBACK_STILL_SERVES_NEW_SHA; else echo FLIP_ROLLED_BACK restored=$OLD code=$rcode; fi; fi`,
  ]
}

/**
 * Keep the newest `keep` releases plus the live one plus the rollback target;
 * only short-SHA dirs directly under /opt/<slot>/releases are candidates.
 * @param {{slot:string, keep:number, prior:string}} a
 */
export function pruneCommands(a) {
  need(NAME.test(a.slot), 'slot')
  need(Number.isInteger(a.keep) && a.keep >= 2, 'keep (at least 2)')
  const base = `/opt/${a.slot}/releases`
  need(a.prior === 'NONE' || new RegExp(`^${base}/[0-9a-f]{7,40}$`).test(a.prior), 'rollback target')
  return [
    'set -e',
    `LIVE=$(readlink -f /opt/${a.slot}/current); [ -d "$LIVE" ] || { echo PRUNE_REFUSED no live release; exit 3; }`,
    `n=0; for r in $(ls -1t ${base}); do n=$((n+1)); p=${base}/$r; ` +
      `if ! printf '%s' "$r" | grep -qE '^[0-9a-f]{7,40}$'; then echo KEEP_UNKNOWN $p; continue; fi; ` +
      `if [ $n -le ${a.keep} ] || [ "$p" = "$LIVE" ] || [ "$p" = '${a.prior}' ]; then echo KEEP $p; else rm -rf -- "$p"; echo PRUNED $p; fi; done`,
    `df -h / | tail -1`,
  ]
}

const PHASES = { stage: stageCommands, flip: flipCommands, prune: pruneCommands }

if (process.argv[1] && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1])) {
  const [phase, json] = process.argv.slice(2)
  const fn = PHASES[phase]
  if (!fn || !json) {
    console.error('usage: ssm-commands.mjs stage|flip|prune <json-args>')
    process.exit(2)
  }
  const args = JSON.parse(json)
  if (phase === 'stage') args.check = readFileSync(args.checkPath, 'utf8')
  process.stdout.write(JSON.stringify({ commands: fn(args) }))
}
