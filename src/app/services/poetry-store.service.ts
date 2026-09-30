import { computed, Injectable, signal } from '@angular/core';
import { AlignmentService } from './alignment.service';
import type {
  AnalysisCell,
  AnalysisLine,
  AntithesisPair,
  ArchivePackage,
  ArchiveState,
  CharacterMark,
  CharDiff,
  DraftState,
  FieldConflict,
  FieldOp,
  ImportPlan,
  ImportTransaction,
  LegacyWorkspaceV1,
  MarkField,
  MarkTone,
  MergeField,
  MeterTemplate,
  PackageLine,
  PackageVersion,
  PoemIssue,
  PoemLine,
  PoemVersion,
  PoemWorkspace,
  Tone,
} from '../models/poem.models';
import { MARK_FIELDS } from '../models/poem.models';

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

const DRAFT_KEY = 'sologsb-1015-poetry-draft-v2';
const ARCHIVE_KEY = 'sologsb-1015-poetry-archive-v2';
const TXN_KEY = 'sologsb-1015-poetry-import-txn-v2';
const LEGACY_KEY = 'sologsb-1015-poetry-workspace-v1';
const PUNCTUATION = new Set(['，', '。', '！', '？', '；', '：', '、', ' ', '\t']);
const TONE_DICTIONARY: Record<string, Tone> = {
  春: '平', 眠: '平', 不: '仄', 觉: '仄', 晓: '仄', 处: '仄', 闻: '平', 啼: '平', 鸟: '仄',
  夜: '仄', 来: '平', 风: '平', 雨: '仄', 声: '平', 花: '平', 落: '仄', 知: '平', 多: '平', 少: '仄',
  国: '仄', 破: '仄', 山: '平', 河: '平', 在: '仄', 城: '平', 深: '平', 木: '仄', 草: '仄', 独: '仄',
  明: '平', 月: '仄', 高: '平', 天: '平', 故: '仄', 乡: '平', 万: '仄', 里: '仄', 江: '平', 船: '平',
};

export const FIELD_LABELS: Record<MergeField, string> = {
  tone: '平仄',
  rhyme: '韵组',
  pauseAfter: '停顿',
  basis: '判断依据',
  note: '批注',
  text: '句文本',
};

const clone = <T>(value: T): T => structuredClone(value);
const uid = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

function defaultMark(): CharacterMark {
  return { tone: '?', rhyme: '', pauseAfter: false, basis: '', note: '' };
}

function isMarkFieldEmpty(mark: CharacterMark, field: MarkField): boolean {
  if (field === 'pauseAfter') return !mark.pauseAfter;
  const value = mark[field];
  return value === '' || value === '?' || value === undefined;
}

function setMarkField(mark: CharacterMark, field: MarkField, value: string | boolean): void {
  if (field === 'pauseAfter') mark.pauseAfter = Boolean(value);
  else (mark[field] as string | boolean) = value;
}

function isEmptyMark(mark: CharacterMark): boolean {
  return mark.tone === '?' && !mark.rhyme && !mark.pauseAfter && !mark.basis && !mark.note;
}

/** 把旧版“整段 text + 全局字符位 marks”拆成带稳定身份的行 */
function legacyVersionToLines(version: LegacyWorkspaceV1['versions'][number]): PoemLine[] {
  return version.text.split('\n').map((text, lineIndex) => {
    const marks: Record<number, CharacterMark> = {};
    Object.entries(version.marks ?? {}).forEach(([k, mark]) => {
      const [lineStr, posStr] = k.split(':');
      if (Number(lineStr) === lineIndex) marks[Number(posStr)] = clone(mark);
    });
    return { lineId: `line-${version.id}-${lineIndex}`, text, marks };
  });
}

