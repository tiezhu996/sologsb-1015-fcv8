export type Tone = '平' | '仄' | '中' | '?';
export type MarkTone = '平' | '仄' | '中';

/** 可在导入时按字段自动合并 / 冲突裁决的标注字段名 */
export type MarkField = 'tone' | 'rhyme' | 'pauseAfter' | 'basis' | 'note';
export const MARK_FIELDS: MarkField[] = ['tone', 'rhyme', 'pauseAfter', 'basis', 'note'];

/** 标注字段名（含行文本这一虚拟字段） */
export type MergeField = MarkField | 'text';

export interface CharacterMark {
  tone: MarkTone | '?';
  rhyme: string;
  pauseAfter: boolean;
  basis: string;
  note: string;
  /** 每个字段值来源的归档包 id；人工编辑后对应字段来源被清除 */
  fieldSources?: Partial<Record<MergeField, string>>;
}

/** 一句诗：拥有稳定身份 lineId，标注按“句 + 句内字位”存放，不跨句错位 */
export interface PoemLine {
  lineId: string;
  text: string;
  marks: Record<number, CharacterMark>;
}

export interface PoemVersion {
  id: string;
  name: string;
  source: string;
  createdAt: string;
  lines: PoemLine[];
  antithesisPairs: AntithesisPair[];
}

export interface AntithesisPair {
  id: string;
  leftLine: number;
  rightLine: number;
  note: string;
}

export interface PoemWorkspace {
  title: string;
  author: string;
  templateId: string;
  versions: PoemVersion[];
  activeVersionId: string;
  updatedAt: string;
}

/** 当前校勘稿仓：可自由编辑；冲突裁决记录也挂在这里 */
export interface DraftState {
  schema: 2;
  workspace: PoemWorkspace;
  conflicts: FieldConflict[];
}

/** 历史底稿仓：只追加归档包，任何编辑动作都不写这里 */
export interface ArchiveState {
  schema: 2;
  packages: ArchivePackage[];
}

export type PackageKind = 'snapshot' | 'import' | 'migration';
export type PackageStatus = 'applied' | 'withdrawn';

/** 归档包：导入/归档时原样留存的不可变快照 */
export interface ArchivePackage {
  id: string;
  kind: PackageKind;
  label: string;
  source: string;
  note: string;
  createdAt: string;
  status: PackageStatus;
  /** 归档时整份工作区快照（snapshot / migration） */
  workspace?: PoemWorkspace;
  /** 导入包携带的版本 */
  versions?: PackageVersion[];
  /** migration 包额外保留的旧格式原文，确保原内容不丢 */
  legacyRaw?: string;
}

/** 导入包中的版本（行内文本即行身份线索） */
export interface PackageVersion {
  id?: string;
  name: string;
  source: string;
  lines: PackageLine[];
  antithesisPairs?: AntithesisPair[];
}

export interface PackageLine {
  lineId?: string;
  text: string;
  marks?: Record<number, CharacterMark>;
}

/** 同一字段、双方都有值且不一致时留给人裁决 */
export interface FieldConflict {
  id: string;
  packageId: string;
  versionId: string;
  lineId: string;
  position: number | null;
  field: MergeField;
  incomingValue: string | boolean | null;
  currentValue: string | boolean | null;
  resolution: ConflictResolution | null;
  createdAt: string;
}

export type ConflictResolution = 'incoming' | 'current' | { custom: string | boolean };

/** 导入事务的检查点状态 */
export type TxnPhase = 'prepare' | 'archive-written' | 'draft-applied';

export interface ImportTransaction {
  id: string;
  packageId: string;
  pkg: ArchivePackage;
  plan: ImportPlan;
  phase: TxnPhase;
  createdAt: string;
  updatedAt: string;
  error: string;
}

/** 导入前计算好的合并计划：应用与撤回都按它执行 */
export interface ImportPlan {
  versionOps: VersionOp[];
  lineOps: LineOp[];
  fieldOps: FieldOp[];
  pairOps: PairOp[];
  conflicts: FieldConflict[];
}

export interface VersionOp {
  type: 'addVersion';
  versionId: string;
  name: string;
  source: string;
}

export type LineOp =
  | { type: 'addLine'; versionId: string; index: number; lineId: string; text: string }
  | { type: 'updateLineText'; versionId: string; lineId: string; from: string; to: string };

export interface FieldOp {
  versionId: string;
  lineId: string;
  position: number | null;
  field: MergeField;
  /** 空值表示自动合并（仅在当前为空时填入）；非空值表示冲突解决后才落值 */
  autoFill: string | boolean | null;
  incomingValue: string | boolean | null;
  conflictId: string | null;
}

export interface PairOp {
  type: 'addPair';
  versionId: string;
  pair: AntithesisPair;
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

/** 旧版 v1 存储形状（首启迁移用） */
export interface LegacyWorkspaceV1 {
  title: string;
  author: string;
  templateId: string;
  versions: Array<{
    id: string;
    name: string;
    source: string;
    createdAt: string;
    text: string;
    marks: Record<string, CharacterMark>;
    antithesisPairs: AntithesisPair[];
  }>;
  activeVersionId: string;
  updatedAt: string;
}
