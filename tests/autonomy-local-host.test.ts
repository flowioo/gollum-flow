import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, symlinkSync, chmodSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseGeneratedObject, applyLocalChanges } from '../src/autonomy/local-host.js';

test('local JSON extraction preserves nested objects and quoted code braces', () => {
  const expected = { summary: 'fix', changes: [{ path: 'a.ts', content: 'const x = { q: "}\\\\" };\n' }] };
  assert.deepEqual(parseGeneratedObject(`model banner\n${JSON.stringify(expected)}\n[done]`), expected);
  assert.throws(() => parseGeneratedObject('{"incomplete":'), /complete JSON/);
});

test('local model edits validate the entire response before touching the candidate', t => {
  const dir = mkdtempSync(join(tmpdir(), 'gollum-local-edit-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'code.ts'), 'original'); writeFileSync(join(dir, 'test.ts'), 'assertion');
  const allowed = ['code.ts'];
  assert.throws(() => applyLocalChanges(dir, allowed, { summary: 'bad', changes: [
    { path: 'code.ts', content: 'new' }, { path: 'test.ts', content: 'weakened' },
  ] }), /unauthorized/);
  assert.equal(readFileSync(join(dir, 'code.ts'), 'utf8'), 'original');
  symlinkSync(join(dir, 'test.ts'), join(dir, 'alias.ts'));
  assert.throws(() => applyLocalChanges(dir, ['alias.ts'], { summary: 'bad', changes: [{ path: 'alias.ts', content: 'changed' }] }), /symlink/);
  applyLocalChanges(dir, allowed, { summary: 'fix', changes: [{ path: 'code.ts', content: 'fixed' }] });
  assert.equal(readFileSync(join(dir, 'code.ts'), 'utf8'), 'fixed');
  assert.equal(readFileSync(join(dir, 'test.ts'), 'utf8'), 'assertion');
});

test('local adapter invokes only offline inference and strips cloud credentials from its child', { skip: process.platform === 'win32' }, async t => {
  const dir = mkdtempSync(join(tmpdir(), 'gollum-local-protocol-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const executable = join(dir, 'llama-fixture'), model = join(dir, 'fixture.gguf');
  writeFileSync(model, 'fixture'); writeFileSync(join(dir, 'code.ts'), 'original');
  writeFileSync(executable, `#!${process.execPath}
const assert = require('node:assert/strict'), fs = require('node:fs');
const argv = process.argv.slice(2);
assert.ok(argv.includes('--offline'));
assert.equal(process.env.ANTHROPIC_API_KEY, undefined);
assert.equal(process.env.LLAMA_ARG_SERVER_BASE, undefined);
const prompt = fs.readFileSync(argv[argv.indexOf('--file') + 1], 'utf8');
assert.ok(prompt.includes('original'));
const schema = JSON.parse(fs.readFileSync(argv[argv.indexOf('--json-schema-file') + 1], 'utf8'));
assert.ok(schema.properties.changes);
console.log('local runtime banner');
console.log(JSON.stringify({summary:'fixed',changes:[{path:'code.ts',content:'corrected'}]}));
`);
  chmodSync(executable, 0o755);
  const child = execFile(process.execPath, [join(process.cwd(), 'dist/autonomy/local-host.js'), '--model', model,
    '--executable', executable, '--files', 'code.ts'], { cwd: dir,
    env: { ...process.env, ANTHROPIC_API_KEY: 'fixture-only', LLAMA_ARG_SERVER_BASE: 'https://example.invalid' } });
  const completed = new Promise<{stdout:string;stderr:string}>((resolve, reject) => {
    let stdout = '', stderr = '';
    child.stdout!.on('data', c => { stdout += c; }); child.stderr!.on('data', c => { stderr += c; });
    child.on('error', reject); child.on('close', code => code === 0 ? resolve({stdout,stderr}) : reject(new Error(stdout + stderr)));
  });
  child.stdin!.end(JSON.stringify({stage:'implement',prompt:'Fix code.ts',schema:{type:'object'}}));
  const {stdout} = await completed;
  assert.equal(JSON.parse(stdout).total_cost_usd, 0);
  assert.equal(readFileSync(join(dir, 'code.ts'), 'utf8'), 'corrected');
});
