import { computed, Injectable, signal } from '@angular/core';
import type {
  AntithesisPair,
  AnalysisCell,
  AnalysisLine,
  ArchivePackage,
  ArchiveReceipt,
  ArchiveState,
  CharacterMark,
  CharDiff,
  ConflictRecord,
  DraftState,
  ImportJournal,
  MarkTone,
  MeterTemplate,
  OrphanMark,
  PoemIssue,
  PoemVersion,
  StoredPlan,
  StoredPlanPair,
  Tone,
} from '../models/poem.models';
import { MARK_FIELDS, MARK_FIELD_LABELS } from '../models/poem.models';
import { StorageAdapter } from './storage.adapter';
import {
  conflictFingerprint,
  describeLines,
  fieldIsMeaningful,
  markKey,
  mergeVersionMarks,
  migrateAntithesis,
  migrateMarksForTextChange,
} from './collation-engine';

export const METER_TEMPLATES: MeterTemplate[] = [
  {
    id: 'wuyan-zeqi',
    name: '五言绝句 · 仄起首句不入韵',
    summary: '四句，每句五字；二、四句押韵',
    lineCount: 4,
    lineLength: 5,
    pattern: ['仄', '仄', '中', '平', '仄', '中', '平', '中', '仄', '仄', '中', '平', '中', '仄', '中', '平', '中', '仄', '中', '平'],
    rhymeLines: [1, 3],
  },
  {
    id: 'wuyan-pingqi',
    name: '五言绝句 · 平起首句入韵',
    summary: '四句，每句五字；一、二、四句押韵',
    lineCount: 4,
    lineLength: 5,
    pattern: ['中', '平', '中', '仄', '平', '仄', '仄', '中', '平', '仄', '中', '平', '中', '仄', '仄', '中', '平', '仄', '中', '平'],
    rhymeLines: [0, 1, 3],
  },
  {
    id: 'qiyan-zeqi',
    name: '七言绝句 · 仄起首句入韵',
    summary: '四句，每句七字；一、二、四句押韵',
    lineCount: 4,
    lineLength: 7,
    pattern: ['仄', '仄', '中', '平', '中', '仄', '平', '中', '平', '中', '仄', '仄', '中', '平', '中', '仄', '中', '平', '中', '仄', '仄', '中', '平', '中', '仄', '中', '平', '中'],
    rhymeLines: [0, 1, 3],
  },
  {
    id: 'qiyan-pingqi',
    name: '七言绝句 · 平起首句不入韵',
    summary: '四句，每句七字；二、四句押韵',
    lineCount: 4,
    lineLength: 7,
    pattern: ['中', '平', '中', '仄', '仄', '中', '平', '仄', '仄', '中', '平', '平', '仄', '仄', '中', '平', '中', '仄', '中', '平', '仄', '仄', '中', '平', '中', '仄', '仄', '中', '平'],
    rhymeLines: [1, 3],
  },
];

const PUNCTUATION = new Set(['，', '。', '！', '？', '；', '：', '、', ' ', '\t']);
const TONE_DICTIONARY: Record<string, Tone> = {
  春: '平', 眠: '平', 不: '仄', 觉: '仄', 晓: '仄', 处: '仄', 闻: '平', 啼: '平', 鸟: '仄',
  夜: '仄', 来: '平', 风: '平', 雨: '仄', 声: '平', 花: '平', 落: '仄', 知: '平', 多: '平', 少: '仄',
  国: '仄', 破: '仄', 山: '平', 河: '平', 在: '仄', 城: '平', 深: '平', 木: '仄', 草: '仄', 独: '仄',
  明: '平', 月: '仄', 高: '平', 天: '平', 故: '仄', 乡: '平', 万: '仄', 里: '仄', 江: '平', 船: '平',
};

const clone = <T>(value: T): T => structuredClone(value);
const uid = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

function defaultMark(): CharacterMark {
  return { tone: '?', rhyme: '', pauseAfter: false, basis: '', note: '' };
}

/** 旧版（v1）标注键 `行号:字位` → 新版行身份键 `${lineId}:字位`（同文重复句按行号各自归位）。 */
function reindexMarks(text: string, marks: Record<string, CharacterMark>): Record<string, CharacterMark> {
  const descriptors = describeLines(text);
  const result: Record<string, CharacterMark> = {};
  Object.entries(marks).forEach(([oldKey, mark]) => {
    const sep = oldKey.lastIndexOf(':');
    const line = Number(oldKey.slice(0, sep));
    const position = Number(oldKey.slice(sep + 1));
    const descriptor = descriptors[line];
    if (!descriptor || !Number.isFinite(position)) return;
    result[markKey(descriptor.id, position)] = mark;
  });
  return result;
}
function initialDraft(): DraftState {
  const now = new Date().toISOString();
  const spring = '春眠不觉晓，\n处处闻啼鸟。\n夜来风雨声，\n花落知多少。';
  const marksByLine: Record<number, CharacterMark>[] = [{}, {}, {}, {}];
  const rhymes = ['晓', '鸟', '声', '少'];
  rhymes.forEach((char, line) => {
    marksByLine[line][4] = { tone: '平', rhyme: 'A', pauseAfter: false, basis: '《平水韵》上声十七筱', note: `${char} 为韵脚` };
  });
  marksByLine[0][2] = { tone: '平', rhyme: '', pauseAfter: false, basis: '平水韵', note: '句中平声' };
  marksByLine[1][2] = { tone: '平', rhyme: '', pauseAfter: false, basis: '平水韵', note: '' };
  marksByLine[2][2] = { tone: '平', rhyme: '', pauseAfter: false, basis: '平水韵', note: '' };

  const buildVersion = (id: string, name: string, source: string, text: string): PoemVersion => {
    const descriptors = describeLines(text);
    const marks: Record<string, CharacterMark> = {};
    descriptors.forEach((descriptor, line) => {
      Object.entries(marksByLine[line]).forEach(([position, mark]) => {
        marks[markKey(descriptor.id, Number(position))] = clone(mark);
      });
    });
    return { id, name, source, createdAt: now, text, marks, antithesisPairs: [] };
  };

  const topVersion = buildVersion('version-main', '通行本 · 孟浩然集', '《孟浩然诗集笺注》', spring);
  const variant = buildVersion('version-song', '宋刻本异文', '宋蜀刻本', spring);

  return {
    schema: 2,
    title: '春晓',
    author: '孟浩然',
    templateId: 'wuyan-zeqi',
    versions: [topVersion, variant],
    activeVersionId: topVersion.id,
    conflicts: [],
    orphans: [],
    updatedAt: now,
  };
}

