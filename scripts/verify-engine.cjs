/* 纯逻辑行为验证（node 运行，非 karma 套件）：两仓迁移核心算法 */
const assert = require('assert');
const {
  describeLines,
  alignPositions,
  alignLineIndices,
  mergeVersionMarks,
  migrateMarksForTextChange,
  migrateAntithesis,
  markKey,
  normalizeLine,
} = require('./_verify_out/services/collation-engine.js');

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

const m = (tone, rhyme = '', pauseAfter = false, basis = '', note = '') => ({ tone, rhyme, pauseAfter, basis, note });

// 1. 行身份：标点不敏感、重复句消歧
test('行身份 = 规范化句文，重复句带序号', () => {
  const d = describeLines('春眠不觉晓，\n春眠不觉晓。\n处处闻啼鸟。');
  assert.strictEqual(d[0].id, '春眠不觉晓');
  assert.strictEqual(d[1].id, '春眠不觉晓#2');
  assert.strictEqual(d[2].id, '处处闻啼鸟');
});

// 2. 行内 LCS：在句首改字，后面的标注不串位
test('句首插字后字位对齐迁移（原“晓”的韵脚标迁移到新字位）', () => {
  const oldText = '春眠不觉晓，';
  const newText = '新春眠不觉晓，'; // 句首插一“新”字
  const descOld = describeLines(oldText)[0];
  const oldMarks = { [markKey(descOld.id, 4)]: m('平', 'A', false, '平水韵', '晓为韵脚') };
  const { marks, dropped } = migrateMarksForTextChange(oldText, newText, oldMarks);
  const descNew = describeLines(newText)[0];
  assert.deepStrictEqual(marks[markKey(descNew.id, 5)], m('平', 'A', false, '平水韵', '晓为韵脚'));
  assert.strictEqual(dropped, 0);
});

// 3. 改字（异文替换）：公共字标注保留，被替换字标注丢弃
test('异文替换一字，公共字标注保留、被删字计入 dropped', () => {
  const oldText = '处处闻啼鸟。';
  const newText = '处处闻鸣鸟。'; // 啼 -> 鸣
  const descOld = describeLines(oldText)[0];
  const oldMarks = {
    [markKey(descOld.id, 3)]: m('平', '', false, '依据A', '啼字注'),
    [markKey(descOld.id, 4)]: m('平', 'A'),
  };
  const { marks, dropped } = migrateMarksForTextChange(oldText, newText, oldMarks);
  const descNew = describeLines(newText)[0];
  assert.strictEqual(dropped, 1); // “啼”位的标注
  assert.deepStrictEqual(marks[markKey(descNew.id, 4)], m('平', 'A'));
  assert.strictEqual(marks[markKey(descNew.id, 3)], undefined);
});

// 4. 行顺序调整：标注随行迁移
test('整句换序，标注跟着行身份走', () => {
  const oldText = '春眠不觉晓，\n处处闻啼鸟。';
  const newText = '处处闻啼鸟，\n春眠不觉晓。';
  const [o0, o1] = describeLines(oldText);
  const oldMarks = {
    [markKey(o0.id, 4)]: m('平', 'A'),
    [markKey(o1.id, 4)]: m('仄', 'B'),
  };
  const { marks } = migrateMarksForTextChange(oldText, newText, oldMarks);
  const [n0, n1] = describeLines(newText);
  assert.deepStrictEqual(marks[markKey(n0.id, 4)], m('仄', 'B'));
  assert.deepStrictEqual(marks[markKey(n1.id, 4)], m('平', 'A'));
});

// 5. 行对齐：相似度匹配异文行
test('异文行按 LCS 相似度匹配', () => {
  const a = describeLines('夜来风雨声，');
  const b = describeLines('夜来风月声，');
  const map = alignLineIndices(a, b);
  assert.strictEqual(map.get(0), 0);
});

