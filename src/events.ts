/**
 * ゲームイベントの型定義
 */
export interface GameEvent {
  type: 'game_start' | 'role_assignment' | 'day_start' | 'statement' | 'vote' | 'execution' | 'night_start' | 'night_action' | 'game_end';
  data: any;
  timestamp: number;
}

/**
 * イベントエミッター（簡易実装）
 */
export class EventEmitter {
  private listeners: Map<string, Array<(data: any) => void>> = new Map();

  on(event: string, callback: (data: any) => void): void {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, []);
    }
    this.listeners.get(event)!.push(callback);
  }

  emit(event: string, data: any): void {
    const callbacks = this.listeners.get(event);
    if (callbacks) {
      callbacks.forEach(callback => {
        try {
          callback(data);
        } catch (err) {
          try { console.error(`[EventEmitter] listener error on ${event}:`, err); } catch(e) {}
        }
      });
    }
  }

  removeAllListeners(): void {
    this.listeners.clear();
  }
}