const emptyArchive = (): ArchiveState => ({ schema: 1, packages: [], receipts: [] });

@Injectable({ providedIn: 'root' })
export class PoetryStoreService {
  private readonly storage = new StorageAdapter();
  private readonly booted = this.bootstrap();

  readonly draft = signal<DraftState>(this.booted.draft);
  readonly archive = signal<ArchiveState>(this.booted.archive);
  /** 兼容既有模板：workspace 即当前校勘稿仓。 */
  readonly workspace = this.draft.asReadonly();

  readonly selectedLine = signal(0);
  readonly selectedPosition = signal(4);
  readonly baselineVersionId = signal<string>('');
  readonly currentDiffIndex = signal(0);
  readonly toast = signal('');
  readonly undoCount = signal(0);
  readonly redoCount = signal(0);
  /** 中断的导入/撤回事务；非空时界面提供「继续」与「撤回整包」。 */
  readonly pendingJournal = signal<ImportJournal | null>(this.booted.journal);

  constructor() {
    if (this.booted.toast) queueMicrotask(() => this.toast.set(this.booted.toast!));
  }

  private undoStack: DraftState[] = [];
  private redoStack: DraftState[] = [];

  readonly activeVersion = computed(() => {
    const state = this.draft();
    return state.versions.find((version) => version.id === state.activeVersionId) ?? state.versions[0];
  });

  readonly template = computed(() => METER_TEMPLATES.find((item) => item.id === this.draft().templateId) ?? METER_TEMPLATES[0]);
  readonly lineDescriptors = computed(() => describeLines(this.activeVersion().text));
  readonly lines = computed(() => this.activeVersion().text.split('\n'));

  readonly conflicts = computed(() => this.draft().conflicts.filter((item) => !item.resolved));
  readonly resolvedConflicts = computed(() => this.draft().conflicts.filter((item) => item.resolved));
  readonly orphans = computed(() => this.draft().orphans);
  readonly archivedPackages = computed(() => this.archive().packages);

  readonly analysis = computed<AnalysisLine[]>(() => {
    const version = this.activeVersion();
    const template = this.template();
    const descriptors = this.lineDescriptors();
    return this.lines().map((line, lineIndex) => {
      const chars = Array.from(line).filter((char) => !PUNCTUATION.has(char));
      const lineId = descriptors[lineIndex]?.id ?? '';
      const cells: AnalysisCell[] = chars.map((char, position) => {
        const mark = version.marks[markKey(lineId, position)] ?? defaultMark();
        const expected = template.pattern[lineIndex * template.lineLength + position] ?? '中';
        const actual = mark.tone === '?' ? (TONE_DICTIONARY[char] ?? '?') : mark.tone;
        let status: AnalysisCell['status'] = 'neutral';
        let message = '标点或不计律位置';
        if (PUNCTUATION.has(char)) {
          status = 'neutral';
        } else if (actual === '?') {
          status = 'unknown';
          message = '尚未标注平仄';
        } else if (expected === '中') {
          status = 'correct';
          message = '可平可仄';
        } else if (actual === expected) {
          status = 'correct';
          message = '合律';
        } else if (this.isAcceptableVariant(template, position)) {
          status = 'variant';
          message = '一三五位置的可接受变体';
        } else {
          status = 'error';
          message = `此处应为${expected}声`;
        }
        return { char, position, expected, actual, status, message, mark };
      });
      const rhymeChars = template.rhymeLines.includes(lineIndex) ? cells.slice(-1).map((cell) => cell.char) : [];
      return {
        index: lineIndex,
        lineId,
        cells,
        rhymeChars,
        errors: cells.filter((cell) => cell.status === 'error').length,
        variants: cells.filter((cell) => cell.status === 'variant').length,
      };
    });
  });

