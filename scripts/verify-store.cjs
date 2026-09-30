/* store 层事务验证（node CommonJS）：两仓所有权、v1 迁移、检查点续做/整包撤回、冲突裁决 */
const assert = require('assert');

class FakeStorage {
  constructor() { this.map = new Map(); this.failingKeys = new Set(); }
  getItem(key) { return this.map.has(key) ? this.map.get(key) : null; }
  setItem(key, value) {
    if (this.failingKeys.has(key)) {
      const err = new Error('QuotaExceededError: simulated');
      err.name = 'QuotaExceededError';
      throw err;
    }
    this.map.set(key, value);
  }
  removeItem(key) { this.map.delete(key); }
  get length() { return this.map.size; }
  key(i) { return [...this.map.keys()][i] ?? null; }
}

globalThis.localStorage = new FakeStorage();

const DRAFT_KEY = 'sologsb-1015-draft-v2';
const ARCHIVE_KEY = 'sologsb-1015-archive-v1';
const JOURNAL_KEY = 'sologsb-1015-import-journal-v1';
const LEGACY_KEY = 'sologsb-1015-poetry-workspace-v1';

const { PoetryStoreService } = require('./_verify_out/services/poetry-store.service.js');
const { markKey } = require('./_verify_out/services/collation-engine.js');

const read = (key) => JSON.parse(globalThis.localStorage.getItem(key));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fullText = '春眠不觉晓，\n处处闻啼鸟。\n夜来风雨声，\n花落知多少。';

function xiaorhymePackage(overrides = {}) {
  return {
    id: 'pkg-x', name: '异文包', source: '', archivedAt: new Date().toISOString(),
    title: '春晓', author: '', templateId: 'wuyan-zeqi',
    versions: [{
      id: 'version-main', name: '通行本 · 孟浩然集', source: '', createdAt: '',
      text: fullText,
      marks: { [markKey('春眠不觉晓', 4)]: { tone: '平', rhyme: 'X', pauseAfter: false, basis: '', note: '' } },
      antithesisPairs: [],
    }],
    ...overrides,
  };
}