function initialWorkspace(): PoemWorkspace {
  const now = new Date().toISOString();
  const spring = '春眠不觉晓，\n处处闻啼鸟。\n夜来风雨声，\n花落知多少。';
  const legacyMarks = (() => {
    const marks: Record<string, CharacterMark> = {};
    const cells = [
      ['晓', 0, '平'], ['鸟', 1, '平'], ['声', 2, '平'], ['少', 3, '平'],
    ] as const;
    cells.forEach(([char, line, tone]) => {
      marks[`${line}:4`] = { tone, rhyme: 'A', pauseAfter: false, basis: '《平水韵》上声十七筱', note: `${char} 为韵脚` };
    });
    marks['0:2'] = { tone: '平', rhyme: '', pauseAfter: false, basis: '平水韵', note: '句中平声' };
    marks['1:2'] = { tone: '平', rhyme: '', pauseAfter: false, basis: '平水韵', note: '' };
    marks['2:2'] = { tone: '平', rhyme: '', pauseAfter: false, basis: '平水韵', note: '' };
    return marks;
  })();

  const build = (id: string, name: string, source: string, text: string): PoemVersion => ({
    id,
    name,
    source,
    createdAt: now,
    lines: legacyVersionToLines({ id, name, source, createdAt: now, text, marks: legacyMarks, antithesisPairs: [] }),
    antithesisPairs: [],
  });

  const top = build('version-main', '通行本 · 孟浩然集', '《孟浩然诗集笺注》', spring);
  return {
    title: '春晓',
    author: '孟浩然',
    templateId: 'wuyan-zeqi',
    versions: [top],
    activeVersionId: top.id,
    updatedAt: now,
  };
}

/**
 * 首次打开：把旧单仓数据迁移到“校勘稿 / 历史底稿”两仓。
 * 顺序：先写两仓并校验可读，最后才删除旧键——任何中断都不丢原内容。
 */
function migrateLegacyIfNeeded(): { draft: DraftState; archive: ArchiveState } | null {
  const legacyRaw = localStorage.getItem(LEGACY_KEY);
  if (!legacyRaw) return null;

  let legacy: LegacyWorkspaceV1;
  try {
    legacy = JSON.parse(legacyRaw) as LegacyWorkspaceV1;
  } catch {
    return null;
  }
  if (!legacy.versions?.length) return null;

  const now = new Date().toISOString();
  const workspace: PoemWorkspace = {
    title: legacy.title,
    author: legacy.author,
    templateId: legacy.templateId,
    updatedAt: legacy.updatedAt ?? now,
    activeVersionId: legacy.activeVersionId,
    versions: legacy.versions.map((version) => ({
      id: version.id,
      name: version.name,
      source: version.source,
      createdAt: version.createdAt,
      lines: legacyVersionToLines(version),
      antithesisPairs: clone(version.antithesisPairs ?? []),
    })),
  };

  const draft: DraftState = { schema: 2, workspace, conflicts: [] };
  const migrationPkg: ArchivePackage = {
    id: uid('pkg-migrate'),
    kind: 'migration',
    label: `旧版数据迁移 · ${workspace.title}`,
    source: 'localStorage v1',
    note: '首次打开两仓版本时自动归档，保留迁移前的原始数据。',
    createdAt: now,
    status: 'applied',
    workspace: clone(workspace),
    legacyRaw,
  };
  const archive: ArchiveState = { schema: 2, packages: [migrationPkg] };

  localStorage.setItem(DRAFT_KEY, JSON.stringify(draft));
  localStorage.setItem(ARCHIVE_KEY, JSON.stringify(archive));
  // 校验两仓确实落盘后才移除旧键
  if (localStorage.getItem(DRAFT_KEY) && localStorage.getItem(ARCHIVE_KEY)) {
    localStorage.removeItem(LEGACY_KEY);
  }
  return { draft, archive };
}

function loadDraft(): DraftState {
  const migrated = migrateLegacyIfNeeded();
  if (migrated) return migrated.draft;
  try {
    const raw = localStorage.getItem(DRAFT_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as DraftState;
      if (parsed.schema === 2 && parsed.workspace?.versions?.length) return parsed;
    }
  } catch {
    /* 落盘损坏时回到初始稿，归档仓不受影响 */
  }
  return { schema: 2, workspace: initialWorkspace(), conflicts: [] };
}

function loadArchive(): ArchiveState {
  try {
    const raw = localStorage.getItem(ARCHIVE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as ArchiveState;
      if (parsed.schema === 2) return parsed;
    }
  } catch {
    /* 归档仓不可读时以空仓启动，不影响校勘稿编辑 */
  }
  return { schema: 2, packages: [] };
}

@Injectable({ providedIn: 'root' })
export class PoetryStoreService {
  private readonly alignment = new AlignmentService();

  /** 校勘稿状态所有权：仅本仓接受编辑 */
  readonly draft = signal<DraftState>(loadDraft());
  /** 历史底稿状态所有权：只追加归档包，编辑流程永不写此仓（撤回仅改状态标记） */
  readonly archive = signal<ArchiveState>(loadArchive());