  readonly issues = computed<PoemIssue[]>(() => {
    const analysis = this.analysis();
    const version = this.activeVersion();
    const template = this.template();
    const issues: PoemIssue[] = [];
    analysis.forEach((line) => {
      line.cells.filter((cell) => cell.status === 'error').forEach((cell) => {
        issues.push({
          id: uid('issue'),
          level: 'error',
          title: '出律位置',
          detail: `第 ${line.index + 1} 句“${cell.char}”：${cell.message}`,
          line: line.index,
          position: cell.position,
        });
      });
      if (line.cells.some((cell) => cell.status === 'unknown')) {
        issues.push({ id: uid('issue'), level: 'warning', title: '存在未标注字', detail: `第 ${line.index + 1} 句仍有平仄未确认。`, line: line.index });
      }
    });
    const rhymeCells = template.rhymeLines.map((line) => analysis[line]?.cells.at(-1)).filter(Boolean);
    const rhymeGroups = new Map<string, string[]>();
    rhymeCells.forEach((cell) => {
      if (!cell?.mark.rhyme) {
        issues.push({ id: uid('issue'), level: 'warning', title: '韵脚缺少韵部', detail: `韵句末字尚未指定韵部。` });
        return;
      }
      rhymeGroups.set(cell.mark.rhyme, [...(rhymeGroups.get(cell.mark.rhyme) ?? []), cell.char]);
    });
    rhymeGroups.forEach((chars, rhyme) => {
      const duplicate = chars.find((char, index) => chars.indexOf(char) !== index);
      if (duplicate) issues.push({ id: uid('issue'), level: 'warning', title: '重复用韵', detail: `韵部 ${rhyme} 重复使用末字“${duplicate}”。` });
    });
    if (version.antithesisPairs.length === 0) {
      issues.push({ id: 'antithesis-empty', level: 'info', title: '尚未标记对仗', detail: '可在检视器中把两句建立对仗关系。' });
    }
    this.conflicts().forEach((conflict) => {
      issues.push({
        id: `conflict-issue-${conflict.id}`,
        level: 'warning',
        title: `待裁决异文 · ${MARK_FIELD_LABELS[conflict.field]}`,
        detail: `第 ${conflict.draftLine + 1} 句“${conflict.char}”：校勘稿「${conflict.draftValue}」与归档包「${conflict.incomingValue}」不一致。`,
        line: conflict.draftLine,
        position: conflict.position,
      });
    });
    if (this.orphans().length) {
      issues.push({ id: 'orphan-issue', level: 'warning', title: '存在未安置标注', detail: `归档包中有 ${this.orphans().length} 条标注未能随行迁入，请在历史底稿页安置或放弃。` });
    }
    if (!issues.some((issue) => issue.level === 'error')) {
      issues.unshift({ id: 'meter-ok', level: 'info', title: '格律检查通过', detail: '当前未发现硬性出律，请继续核对可接受变体。' });
    }
    return issues;
  });

  readonly diff = computed<CharDiff[]>(() => {
    const left = this.draft().versions.find((version) => version.id === this.baselineVersionId());
    const right = this.activeVersion();
    if (!left || left.id === right.id) return [];
    const leftChars = Array.from(left.text.replace(/\n/g, ''));
    const rightChars = Array.from(right.text.replace(/\n/g, ''));
    const size = Math.max(leftChars.length, rightChars.length);
    return Array.from({ length: size }, (_, index) => ({
      index,
      left: leftChars[index] ?? '',
      right: rightChars[index] ?? '',
      changed: leftChars[index] !== rightChars[index],
    }));
  });

  readonly differences = computed(() => this.diff().filter((item) => item.changed).map((item) => item.index));
  readonly baselineVersion = computed(() => this.draft().versions.find((version) => version.id === this.baselineVersionId()));

  // ---------------------------------------------------------------- 常规编辑

  selectVersion(id: string): void {
    this.draft.update((state) => ({ ...state, activeVersionId: id }));
    this.persistDraft();
  }

  selectCell(line: number, position: number): void {
    this.selectedLine.set(line);
    this.selectedPosition.set(position);
  }

  setTemplate(id: string): void {
    this.commit((draft) => {
      draft.templateId = id;
    });
  }

  updateText(text: string): void {
    // 改字不再按字符位置覆盖：标注按行身份 + LCS 随行随字迁移。
    this.commit((draft) => {
      const version = this.versionIn(draft);
      const migration = migrateMarksForTextChange(version.text, text, version.marks);
      version.marks = migration.marks;
      version.antithesisPairs = migrateAntithesis(version.text, text, version.antithesisPairs);
      version.text = text;
      if (migration.dropped > 0) {
        queueMicrotask(() => this.toast.set(`改字后 ${migration.dropped} 条标注随原字移除，其余已随行迁移`));
      }
    });
  }

  updateTitle(title: string): void {
    this.commit((draft) => {
      draft.title = title;
    });
  }

  updateVersionSource(source: string): void {
    this.commit((draft) => {
      this.versionIn(draft).source = source;
    });
  }

  setMark(patch: Partial<CharacterMark>): void {
    this.commit((draft) => {
      const version = this.versionIn(draft);
      const lineId = describeLines(version.text)[this.selectedLine()]?.id;
      if (!lineId) return;
      const id = markKey(lineId, this.selectedPosition());
      version.marks[id] = { ...defaultMark(), ...version.marks[id], ...patch };
    });
  }

  cycleTone(): void {
    const cell = this.selectedCell();
    const next: Record<Tone, MarkTone | '?'> = { '?': '平', 平: '仄', 仄: '中', 中: '?' };
    this.setMark({ tone: next[cell?.actual ?? '?'] });
  }

  togglePause(): void {
    const cell = this.selectedCell();
    this.setMark({ pauseAfter: !(cell?.mark.pauseAfter ?? false) });
  }

  cycleRhyme(): void {
    const cell = this.selectedCell();
    const current = cell?.mark.rhyme ?? '';
    const next = current === '' ? 'A' : current === 'A' ? 'B' : current === 'B' ? 'C' : '';
    this.setMark({ rhyme: next });
  }

