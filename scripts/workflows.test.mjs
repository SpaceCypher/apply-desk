import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'

function job(source, name) {
  const lines = source.split('\n')
  const start = lines.indexOf(`  ${name}:`)
  assert.ok(start >= 0, `missing ${name} job`)
  const next = lines.findIndex((line, index) => index > start && /^  [\w-]+:/.test(line))
  return lines.slice(start + 1, next < 0 ? undefined : next).join('\n')
}

for (const [name, dependentJobs] of [['migrate', ['migrate']], ['inbox', ['inbox']], ['apply', ['apply']], ['bench', ['fixtures', 'live', 'summary']], ['scoreboard', ['score']]]) {
  test(`${name}: missing database skips cleanly; configured database enables dependent jobs without logging it`, async () => {
    const source = await readFile(new URL(`../.github/workflows/${name}.yml`, import.meta.url), 'utf8')
    const configuration = job(source, 'configuration')
    // Bench/Scoreboard also have scratch URLs: the preflight must check the external secret.
    assert.match(configuration, /DATABASE_URL: \$\{\{ secrets\.DATABASE_URL \}\}/)
    assert.match(configuration, /ready: \$\{\{ steps\.database\.outputs\.ready \}\}/)
    for (const name of dependentJobs) {
      const dependent = job(source, name)
      assert.match(dependent, /needs:.*configuration/)
      assert.match(dependent, /if:.*needs\.configuration\.outputs\.ready == 'true'/)
    }
    const script = configuration.split('        run: |\n')[1]?.split('\n').map(line => line.replace(/^ {10}/, '')).join('\n')
    assert.ok(script, 'run the actual preflight shell')
    const dir = await mkdtemp(join(tmpdir(), 'workflow-config-'))
    try {
      for (const [index, value] of [undefined, '', 'postgresql://fixture:fake@localhost/test'].entries()) {
        const output = join(dir, `output-${index}`)
        const env = { PATH: process.env.PATH, GITHUB_OUTPUT: output, ...(value === undefined ? {} : { DATABASE_URL: value }) }
        const result = spawnSync('bash', ['-e', '-c', script], { env, encoding: 'utf8' })
        assert.equal(result.status, 0, result.stderr)
        assert.equal((await readFile(output, 'utf8')).trim(), `ready=${!!value}`)
        if (!value) assert.match(result.stdout, /::notice::DATABASE_URL is not set/)
        else assert.ok(!result.stdout.includes(value))
      }
    } finally { await rm(dir, { recursive: true, force: true }) }
  })
}

test('bench summary still runs after configured benchmark failures', async () => {
  const source = await readFile(new URL('../.github/workflows/bench.yml', import.meta.url), 'utf8')
  const summary = job(source, 'summary')
  assert.match(summary, /needs: \[configuration, fixtures, live\]/)
  assert.match(summary, /if:.*always\(\).*needs\.configuration\.outputs\.ready == 'true'/)
  assert.ok(!source.includes('continue-on-error: true'))
})
