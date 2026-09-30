/**
 * scripts/deploy-web-box.sh ships the web app to the EC2 box behind
 * access0x1.click. These tests pin the promises that keep a bad release off the
 * live site: the box's native image engine (sharp) is proven AS the unit's user
 * before a canary boots, the canary runs with the live env file and must report
 * this commit + a durable store, the flip must serve health AND a WebP from the
 * running process or roll back, and pruning never touches the live release or
 * the rollback target. The commands under test are the exact strings sent to
 * the box (scripts/box/ssm-commands.mjs).
 */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

import { flipCommands, pruneCommands, stageCommands } from '../../scripts/box/ssm-commands.mjs'

const ROOT = resolve(__dirname, '../..')
const SCRIPT = join(ROOT, 'scripts/deploy-web-box.sh')
const CHECK = join(ROOT, 'scripts/box/check-sharp.cjs')
const RETARGET = join(ROOT, 'scripts/box/retarget-sharp.mjs')
const src = readFileSync(SCRIPT, 'utf8')
const check = readFileSync(CHECK, 'utf8')

const stageArgs = {
  url: 'https://bucket.s3.amazonaws.com/deploy/access0x1-web-abc1234.tgz?X-Amz-Signature=f00',
  rel: '/opt/access0x1/releases/abc1234',
  slot: 'access0x1',
  canaryPort: 3105,
  sha: 'abc1234',
  envFile: '/opt/access0x1/shared/env',
  requireStore: 'postgres',
  check,
}
const flipArgs = { rel: '/opt/access0x1/releases/abc1234', slot: 'access0x1', port: 3014, sha: 'abc1234', imagePath: '/icon-512.png' }

// Index of the first command satisfying `pred`; a missing step fails loudly.
function at(cmds: string[], pred: (c: string) => boolean, what: string): number {
  const i = cmds.findIndex(pred)
  if (i < 0) throw new Error(`CONTROL FAILED: no ${what}`)
  return i
}

describe('stage: the release proves itself before anything live changes', () => {
  const cmds = stageCommands(stageArgs)

  it('refuses an env file that would override the unit, and a redeploy over the live release', () => {
    expect(cmds[0]).toBe('set -e')
    const env = at(cmds, (c) => c.includes('ENV_FILE_OVERRIDES_UNIT'), 'env-file guard')
    const live = at(cmds, (c) => c.includes('RELEASE_IS_LIVE'), 'live-release guard')
    const unpack = at(cmds, (c) => c.startsWith('rm -rf /opt/access0x1/releases/abc1234'), 'unpack')
    expect(cmds[env]).toContain("'^(PORT|HOSTNAME|BUILD_ID)='")
    expect(env < unpack && live < unpack).toBe(true)
  })

  it('ships the guard verbatim and runs it as the unit user before the canary boots', () => {
    const ship = at(cmds, (c) => c.includes("<<'BOXSHARP'"), 'shipped guard')
    expect(cmds[ship]).toContain(check)
    const chown = at(cmds, (c) => c.startsWith('chown -R'), 'chown')
    const run = at(cmds, (c) => c.includes('.check-sharp.cjs )'), 'guard run')
    const canary = at(cmds, (c) => c.startsWith('systemd-run'), 'canary')
    expect(ship < chown && chown < run && run < canary).toBe(true)
    expect(cmds[run]).toContain('runuser -u "$U" -g "$G" -- /usr/bin/node ')
    expect(cmds[run].endsWith('|| { echo SHARP_GUARD_FAILED; exit 4; }')).toBe(true)
  })

  it('boots the canary with the live env file and demands this commit, ok and the durable store', () => {
    const canary = cmds[at(cmds, (c) => c.startsWith('systemd-run'), 'canary')]
    expect(canary).toContain('-p EnvironmentFile=/opt/access0x1/shared/env')
    expect(canary).toContain('--setenv=PORT=3105')
    expect(canary).toContain('--setenv=BUILD_ID=abc1234')
    const poll = cmds[at(cmds, (c) => c.includes('/api/health'), 'health poll')]
    for (const m of ['"commit":"abc1234"', '"ok":true', '"store":"postgres"']) expect(poll).toContain(`grep -qF '${m}'`)
  })

  it('refuses bad inputs instead of building a command from them', () => {
    expect(() => stageCommands({ ...stageArgs, sha: 'abc; rm' })).toThrow(/sha/)
    expect(() => stageCommands({ ...stageArgs, rel: '/opt/access0x1/current' })).toThrow(/release path/)
    expect(() => stageCommands({ ...stageArgs, url: "https://x/'a" })).toThrow(/url/)
    expect(() => stageCommands({ ...stageArgs, check: 'BOXSHARP' })).toThrow(/delimiter/)
  })
})