  addAntithesis(): void {
    const line = this.selectedLine();
    const other = line === 0 ? 1 : line - 1;
    this.commit((draft) => {
      const version = this.versionIn(draft);
      if (version.antithesisPairs.some((pair) => pair.leftLine === line && pair.rightLine === other)) return;
      version.antithesisPairs.push({ id: uid('pair'), leftLine: Math.min(line, other), rightLine: Math.max(line, other), note: '结构相对，词性相应。' });
    });
  }

  removeAntithesis(id: string): void {
    this.commit((draft) => {
      const version = this.versionIn(draft);
      version.antithesisPairs = version.antithesisPairs.filter((pair) => pair.id !== id);
    });
  }

  updateAntithesis(id: string, note: string): void {
    this.commit((draft) => {
      const pair = this.versionIn(draft).antithesisPairs.find((item) => item.id === id);
      if (pair) pair.note = note;
    });
  }

  /** 在当前校勘稿仓内另存一个可继续编辑的副本（不进入历史归档仓）。 */
  snapshot(): void {
    const active = clone(this.activeVersion());
    active.id = uid('version');
    active.name = `校勘稿 ${this.draft().versions.length}`;
    active.createdAt = new Date().toISOString();
    this.commit((draft) => {
      draft.versions.unshift(active);
      draft.activeVersionId = active.id;
    });
    this.toast.set('已在当前校勘稿内另存可编辑副本');
  }

  duplicateActiveAsBaseline(): void {
    this.baselineVersionId.set(this.activeVersion().id);
  }

  nextDifference(): void {
    const values = this.differences();
    if (!values.length) return;
    const current = values.findIndex((index) => index >= this.currentDiffIndex());
    this.currentDiffIndex.set(values[(current + 1) % values.length]);
  }

  previousDifference(): void {
    const values = this.differences();
    if (!values.length) return;
    const reverse = [...values].reverse();
    const current = reverse.findIndex((index) => index <= this.currentDiffIndex());
    this.currentDiffIndex.set(reverse[(current + 1) % reverse.length]);
  }

  undo(): void {
    const previous = this.undoStack.pop();
    if (!previous) return;
    this.redoStack.push(clone(this.draft()));
    this.draft.set(previous);
    this.undoCount.set(this.undoStack.length);
    this.redoCount.set(this.redoStack.length);
    this.persistDraft();
  }

  redo(): void {
    const next = this.redoStack.pop();
    if (!next) return;
    this.undoStack.push(clone(this.draft()));
    this.draft.set(next);
    this.undoCount.set(this.undoStack.length);
    this.redoCount.set(this.redoStack.length);
    this.persistDraft();
  }

  selectedCell(): AnalysisCell | undefined {
    return this.analysis()[this.selectedLine()]?.cells[this.selectedPosition()];
  }

  // ------------------------------------------------------------ 归档（只收包）

  /** 把当前校勘稿整体冻结为归档包，追加进历史底稿仓；校勘稿本身不动。 */
  archiveCurrentDraft(): void {
    const state = this.draft();
    const stamp = new Date();
    const activeName = state.versions.find((version) => version.id === state.activeVersionId)?.name ?? state.versions[0]?.name ?? '';
    const pkg: ArchivePackage = {
      id: uid('pkg'),
      name: `${state.title} · 历史底稿 ${stamp.toLocaleString('zh-CN', { hour12: false })}`,
      source: `校勘台归档 · ${activeName}`,
      archivedAt: stamp.toISOString(),
      title: state.title,
      author: state.author,
      templateId: state.templateId,
      versions: clone(state.versions),
    };
    const nextArchive = clone(this.archive());
    nextArchive.packages.unshift(pkg);
    const result = this.storage.writeArchive(nextArchive);
    if (!result.ok) {
      this.toast.set(`归档写入失败：${result.error}，请重试；当前校勘稿未受影响`);
      return;
    }
    this.archive.set(nextArchive);
    this.toast.set('已冻结为历史底稿归档包；校勘稿可继续编辑，底稿不会被改动');
  }

  downloadPackage(pkg: ArchivePackage): void {
    const payload = JSON.stringify({ format: 'poetry-archive-package', version: 1, ...pkg }, null, 2);
    const anchor = document.createElement('a');
    anchor.href = URL.createObjectURL(new Blob([payload], { type: 'application/json;charset=utf-8' }));
    anchor.download = `${pkg.name}.json`;
    anchor.click();
    URL.revokeObjectURL(anchor.href);
  }

  // ------------------------------------------------------------ 导入事务

  /**
   * 导入归档包：
   * 1. 按来源（版本名/出处）选定包内版本与当前稿目标版本，按上下文行身份对齐；
   * 2. 先落检查点 journal（含导入前整稿备份），再提交两仓；
   * 3. 不同字段自动合并，同字段冲突挂起待人裁决。
   * 返回是否提交成功；失败后可 retryPendingImport / withdrawPendingImport。
   */
  importPackage(raw: unknown): { ok: boolean; error?: string } {
    const parsed = this.parsePackage(raw);
    if (!parsed.ok) return { ok: false, error: parsed.error };
    const pkg = parsed.pkg!;

    if (this.archive().packages.some((item) => item.id === pkg.id)) {
      return { ok: false, error: '该归档包已在历史底稿仓中，不能重复导入。' };
    }

    const backup = clone(this.draft());
    const prepared = this.prepareImport(backup, pkg);

    const now = new Date().toISOString();
    const journal: ImportJournal = {
      phase: 'checkpoint',
      kind: 'import',
      package: pkg,
      receipt: prepared.receipt,
      plan: prepared.plan,
      startedAt: now,
      updatedAt: now,
      attempts: 1,
    };
    const journalResult = this.storage.writeJournal(journal);
    if (!journalResult.ok) {
      this.toast.set(`无法建立导入检查点：${journalResult.error}`);
      return { ok: false, error: journalResult.error };
    }
    this.pendingJournal.set(journal);
    return this.commitImport(journal);
  }

