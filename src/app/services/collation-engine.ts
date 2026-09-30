import type {
  CharacterMark,
  ConflictRecord,
  LineDescriptor,
  OrphanMark,
  PoemVersion,
} from '../models/poem.models';
import { MARK_FIELDS } from '../models/poem.models';

const PUNCTUATION = new Set(['，', '。', '！', '？', '；', '：', '、', ' ', '\t', '\r', '—', '－', '…']);

export function normalizedChars(line: string): string[] {
  return Array.from(line).filter((char) => !PUNCTUATION.has(char));
}

export function normalizeLine(line: string): string {
  return normalizedChars(line).join('');
}

export function splitLines(text: string): string[] {
  return text.split('\n');
}

/**
 * 行身份 = 规范化句文 + 同文句在本篇中的出现次序（#2、#3…）。
 * - 单句（含异文校勘中最常见的情形）身份就是句文本身；
 * - 重复句靠出现次序消歧，次序按「规范化句文」重新数出，
 *   因此在重复句前插入/删除其他行不会让该句的身份错乱（其序号只随同文句变化）。
 * 标点差异不影响身份。
 */
export function describeLines(text: string): LineDescriptor[] {
  const counts = new Map<string, number>();
  return splitLines(text).map((raw, index) => {
    const normalized = normalizeLine(raw);
    const order = (counts.get(normalized) ?? 0) + 1;
    counts.set(normalized, order);
    const id = order === 1 ? normalized : `${normalized}#${order}`;
    return { id, index, raw, normalized };
  });
}

export function markKey(lineId: string, position: number): string {
  return `${lineId}:${position}`;
}

export function isMeaningful(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value === 'string') return value.trim() !== '';
  if (typeof value === 'boolean') return value;
  return true;
}

/** 平仄字段以 '?' 表示未标注，按空值参与合并。 */
export function fieldIsMeaningful(field: keyof CharacterMark, value: unknown): boolean {
  if (field === 'tone' && value === '?') return false;
  return isMeaningful(value);
}

/** 标注是否完全为空（导入迁移时跳过空标注）。 */
export function isEmptyMark(mark: CharacterMark): boolean {
  return mark.tone === '?' && mark.rhyme.trim() === '' && !mark.pauseAfter && mark.basis.trim() === '' && mark.note.trim() === '';
}

export function lcsLength(a: string, b: string): number {
  const ca = Array.from(a);
  const cb = Array.from(b);
  const dp = Array.from({ length: ca.length + 1 }, () => new Array<number>(cb.length + 1).fill(0));
  for (let i = 1; i <= ca.length; i++) {
    for (let j = 1; j <= cb.length; j++) {
      dp[i][j] = ca[i - 1] === cb[j - 1] ? dp[i - 1][j - 1] + 1 : Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }
  return dp[ca.length][cb.length];
}

/**
 * 行身份对齐：按「同文优先（同文句按出现次序配对）+ 异文行 LCS 相似度 + 行序上下文」
 * 判定每一行的对应关系。返回 new 行号 -> old 行号 的一一映射。
 */
export function alignLineIndices(newLines: LineDescriptor[], oldLines: LineDescriptor[]): Map<number, number> {
  const usedOld = new Set<number>();
  const mapping = new Map<number, number>();
  const oldSeen = new Map<string, number[]>();
  oldLines.forEach((desc, oi) => {
    if (!desc.normalized) return;
    oldSeen.set(desc.normalized, [...(oldSeen.get(desc.normalized) ?? []), oi]);
  });
  const oldCursor = new Map<string, number>();

  // 第一轮：同文句按出现次序直接配对（上下文来源的行身份判定）
  newLines.forEach((desc, ni) => {
    if (!desc.normalized) return;
    const candidates = oldSeen.get(desc.normalized);
    if (!candidates) return;
    const cursor = oldCursor.get(desc.normalized) ?? 0;
    if (cursor < candidates.length) {
      const oi = candidates[cursor];
      oldCursor.set(desc.normalized, cursor + 1);
      usedOld.add(oi);
      mapping.set(ni, oi);
    }
  });

  // 第二轮：未配上的异文行按相似度 + 行序加权贪心匹配
  const pendingNew = newLines.map((_, ni) => ni).filter((ni) => !mapping.has(ni) && newLines[ni].normalized);
  const candidates: { ni: number; oi: number; score: number }[] = [];
  pendingNew.forEach((ni) => {
    const a = newLines[ni];
    oldLines.forEach((b, oi) => {
      if (usedOld.has(oi) || !b.normalized) return;
      const lcs = lcsLength(a.normalized, b.normalized);
      const similarity = (2 * lcs) / (a.normalized.length + b.normalized.length);
      if (similarity < 0.45) return;
      const order = 1 - Math.min(Math.abs(ni - oi), newLines.length) / newLines.length;
      candidates.push({ ni, oi, score: similarity * 0.9 + order * 0.1 });
    });
  });
  candidates.sort((x, y) => y.score - x.score);
  candidates.forEach(({ ni, oi }) => {
    if (mapping.has(ni) || usedOld.has(oi)) return;
    mapping.set(ni, oi);
    usedOld.add(oi);
  });

  return mapping;
}

/**
 * 行内字级对齐：返回 old 字位 -> new 字位 的映射（LCS 公共字对齐）。
 * 改字、异文导致的串位由此消化：标注挂到对齐后的同一字上，而非按原始位置覆盖。
 */
export function alignPositions(newLine: string, oldLine: string): Map<number, number> {
  const a = normalizedChars(newLine);
  const b = normalizedChars(oldLine);
  const dp = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] = a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] + 1 : Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }
  const result = new Map<number, number>();
  let i = a.length;
  let j = b.length;
  while (i > 0 && j > 0) {
    if (a[i - 1] === b[j - 1]) {
      result.set(j - 1, i - 1);
      i -= 1;
      j -= 1;
    } else if (dp[i - 1][j] >= dp[i][j - 1]) {
      i -= 1;
    } else {
      j -= 1;
    }
  }
  return result;
}

