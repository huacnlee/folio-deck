import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { Buffer } from 'node:buffer';
import { createHash, randomBytes } from 'node:crypto';
import { Mailbox, draftText } from '../mailbox.js';

// Link the production view to a minimal host: test owner commands and async
// races here; check-states.py separately materializes real native components.
const storage = new Map();
const context = vm.createContext({
  console, Set, Map, Object, JSON,
  localStorage: { getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value) },
});
const modules = new Map();
async function moduleAt(path) {
  if (modules.has(path)) return modules.get(path);
  const module = new vm.SourceTextModule(await readFile(new URL(path, import.meta.url), 'utf8'), { context });
  modules.set(path, module);
  await module.link(async specifier => {
    if (specifier.startsWith('./')) return moduleAt('../' + specifier.slice(2));
    const exports = specifier === 'process' ? { default: { run() {} } } : specifier === 'buffer' ? { Buffer } : specifier === 'crypto' ? { createHash, randomBytes } : specifier === 'gpui-kit' ? { View: class {}, div() {}, image() {}, svg() {}, PathBuilder: {} }
      : specifier === 'gpui-base' ? { h_flex() {}, v_flex() {}, h_resizable() {}, resizable_panel() {}, set_theme() {}, TextView: {} }
        : Object.fromEntries(['Button', 'TitleBar', 'InputState', 'TextareaState', 'InputGroup', 'InputGroupInput', 'InputGroupTextarea'].map(name => [name, () => {}]));
    return new vm.SyntheticModule(Object.keys(exports), function () {
      for (const [name, value] of Object.entries(exports)) this.setExport(name, value);
    }, { context });
  });
  return module;
}
const main = await moduleAt('../main.js');
await main.evaluate();
const View = main.namespace.default;
function owner() {
  const view = new View();
  view.mailbox = new Mailbox();
  view.editors = Object.fromEntries(view.mailbox.rows().map(c => [c.id, { set_value(value) { this.value = value; } }]));
  view.search = { set_value() {} };
  view.generation = 0;
  view.noticeRevision = 0;
  view.online = true;
  view.tone = 'Formal';
  const waits = [];
  const tasks = [];
  const cx = {
    notify() {}, timer: { after() {} },
    sleep: () => new Promise(resolve => waits.push(resolve)),
    spawn: body => { tasks.push(body(cx)); },
  };
  return { view, cx, complete: async () => { waits.splice(0).forEach(resolve => resolve()); await Promise.all(tasks); } };
}

test('send finishes on its original letter even after selection changes', async () => {
  const { view, cx, complete } = owner();
  view.send('maya', cx);
  view.select('noah', cx);
  await complete();
  assert.equal(view.mailbox.sent.has('maya'), true);
  assert.equal(view.mailbox.sent.has('noah'), false);
  assert.equal(view.mailbox.selectedId, 'noah');
});

test('reset cancels old sends and rewrites without modifying restored letters', async () => {
  const { view, cx, complete } = owner();
  view.send('maya', cx);
  view.rewrite('noah', cx);
  view.reset(cx);
  await complete();
  assert.equal(view.mailbox.sent.size, 0);
  assert.equal(view.mailbox.draft('noah'), draftText('noah'));
  assert.equal(view.generatingId, null);
});

test('rewrite respects intervening edits and offline sends offer retry', async () => {
  const { view, cx, complete } = owner();
  view.rewrite('maya', cx);
  view.mailbox.drafts.maya = 'My new draft';
  await complete();
  assert.equal(view.mailbox.draft('maya'), 'My new draft');
  view.online = false;
  view.send('maya', cx);
  await complete();
  assert.equal(view.mailbox.failed.has('maya'), true);
  view.online = true;
  view.send('maya', cx);
  await complete();
  assert.equal(view.mailbox.sent.has('maya'), true);
  assert.equal(view.mailbox.failed.has('maya'), false);
});