  /** 从检查点续做：依据导入前备份与归档包重新确定性地构建结果并重放提交。 */
  retryPendingImport(): void {
    const journal = this.pendingJournal();
    if (!journal) return;
    const next: ImportJournal = { ...journal, attempts: journal.attempts + 1, updatedAt: new Date().toISOString() };
    this.pendingJournal.set(next);
    this.storage.writeJournal(next);
    if (next.kind === 'import') {
      const result = this.commitImport(next);
      if (result.ok) this.toast.set('已从检查点续做，归档包导入完成');
      else this.toast.set(`续做仍未成功：${result.error}，可继续重试或撤回整包`);
    } else {
      const result = this.commitWithdraw(next);
      if (result.ok) this.toast.set('已从检查点续做，整包撤回完成');
      else this.toast.set(`续做仍未成功：${result.error}`);
    }
  }

  /** 撤回检查点中的未完成导入：恢复导入前整稿，不写入归档包，不留半套历史。 */
  withdrawPendingImport(): void {
    const journal = this.pendingJournal();
    if (!journal || journal.kind !== 'import' || !journal.receipt) return;
    const backup = journal.receipt.backup;
    const draftResult = this.storage.writeDraft(backup);
    if (!draftResult.ok) {
      const failed: ImportJournal = { ...journal, lastError: draftResult.error, updatedAt: new Date().toISOString() };
      this.storage.writeJournal(failed);
      this.pendingJournal.set(failed);
      this.toast.set(`撤回写入失败：${draftResult.error}，已保留检查点，可重试撤回`);
      return;
    }
    // 归档仓可能已在崩溃前写入（草稿成功 + 归档成功但未收尾）：仅当确实含该包时才清理。
    const currentArchive = this.archive();
    const needsCleanup =
      currentArchive.packages.some((item) => item.id === journal.package.id) ||
      currentArchive.receipts.some((item) => item.packageId === journal.package.id);
    if (needsCleanup) {
      const nextArchive = clone(currentArchive);
      nextArchive.packages = nextArchive.packages.filter((item) => item.id !== journal.package.id);
      nextArchive.receipts = nextArchive.receipts.filter((item) => item.packageId !== journal.package.id);
      const archiveResult = this.storage.writeArchive(nextArchive);
      if (!archiveResult.ok) {
        const failed = { ...journal, lastError: archiveResult.error, updatedAt: new Date().toISOString() };
        this.storage.writeJournal(failed);
        this.pendingJournal.set(failed);
        this.toast.set(`撤回归档仓失败：${archiveResult.error}，校勘稿已恢复，可再次重试撤回以清理底稿仓`);
        return;
      }
      this.archive.set(nextArchive);
    }
    this.draft.set(backup);
    this.storage.writeJournal(null);
    this.pendingJournal.set(null);
    this.undoStack = [];
    this.redoStack = [];
    this.undoCount.set(0);
    this.redoCount.set(0);
    this.toast.set('已撤回整包，当前校勘稿恢复到导入前状态');
  }

  /**
   * 撤回一个已经导入完成的归档包：依据回执中的导入前整稿备份原样恢复，
   * 同时把包与回执从归档仓移除。同样走检查点事务。
   */
  withdrawCommittedPackage(packageId: string): void {
    const archive = this.archive();
    const receipt = archive.receipts.find((item) => item.packageId === packageId);
    if (!receipt) {
      this.toast.set('未找到该包的导入回执，无法撤回（迁移归档的底稿不在此列）。');
      return;
    }
    const pkg = archive.packages.find((item) => item.id === packageId);
    if (!pkg) return;
    const now = new Date().toISOString();
    const journal: ImportJournal = {
      phase: 'checkpoint',
      kind: 'withdraw',
      package: pkg,
      receipt,
      startedAt: now,
      updatedAt: now,
      attempts: 1,
    };
    this.storage.writeJournal(journal);
    this.pendingJournal.set(journal);
    const result = this.commitWithdraw(journal);
    if (result.ok) this.toast.set('整包已撤回，校勘稿恢复至该包导入前，归档包一并移除');
  }

  private commitImport(journal: ImportJournal): { ok: boolean; error?: string } {
    if (!journal.receipt || !journal.plan) return { ok: false, error: '检查点缺少导入计划' };
    const backup = journal.receipt.backup;
    const prepared = this.prepareImport(backup, journal.package);

    // 先持久化后上信号：写失败时内存状态不变，检查点仍可干净重放。
    const draftResult = this.storage.writeDraft(prepared.nextDraft);
    if (!draftResult.ok) {
      const failed = { ...journal, lastError: draftResult.error, updatedAt: new Date().toISOString() };
      this.storage.writeJournal(failed);
      this.pendingJournal.set(failed);
      return { ok: false, error: draftResult.error };
    }
    const nextArchive = clone(this.archive());
    if (!nextArchive.packages.some((item) => item.id === journal.package.id)) {
      nextArchive.packages.unshift(journal.package);
    }
    if (!nextArchive.receipts.some((item) => item.packageId === journal.receipt!.packageId)) {
      nextArchive.receipts.unshift(prepared.receipt);
    }
    const archiveResult = this.storage.writeArchive(nextArchive);
    if (!archiveResult.ok) {
      const failed = { ...journal, lastError: archiveResult.error, updatedAt: new Date().toISOString() };
      this.storage.writeJournal(failed);
      this.pendingJournal.set(failed);
      return { ok: false, error: archiveResult.error };
    }

    const done: ImportJournal = { ...journal, phase: 'committed', updatedAt: new Date().toISOString(), lastError: undefined };
    this.storage.writeJournal(done);
    this.draft.set(prepared.nextDraft);
    this.archive.set(nextArchive);
    this.storage.writeJournal(null);
    this.pendingJournal.set(null);
    this.undoStack = [];
    this.redoStack = [];
    this.undoCount.set(0);
    this.redoCount.set(0);
    return { ok: true };
  }

