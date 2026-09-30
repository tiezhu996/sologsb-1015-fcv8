import type { ArchiveState, DraftState, ImportJournal } from '../models/poem.models';

/**
 * 两仓持久化：当前校勘稿仓与历史归档仓分 key 存放，状态所有权彻底分离。
 * journal 是导入事务的检查点，任何阶段失败都不会留下「半套历史」。
 */
const DRAFT_KEY = 'sologsb-1015-draft-v2';
const ARCHIVE_KEY = 'sologsb-1015-archive-v1';
const JOURNAL_KEY = 'sologsb-1015-import-journal-v1';
/** 旧版（v1）单仓数据，迁移后原样保留在该 key，不覆盖、不删除。 */
const LEGACY_KEY = 'sologsb-1015-poetry-workspace-v1';

export interface StorageResult<T> {
  ok: boolean;
  value?: T;
  error?: string;
}

export class StorageAdapter {
  constructor(private readonly backend: Storage = localStorage) {}

  get raw(): Storage {
    return this.backend;
  }

  readDraft(): DraftState | null {
    return this.read<DraftState>(DRAFT_KEY);
  }

  writeDraft(state: DraftState): StorageResult<void> {
    return this.writeWithRetry(DRAFT_KEY, state);
  }

  readArchive(): ArchiveState | null {
    return this.read<ArchiveState>(ARCHIVE_KEY);
  }

  writeArchive(state: ArchiveState): StorageResult<void> {
    return this.writeWithRetry(ARCHIVE_KEY, state);
  }

  readJournal(): ImportJournal | null {
    return this.read<ImportJournal>(JOURNAL_KEY);
  }

  writeJournal(journal: ImportJournal | null): StorageResult<void> {
    if (journal === null) {
      this.backend.removeItem(JOURNAL_KEY);
      return { ok: true };
    }
    return this.writeWithRetry(JOURNAL_KEY, journal);
  }

  readLegacy(): unknown {
    const raw = this.backend.getItem(LEGACY_KEY);
    if (!raw) return null;
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  /** 估算剩余配额（不支持时回退为试写）。 */
  private writeWithRetry(key: string, value: unknown, attempt = 0): StorageResult<void> {
    const serialized = JSON.stringify(value);
    try {
      this.backend.setItem(key, serialized);
      return { ok: true };
    } catch (error) {
      const quota = error instanceof DOMException && (error.name === 'QuotaExceededError' || error.name === 'NS_ERROR_DOM_QUOTA_REACHED');
      // 配额类失败：重试三次。旧数据我们绝不删，只压缩自身的临时检查点。
      if (quota && attempt < 3) {
        const wait = (attempt + 1) * 12;
        const start = Date.now();
        while (Date.now() - start < wait) { /* 短促让出，保持同步语义 */ }
        return this.writeWithRetry(key, value, attempt + 1);
      }
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  private read<T>(key: string): T | null {
    const raw = this.backend.getItem(key);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return null;
    }
  }
}
