import { useState } from "preact/hooks";

interface MessageComposerProps {
  /** event timeline トラックの publisher が active でないときは true */
  disabled: boolean;
  /** 送信するメッセージ (前後の空白を除いたもの) */
  onSend: (text: string) => void;
  /** event timeline に送ったメッセージの数 */
  sentCount: number;
}

/**
 * event timeline に送るチャットのメッセージの入力欄
 *
 * Enter キーでも送信できる。空のメッセージは送らない (data.text が空の entry を
 * 作らない)。配信を始めていない間は入力も送信も無効にする
 */
export function MessageComposer({ disabled, onSend, sentCount }: MessageComposerProps) {
  const [text, setText] = useState("");
  const trimmed = text.trim();
  const sendDisabled = disabled || trimmed.length === 0;

  const send = () => {
    if (sendDisabled) return;
    onSend(trimmed);
    setText("");
  };

  return (
    <div
      class="rounded-lg px-3 py-2 mb-4 border bg-green-50 border-green-200"
      data-testid="publisher-messages"
    >
      <h3 class="text-xs font-semibold uppercase tracking-wide mb-1 flex items-center gap-1.5 text-green-700">
        <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path
            stroke-linecap="round"
            stroke-linejoin="round"
            stroke-width="2"
            d="M8 10h.01M12 10h.01M16 10h.01M9 16H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-5l-5 5v-5z"
          />
        </svg>
        Messages
      </h3>
      <div class="flex gap-2">
        <input
          type="text"
          value={text}
          onInput={(event) => setText(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              send();
            }
          }}
          disabled={disabled}
          placeholder="Message to send on the event timeline"
          data-testid="publisher-message-input"
          class="flex-1 min-w-0 px-2 py-1 text-xs bg-white border border-green-200 rounded focus:outline-none focus:ring-1 focus:ring-green-400 disabled:bg-slate-100 disabled:text-slate-400"
        />
        <button
          type="button"
          onClick={send}
          disabled={sendDisabled}
          data-testid="publisher-message-send"
          class="w-16 py-1 text-xs font-medium bg-green-500 hover:bg-green-600 disabled:bg-slate-300 disabled:cursor-not-allowed text-white rounded transition-colors"
        >
          Send
        </button>
      </div>
      <div class="mt-1 text-xs text-slate-500" data-testid="publisher-messages-sent">
        Sent: {sentCount}
      </div>
    </div>
  );
}
