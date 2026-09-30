export type Tone = '平' | '仄' | '中' | '?';
export type MarkTone = '平' | '仄' | '中';

export interface CharacterMark {
  tone: MarkTone | '?';
  rhyme: string;
  pauseAfter: boolean;
  basis: string;
  note: string;
}

/** 可逐字合并的标注字段；不同字段自动合并，同一字段冲突留给人裁决。 */
export type MarkField = keyof CharacterMark;
export const MARK_FIELDS: MarkField[] = ['tone', 'rhyme', 'pauseAfter', 'basis', 'note'];
export const MARK_FIELD_LABELS: Record<MarkField, string> = {
  tone: '平仄',
  rhyme: '韵组',
  pauseAfter: '停顿',
  basis: '判断依据',
  note: '批注',
};

/**
 * 行身份：由规范化（去标点空白）后的句文派生，稳定且可复算。
 * 同篇内同文句按出现次序加序号消歧。标注挂在行身份而非行号上，
 * 行序调整、上下句增删时标注随行迁移，不再依赖字符位置覆盖。
 */
export interface LineDescriptor {
  id: string;
  index: number;
  raw: string;
  normalized: string;
}

export interface PoemVersion {
  id: string;
  name: string;
  source: string;
  createdAt: string;
  text: string;
  /** 键为 `${lineId}:${position}`，position 相对去标点后的字序。 */
  marks: Record<string, CharacterMark>;
  antithesisPairs: AntithesisPair[];
}

export interface AntithesisPair {
  id: string;
  leftLine: number;
  rightLine: number;
  note: string;
}

/** 当前校勘稿仓：唯一允许编辑的状态。 */
export interface DraftState {
  schema: 2;
  title: string;
  author: string;
  templateId: string;
  versions: PoemVersion[];
  activeVersionId: string;
  /** 导入产生、待人工裁决的字段冲突。 */
  conflicts: ConflictRecord[];
  /** 导入时未能安置的标注，等待人工处理。 */
  orphans: OrphanMark[];
  /** 非空表示存在未完成的导入事务（对应检查点 journal）。 */
  pendingImport?: string;
  updatedAt: string;
}

/** 冲突记录：同一字段双方都有非空值且不一致时生成，等待人工裁决。 */
export interface ConflictRecord {
  id: string;
  packageId: string;
  packageName: string;
  versionId: string;
  versionName: string;
  draftLine: number;
  packageLine: number;
  position: number;
  char: string;
  field: MarkField;
  draftValue: string | boolean;
  incomingValue: string | boolean;
  resolved: boolean;
  resolvedAt?: string;
  resolvedValue?: string | boolean;
  createdAt: string;
}

/** 导入前无法在当前稿中找到对应行的标注，登记待人工安置，不丢弃。 */
export interface OrphanMark {
  packageLine: number;
  normalized: string;
  position: number;
  mark: CharacterMark;
}

/** 历史归档包：内容冻结，只允许写入仓或从仓中撤回，不在仓内编辑。 */
export interface ArchivePackage {
  id: string;
  name: string;
  source: string;
  archivedAt: string;
  title: string;
  author: string;
  templateId: string;
  versions: PoemVersion[];
}

/** 归档仓：只收归档包（追加 / 撤回整包），与当前校勘稿状态所有权分离。 */
export interface ArchiveState {
  schema: 1;
  packages: ArchivePackage[];
  /** 已导入当前稿的包回执；撤回整包时据此恢复导入前备份。 */
  receipts: ArchiveReceipt[];
}

export interface ArchiveReceipt {
  packageId: string;
  packageName: string;
  importedAt: string;
  targetVersionId: string;
  conflictCount: number;
  migratedCount: number;
  /** 导入前整稿备份，撤回整包时原样恢复，保证不留半套历史。 */
  backup: DraftState;
}

/**
 * 导入检查点：任何写入失败后都可从该检查点续做，或撤回整包。
 * phase 为 'checkpoint' 时说明尚未提交完成，重开页面会被识别为中断事务。
 * kind 区分「导入」与「撤回」两类事务，撤回同样走检查点，不留半套历史。
 */
export interface ImportJournal {
  phase: 'checkpoint' | 'committed';
  kind: 'import' | 'withdraw';
  package: ArchivePackage;
  receipt?: ArchiveReceipt;
  plan?: StoredPlan;
  startedAt: string;
  updatedAt: string;
  attempts: number;
  lastError?: string;
}

export interface StoredPlan {
  /** 包内各版本 → 稿方版本的匹配与迁移明细（按来源版本名/出处定身份）。 */
  pairs: StoredPlanPair[];
  matchedLines: number;
  migratedMarks: number;
  conflicts: Omit<ConflictRecord, 'id' | 'resolved' | 'createdAt'>[];
  orphans: OrphanMark[];
}

export interface StoredPlanPair {
  targetVersionId: string;
  packageVersionId: string;
  matchedLines: number;
  migratedMarks: number;
}

export interface MeterTemplate {
  id: string;
  name: string;
  summary: string;
  lineCount: number;
  lineLength: number;
  pattern: Tone[];
  rhymeLines: number[];
}

export interface AnalysisCell {
  char: string;
  position: number;
  expected: Tone;
  actual: Tone;
  status: 'correct' | 'variant' | 'error' | 'unknown' | 'neutral';
  message: string;
  mark: CharacterMark;
}

export interface AnalysisLine {
  index: number;
  lineId: string;
  cells: AnalysisCell[];
  rhymeChars: string[];
  errors: number;
  variants: number;
}

export interface PoemIssue {
  id: string;
  level: 'error' | 'warning' | 'info';
  title: string;
  detail: string;
  line?: number;
  position?: number;
}

export interface CharDiff {
  index: number;
  left: string;
  right: string;
  changed: boolean;
}
