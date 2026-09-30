import { Injectable } from '@angular/core';
import type { PackageLine, PoemLine } from '../models/poem.models';

export interface AlignedPair {
  /** 目标行下标，-1 表示归档行无对应（新增） */
  targetIndex: number;
  /** 归档行下标，-1 表示目标多出的行 */
  sourceIndex: number;
  /** 0~1 匹配置信度 */
  score: number;
  reason: 'lineId' | 'context' | 'similarity' | 'insert' | 'orphan';
}

export interface CharMapping {
  /** 归档字符句内序号 → 目标字符句内序号（仅汉字/有效字符，-1 表示新增对不上） */
  pairs: Array<{ source: number; target: number }>;
}

/**
 * 行身份判定与字符对齐。
 * 导入时不依赖脆弱的字符位置覆盖：先按稳定 lineId，再按来源上下文（序号与邻句），
 * 最后按文本相似度决定行身份；行内再用 Needleman–Wunsch 对齐字符，
 * 让逐字标注随“同一字”迁移，改字/增字后不再串位。
 */
@Injectable({ providedIn: 'root' })
export class AlignmentService {
  alignLines(source: PackageLine[], target: PoemLine[]): AlignedPair[] {
    const result: AlignedPair[] = [];
    const usedTargets = new Set<number>();

    // 第一轮：稳定 lineId 直接认亲
    source.forEach((src, sourceIndex) => {
      if (!src.lineId) return;
      const targetIndex = target.findIndex((line) => line.lineId === src.lineId);
      if (targetIndex >= 0 && !usedTargets.has(targetIndex)) {
        usedTargets.add(targetIndex);
        result.push({ sourceIndex, targetIndex, score: 1, reason: 'lineId' });
      }
    });

    // 第二轮：按上下文（相同句序、邻句文本互相印证）
    source.forEach((src, sourceIndex) => {
      if (result.some((pair) => pair.sourceIndex === sourceIndex)) return;
      const candidates = target
        .map((line, targetIndex) => ({ line, targetIndex }))
        .filter(({ targetIndex }) => !usedTargets.has(targetIndex));
      if (!candidates.length) return;

      const atSameIndex = candidates.find(({ targetIndex }) => targetIndex === sourceIndex);
      const contextHit = atSameIndex && this.contextMatches(source, sourceIndex, target, atSameIndex.targetIndex) ? atSameIndex : undefined;
      if (contextHit) {
        usedTargets.add(contextHit.targetIndex);
        result.push({ sourceIndex, targetIndex: contextHit.targetIndex, score: 0.9, reason: 'context' });
        return;
      }

      // 第三轮：文本相似度
      const scored = candidates.map(({ targetIndex }) => ({ targetIndex, score: this.similarity(src.text, target[targetIndex].text) }));
      const best = scored.sort((a, b) => b.score - a.score)[0];
      if (best && best.score >= 0.5) {
        usedTargets.add(best.targetIndex);
        result.push({ sourceIndex, targetIndex: best.targetIndex, score: best.score, reason: 'similarity' });
      }
    });

    // 归档行仍无对应：作为新增行
    source.forEach((_, sourceIndex) => {
      if (!result.some((pair) => pair.sourceIndex === sourceIndex)) {
        result.push({ sourceIndex, targetIndex: -1, score: 0, reason: 'insert' });
      }
    });
    // 目标多出的行（撤回合并时不需要处理，这里仅备查）
    target.forEach((_, targetIndex) => {
      if (!usedTargets.has(targetIndex)) {
        result.push({ sourceIndex: -1, targetIndex, score: 0, reason: 'orphan' });
      }
    });

    return result.sort((a, b) => a.sourceIndex - b.sourceIndex);
  }

  /** 句内字符对齐：返回 归档字符序号 → 目标字符序号 */
  alignChars(sourceText: string, targetText: string): CharMapping {
    const source = Array.from(this.validChars(sourceText));
    const target = Array.from(this.validChars(targetText));
    const n = source.length;
    const m = target.length;
    const gap = -1;
    const match = 2;
    const mismatch = -1;

    const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
    for (let i = 1; i <= n; i++) dp[i][0] = i * gap;
    for (let j = 1; j <= m; j++) dp[0][j] = j * gap;
    for (let i = 1; i <= n; i++) {
      for (let j = 1; j <= m; j++) {
        const diag = dp[i - 1][j - 1] + (source[i - 1] === target[j - 1] ? match : mismatch);
        dp[i][j] = Math.max(diag, dp[i - 1][j] + gap, dp[i][j - 1] + gap);
      }
    }

    const pairs: Array<{ source: number; target: number }> = [];
    let i = n;
    let j = m;
    while (i > 0 || j > 0) {
      if (i > 0 && j > 0 && dp[i][j] === dp[i - 1][j - 1] + (source[i - 1] === target[j - 1] ? match : mismatch)) {
        pairs.push({ source: i - 1, target: j - 1 });
        i--;
        j--;
      } else if (i > 0 && dp[i][j] === dp[i - 1][j] + gap) {
        // 归档字在目标中被删：标注无法随行，交由调用方挂到最近邻位（此处不迁移）
        pairs.push({ source: i - 1, target: -1 });
        i--;
      } else {
        j--;
      }
    }
    pairs.reverse();
    return { pairs };
  }

  similarity(a: string, b: string): number {
    const left = Array.from(this.validChars(a));
    const right = Array.from(this.validChars(b));
    if (!left.length || !right.length) return 0;
    const set = new Set([...left, ...right]);
    let common = 0;
    set.forEach((char) => {
      common += Math.min(left.filter((c) => c === char).length, right.filter((c) => c === char).length);
    });
    return (2 * common) / (left.length + right.length);
  }

  private contextMatches(source: PackageLine[], sourceIndex: number, target: PoemLine[], targetIndex: number): boolean {
    // 前后邻句任一条能对上（lineId 或高相似度），即认为上下文成立
    const checks: Array<[number, number]> = [
      [sourceIndex - 1, targetIndex - 1],
      [sourceIndex + 1, targetIndex + 1],
    ];
    return checks.some(([si, ti]) => {
      if (si < 0 || ti < 0 || si >= source.length || ti >= target.length) return false;
      if (source[si].lineId && source[si].lineId === target[ti].lineId) return true;
      return this.similarity(source[si].text, target[ti].text) >= 0.5;
    });
  }

  private validChars(text: string): string {
    const punctuation = new Set(['，', '。', '！', '？', '；', '：', '、', ' ', '\t', ',', '.', '!', '?', ';', ':', '"', "'", '「', '」', '『', '』', '（', '）', '(', ')', '【', '】', '《', '》', '-', '—', '…', '·']);
    return Array.from(text)
      .filter((char) => !punctuation.has(char) && !/\s/.test(char))
      .join('');
  }
}