  private commitWithdraw(journal: ImportJournal): { ok: boolean; error?: string } {
    if (!journal.receipt) return { ok: false, error: '检查点缺少回执备份' };
    const restored = clone(journal.receipt.backup);
    restored.pendingImport = undefined;
    const draftResult = this.storage.writeDraft(restored);
    if (!draftResult.ok) {
      const failed = { ...journal, lastError: draftResult.error, updatedAt: new Date().toISOString() };
      this.storage.writeJournal(failed);
      this.pendingJournal.set(failed);
      return { ok: false, error: draftResult.error };
    }
    const nextArchive = clone(this.archive());
    nextArchive.packages = nextArchive.packages.filter((item) => item.id !== journal.package.id);
    nextArchive.receipts = nextArchive.receipts.filter((item) => item.packageId !== journal.package.id);
    const archiveResult = this.storage.writeArchive(nextArchive);
    if (!archiveResult.ok) {
      const failed = { ...journal, lastError: archiveResult.error, updatedAt: new Date().toISOString() };
      this.storage.writeJournal(failed);
      this.pendingJournal.set(failed);
      return { ok: false, error: archiveResult.error };
    }
    const done: ImportJournal = { ...journal, phase: 'committed', updatedAt: new Date().toISOString(), lastError: undefined };
    this.storage.writeJournal(done);
    this.draft.set(restored);
    this.archive.set(nextArchive);
    this.storage.writeJournal(null);
    this.pendingJournal.set(null);
    return { ok: true };
  }

  private prepareImport(
    base: DraftState,
    pkg: ArchivePackage,
  ): { nextDraft: DraftState; receipt: ArchiveReceipt; plan: StoredPlan } {
    const nextDraft = clone(base);

    // 按来源（版本名/出处）为包内每个版本确定稿方目标版本：
    // 同名优先，其次同出处，再退化为当前活动版本；一个稿方版本只接收一次合并。
    const active = nextDraft.versions.find((version) => version.id === nextDraft.activeVersionId) ?? nextDraft.versions[0];
    const claimedTargets = new Set<string>();
    const pairs: { target: PoemVersion; incoming: PoemVersion }[] = [];
    pkg.versions.forEach((incoming) => {
      const byName = nextDraft.versions.find((version) => !claimedTargets.has(version.id) && version.name === incoming.name);
      const bySource = byName
        ?? nextDraft.versions.find((version) => !claimedTargets.has(version.id) && incoming.source && version.source === incoming.source);
      const target = bySource ?? (claimedTargets.has(active.id) ? undefined : active);
      if (!target) return;
      claimedTargets.add(target.id);
      pairs.push({ target, incoming });
    });

    const planPairs: StoredPlanPair[] = [];
    const allConflicts: ConflictRecord[] = [];
    const allOrphans: OrphanMark[] = [];
    let matchedLines = 0;
    let migratedMarks = 0;
    const known = new Set(nextDraft.conflicts.map((item) => conflictFingerprint(item)));

    pairs.forEach(({ target, incoming }) => {
      const result = mergeVersionMarks(target, incoming, pkg.id, pkg.name);
      target.marks = result.marks;
      matchedLines += result.matchedLines;
      migratedMarks += result.migratedMarks;
      result.conflicts.forEach((conflict) => {
        const fingerprint = conflictFingerprint(conflict);
        if (known.has(fingerprint)) return;
        known.add(fingerprint);
        allConflicts.push(conflict);
      });
      result.orphans.forEach((orphan) => allOrphans.push({ ...orphan, mark: clone(orphan.mark) }));
      planPairs.push({
        targetVersionId: target.id,
        packageVersionId: incoming.id,
        matchedLines: result.matchedLines,
        migratedMarks: result.migratedMarks,
      });
    });

    nextDraft.conflicts = [...nextDraft.conflicts, ...allConflicts];
    nextDraft.orphans = [...nextDraft.orphans, ...allOrphans];
    nextDraft.pendingImport = pkg.id;
    nextDraft.updatedAt = new Date().toISOString();

    const plan: StoredPlan = {
      pairs: planPairs,
      matchedLines,
      migratedMarks,
      conflicts: allConflicts.map(({ id: _id, resolved: _r, createdAt: _c, ...rest }) => rest),
      orphans: allOrphans,
    };
    const receipt: ArchiveReceipt = {
      packageId: pkg.id,
      packageName: pkg.name,
      importedAt: new Date().toISOString(),
      targetVersionId: active.id,
      conflictCount: allConflicts.length,
      migratedCount: migratedMarks,
      backup: clone(base),
    };
    return { nextDraft, receipt, plan };
  }

