import { AlignmentService } from './alignment.service';
import type { PackageLine, PoemLine } from '../models/poem.models';

const makeTarget = (texts: string[], prefix = 'line'): PoemLine[] =>
  texts.map((text, index) => ({ lineId: `${prefix}-${index}`, text, marks: {} }));

describe('AlignmentService', () => {
  let service: AlignmentService;

  beforeEach(() => {
    service = new AlignmentService();
  });

  describe('alignChars', () => {
    it('改字后标注按同一字对齐，不发生位置覆盖', () => {
      // “处处闻啼鸟” → “忽闻啼鸟处”：闻啼鸟三字应保持同一身份
      const { pairs } = service.alignChars('处处闻啼鸟', '忽闻啼鸟处');
      const map = new Map(pairs.filter((pair) => pair.target >= 0).map((pair) => [pair.source, pair.target]));
      expect(map.get(2)).toBe(1); // 闻 → 第2字
      expect(map.get(3)).toBe(2); // 啼
      expect(map.get(4)).toBe(3); // 鸟
    });

    it('插入字时后续标注随行迁移', () => {
      const { pairs } = service.alignChars('春眠晓', '春眠不觉晓');
      const map = new Map(pairs.filter((pair) => pair.target >= 0).map((pair) => [pair.source, pair.target]));
      expect(map.get(0)).toBe(0);
      expect(map.get(1)).toBe(1);
      expect(map.get(2)).toBe(4); // 晓随迁到末位
    });

    it('忽略标点，只按有效字符对齐', () => {
      const { pairs } = service.alignChars('春眠不觉晓，', '春眠不觉晓。');
      expect(pairs.length).toBe(5);
      expect(pairs.every((pair) => pair.target >= 0)).toBeTrue();
    });
  });

  describe('alignLines', () => {
    it('优先用稳定 lineId 认亲，无视顺序变化', () => {
      const source: PackageLine[] = [
        { lineId: 'b', text: '处处闻啼鸟。' },
        { lineId: 'a', text: '春眠不觉晓，' },
      ];
      const target = makeTarget(['春眠不觉晓，', '处处闻啼鸟。']);
      const result = service.alignLines(source, target);
      const first = result.find((pair) => pair.sourceIndex === 0);
      expect(first?.targetIndex).toBe(1);
      expect(first?.reason).toBe('lineId');
    });

    it('无 lineId 时按上下文与相似度匹配行', () => {
      const source: PackageLine[] = [{ text: '春眠不觉晓啊' }, { text: '处处闻啼鸟。' }, { text: '夜来风雨声，' }, { text: '花落知多少。' }];
      const target = makeTarget(['春眠不觉晓，', '处处闻啼鸟。', '夜来风雨声，', '花落知多少。']);
      const result = service.alignLines(source, target);
      expect(result.find((pair) => pair.sourceIndex === 0)?.targetIndex).toBe(0);
      expect(result.find((pair) => pair.sourceIndex === 2)?.reason).toBe('context');
    });

    it('归档多出的行标记为 insert', () => {
      const source: PackageLine[] = [{ text: '春眠不觉晓，' }, { text: '新增的一句。' }];
      const target = makeTarget(['春眠不觉晓，']);
      const result = service.alignLines(source, target);
      expect(result.find((pair) => pair.sourceIndex === 1)?.reason).toBe('insert');
    });
  });

  describe('similarity', () => {
    it('完全相同为 1，完全不同为 0', () => {
      expect(service.similarity('春眠', '春眠')).toBe(1);
      expect(service.similarity('春眠', '风雨')).toBe(0);
    });
  });
});
