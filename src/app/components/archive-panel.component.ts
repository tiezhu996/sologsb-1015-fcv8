import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { NzAlertModule } from 'ng-zorro-antd/alert';
import { NzButtonModule } from 'ng-zorro-antd/button';
import { NzDividerModule } from 'ng-zorro-antd/divider';
import { NzEmptyModule } from 'ng-zorro-antd/empty';
import { NzInputModule } from 'ng-zorro-antd/input';
import { NzRadioModule } from 'ng-zorro-antd/radio';
import { NzTagModule } from 'ng-zorro-antd/tag';
import { NzToolTipModule } from 'ng-zorro-antd/tooltip';
import type { ArchivePackage, ConflictRecord } from '../models/poem.models';
import { MARK_FIELD_LABELS } from '../models/poem.models';
import { PoetryStoreService } from '../services/poetry-store.service';

/**
 * 历史底稿页：归档仓只展示/接收冻结包；导入走检查点事务；
 * 字段冲突在此由人裁决，未安置标注在此人工安置。
 */
@Component({
  selector: 'app-archive-panel',
  imports: [CommonModule, FormsModule, NzAlertModule, NzButtonModule, NzDividerModule, NzEmptyModule, NzInputModule, NzRadioModule, NzTagModule, NzToolTipModule],
  templateUrl: './archive-panel.component.html',
  styleUrl: './archive-panel.component.less',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ArchivePanelComponent {
  readonly store = inject(PoetryStoreService);
  readonly fieldLabels = MARK_FIELD_LABELS;
  readonly fileError = signal('');
  readonly fileInputKey = signal(0);

  customChoice: Record<string, 'draft' | 'incoming' | 'custom'> = {};
  customValue: Record<string, string> = {};

  onFileSelected(event: Event): void {
    this.fileError.set('');
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const parsed = JSON.parse(String(reader.result));
        const result = this.store.importPackage(parsed);
        if (!result.ok) this.fileError.set(result.error ?? '导入失败');
      } catch (error) {
        this.fileError.set(`无法解析文件：${error instanceof Error ? error.message : String(error)}`);
      } finally {
        input.value = '';
      }
    };
    reader.onerror = () => this.fileError.set('读取文件失败，请重试。');
    reader.readAsText(file, 'utf-8');
  }

  fieldValue(value: string | boolean): string {
    return typeof value === 'boolean' ? (value ? '有' : '无') : String(value);
  }

  choiceFor(conflict: ConflictRecord): 'draft' | 'incoming' | 'custom' {
    return this.customChoice[conflict.id] ?? 'draft';
  }

  setChoice(conflict: ConflictRecord, choice: 'draft' | 'incoming' | 'custom'): void {
    this.customChoice[conflict.id] = choice;
  }

  submitConflict(conflict: ConflictRecord): void {
    const choice = this.choiceFor(conflict);
    if (choice === 'custom') {
      const raw = this.customValue[conflict.id] ?? '';
      if (conflict.field === 'pauseAfter') {
        this.store.resolveConflict(conflict.id, 'custom', raw === 'true');
      } else if (conflict.field === 'tone') {
        const tone = raw.trim();
        if (tone !== '平' && tone !== '仄' && tone !== '中') {
          this.fileError.set('平仄自定义值只能是 平 / 仄 / 中');
          return;
        }
        this.store.resolveConflict(conflict.id, 'custom', tone);
      } else {
        this.store.resolveConflict(conflict.id, 'custom', raw);
      }
    } else {
      this.store.resolveConflict(conflict.id, choice);
    }
  }

  download(pkg: ArchivePackage): void {
    this.store.downloadPackage(pkg);
  }

  withdraw(pkg: ArchivePackage): void {
    this.store.withdrawCommittedPackage(pkg.id);
  }
}