  private parsePackage(raw: unknown): { ok: boolean; error?: string; pkg?: ArchivePackage } {
    const candidate = raw as Partial<ArchivePackage> | null;
    if (!candidate || typeof candidate !== 'object') return { ok: false, error: '文件不是有效的归档包。' };
    if (!Array.isArray(candidate.versions) || candidate.versions.length === 0) {
      return { ok: false, error: '归档包中没有任何版本。' };
    }
    const pkg: ArchivePackage = {
      id: typeof candidate.id === 'string' && candidate.id ? candidate.id : uid('pkg'),
      name: typeof candidate.name === 'string' && candidate.name ? candidate.name : '未命名归档包',
      source: typeof candidate.source === 'string' ? candidate.source : '',
      archivedAt: typeof candidate.archivedAt === 'string' ? candidate.archivedAt : new Date().toISOString(),
      title: typeof candidate.title === 'string' ? candidate.title : '',
      author: typeof candidate.author === 'string' ? candidate.author : '',
      templateId: typeof candidate.templateId === 'string' ? candidate.templateId : this.draft().templateId,
      versions: candidate.versions.map((version, index) => this.sanitizeVersion(version, index)),
    };
    return { ok: true, pkg };
  }

  private sanitizeVersion(version: Partial<PoemVersion>, index: number): PoemVersion {
    return {
      id: typeof version.id === 'string' && version.id ? version.id : uid('pkg-version'),
      name: typeof version.name === 'string' && version.name ? version.name : `包内版本 ${index + 1}`,
      source: typeof version.source === 'string' ? version.source : '',
      createdAt: typeof version.createdAt === 'string' ? version.createdAt : new Date().toISOString(),
      text: typeof version.text === 'string' ? version.text : '',
      marks: typeof version.marks === 'object' && version.marks ? version.marks as Record<string, CharacterMark> : {},
      antithesisPairs: Array.isArray(version.antithesisPairs) ? (version.antithesisPairs as AntithesisPair[]) : [],
    };
  }

  // ------------------------------------------------------------ 冲突裁决 / 孤儿安置

  resolveConflict(id: string, choice: 'draft' | 'incoming' | 'custom', customValue?: string | boolean): void {
    this.commit((draft) => {
      const conflict = draft.conflicts.find((item) => item.id === id);
      if (!conflict || conflict.resolved) return;
      const value = choice === 'draft' ? conflict.draftValue : choice === 'incoming' ? conflict.incomingValue : customValue;
      if (value === undefined) return;
      const version = draft.versions.find((item) => item.id === conflict.versionId);
      const descriptors = version ? describeLines(version.text) : [];
      const descriptor = descriptors[conflict.draftLine];
      if (version && descriptor) {
        const key = markKey(descriptor.id, conflict.position);
        version.marks[key] = { ...{ tone: '?', rhyme: '', pauseAfter: false, basis: '', note: '' }, ...version.marks[key], [conflict.field]: value };
      }
      conflict.resolved = true;
      conflict.resolvedAt = new Date().toISOString();
      conflict.resolvedValue = value;
    });
    this.toast.set('冲突已裁决并写入当前校勘稿');
  }

  resolveAllConflicts(choice: 'draft' | 'incoming'): void {
    this.commit((draft) => {
      const now = new Date().toISOString();
      draft.conflicts.forEach((conflict) => {
        if (conflict.resolved) return;
        const value = choice === 'draft' ? conflict.draftValue : conflict.incomingValue;
        const version = draft.versions.find((item) => item.id === conflict.versionId);
        const descriptor = version ? describeLines(version.text)[conflict.draftLine] : undefined;
        if (version && descriptor) {
          const key = markKey(descriptor.id, conflict.position);
          const field = conflict.field;
          version.marks[key] = { ...{ tone: '?', rhyme: '', pauseAfter: false, basis: '', note: '' }, ...version.marks[key], [field]: value };
        }
        conflict.resolved = true;
        conflict.resolvedAt = now;
        conflict.resolvedValue = value;
      });
    });
    this.toast.set(choice === 'draft' ? '已全部按校勘稿取值裁决' : '已全部按归档包取值裁决');
  }

  jumpToConflict(conflict: ConflictRecord): void {
    if (conflict.versionId !== this.draft().activeVersionId) {
      this.commit((draft) => {
        draft.activeVersionId = conflict.versionId;
      });
    }
    this.selectCell(conflict.draftLine, conflict.position);
  }

  /** 人工把孤儿标注安置到当前选中字格（人已确认归属，直接并入该字标注）。 */
  placeOrphan(index: number): void {
    const orphan = this.draft().orphans[index];
    if (!orphan) return;
    this.commit((draft) => {
      const version = this.versionIn(draft);
      const descriptor = describeLines(version.text)[this.selectedLine()];
      if (!descriptor) return;
      const key = markKey(descriptor.id, this.selectedPosition());
      const merged = { ...defaultMark(), ...version.marks[key] };
      MARK_FIELDS.forEach((field) => {
        if (fieldIsMeaningful(field, orphan.mark[field]) && !fieldIsMeaningful(field, merged[field])) {
          (merged[field] as string | boolean) = orphan.mark[field] as string | boolean;
        }
      });
      version.marks[key] = merged;
      draft.orphans = draft.orphans.filter((_, itemIndex) => itemIndex !== index);
    });
    this.toast.set('孤儿标注已安置到选中字格');
  }

  discardOrphan(index: number): void {
    this.commit((draft) => {
      draft.orphans = draft.orphans.filter((_, itemIndex) => itemIndex !== index);
    });
  }

  // ------------------------------------------------------------ 导出

