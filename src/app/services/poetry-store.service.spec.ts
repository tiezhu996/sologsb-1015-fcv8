import { TestBed } from '@angular/core/testing';
import { PoetryStoreService } from './poetry-store.service';
import type { CharacterMark, PackageVersion } from '../models/poem.models';

const mark = (partial: Partial<CharacterMark>): CharacterMark => ({
  tone: '?',
  rhyme: '',
  pauseAfter: false,
  basis: '',
  note: '',
  ...partial,
});

describe('PoetryStoreService', () => {
  beforeEach(() => {
    localStorage.clear();
    TestBed.resetTestingModule();
  });

  function createStore(): PoetryStoreService {
    return TestBed.runInInjectionContext(() => new PoetryStoreService());
  }

  describe('两仓状态所有权', () => {
    it('校勘稿可编辑，历史底稿仓不被编辑改写', () => {
      const store = createStore();
      store.archiveSnapshot();
      const before = JSON.stringify(store.packages()[0]);
      store.updateTitle('全新篇名');
      store.setMark({ tone: '仄' });
      const after = JSON.stringify(store.packages()[0]);
      expect(after).toBe(before);
      expect(store.workspace().title).toBe('全新篇名');
    });

    it('归档只追加到底稿仓', () => {
      const store = createStore();
      expect(store.packages().length).toBe(0);
      store.archiveSnapshot();
      expect(store.packages().length).toBe(1);
      expect(store.packages()[0].status).toBe('applied');
    });
  });

  describe('改字后标注随行迁移', () => {
    it('编辑文本不按字符位置覆盖，已有标注跟随同一字', () => {
      const store = createStore();
      store.selectCell(1, 4);
      store.setMark({ tone: '仄', rhyme: 'B' });

      // “处处闻啼鸟”改为“忽闻啼鸟处”
      const text = store.activeVersion().lines.map((line) => line.text);
      text[1] = '忽闻啼鸟处。';
      store.updateText(text.join('\n'));

      const changed = store.activeVersion().lines[1];
      expect(changed.marks[3]).toEqual(jasmine.objectContaining({ tone: '仄', rhyme: 'B' }));
      expect(changed.marks[4]).toBeUndefined();
    });
  });

  describe('导入合并', () => {
    const importPayload = (): { label: string; source: string; note: string; versions: PackageVersion[] } => {
      return {
        label: '外部校勘包',
        source: '《宋蜀刻本》',
        note: '',
        versions: [
          {
            name: '通行本 · 孟浩然集',
            source: '《孟浩然诗集笺注》',
            lines: [
              { lineId: 'line-version-main-0', text: '春眠不觉晓，', marks: { 0: mark({ tone: '仄', basis: '广韵' }) } },
              {
                lineId: 'line-version-main-1',
                text: '处处闻啼鸟。',
                marks: {
                  2: mark({ tone: '平', note: '归档批注' }),
                  4: mark({ tone: '仄', rhyme: 'C' }),
                },
              },
            ],
          },
        ],
      };
    };

    it('不同字段自动合并，不覆盖已有字段', () => {
      const store = createStore();
      store.selectCell(0, 0);
      store.setMark({ note: '人工批注' });
      store.importPackage(importPayload());

      const line0 = store.activeVersion().lines[0];
      const cell0 = line0.marks[0];
      expect(cell0.tone).toBe('仄');
      expect(cell0.basis).toBe('广韵');
      expect(cell0.note).toBe('人工批注'); // 同字段人已有值：空字段自动填入，已有字段不动
      expect(store.pendingTransaction()).toBeNull();
    });

    it('同一字段双方都有且不一致时产生冲突，交人裁决', () => {
      const store = createStore();
      store.selectCell(1, 4);
      store.setMark({ rhyme: 'A' });
      store.importPackage(importPayload());

      expect(store.conflicts().length).toBe(1);
      const conflict = store.conflicts()[0];
      expect(conflict.field).toBe('rhyme');
      expect(conflict.incomingValue).toBe('C');
      expect(conflict.currentValue).toBe('A');
      // 裁决前不覆盖
      expect(store.activeVersion().lines[1].marks[4].rhyme).toBe('A');

      store.resolveConflict(conflict.id, 'incoming');
      expect(store.conflicts().length).toBe(0);
      expect(store.activeVersion().lines[1].marks[4].rhyme).toBe('C');
    });

    it('归档标注按字符对齐随字迁移，而非按位置覆盖', () => {
      const store = createStore();
      // 校勘稿第二句已改写
      const text = store.activeVersion().lines.map((line) => line.text);
      text[1] = '忽闻啼鸟处。';
      store.updateText(text.join('\n'));

      const payload = importPayload();
      store.importPackage(payload);

      // 归档中“闻”在第2位且带批注；校勘稿中“闻”在第1位
      const changed = store.activeVersion().lines[1];
      expect(changed.marks[1]).toEqual(jasmine.objectContaining({ note: '归档批注' }));
    });

    it('归档包文字不覆盖校勘稿文字', () => {
      const store = createStore();
      const text = store.activeVersion().lines.map((line) => line.text);
      text[0] = '春眠不觉晓啊，';
      store.updateText(text.join('\n'));
      store.importPackage(importPayload());
      expect(store.activeVersion().lines[0].text).toBe('春眠不觉晓啊，');
    });
  });

  describe('事务检查点与撤回', () => {
    const payload = () => ({
      label: '导入',
      source: 's',
      note: '',
      versions: [
        {
          name: '新版本',
          source: '另一来源',
          lines: [{ text: '归档新增句。', marks: { 0: mark({ tone: '平', basis: '韵书' }) } }],
        },
      ] as PackageVersion[],
    });

    it('写入失败后留下检查点，重试可从检查点续上且不留半套', () => {
      const store = createStore();
      const original = Storage.prototype.setItem;
      let failDraft = true;
      spyOn(Storage.prototype, 'setItem').and.callFake(function (this: Storage, key: string, value: string) {
        if (failDraft && key === 'sologsb-1015-poetry-draft-v2') throw new Error('write failed');
        return original.call(this, key, value);
      });

      // 首次导入：归档仓已写，校勘稿写入失败
      expect(() =>
        store.importPackage({
          label: '导入',
          source: 's',
          note: '',
          versions: [{ name: '断点版本', source: '断点来源', lines: [{ text: '断点新增句。' }] }],
        }),
      ).not.toThrow();
      let txn = store.pendingTransaction();
      expect(txn?.phase).toBe('archive-written');
      expect(store.workspace().versions.some((version) => version.name === '断点版本')).toBeFalse();

      // 解除故障并重试：从检查点续上，完成后检查点清除
      failDraft = false;
      store.resumeImport();
      txn = store.pendingTransaction();
      expect(txn).toBeNull();
      expect(store.workspace().versions.some((version) => version.name === '断点版本')).toBeTrue();
      expect(JSON.parse(localStorage.getItem('sologsb-1015-poetry-archive-v2') ?? '{}').packages.length).toBe(1);
    });

    it('整包撤回移除该包带来的版本与字段，归档包标记 withdrawn', () => {
      const store = createStore();
      const txn = store.importPackage(payload());
      const packageId = txn.packageId;
      expect(store.workspace().versions.some((version) => version.id.startsWith(`imp-${packageId}`))).toBeTrue();

      store.withdrawPackage(packageId);
      expect(store.workspace().versions.some((version) => version.id.startsWith(`imp-${packageId}`))).toBeFalse();
      const pkg = store.packages().find((item) => item.id === packageId);
      expect(pkg?.status).toBe('withdrawn');
      expect(store.pendingTransaction()).toBeNull();
    });

    it('撤回自动合并字段时保留人工内容', () => {
      const store = createStore();
      store.selectCell(0, 0);
      store.setMark({ note: '我的批注' });
      const txn = store.importPackage({
        label: 'p',
        source: 'src',
        note: '',
        versions: [
          {
            name: store.activeVersion().name,
            source: store.activeVersion().source,
            lines: [{ lineId: store.activeVersion().lines[0].lineId, text: store.activeVersion().lines[0].text, marks: { 0: mark({ tone: '仄' }) } }],
          },
        ],
      });
      store.withdrawPackage(txn.packageId);
      const cell = store.activeVersion().lines[0].marks[0];
      expect(cell.note).toBe('我的批注');
    });

    it('archive-written 阶段重启后自动从检查点续上', () => {
      const store1 = createStore();
      // 先正常导入拿到包结构，然后手工制造 archive-written 检查点
      const draftBefore = localStorage.getItem('sologsb-1015-poetry-draft-v2');
      const pkg = {
        id: 'pkg-import-testcheckpoint',
        kind: 'import' as const,
        label: '断点包',
        source: 'x',
        note: '',
        createdAt: new Date().toISOString(),
        status: 'applied' as const,
        versions: [{ name: '断点版本', source: '断点来源', lines: [{ text: '断点新增句。' }] }],
      };
      // 归档仓先有包
      const archive = { schema: 2 as const, packages: [pkg] };
      localStorage.setItem('sologsb-1015-poetry-archive-v2', JSON.stringify(archive));
      localStorage.setItem('sologsb-1015-poetry-draft-v2', draftBefore ?? '');
      localStorage.setItem(
        'sologsb-1015-poetry-import-txn-v2',
        JSON.stringify({
          id: 'txn-1',
          packageId: pkg.id,
          pkg,
          plan: {
            versionOps: [{ type: 'addVersion', versionId: 'imp-pkg-import-testcheckpoint-0', name: '断点版本', source: '断点来源' }],
            lineOps: [{ type: 'addLine', versionId: 'imp-pkg-import-testcheckpoint-0', index: 0, lineId: 'line-pkg-import-testcheckpoint-0-0', text: '断点新增句。' }],
            fieldOps: [],
            pairOps: [],
            conflicts: [],
          },
          phase: 'archive-written',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          error: '',
        }),
      );

      const store2 = createStore();
      expect(store2.pendingTransaction()).toBeNull();
      expect(store2.workspace().versions.some((version) => version.name === '断点版本')).toBeTrue();
    });
  });

  describe('首次打开迁移', () => {
    it('旧 v1 单仓数据原子迁入两仓，原内容不丢且旧键移除', () => {
      const legacy = {
        title: '旧诗',
        author: '佚名',
        templateId: 'wuyan-zeqi',
        activeVersionId: 'v-old',
        updatedAt: new Date().toISOString(),
        versions: [
          {
            id: 'v-old',
            name: '旧版本',
            source: '旧书',
            createdAt: new Date().toISOString(),
            text: '春眠不觉晓，\n处处闻啼鸟。',
            marks: { '1:4': mark({ tone: '仄', rhyme: 'A' }) },
            antithesisPairs: [],
          },
        ],
      };
      localStorage.setItem('sologsb-1015-poetry-workspace-v1', JSON.stringify(legacy));

      const store = createStore();
      expect(store.workspace().title).toBe('旧诗');
      expect(store.activeVersion().lines[1].marks[4].rhyme).toBe('A');
      expect(store.packages()[0].kind).toBe('migration');
      expect(store.packages()[0].legacyRaw).toContain('旧诗');
      expect(localStorage.getItem('sologsb-1015-poetry-workspace-v1')).toBeNull();
    });

    it('两仓写入失败时旧键保留，下次打开可重跑迁移', () => {
      const legacy = {
        title: '旧诗',
        author: '佚名',
        templateId: 'wuyan-zeqi',
        activeVersionId: 'v-old',
        versions: [
          {
            id: 'v-old',
            name: '旧版本',
            source: '旧书',
            createdAt: new Date().toISOString(),
            text: '春眠不觉晓，',
            marks: {},
            antithesisPairs: [],
          },
        ],
      };
      localStorage.setItem('sologsb-1015-poetry-workspace-v1', JSON.stringify(legacy));
      // 归档仓写入抛错：迁移无法完成，旧键必须保留
      const original = Storage.prototype.setItem;
      spyOn(Storage.prototype, 'setItem').and.callFake(function (this: Storage, key: string, value: string) {
        if (key === 'sologsb-1015-poetry-archive-v2') throw new Error('quota exceeded');
        return original.call(this, key, value);
      });
      expect(() => createStore()).toThrowError('quota exceeded');
      expect(localStorage.getItem('sologsb-1015-poetry-workspace-v1')).toContain('旧诗');
    });
  });
});