describe('flip: health and a real optimized image, or the prior release comes back', () => {
  const cmds = flipCommands(flipArgs)
  const last = cmds[cmds.length - 1]

  it('records the rollback target without trusting readlink on a missing link', () => {
    expect(cmds[0]).toBe('set +e')
    expect(cmds[1]).toMatch(/^if \[ -L \/opt\/access0x1\/current \]; then OLD=\$\(readlink -f/)
  })

  it('asks the running process for a 64px WebP through the optimizer', () => {
    const img = cmds[at(cmds, (c) => c.includes('/_next/image'), 'image probe')]
    expect(img).toContain("'http://127.0.0.1:3014/_next/image?url=%2Ficon-512.png&w=64&q=75'")
    expect(img).toContain('"200 image/webp"')
  })

  it('declares FLIP_OK only when both hold, and otherwise restores symlink and BUILD_ID drop-in', () => {
    expect(last.startsWith('if [ $ok = 1 ] && [ $img = 1 ]; then echo FLIP_OK')).toBe(true)
    const rollback = last.slice(last.indexOf('FLIP_FAILED'))
    expect(rollback).toContain('ln -sfn $OLD /opt/access0x1/current')
    expect(rollback).toContain('/etc/systemd/system/access0x1.service.d/40-build-id.conf')
    expect(rollback).toContain('FLIP_ROLLED_BACK')
  })
})

describe('prune: never the live release, never the rollback target', () => {
  it('keeps live and prior, and deletes only short-SHA release dirs', () => {
    const cmds = pruneCommands({ slot: 'access0x1', keep: 3, prior: '/opt/access0x1/releases/1e56a84' })
    const loop = cmds[at(cmds, (c) => c.startsWith('n=0;'), 'prune loop')]
    expect(loop).toContain(`[ "$p" = "$LIVE" ]`)
    expect(loop).toContain(`[ "$p" = '/opt/access0x1/releases/1e56a84' ]`)
    expect(loop).toContain("grep -qE '^[0-9a-f]{7,40}$'")
    expect(cmds[1]).toContain('PRUNE_REFUSED')
  })

  it('refuses a rollback target outside the release dir and a keep below 2', () => {
    expect(() => pruneCommands({ slot: 'access0x1', keep: 3, prior: '/etc' })).toThrow(/rollback/)
    expect(() => pruneCommands({ slot: 'access0x1', keep: 1, prior: 'NONE' })).toThrow(/keep/)
  })
})

describe('deploy-web-box.sh: the order of the local steps', () => {
  const pos = (s: string) => {
    const i = src.indexOf(s)
    if (i < 0) throw new Error(`CONTROL FAILED: "${s}" not in deploy-web-box.sh`)
    return i
  }

  it('strips every .env from the release, retargets sharp, then packs', () => {
    const strip = pos("-name '.env*' -not -path '*/node_modules/*' -exec rm -f {} +")
    const retarget = pos('node scripts/box/retarget-sharp.mjs "$STAGE"')
    const pack = pos('say "3/7 pack"')
    expect(strip < retarget && retarget < pack).toBe(true)
  })

  it('stops before the flip unless the guard printed SHARP_OK and the canary CANARY_OK', () => {
    const flip = pos('say "6/7 flip')
    expect(pos("grep -q '^SHARP_OK '") < flip).toBe(true)
    expect(pos("grep -q '^CANARY_OK'") < flip).toBe(true)
  })

  it('refuses to run without a box to deploy to, before any build', () => {
    const env = { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', NODE_ENV: 'test' as const }
    const r = spawnSync('bash', [SCRIPT], { env, encoding: 'utf8' })
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('BOX_INSTANCE_ID is not set')
  })

  it('the command CLI emits the same commands the functions return', () => {
    const r = spawnSync('node', [join(ROOT, 'scripts/box/ssm-commands.mjs'), 'flip', JSON.stringify(flipArgs)], { encoding: 'utf8' })
    expect(r.status).toBe(0)
    expect(JSON.parse(r.stdout).commands).toEqual(flipCommands(flipArgs))
  })
})

describe('the vendored image-engine files', () => {
  // Verbatim copies of the upstream release tooling. A change here is deliberate:
  // update the file from upstream and this pin together.
  const sha256 = (p: string) => createHash('sha256').update(readFileSync(p)).digest('hex')
  it('are the reviewed versions', () => {
    expect(sha256(CHECK)).toBe('302abe1e68c59d75cac31bd3f17d293fb4219cf71db47b63f9af33042d62fb73')
    expect(sha256(RETARGET)).toBe('5f002991de1790121a8a30684994fb53c290f7abb65562182fc45efd46ab02d7')
  })

  it('the guard fails where next is not resolvable', () => {
    const r = spawnSync('node', [CHECK], { cwd: mkdtempSync(join(tmpdir(), 'sharp-guard-')), encoding: 'utf8' })
    expect(r.status).toBe(1)
    expect(r.stdout).toContain('SHARP_GUARD_FAIL next is not resolvable')
  })
})