export interface MergePlan {
  matchedLines: number;
  migratedMarks: number;
  /** 合并后的整份标注（稿方拷贝 + 自动合并结果；冲突字段保持稿方值）。 */
  marks: Record<string, CharacterMark>;
  /** draft 行号 -> package 行号（供冲突定位） */
  lineMapping: Map<number, number>;
  conflicts: ConflictRecord[];
  orphans: OrphanMark[];
}

let conflictSeq = 0;
function conflictId(): string {
  conflictSeq += 1;
  return `conflict-${Date.now().toString(36)}-${conflictSeq}`;
}

export function valuesEqual(a: unknown, b: unknown): boolean {
  return a === b;
}

/**
 * 把归档包中某个版本的标注合并进当前稿：
 * - 行身份由来源版本名/出处选定目标版本，行级按上下文（同文次序、相似度、行序）对齐；
 * - 字位按 LCS 对齐迁移标注；
 * - 不同字段自动合并（稿方空 / 包方有 → 直接收）；
 * - 同一字段双方都有非空值且不一致 → 冲突记录，留给人裁决；
 * - 找不到对应行、或对应字已不存在的标注登记为孤儿标注，绝不静默丢弃。
 */
export function mergeVersionMarks(
  draft: PoemVersion,
  incoming: PoemVersion,
  packageId: string,
  packageName: string,
): MergePlan {
  const draftDesc = describeLines(draft.text);
  const incomingDesc = describeLines(incoming.text);
  const lineMapping = alignLineIndices(draftDesc, incomingDesc); // draft 行 -> incoming 行
  const conflicts: ConflictRecord[] = [];
  const orphans: OrphanMark[] = [];
  const marks: Record<string, CharacterMark> = structuredClone(draft.marks);
  let migratedMarks = 0;
  const now = new Date().toISOString();
  const matchedIncoming = new Set<number>();

  lineMapping.forEach((bi) => matchedIncoming.add(bi));

  lineMapping.forEach((bi, ai) => {
    const target = draftDesc[ai];
    const source = incomingDesc[bi];
    const incomingByPos = collectLineMarks(incoming.marks, source.id);
    if (incomingByPos.size === 0) return;
    const positionMap = alignPositions(target.raw, source.raw); // incoming 旧字位 -> draft 新字位
    incomingByPos.forEach((incomingMark, incomingPos) => {
      const draftPos = positionMap.get(incomingPos);
      if (draftPos === undefined) {
        orphans.push({ packageLine: bi, normalized: source.normalized, position: incomingPos, mark: incomingMark });
        return;
      }
      const key = markKey(target.id, draftPos);
      const draftMark = marks[key];
      migratedMarks += 1;
      if (!draftMark) {
        marks[key] = { ...incomingMark };
        return;
      }
      const merged: CharacterMark = { ...draftMark };
      MARK_FIELDS.forEach((field) => {
        const incomingValue = incomingMark[field];
        if (!fieldIsMeaningful(field, incomingValue)) return;
        if (!fieldIsMeaningful(field, draftMark[field])) {
          (merged[field] as string | boolean) = incomingValue as string | boolean;
          return;
        }
        if (!valuesEqual(draftMark[field], incomingValue)) {
          conflicts.push({
            id: conflictId(),
            packageId,
            packageName,
            versionId: draft.id,
            versionName: draft.name,
            draftLine: ai,
            packageLine: bi,
            position: draftPos,
            char: normalizedChars(target.raw)[draftPos] ?? '',
            field,
            draftValue: draftMark[field] as string | boolean,
            incomingValue: incomingValue as string | boolean,
            resolved: false,
            createdAt: now,
          });
        }
      });
      marks[key] = merged;
    });
  });

  // 未匹配上的整行：其标注全部登记为孤儿
  incomingDesc.forEach((desc, bi) => {
    if (matchedIncoming.has(bi) || !desc.normalized) return;
    collectLineMarks(incoming.marks, desc.id).forEach((mark, position) => {
      orphans.push({ packageLine: bi, normalized: desc.normalized, position, mark });
    });
  });

  return { matchedLines: lineMapping.size, migratedMarks, marks, lineMapping, conflicts, orphans };
}