  readonly selectedLine = signal(0);
  readonly selectedPosition = signal(4);
  readonly baselineVersionId = signal<string>('');
  readonly currentDiffIndex = signal(0);
  readonly toast = signal('');
  readonly undoCount = signal(0);
  readonly redoCount = signal(0);
  /** 导入事务状态（检查点续传 / 撤回） */
  readonly pendingTransaction = signal<ImportTransaction | null>(this.readTransaction());
  readonly importError = signal('');

  private undoStack: DraftState[] = [];
  private redoStack: DraftState[] = [];

  readonly workspace = computed(() => this.draft().workspace);
  readonly conflicts = computed(() => this.draft().conflicts.filter((item) => item.resolution === null));
  readonly resolvedConflicts = computed(() => this.draft().conflicts.filter((item) => item.resolution !== null));
  readonly packages = computed(() => this.archive().packages);

  readonly activeVersion = computed<PoemVersion>(() => {
    const state = this.workspace();
    return state.versions.find((version) => version.id === state.activeVersionId) ?? state.versions[0];
  });

  readonly template = computed(() => {
    return METER_TEMPLATES.find((item) => item.id === this.workspace().templateId) ?? METER_TEMPLATES[0];
  });

  readonly lines = computed(() => this.activeVersion().lines.map((line) => line.text));