async function main() {
  let passed = 0;
  async function test(name, fn) { await fn(); passed += 1; console.log(`  ✓ ${name}`); }

  await test('两仓分 key；编辑校勘稿不碰归档仓', () => {
    globalThis.localStorage = new FakeStorage();
    const store = new PoetryStoreService();
    const archiveBefore = globalThis.localStorage.getItem(ARCHIVE_KEY);
    store.updateTitle('测试诗稿');
    const draft = read(DRAFT_KEY);
    assert.strictEqual(draft.title, '测试诗稿');
    assert.strictEqual(draft.schema, 2);
    assert.ok(Array.isArray(draft.conflicts) && Array.isArray(draft.orphans));
    assert.strictEqual(globalThis.localStorage.getItem(ARCHIVE_KEY), archiveBefore);
  });

  await test('归档包冻结；后续改稿不影响历史底稿', () => {
    globalThis.localStorage = new FakeStorage();
    const store = new PoetryStoreService();
    store.archiveCurrentDraft();
    const archivedTitle = read(ARCHIVE_KEY).packages[0].title;
    store.updateTitle('改后的题名');
    assert.strictEqual(read(ARCHIVE_KEY).packages[0].title, archivedTitle);
  });

  await test('首次打开迁移 v1 数据到两仓，原内容保留', () => {
    globalThis.localStorage = new FakeStorage();
    const legacy = {
      title: '旧诗稿', author: '佚名', templateId: 'wuyan-zeqi', activeVersionId: 'v1',
      updatedAt: '2026-01-01T00:00:00.000Z',
      versions: [{
        id: 'v1', name: '旧版本', source: '旧出处', createdAt: '2026-01-01T00:00:00.000Z',
        text: '春眠不觉晓，\n处处闻啼鸟。',
        antithesisPairs: [{ id: 'p1', leftLine: 0, rightLine: 1, note: '旧对仗' }],
        marks: { '0:4': { tone: '仄', rhyme: 'A', pauseAfter: false, basis: '旧依据', note: '旧批注' } },
      }],
    };
    globalThis.localStorage.setItem(LEGACY_KEY, JSON.stringify(legacy));
    const store = new PoetryStoreService();
    const draft = store.draft();
    assert.strictEqual(draft.title, '旧诗稿');
    assert.deepStrictEqual(
      draft.versions[0].marks[markKey('春眠不觉晓', 4)],
      { tone: '仄', rhyme: 'A', pauseAfter: false, basis: '旧依据', note: '旧批注' },
    );
    assert.strictEqual(draft.versions[0].antithesisPairs[0].note, '旧对仗');
    assert.strictEqual(read(ARCHIVE_KEY).packages[0].versions[0].marks[markKey('春眠不觉晓', 4)].basis, '旧依据');
    assert.ok(globalThis.localStorage.getItem(LEGACY_KEY).includes('0:4'));
  });

  await test('导入：不同字段自动合并、同字段冲突挂起、journal 提交后清除', () => {
    globalThis.localStorage = new FakeStorage();
    const store = new PoetryStoreService();
    const pkg = xiaorhymePackage({ id: 'pkg-1', name: '宋刻本包', source: '宋本' });
    const result = store.importPackage(pkg);
    assert.strictEqual(result.ok, true);
    assert.strictEqual(globalThis.localStorage.getItem(JOURNAL_KEY), null);
    const xiaosMark = store.draft().versions[0].marks[markKey('春眠不觉晓', 4)];
    assert.strictEqual(xiaosMark.rhyme, 'A'); // 冲突字段保留稿方
    assert.ok(store.conflicts().some((c) => c.field === 'rhyme' && c.draftValue === 'A' && c.incomingValue === 'X'));
    const archive = read(ARCHIVE_KEY);
    assert.strictEqual(archive.packages.length, 1);
    assert.strictEqual(archive.receipts.length, 1);
    assert.ok(archive.receipts[0].backup.title);
  });

  await test('人工裁决冲突：取归档包值后写入', () => {
    globalThis.localStorage = new FakeStorage();
    const store = new PoetryStoreService();
    store.importPackage(xiaorhymePackage({ id: 'pkg-c' }));
    const conflict = store.conflicts().find((c) => c.field === 'rhyme');
    store.resolveConflict(conflict.id, 'incoming');
    assert.strictEqual(store.draft().versions[0].marks[markKey('春眠不觉晓', 4)].rhyme, 'X');
    assert.strictEqual(store.conflicts().length, 0);
  });

  await test('归档仓写入失败 → 检查点保留；重开回滚半套；续做成功', async () => {
    globalThis.localStorage = new FakeStorage();
    let store = new PoetryStoreService();
    globalThis.localStorage.failingKeys.add(ARCHIVE_KEY);
    const result = store.importPackage(xiaorhymePackage({ id: 'pkg-fail', name: '中断包' }));
    assert.strictEqual(result.ok, false);
    assert.ok(globalThis.localStorage.getItem(JOURNAL_KEY));
    assert.strictEqual(store.pendingJournal().package.id, 'pkg-fail');

    store = new PoetryStoreService();
    assert.ok(store.pendingJournal());
    await sleep(0);
    assert.strictEqual(read(DRAFT_KEY).pendingImport, undefined);

    globalThis.localStorage.failingKeys.delete(ARCHIVE_KEY);
    store.retryPendingImport();
    assert.strictEqual(store.pendingJournal(), null);
    assert.strictEqual(read(ARCHIVE_KEY).packages.length, 1);
    assert.strictEqual(globalThis.localStorage.getItem(JOURNAL_KEY), null);
    assert.ok(store.conflicts().some((c) => c.field === 'rhyme' && c.incomingValue === 'X'));
  });

  await test('撤回未完成导入 → 恢复导入前整稿', async () => {
    globalThis.localStorage = new FakeStorage();
    let store = new PoetryStoreService();
    const beforeMark = store.draft().versions[0].marks[markKey('春眠不觉晓', 4)].rhyme;
    globalThis.localStorage.failingKeys.add(ARCHIVE_KEY);
    store.importPackage(xiaorhymePackage({ id: 'pkg-wd' }));
    store = new PoetryStoreService();
    await sleep(0);
    store.withdrawPendingImport();
    assert.strictEqual(store.pendingJournal(), null);
    assert.strictEqual(globalThis.localStorage.getItem(JOURNAL_KEY), null);
    assert.strictEqual(read(ARCHIVE_KEY)?.packages.length ?? 0, 0);
    assert.strictEqual(store.draft().versions[0].marks[markKey('春眠不觉晓', 4)].rhyme, beforeMark);
    assert.strictEqual(store.conflicts().length, 0);
  });

  await test('撤回已提交整包 → 草稿恢复备份、包与回执移除', () => {
    globalThis.localStorage = new FakeStorage();
    const store = new PoetryStoreService();
    store.updateTitle('导入前题名');
    store.importPackage(xiaorhymePackage({ id: 'pkg-done' }));
    assert.strictEqual(store.conflicts().length, 1);
    store.withdrawCommittedPackage('pkg-done');
    assert.strictEqual(store.pendingJournal(), null);
    assert.strictEqual(store.draft().title, '导入前题名');
    assert.strictEqual(store.conflicts().length, 0);
    const archive = read(ARCHIVE_KEY);
    assert.strictEqual(archive.packages.length, 0);
    assert.strictEqual(archive.receipts.length, 0);
  });

  await test('改字：句首插字后韵脚标注不串位', () => {
    globalThis.localStorage = new FakeStorage();
    const store = new PoetryStoreService();
    const inserted = '新' + store.activeVersion().text;
    store.updateText(inserted);
    const desc = store.lineDescriptors();
    assert.strictEqual(store.activeVersion().marks[markKey(desc[0].id, 5)]?.rhyme, 'A');
    assert.strictEqual(store.activeVersion().marks[markKey(desc[0].id, 4)], undefined);
  });

  await test('重复导入同一归档包被拒绝', () => {
    globalThis.localStorage = new FakeStorage();
    const store = new PoetryStoreService();
    store.archiveCurrentDraft();
    const second = store.importPackage(read(ARCHIVE_KEY).packages[0]);
    assert.strictEqual(second.ok, false);
  });

  console.log(`\n全部 ${passed} 项 store 事务验证通过。`);
}

main().catch((error) => { console.error(error); process.exit(1); });