function collectLineMarks(marks: Record<string, CharacterMark>, lineId: string): Map<number, CharacterMark> {
  const result = new Map<number, CharacterMark>();
  const prefix = `${lineId}:`;
  Object.entries(marks).forEach(([key, mark]) => {
    if (!key.startsWith(prefix) || isEmptyMark(mark)) return;
    const position = Number(key.slice(prefix.length));
    if (Number.isFinite(position)) result.set(position, mark);
  });
  return result;
}

/**
 * 当前稿改字时，把旧行身份下的标注按行对齐 + 行内 LCS 迁到新行身份，
 * 解决「改字后标注串位」：公共字标注随行迁移，被删字/被删整行的标注计数后提示。
 */
export function migrateMarksForTextChange(
  oldText: string,
  newText: string,
  oldMarks: Record<string, CharacterMark>,
): { marks: Record<string, CharacterMark>; dropped: number } {
  const oldDesc = describeLines(oldText);
  const newDesc = describeLines(newText);
  const mapping = alignLineIndices(newDesc, oldDesc); // 新行 -> 旧行
  const marks: Record<string, CharacterMark> = {};
  let dropped = 0;
  const matchedOld = new Set<number>();
  mapping.forEach((oi) => matchedOld.add(oi));

  newDesc.forEach((target, ni) => {
    const oi = mapping.get(ni);
    if (oi === undefined) return;
    const oldLine = oldDesc[oi];
    const positionMap = alignPositions(target.raw, oldLine.raw); // 旧字位 -> 新字位
    collectLineMarks(oldMarks, oldLine.id).forEach((mark, oldPos) => {
      const newPos = positionMap.get(oldPos);
      if (newPos === undefined) {
        dropped += 1;
        return;
      }
      marks[markKey(target.id, newPos)] = structuredClone(mark);
    });
  });

  // 整行被删除：该行全部标注计入丢失
  oldDesc.forEach((desc, oi) => {
    if (matchedOld.has(oi)) return;
    dropped += collectLineMarks(oldMarks, desc.id).size;
  });

  return { marks, dropped };
}

/** 对仗关系按行身份（规范化句文 + 出现次序）随行迁移。 */
export function migrateAntithesis(oldText: string, newText: string, pairs: PoemVersion['antithesisPairs']): PoemVersion['antithesisPairs'] {
  const oldDesc = describeLines(oldText);
  const mapping = alignLineIndices(describeLines(newText), oldDesc); // 新行 -> 旧行
  const oldToNew = new Map<number, number>();
  mapping.forEach((oi, ni) => oldToNew.set(oi, ni));
  const maxIndex = describeLines(newText).length - 1;
  return pairs.map((pair) => ({
    ...pair,
    leftLine: oldToNew.get(pair.leftLine) ?? Math.min(pair.leftLine, maxIndex),
    rightLine: oldToNew.get(pair.rightLine) ?? Math.min(pair.rightLine, maxIndex),
  }));
}

export function conflictFingerprint(record: Pick<ConflictRecord, 'packageId' | 'versionId' | 'draftLine' | 'position' | 'field'>): string {
  return `${record.packageId}|${record.versionId}|${record.draftLine}|${record.position}|${record.field}`;
}
