import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  ViewChild,
  computed,
  effect,
  inject,
  signal,
} from '@angular/core';
import { MatIconModule } from '@angular/material/icon';
import { Composer } from './components/composer';
import { MessageItem } from './components/message-item';
import { HistoryDrawer } from './components/history-drawer';
import { SettingsDialog } from './components/settings-dialog';
import { DiagnosticsModal } from './components/diagnostics-modal';
import { ChatState } from './services/chat-state';

@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'app-root',
  imports: [
    MatIconModule,
    Composer,
    MessageItem,
    HistoryDrawer,
    SettingsDialog,
    DiagnosticsModal,
  ],
  templateUrl: './app.html',
  styleUrl: './app.css',
})
export class App {
  chatState = inject(ChatState);

  @ViewChild('scrollContainer') scrollContainer?: ElementRef<HTMLDivElement>;

  isHistoryOpen = signal<boolean>(false);
  isSettingsOpen = signal<boolean>(false);
  isDiagnosticsOpen = signal<boolean>(false);

  promptStarters = computed(() => {
    const isAr = this.chatState.language() === 'ar';
    if (isAr) {
      return [
        { text: 'ما هي آخر أخبار ونتائج مباريات الأهلي والزمالك والدوري اليوم؟', icon: 'sports_soccer' },
        { text: 'اشرح لي نظرية فيزيائية مع معادلة بـ LaTeX وجدول مقارنة منظم', icon: 'functions' },
        { text: 'اكتب دالة بلغة TypeScript للتحقق من أمان الروابط مع كود كامل', icon: 'code' },
        { text: 'صغ لي رسالة اعتذار رسمية ولبقة بروح مصرية راقية', icon: 'mail_outline' },
      ];
    }
    return [
      { text: 'What are today’s latest football matches and scores with live sources?', icon: 'sports_soccer' },
      { text: 'Explain a mathematical theorem using LaTeX and comparison table', icon: 'functions' },
      { text: 'Write a TypeScript utility with SSRF protection and tests', icon: 'code' },
      { text: 'Introduce yourself and your custom personality and memory capabilities', icon: 'auto_awesome' },
    ];
  });

  constructor() {
    // Scroll down automatically when new tokens arrive or message count changes
    effect(() => {
      this.chatState.currentMessages();

      setTimeout(() => {
        if (this.scrollContainer?.nativeElement) {
          const el = this.scrollContainer.nativeElement;
          el.scrollTop = el.scrollHeight;
        }
      }, 30);
    });
  }

  toggleQuickTheme() {
    const next = this.chatState.theme() === 'dark' ? 'light' : 'dark';
    this.chatState.setTheme(next);
  }
}