// 6. 合并：不同字段自动合并
test('不同字段自动合并（稿有平仄、包有韵组 → 合并）', () => {
  const draft = {
    id: 'd', name: '稿', source: 's', createdAt: '', text: '春眠不觉晓，',
    marks: { [markKey('春眠不觉晓', 4)]: m('仄') }, antithesisPairs: [],
  };
  const incoming = {
    id: 'i', name: '本', source: 's', createdAt: '', text: '春眠不觉晓，',
    marks: { [markKey('春眠不觉晓', 4)]: m('?', 'A', false, '平水韵') }, antithesisPairs: [],
  };
  const plan = mergeVersionMarks(draft, incoming, 'pkg-1', '宋本');
  const merged = plan.marks[markKey('春眠不觉晓', 4)];
  assert.strictEqual(merged.tone, '仄');
  assert.strictEqual(merged.rhyme, 'A');
  assert.strictEqual(merged.basis, '平水韵');
  assert.strictEqual(plan.conflicts.length, 0);
});

// 7. 合并：同字段冲突挂起，不覆盖
test('同一字段双方非空且不一致 → 冲突，稿方值保留', () => {
  const draft = {
    id: 'd', name: '稿', source: 's', createdAt: '', text: '春眠不觉晓，',
    marks: { [markKey('春眠不觉晓', 4)]: m('仄', 'A') }, antithesisPairs: [],
  };
  const incoming = {
    id: 'i', name: '本', source: 's', createdAt: '', text: '春眠不觉晓，',
    marks: { [markKey('春眠不觉晓', 4)]: m('平', 'B') }, antithesisPairs: [],
  };
  const plan = mergeVersionMarks(draft, incoming, 'pkg-1', '宋本');
  assert.strictEqual(plan.conflicts.length, 2);
  const fields = plan.conflicts.map((c) => c.field).sort();
  assert.deepStrictEqual(fields, ['rhyme', 'tone']);
  assert.strictEqual(plan.marks[markKey('春眠不觉晓', 4)].tone, '仄');
  assert.strictEqual(plan.marks[markKey('春眠不觉晓', 4)].rhyme, 'A');
});

// 8. 导入异文包：标注随行随字迁入
test('导入异文版本（句中换字），公共字标注按 LCS 迁入', () => {
  const draft = {
    id: 'd', name: '稿', source: '', createdAt: '', text: '春眠不觉晓，\n处处闻啼鸟。',
    marks: {}, antithesisPairs: [],
  };
  const incoming = {
    id: 'i', name: '本', source: '', createdAt: '',
    text: '春眠不觉晓，\n处处闻鸣鸟。',
    marks: { [markKey('春眠不觉晓', 4)]: m('平', 'A') },
    antithesisPairs: [],
  };
  const plan = mergeVersionMarks(draft, incoming, 'pkg', '包');
  assert.strictEqual(plan.matchedLines, 2);
  assert.deepStrictEqual(plan.marks[markKey('春眠不觉晓', 4)], m('平', 'A'));
});

// 9. 匹配不上的行 → 孤儿标注
test('包中多出的整行，标注进孤儿清单不丢弃', () => {
  const draft = { id: 'd', name: '稿', source: '', createdAt: '', text: '春眠不觉晓，', marks: {}, antithesisPairs: [] };
  const incoming = {
    id: 'i', name: '本', source: '', createdAt: '',
    text: '春眠不觉晓，\n花落知多少。',
    marks: { [markKey('花落知多少', 4)]: m('平', 'A') },
    antithesisPairs: [],
  };
  const plan = mergeVersionMarks(draft, incoming, 'pkg', '包');
  assert.strictEqual(plan.orphans.length, 1);
  assert.strictEqual(plan.orphans[0].normalized, '花落知多少');
});

// 10. 对仗随行迁移
test('对仗关系随整句换序迁移', () => {
  const pairs = [{ id: 'p', leftLine: 0, rightLine: 1, note: '' }];
  const moved = migrateAntithesis('春眠不觉晓，\n处处闻啼鸟。', '处处闻啼鸟，\n春眠不觉晓。', pairs);
  assert.strictEqual(moved[0].leftLine, 1);
  assert.strictEqual(moved[0].rightLine, 0);
});

// 11. 标点规范化
test('标点与空白不参与规范化', () => {
  assert.strictEqual(normalizeLine(' 春眠，不觉 晓。'), '春眠不觉晓');
});

console.log(`\n全部 ${passed} 项引擎行为验证通过。`);
