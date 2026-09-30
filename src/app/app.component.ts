import { ChangeDetectionStrategy, Component, HostListener, computed, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { NzAlertModule } from 'ng-zorro-antd/alert';
import { NzBadgeModule } from 'ng-zorro-antd/badge';
import { NzButtonModule } from 'ng-zorro-antd/button';
import { NzDividerModule } from 'ng-zorro-antd/divider';
import { NzEmptyModule } from 'ng-zorro-antd/empty';
import { NzInputModule } from 'ng-zorro-antd/input';
import { NzProgressModule } from 'ng-zorro-antd/progress';
import { NzSelectModule } from 'ng-zorro-antd/select';
import { NzSwitchModule } from 'ng-zorro-antd/switch';
import { NzTabsModule } from 'ng-zorro-antd/tabs';
import { NzTagModule } from 'ng-zorro-antd/tag';
import { NzToolTipModule } from 'ng-zorro-antd/tooltip';
import { FIELD_LABELS, METER_TEMPLATES, PoetryStoreService } from './services/poetry-store.service';
import type { FieldConflict, PackageVersion } from './models/poem.models';

const PACKAGE_KIND_LABELS: Record<string, string> = {
  snapshot: '阶段归档',
  import: '归档包导入',
  migration: '旧稿迁移',
};

@Component({
  selector: 'app-root',
  imports: [
    CommonModule,
    FormsModule,
    NzAlertModule,
    NzBadgeModule,
    NzButtonModule,
    NzDividerModule,
    NzEmptyModule,
    NzInputModule,
    NzProgressModule,
    NzSelectModule,
    NzSwitchModule,
    NzTabsModule,
    NzTagModule,
    NzToolTipModule,
  ],
  templateUrl: './app.component.html',
  styleUrl: './app.component.less',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AppComponent {
  readonly store = inject(PoetryStoreService);
  readonly templates = METER_TEMPLATES;
  readonly selectedCell = computed(() => this.store.selectedCell());
  readonly fieldLabels = FIELD_LABELS;
  readonly kindLabels = PACKAGE_KIND_LABELS;
  readonly activeTab = signal(0);

  readonly importJson = signal('');

  get totalErrors(): number {
    return this.store.issues().filter((issue) => issue.level === 'error').length;
  }

  get totalWarnings(): number {
    return this.store.issues().filter((issue) => issue.level === 'warning').length;
  }

  get checkedRate(): number {
    const cells = this.store.analysis().flatMap((line) => line.cells);
    if (!cells.length) return 0;
    return Math.round((cells.filter((cell) => cell.actual !== '?').length / cells.length) * 100);
  }

  setTone(tone: '平' | '仄' | '中' | '?'): void {
    this.store.setMark({ tone });
  }

  updateSource(source: string): void {
    this.store.setMark({ basis: source });
  }

  updateVersionSource(source: string): void {
    this.store.updateVersionSource(source);
  }

  activeText(): string {
    return this.store.activeVersion().lines.map((line) => line.text).join('\n');
  }

  versionPreview(version: { lines: Array<{ text: string }> }): string {
    return version.lines.map((line) => line.text).join(' / ');
  }

  trackTemplate(index: number, item: (typeof METER_TEMPLATES)[number]): string {
    return item.id;
  }

  // ── 归档与导入 ──

  submitImport(): void {
    try {
      const parsed = this.store.parseImportJson(this.importJson());
      this.store.importPackage(parsed);
      this.importJson.set('');
      this.activeTab.set(3);
    } catch (error) {
      this.store.importError.set((error as Error).message);
    }
  }

  onImportFile(event: Event): void {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => this.importJson.set(String(reader.result ?? ''));
    reader.readAsText(file, 'utf-8');
    input.value = '';
  }

  exportImportPackage(): void {
    const workspace = this.store.workspace();
    const versions: PackageVersion[] = workspace.versions.map((version) => ({
      id: version.id,
      name: version.name,
      source: version.source,
      lines: version.lines.map((line) => ({
        lineId: line.lineId,
        text: line.text,
        marks: line.marks,
      })),
      antithesisPairs: version.antithesisPairs,
    }));
    const payload = {
      label: `${workspace.title} · 归档交换包`,
      source: '古诗格律校勘台',
      note: `由 ${workspace.title} 导出`,
      versions,
    };
    const anchor = document.createElement('a');
    anchor.href = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json;charset=utf-8' }));
    anchor.download = `${workspace.title}-归档包.json`;
    anchor.click();
    URL.revokeObjectURL(anchor.href);
  }

  retryImport(): void {
    try {
      this.store.resumeImport();
    } catch (error) {
      this.store.importError.set((error as Error).message);
    }
  }

  withdraw(packageId: string): void {
    this.store.withdrawPackage(packageId);
  }

  // ── 冲突裁决 ──

  versionName(versionId: string): string {
    return this.store.workspace().versions.find((version) => version.id === versionId)?.name ?? '已移除版本';
  }

  conflictLocation(conflict: FieldConflict): string {
    const version = this.store.workspace().versions.find((item) => item.id === conflict.versionId);
    const lineIndex = version?.lines.findIndex((line) => line.lineId === conflict.lineId) ?? -1;
    const linePart = lineIndex >= 0 ? `第 ${lineIndex + 1} 句` : '行已移除';
    return conflict.position === null ? linePart : `${linePart} · 第 ${conflict.position + 1} 字`;
  }

  conflictDisplay(value: string | boolean | null): string {
    if (value === null || value === '') return '（空）';
    if (typeof value === 'boolean') return value ? '有停顿' : '无停顿';
    return String(value);
  }

  chooseIncoming(conflict: FieldConflict): void {
    this.store.resolveConflict(conflict.id, 'incoming');
  }

  chooseCurrent(conflict: FieldConflict): void {
    this.store.resolveConflict(conflict.id, 'current');
  }

  @HostListener('document:keydown', ['$event'])
  handleKeyboard(event: KeyboardEvent): void {
    const target = event.target as HTMLElement | null;
    const inTextEntry = target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target?.getAttribute('contenteditable') === 'true';
    const command = event.ctrlKey || event.metaKey;

    if (command && event.key.toLowerCase() === 'z') {
      event.preventDefault();
      event.shiftKey ? this.store.redo() : this.store.undo();
      return;
    }
    if (command && event.key.toLowerCase() === 'y') {
      event.preventDefault();
      this.store.redo();
      return;
    }
    if (command && event.key.toLowerCase() === 's') {
      event.preventDefault();
      this.store.toast.set('内容已保存在本机');
      return;
    }
    if (inTextEntry) return;

    if (event.key === 'ArrowLeft') {
      event.preventDefault();
      const line = this.store.analysis()[this.store.selectedLine()];
      const next = Math.max(0, this.store.selectedPosition() - 1);
      this.store.selectCell(this.store.selectedLine(), Math.min(next, Math.max(0, line?.cells.length - 1)));
    } else if (event.key === 'ArrowRight') {
      event.preventDefault();
      const line = this.store.analysis()[this.store.selectedLine()];
      const next = Math.min((line?.cells.length ?? 1) - 1, this.store.selectedPosition() + 1);
      this.store.selectCell(this.store.selectedLine(), next);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      const next = Math.max(0, this.store.selectedLine() - 1);
      const max = Math.max(0, (this.store.analysis()[next]?.cells.length ?? 1) - 1);
      this.store.selectCell(next, Math.min(this.store.selectedPosition(), max));
    } else if (event.key === 'ArrowDown') {
      event.preventDefault();
      const next = Math.min(this.store.analysis().length - 1, this.store.selectedLine() + 1);
      const max = Math.max(0, (this.store.analysis()[next]?.cells.length ?? 1) - 1);
      this.store.selectCell(next, Math.min(this.store.selectedPosition(), max));
    } else if (event.key === '1') {
      this.setTone('平');
    } else if (event.key === '2') {
      this.setTone('仄');
    } else if (event.key === '3') {
      this.setTone('中');
    } else if (event.key === ' ') {
      event.preventDefault();
      this.store.togglePause();
    } else if (event.key.toLowerCase() === 'r') {
      this.store.cycleRhyme();
    }
  }
}