  readonly analysis = computed<AnalysisLine[]>(() => {
    const version = this.activeVersion();
    const template = this.template();
    return version.lines.map((poemLine, lineIndex) => {
      const chars = Array.from(poemLine.text).filter((char) => !PUNCTUATION.has(char));
      const cells: AnalysisCell[] = chars.map((char, position) => {
        const mark = poemLine.marks[position] ?? defaultMark();
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
        lineId: poemLine.lineId,
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
        issues.push({ id: uid('issue'), level: 'warning', title: '韵脚缺少韵部', detail: `第 ${(cell?.position ?? 0) + 1} 句末字尚未指定韵部。` });
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
    if (!issues.some((issue) => issue.level === 'error')) {
      issues.unshift({ id: 'meter-ok', level: 'info', title: '格律检查通过', detail: '当前未发现硬性出律，请继续核对可接受变体。' });
    }
    return issues;
  });

  readonly diff = computed<CharDiff[]>(() => {
    const left = this.workspace().versions.find((version) => version.id === this.baselineVersionId());
    const right = this.activeVersion();
    if (!left || left.id === right.id) return [];
    const leftChars = Array.from(left.lines.map((line) => line.text).join('').replace(/\n/g, ''));
    const rightChars = Array.from(right.lines.map((line) => line.text).join('').replace(/\n/g, ''));
    const size = Math.max(leftChars.length, rightChars.length);
    return Array.from({ length: size }, (_, index) => ({
      index,
      left: leftChars[index] ?? '',
      right: rightChars[index] ?? '',
      changed: leftChars[index] !== rightChars[index],
    }));
  });

  readonly differences = computed(() => this.diff().filter((item) => item.changed).map((item) => item.index));
  readonly baselineVersion = computed(() => this.workspace().versions.find((version) => version.id === this.baselineVersionId()));

  constructor() {
    // 启动时若发现未完成的导入事务（写入失败 / 刷新中断），自动从检查点续上
    const txn = this.pendingTransaction();
    if (txn && txn.phase !== 'draft-applied') {
      try {
        this.resumeImport();
      } catch (error) {
        this.importError.set((error as Error).message);
      }
    }
  }

  selectVersion(id: string): void {
    this.commit((draft) => {
      draft.workspace.activeVersionId = id;
    });
  }

  selectCell(line: number, position: number): void {
    this.selectedLine.set(line);
    this.selectedPosition.set(position);
  }

  setTemplate(id: string): void {
    this.commit((draft) => {
      draft.workspace.templateId = id;
    });
  }

  /** 整段文本编辑：先按行身份对齐（增删行不串句），再按字符对齐把标注随字迁走 */
  updateText(text: string): void {
    this.commit((draft) => {
      const version = this.versionIn(draft.workspace);
      const incoming: PackageLine[] = text.split('\n').map((line) => ({ text: line }));
      const aligned = this.alignment.alignLines(incoming, version.lines);
      const next: PoemLine[] = [];
      incoming.forEach((newLine, index) => {
        const mapping = aligned.find((pair) => pair.sourceIndex === index);
        const existing = mapping && mapping.targetIndex >= 0 ? version.lines[mapping.targetIndex] : undefined;
        if (!existing) {
          next.push({ lineId: uid('line'), text: newLine.text, marks: {} });
          return;
        }
        if (existing.text === newLine.text) {
          next.push(existing);
          return;
        }
        const { pairs } = this.alignment.alignChars(existing.text, newLine.text);
        const marks: Record<number, CharacterMark> = {};
        pairs.forEach(({ source, target }) => {
          const mark = existing.marks[source];
          if (mark && target >= 0) marks[target] = clone(mark);
        });
        next.push({ ...existing, text: newLine.text, marks });
      });
      version.lines = next;
    });
  }

  updateTitle(title: string): void {
    this.commit((draft) => {
      draft.workspace.title = title;
    });
  }

  updateVersionSource(source: string): void {
    this.commit((draft) => {
      this.versionIn(draft.workspace).source = source;
    });
  }

  setMark(patch: Partial<CharacterMark>): void {
    this.commit((draft) => {
      const line = this.activePoemLine(draft.workspace);
      const id = this.selectedPosition();
      const mark: CharacterMark = { ...defaultMark(), ...line.marks[id], ...patch };
      // 人工编辑后，被改字段不再归属任何归档包
      (Object.keys(patch) as MarkField[]).forEach((field) => {
        delete mark.fieldSources?.[field];
        if (mark.fieldSources && Object.keys(mark.fieldSources).length === 0) delete mark.fieldSources;
      });
      if (isEmptyMark(mark)) delete line.marks[id];
      else line.marks[id] = mark;
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
      const version = this.versionIn(draft.workspace);
      if (version.antithesisPairs.some((pair) => pair.leftLine === line && pair.rightLine === other)) return;
      version.antithesisPairs.push({ id: uid('pair'), leftLine: Math.min(line, other), rightLine: Math.max(line, other), note: '结构相对，词性相应。' });
    });
  }

  removeAntithesis(id: string): void {
    this.commit((draft) => {
      const version = this.versionIn(draft.workspace);
      version.antithesisPairs = version.antithesisPairs.filter((pair) => pair.id !== id);
    });
  }

  updateAntithesis(id: string, note: string): void {
    this.commit((draftState) => {
      const pair = this.versionIn(draftState.workspace).antithesisPairs.find((item) => item.id === id);
      if (pair) pair.note = note;
    });
  }

  /** 归档当前校勘稿：底稿仓只收只读快照，校勘稿仍可继续编辑，两不相扰 */
  archiveSnapshot(): void {
    const now = new Date().toISOString();
    const pkg: ArchivePackage = {
      id: uid('pkg-snap'),
      kind: 'snapshot',
      label: `归档 · ${this.workspace().title} · ${new Date().toLocaleString()}`,
      source: this.activeVersion().source,
      note: '校勘稿阶段性归档，归档后不再被编辑改写。',
      createdAt: now,
      status: 'applied',
      workspace: clone(this.workspace()),
    };
    const nextArchive = clone(this.archive());
    nextArchive.packages.unshift(pkg);
    this.writeArchive(nextArchive);
    this.archive.set(nextArchive);
    this.toast.set('已把当前校勘稿归档为只读历史底稿，可继续编辑');
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
    this.writeDraft(previous);
  }

  redo(): void {
    const next = this.redoStack.pop();
    if (!next) return;
    this.undoStack.push(clone(this.draft()));
    this.draft.set(next);
    this.undoCount.set(this.undoStack.length);
    this.redoCount.set(this.redoStack.length);
    this.writeDraft(next);
  }

  exportProofreadCopy(): string {
    const active = this.activeVersion();
    const lines = this.analysis().map((line) => {
      const tags = line.cells.map((cell) => `${cell.char}${cell.actual === '?' ? '□' : `(${cell.actual})`}`).join(' ');
      return `第 ${line.index + 1} 句：${tags}`;
    });
    const notes = this.issues().map((issue) => `[${issue.level.toUpperCase()}] ${issue.title}：${issue.detail}`);
    return [`# ${this.workspace().title} · 格律校对稿`, '', `底本：${active.name}`, `出处：${active.source}`, '', '## 字音标注', ...lines, '', '## 检查记录', ...notes].join('\n');
  }

  downloadProofreadCopy(): void {
    const anchor = document.createElement('a');
    anchor.href = URL.createObjectURL(new Blob([this.exportProofreadCopy()], { type: 'text/markdown;charset=utf-8' }));
    anchor.download = `${this.workspace().title}-格律校对稿.md`;
    anchor.click();
    URL.revokeObjectURL(anchor.href);
  }

  selectedCell(): AnalysisCell | undefined {
    return this.analysis()[this.selectedLine()]?.cells[this.selectedPosition()];
  }

  // ───────────────────────── 归档包导入：行身份 + 字段合并 ─────────────────────────

  /** 解析导入包 JSON（失败抛错，由界面提示） */
  parseImportJson(raw: string): { label: string; source: string; note: string; versions: PackageVersion[] } {
    const parsed = JSON.parse(raw) as { label?: string; source?: string; note?: string; versions?: PackageVersion[] };
    if (!parsed.versions?.length || !parsed.versions.every((version) => Array.isArray(version.lines))) {
      throw new Error('归档包格式不正确：需要 versions[].lines');
    }
    return {
      label: parsed.label ?? '外部归档包',
      source: parsed.source ?? '未知来源',
      note: parsed.note ?? '',
      versions: parsed.versions,
    };
  }

  /**
   * 导入归档包。两阶段提交：
   * prepare（计划与检查点）→ archive-written（底稿仓落包）→ draft-applied（校勘稿合并）→ 清理检查点。
   * 任何阶段写入失败都可重试续传，也可整包撤回，不留半套历史。
   */
  importPackage(input: { label: string; source: string; note: string; versions: PackageVersion[] }): ImportTransaction {
    if (this.pendingTransaction()) throw new Error('已有未完成的导入，请先重试完成或整包撤回');
    const now = new Date().toISOString();
    const packageId = uid('pkg-import');
    const pkg: ArchivePackage = {
      id: packageId,
      kind: 'import',
      label: input.label,
      source: input.source,
      note: input.note,
      createdAt: now,
      status: 'applied',
      versions: clone(input.versions).map((version) => ({
        ...version,
        id: version.id ?? uid('pkgver'),
      })),
    };
    const plan = this.buildPlan(pkg.versions ?? [], packageId);
    const txn: ImportTransaction = {
      id: uid('txn'),
      packageId,
      pkg,
      plan,
      phase: 'prepare',
      createdAt: now,
      updatedAt: now,
      error: '',
    };
    this.writeTransaction(txn);
    this.pendingTransaction.set(txn);
    this.advanceImport();
    return txn;
  }

  /** 从检查点继续：失败后重试，各阶段幂等 */
  resumeImport(): void {
    if (!this.pendingTransaction()) throw new Error('没有未完成的导入');
    this.advanceImport();
  }

  /** 撤回整包：移除该包带进校勘稿的全部内容，并在底稿仓把包标记为 withdrawn */
  withdrawPackage(packageId?: string): void {
    const txn = this.pendingTransaction();
    const id = packageId ?? txn?.packageId;
    if (!id) throw new Error('缺少要撤回的归档包');

    const nextDraft = clone(this.draft());
    const plan = txn?.plan;
    nextDraft.workspace.versions = nextDraft.workspace.versions.filter((version) => {
      if (plan?.versionOps.some((op) => op.type === 'addVersion' && op.versionId === version.id)) return false;
      return !version.id.startsWith(`imp-${id}`);
    });
    if (!nextDraft.workspace.versions.some((version) => version.id === nextDraft.workspace.activeVersionId)) {
      nextDraft.workspace.activeVersionId = nextDraft.workspace.versions[0]?.id ?? '';
    }

    nextDraft.workspace.versions.forEach((version) => {
      version.lines = version.lines.filter((line) => !line.lineId.startsWith(`line-${id}-`));
      version.antithesisPairs = version.antithesisPairs.filter((pair) => !pair.id.startsWith(`pair-${id}-`));
      version.lines.forEach((line) => {
        Object.entries(line.marks).forEach(([posStr, mark]) => {
          let touched = false;
          const sources = mark.fieldSources ? { ...mark.fieldSources } : undefined;
          (MARK_FIELDS).forEach((field) => {
            if (sources?.[field] === id) {
              delete sources[field];
              setMarkField(mark, field, field === 'pauseAfter' ? false : field === 'tone' ? '?' : '');
              touched = true;
            }
          });
          if (sources) {
            if (Object.keys(sources).length) mark.fieldSources = sources;
            else delete mark.fieldSources;
          }
          if (touched && isEmptyMark(mark)) delete line.marks[Number(posStr)];
        });
      });
    });
    nextDraft.conflicts = nextDraft.conflicts.filter((conflict) => conflict.packageId !== id);
    this.writeDraft(nextDraft);
    this.draft.set(nextDraft);

    const nextArchive = clone(this.archive());
    const target = nextArchive.packages.find((item) => item.id === id);
    if (target) target.status = 'withdrawn';
    this.writeArchive(nextArchive);
    this.archive.set(nextArchive);

    if (txn) {
      localStorage.removeItem(TXN_KEY);
      this.pendingTransaction.set(null);
    }
    this.importError.set('');
    this.toast.set('已整包撤回，校勘稿与底稿仓均无半套残留');
  }

  /** 冲突裁决：采用归档值 / 保留当前值 / 自定义 */
  resolveConflict(conflictId: string, resolution: Exclude<FieldConflict['resolution'], null>, custom?: string | boolean): void {
    this.commit((draft) => {
      const conflict = draft.conflicts.find((item) => item.id === conflictId);
      if (!conflict || conflict.resolution !== null) return;
      const version = draft.workspace.versions.find((item) => item.id === conflict.versionId);
      const line = version?.lines.find((item) => item.lineId === conflict.lineId);
      if (!version || !line) return;
      let value: string | boolean | null;
      if (resolution === 'incoming') value = conflict.incomingValue;
      else if (resolution === 'current') value = conflict.currentValue;
      else value = custom ?? conflict.incomingValue;

      conflict.resolution = typeof resolution === 'object' ? { custom: value as string | boolean } : resolution;
      if (conflict.field !== 'text' && conflict.position !== null && value !== null) {
        const mark = line.marks[conflict.position] ?? defaultMark();
        setMarkField(mark, conflict.field, value);
        // 采用归档值才归属该包（撤回时随之清走）；保留现值 / 自定义视为人工判断
        if (resolution === 'incoming') {
          mark.fieldSources = { ...(mark.fieldSources ?? {}), [conflict.field]: conflict.packageId };
        } else {
          delete mark.fieldSources?.[conflict.field];
          if (mark.fieldSources && Object.keys(mark.fieldSources).length === 0) delete mark.fieldSources;
        }
        line.marks[conflict.position] = mark;
      }
    });
  }

  // ───────────────────────── 内部实现 ─────────────────────────

  /**
   * 按来源与上下文定行身份，逐字段生成合并计划：
   * 不同字段自动合并；同一字段双方都有且不一致 → 冲突交人；行文本绝不覆盖校勘稿。
   */
  private buildPlan(incomingVersions: PackageVersion[], packageId: string): ImportPlan {
    const plan: ImportPlan = { versionOps: [], lineOps: [], fieldOps: [], pairOps: [], conflicts: [] };
    const now = new Date().toISOString();
    const current = this.workspace();

    incomingVersions.forEach((incoming, versionIndex) => {
      const matchedById = incoming.id ? current.versions.find((version) => version.id === incoming.id) : undefined;
      // 来源（书名/版本名）一致才视为同份校勘稿的更新，否则作为新增版本归档进来
      const matchedBySource = current.versions.find(
        (version) => version.source.trim() && version.source === incoming.source && version.name === incoming.name,
      );
      const target = matchedById ?? matchedBySource;

      let versionId: string;
      if (target) {
        versionId = target.id;
      } else {
        versionId = `imp-${packageId}-${versionIndex}`;
        plan.versionOps.push({ type: 'addVersion', versionId, name: incoming.name, source: incoming.source });
      }

      const aligned = this.alignment.alignLines(incoming.lines, target?.lines ?? []);
      aligned
        .filter((pair) => pair.reason === 'insert')
        .forEach((pair) => {
          const src = incoming.lines[pair.sourceIndex];
          const lineId = `line-${packageId}-${versionIndex}-${pair.sourceIndex}`;
          plan.lineOps.push({ type: 'addLine', versionId, index: pair.sourceIndex, lineId, text: src.text });
        });

      incoming.lines.forEach((srcLine, sourceIndex) => {
        const pair = aligned.find((item) => item.sourceIndex === sourceIndex && item.targetIndex >= 0);
        const isNewLine = !pair;
        const targetLine = pair && target ? target.lines[pair.targetIndex] : undefined;
        const lineId = isNewLine
          ? `line-${packageId}-${versionIndex}-${sourceIndex}`
          : targetLine!.lineId;

        if (!isNewLine && pair && target && targetLine && srcLine.text !== targetLine.text) {
          // 只记录行身份映射，不覆盖文本——校勘稿保留自己的编辑内容
          plan.lineOps.push({ type: 'updateLineText', versionId, lineId, from: targetLine.text, to: srcLine.text });
        }

        // 字符级对齐：归档标注随“同一字”迁移，改字后不串位
        const charPairs = targetLine ? this.alignment.alignChars(srcLine.text, targetLine.text).pairs : undefined;
        this.planMarks(srcLine, lineId, versionId, targetLine, charPairs, packageId, plan, now);
      });

      (incoming.antithesisPairs ?? []).forEach((incomingPair, pairIndex) => {
        if (target?.antithesisPairs.some((existing) => existing.leftLine === incomingPair.leftLine && existing.rightLine === incomingPair.rightLine)) return;
        plan.pairOps.push({
          type: 'addPair',
          versionId,
          pair: { ...clone(incomingPair), id: `pair-${packageId}-${versionIndex}-${pairIndex}` },
        });
      });
    });

    return plan;
  }

  private planMarks(
    srcLine: PackageLine,
    lineId: string,
    versionId: string,
    targetLine: PoemLine | undefined,
    charPairs: Array<{ source: number; target: number }> | undefined,
    packageId: string,
    plan: ImportPlan,
    now: string,
  ): void {
    Object.entries(srcLine.marks ?? {}).forEach(([posStr, incomingMark]) => {
      const sourcePos = Number(posStr);
      const mapped = charPairs?.find((pair) => pair.source === sourcePos && pair.target >= 0);
      const targetPos = mapped ? mapped.target : sourcePos;
      const targetMark = targetLine?.marks[targetPos];

      (MARK_FIELDS).forEach((field) => {
        const incomingValue = incomingMark[field];
        const incomingEmpty = isMarkFieldEmpty({ ...defaultMark(), ...incomingMark }, field);
        if (incomingEmpty) return;
        const currentValue = targetMark ? targetMark[field] : null;
        const currentEmpty = targetMark === undefined || isMarkFieldEmpty(targetMark, field);

        if (!targetMark || currentEmpty) {
          plan.fieldOps.push({ versionId, lineId, position: targetPos, field, autoFill: incomingValue, incomingValue, conflictId: null });
          return;
        }
        if (currentValue !== incomingValue) {
          const conflict: FieldConflict = {
            id: uid('conflict'),
            packageId,
            versionId,
            lineId,
            position: targetPos,
            field,
            incomingValue,
            currentValue,
            resolution: null,
            createdAt: now,
          };
          plan.conflicts.push(conflict);
          plan.fieldOps.push({ versionId, lineId, position: targetPos, field, autoFill: null, incomingValue, conflictId: conflict.id });
        }
      });
    });
  }

  private advanceImport(): void {
    const txn = this.readTransaction();
    if (!txn) return;
    try {
      if (txn.phase === 'prepare') {
        // 阶段一：归档包落入底稿仓（整状态单次写入，天然原子）
        const nextArchive = clone(this.archive());
        if (!nextArchive.packages.some((pkg) => pkg.id === txn.packageId)) {
          nextArchive.packages.unshift(txn.pkg);
        }
        this.writeArchive(nextArchive);
        this.archive.set(nextArchive);
        txn.phase = 'archive-written';
        txn.updatedAt = new Date().toISOString();
        this.writeTransaction(txn);
      }
      if (txn.phase === 'archive-written') {
        // 阶段二：合并进校勘稿（整状态单次写入）
        const nextDraft = this.applyPlan(clone(this.draft()), txn.plan, txn.packageId);
        this.writeDraft(nextDraft);
        this.draft.set(nextDraft);
        txn.phase = 'draft-applied';
        txn.updatedAt = new Date().toISOString();
        this.writeTransaction(txn);
      }
      // 完成：清理检查点
      localStorage.removeItem(TXN_KEY);
      this.pendingTransaction.set(null);
      this.importError.set('');
      const conflictCount = txn.plan.conflicts.length;
      this.toast.set(conflictCount ? `导入完成，${conflictCount} 处同字段冲突待裁决` : '归档包已导入并完成字段合并');
    } catch (error) {
      txn.error = (error as Error).message;
      txn.updatedAt = new Date().toISOString();
      this.writeTransaction(txn);
      this.pendingTransaction.set(txn);
      this.importError.set(txn.error);
      // 同步内存中可能已写入的阶段状态，保证重试基于最新检查点
      this.archive.set(loadArchive());
      this.draft.set(loadDraft());
    }
  }

  private applyPlan(draft: DraftState, plan: ImportPlan, packageId: string): DraftState {
    plan.versionOps.forEach((op) => {
      if (op.type === 'addVersion' && !draft.workspace.versions.some((version) => version.id === op.versionId)) {
        draft.workspace.versions.push({
          id: op.versionId,
          name: op.name,
          source: op.source,
          createdAt: new Date().toISOString(),
          lines: [],
          antithesisPairs: [],
        });
      }
    });

    plan.lineOps
      .filter((op) => op.type === 'addLine')
      .sort((a, b) => (a.type === 'addLine' && b.type === 'addLine' ? a.index - b.index : 0))
      .forEach((op) => {
        if (op.type !== 'addLine') return;
        const version = draft.workspace.versions.find((item) => item.id === op.versionId);
        if (!version || version.lines.some((line) => line.lineId === op.lineId)) return;
        version.lines.splice(Math.min(op.index, version.lines.length), 0, { lineId: op.lineId, text: op.text, marks: {} });
      });

    plan.fieldOps.forEach((op) => {
      if (op.conflictId || op.autoFill === null || op.position === null || op.field === 'text') return;
      const version = draft.workspace.versions.find((item) => item.id === op.versionId);
      const line = version?.lines.find((item) => item.lineId === op.lineId);
      if (!version || !line) return;
      const mark = line.marks[op.position] ?? defaultMark();
      if (!isMarkFieldEmpty(mark, op.field)) return; // 已被人工/其他包填上，不覆盖
      setMarkField(mark, op.field, op.autoFill);
      mark.fieldSources = { ...(mark.fieldSources ?? {}), [op.field]: packageId };
      line.marks[op.position] = mark;
    });

    plan.pairOps.forEach((op) => {
      const version = draft.workspace.versions.find((item) => item.id === op.versionId);
      if (!version || version.antithesisPairs.some((pair) => pair.id === op.pair.id)) return;
      version.antithesisPairs.push(clone(op.pair));
    });

    plan.conflicts.forEach((conflict) => {
      if (!draft.conflicts.some((item) => item.id === conflict.id)) draft.conflicts.push(clone(conflict));
    });

    draft.workspace.updatedAt = new Date().toISOString();
    return draft;
  }

  // ───────────────────────── 持久化（两仓 + 检查点） ─────────────────────────

  private writeDraft(draft: DraftState): void {
    localStorage.setItem(DRAFT_KEY, JSON.stringify(draft));
  }

  private writeArchive(archive: ArchiveState): void {
    localStorage.setItem(ARCHIVE_KEY, JSON.stringify(archive));
  }

  private writeTransaction(txn: ImportTransaction): void {
    localStorage.setItem(TXN_KEY, JSON.stringify(txn));
  }

  private readTransaction(): ImportTransaction | null {
    try {
      const raw = localStorage.getItem(TXN_KEY);
      return raw ? (JSON.parse(raw) as ImportTransaction) : null;
    } catch {
      return null;
    }
  }

  private commit(mutator: (draft: DraftState) => void): void {
    this.undoStack.push(clone(this.draft()));
    if (this.undoStack.length > 80) this.undoStack.shift();
    this.redoStack = [];
    const next = clone(this.draft());
    mutator(next);
    next.workspace.updatedAt = new Date().toISOString();
    this.draft.set(next);
    this.undoCount.set(this.undoStack.length);
    this.redoCount.set(0);
    this.writeDraft(next);
  }

  private versionIn(workspace: PoemWorkspace): PoemVersion {
    return workspace.versions.find((item) => item.id === workspace.activeVersionId) ?? workspace.versions[0];
  }

  private activePoemLine(workspace: PoemWorkspace): PoemLine {
    const version = this.versionIn(workspace);
    return version.lines[this.selectedLine()] ?? version.lines[0];
  }

  private isAcceptableVariant(template: MeterTemplate, position: number): boolean {
    if (template.lineLength === 5) return position === 0 || position === 2;
    return position === 0 || position === 2 || position === 4;
  }
}