  exportProofreadCopy(): string {
    const active = this.activeVersion();
    const lines = this.analysis().map((line) => {
      const tags = line.cells.map((cell) => `${cell.char}${cell.actual === '?' ? '□' : `(${cell.actual})`}`).join(' ');
      return `第 ${line.index + 1} 句：${tags}`;
    });
    const notes = this.issues().map((issue) => `[${issue.level.toUpperCase()}] ${issue.title}：${issue.detail}`);
    return [`# ${this.draft().title} · 格律校对稿`, '', `底本：${active.name}`, `出处：${active.source}`, '', '## 字音标注', ...lines, '', '## 检查记录', ...notes].join('\n');
  }

  downloadProofreadCopy(): void {
    const anchor = document.createElement('a');
    anchor.href = URL.createObjectURL(new Blob([this.exportProofreadCopy()], { type: 'text/markdown;charset=utf-8' }));
    anchor.download = `${this.draft().title}-格律校对稿.md`;
    anchor.click();
    URL.revokeObjectURL(anchor.href);
  }

  // ------------------------------------------------------------ 基础设施

  private commit(mutator: (draft: DraftState) => void): void {
    this.undoStack.push(clone(this.draft()));
    if (this.undoStack.length > 80) this.undoStack.shift();
    this.redoStack = [];
    const next = clone(this.draft());
    mutator(next);
    next.updatedAt = new Date().toISOString();
    this.draft.set(next);
    this.undoCount.set(this.undoStack.length);
    this.redoCount.set(0);
    this.persistDraft();
  }

  private persistDraft(): void {
    const result = this.storage.writeDraft(this.draft());
    if (!result.ok) this.toast.set(`本机写入失败：${result.error}；内容暂存于内存，请尽快重试`);
  }

  private versionIn(draft: DraftState): PoemVersion {
    return draft.versions.find((item) => item.id === draft.activeVersionId) ?? draft.versions[0];
  }

  private isAcceptableVariant(template: MeterTemplate, position: number): boolean {
    if (template.lineLength === 5) return position === 0 || position === 2;
    return position === 0 || position === 2 || position === 4;
  }

  /**
   * 首次打开（信号声明前运行，只读写存储、不触碰任何信号）：
   * - 已有 v2 草稿 → 直接使用；存在中断 journal 时回滚半套草稿并挂起检查点；
   * - 仅有 v1 单仓数据 → 原样迁移到两仓（标注键重排为行身份），
   *   并把迁移前内容冻结为一个历史底稿包；v1 原始 key 原样保留不删除；
   * - 都没有 → 初始示例。
   */
  private bootstrap(): { draft: DraftState; archive: ArchiveState; journal: ImportJournal | null; toast?: string } {
    const archive = this.storage.readArchive() ?? emptyArchive();
    const existing = this.storage.readDraft();
    if (existing) {
      const recovered = this.recoverJournal(existing);
      return { draft: recovered.draft, archive, journal: recovered.journal };
    }
    const legacy = this.storage.readLegacy() as (PoemWorkspaceShape | null);
    if (legacy && Array.isArray(legacy.versions) && legacy.versions.length) {
      return this.migrateLegacy(legacy);
    }
    return { draft: initialDraft(), archive, journal: null };
  }

  private recoverJournal(current: DraftState): { draft: DraftState; journal: ImportJournal | null } {
    const journal = this.storage.readJournal();
    if (!journal) return { draft: current, journal: null };
    if (journal.phase === 'committed') {
      // 收尾阶段崩溃：journal 已无作用，清掉即可。
      this.storage.writeJournal(null);
      return { draft: current, journal: null };
    }
    let draft = current;
    if (journal.kind === 'import' && journal.receipt) {
      // phase 仍为 checkpoint：草稿写入成功后才可能形成「半套」（归档仓未完成）。
      // 若磁盘草稿已带该包标记，说明正处于半套状态——回滚到导入前整稿，等待续做或撤回。
      if (current.pendingImport === journal.package.id) {
        draft = journal.receipt.backup;
        this.storage.writeDraft(draft);
      }
    }
    return { draft, journal };
  }

  private migrateLegacy(legacy: PoemWorkspaceShape): { draft: DraftState; archive: ArchiveState; journal: null; toast: string } {
    const now = new Date().toISOString();
    const versions = legacy.versions.map((version) => ({
      ...version,
      marks: reindexMarks(version.text, version.marks ?? {}),
    }));
    const draft: DraftState = {
      schema: 2,
      title: legacy.title ?? '未命名诗稿',
      author: legacy.author ?? '',
      templateId: legacy.templateId ?? METER_TEMPLATES[0].id,
      versions,
      activeVersionId: legacy.activeVersionId ?? versions[0].id,
      conflicts: [],
      orphans: [],
      updatedAt: legacy.updatedAt ?? now,
    };
    const migrationPackage: ArchivePackage = {
      id: uid('pkg-legacy'),
      name: `迁移前底稿 · ${draft.title}`,
      source: '首次打开自动归档（v1 单仓数据原样冻结）',
      archivedAt: now,
      title: draft.title,
      author: draft.author,
      templateId: draft.templateId,
      versions: clone(versions),
    };
    const archive = emptyArchive();
    archive.packages.push(migrationPackage);
    // 两仓独立写入；任何一仓失败都保留 v1 原 key，下次打开仍可重新迁移。
    this.storage.writeArchive(archive);
    this.storage.writeDraft(draft);
    return { draft, archive, journal: null, toast: '已把原有数据迁入「校勘稿 / 历史底稿」两仓，原 v1 数据原样保留' };
  }
}

/** v1 单仓形状（迁移用）。 */
interface PoemWorkspaceShape {
  title?: string;
  author?: string;
  templateId?: string;
  versions: PoemVersion[];
  activeVersionId?: string;
  updatedAt?: string;
}
