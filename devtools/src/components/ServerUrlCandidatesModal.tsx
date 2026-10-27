/**
 * 接続先 (MOQT URI) の候補を管理するモーダル
 *
 * 登録した候補の一覧を表示し、追加・削除・有効 / 無効の切り替え・全消去を行う。有効な
 * 候補が 1 つ以上あるとき、Publisher と各 Subscriber は接続のたびにその中から 1 つを
 * 選んで使う (どれを選んだかはそれぞれのパネルに出る)。
 *
 * ほかの接続設定と同じく、操作はその場で接続設定と OPFS に反映する (Save / Cancel の
 * ような確定操作は無い)。モーダルを閉じても変更は残る。
 */

import { useEffect, useRef, useState } from "preact/hooks";
import {
  serverUrlCandidates,
  serverUrlCandidatesSaveError,
  serverUrlCandidatesSuspended,
  setServerUrlCandidates,
} from "../signals/connectionSettings";
import {
  addServerUrlEntry,
  removeServerUrlEntry,
  setServerUrlEntryEnabled,
  validateNewServerUrl,
  type ServerUrlEntry,
} from "../utils/serverUrlStore";

interface ServerUrlCandidatesModalProps {
  onClose: () => void;
}

export function ServerUrlCandidatesModal({ onClose }: ServerUrlCandidatesModalProps) {
  // 追加フォームの入力値。候補の登録はこのモーダル内で行う
  const [newUrl, setNewUrl] = useState("");
  const [error, setError] = useState("");
  // Remove all の確認待ち。誤クリックで一覧を失わないよう 2 回押させる
  const [confirmRemoveAll, setConfirmRemoveAll] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // 開いた直後に追加フォームへ焦点を移す (キーボードだけで候補を足せる)
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Esc キーで閉じる (変更はその場で反映済みのため、閉じても取り消さない)
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [onClose]);

  const entries = serverUrlCandidates.value;
  const enabledCount = entries.filter((entry) => entry.enabled).length;

  const updateEntries = (next: readonly ServerUrlEntry[]): void => {
    // 操作はすぐ画面へ反映し、OPFS への保存は直列化して行う。保存できなければ理由を出す
    void setServerUrlCandidates(next);
    setConfirmRemoveAll(false);
  };

  const handleAdd = (): void => {
    const validation = validateNewServerUrl(entries, newUrl);
    if (validation.kind === "error") {
      setError(validation.message);
      return;
    }
    updateEntries(addServerUrlEntry(entries, validation.url));
    setNewUrl("");
    setError("");
  };

  const handleToggle = (index: number): void => {
    const entry = entries[index];
    if (entry === undefined) {
      return;
    }
    updateEntries(setServerUrlEntryEnabled(entries, index, !entry.enabled));
  };

  const handleDelete = (index: number): void => {
    updateEntries(removeServerUrlEntry(entries, index));
  };

  const handleRemoveAll = (): void => {
    // 1 回目は確認待ちにするだけ。2 回目で消す (誤クリックで一覧を失わないようにする)
    if (!confirmRemoveAll) {
      setConfirmRemoveAll(true);
      return;
    }
    updateEntries([]);
    setError("");
  };

  return (
    <div
      class="fixed inset-0 bg-black/50 flex items-center justify-center z-50"
      onClick={onClose}
      role="presentation"
    >
      <div
        class="bg-white rounded-xl shadow-xl max-w-2xl w-full mx-4 p-6"
        onClick={(event) => event.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="server-url-candidates-title"
        data-testid="server-url-candidates-modal"
      >
        <div class="flex items-center justify-between mb-2">
          <h3 id="server-url-candidates-title" class="text-lg font-semibold text-slate-700">
            MOQT URI Candidates
          </h3>
          <div class="flex items-center gap-3">
            {/* 件数は見出しの行に出し、一覧の有無で高さも Close の位置も変わらないよう
                固定幅の枠に入れる */}
            <span class="min-w-20 text-right">
              {enabledCount > 0 && (
                <span
                  class="text-sm text-slate-500"
                  data-testid="server-url-candidates-enabled-count"
                >
                  ({enabledCount} enabled)
                </span>
              )}
            </span>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              data-testid="server-url-candidates-close"
              class="text-slate-400 hover:text-slate-600"
            >
              <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  stroke-width="2"
                  d="M6 18L18 6M6 6l12 12"
                />
              </svg>
            </button>
          </div>
        </div>
        <p class="text-sm text-slate-600 mb-4">
          Checked candidates are used for connections. When two or more are checked, each connection
          selects one at random. Add candidates from the form below.
        </p>

        {/* 追加フォーム。Enter でも追加できるよう form の submit で扱う */}
        <form
          class="flex gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            handleAdd();
          }}
        >
          <input
            ref={inputRef}
            type="text"
            value={newUrl}
            onInput={(event) => {
              setNewUrl(event.currentTarget.value);
              // 入力を直したら前のエラーを消す
              if (error !== "") {
                setError("");
              }
            }}
            placeholder="moqt://moq.example.com/"
            autocomplete="off"
            spellcheck={false}
            data-testid="server-url-candidates-input"
            aria-label="MOQT URI to register"
            class={`flex-1 px-3 py-1.5 border rounded-md text-sm font-mono focus:outline-none focus:ring-2 focus:ring-blue-500 ${
              error !== "" ? "border-rose-400" : "border-slate-300"
            }`}
          />
          <button
            type="submit"
            data-testid="server-url-candidates-add"
            class="px-3 py-1.5 text-sm text-white bg-blue-600 border border-blue-600 rounded-md hover:bg-blue-700"
          >
            Add
          </button>
        </form>
        {/* エラーの有無や長さで下の一覧とフッターが動かないよう、1 行分の固定領域に
            描く (長いエラーはこの領域の中でスクロールする) */}
        <div class="h-6 overflow-y-auto mt-1 mb-1">
          <p class="text-xs text-rose-600" data-testid="server-url-candidates-error">
            {error}
          </p>
        </div>

        {/* 候補の有無でモーダルの高さが変わらないよう、一覧は常に同じ高さで描く */}
        <div class="mt-3 h-64 overflow-y-auto rounded-md border border-slate-200">
          {entries.map((entry, index) => (
            <div
              key={entry.url}
              data-testid={`server-url-candidates-entry-${index}`}
              class="flex items-center gap-2 px-2 py-1.5 border-b border-slate-200 last:border-b-0"
            >
              <input
                type="checkbox"
                checked={entry.enabled}
                onChange={() => handleToggle(index)}
                aria-label={`Use ${entry.url} for connections`}
                data-testid={`server-url-candidates-enabled-${index}`}
                class="cursor-pointer"
              />
              <span
                class={`flex-1 overflow-hidden text-ellipsis whitespace-nowrap font-mono text-xs ${
                  entry.enabled ? "text-slate-800" : "text-slate-400"
                }`}
                title={entry.url}
              >
                {entry.url}
              </span>
              <button
                type="button"
                onClick={() => handleDelete(index)}
                aria-label={`Delete ${entry.url}`}
                data-testid={`server-url-candidates-delete-${index}`}
                class="px-1.5 py-0.5 text-sm text-rose-600 border border-rose-200 rounded hover:bg-rose-50"
              >
                &times;
              </button>
            </div>
          ))}
          {entries.length === 0 && (
            <p
              class="text-sm text-slate-500 text-center py-4"
              data-testid="server-url-candidates-empty"
            >
              No MOQT URI is registered
            </p>
          )}
        </div>

        <p class="text-xs text-slate-500 mt-2">
          Saved in this browser (OPFS) for this origin only. Changes take effect immediately.
        </p>
        {/* 保存の失敗と共有リンクによる停止の案内は、出たり消えたりしても高さが変わらない
            よう 1 行分の領域に描く */}
        <div class="min-h-4 mt-1">
          {serverUrlCandidatesSaveError.value ? (
            <p class="text-xs text-rose-600" data-testid="server-url-candidates-save-error">
              failed to save the MOQT URI candidates in this browser
            </p>
          ) : (
            serverUrlCandidatesSuspended.value && (
              <p class="text-xs text-slate-500" data-testid="server-url-candidates-suspended-note">
                This page uses the shared MOQT URI. Editing the candidates enables them here.
              </p>
            )
          )}
        </div>

        <div class="flex items-center justify-between mt-4">
          <button
            type="button"
            onClick={handleRemoveAll}
            data-testid="server-url-candidates-remove-all"
            title={
              confirmRemoveAll
                ? "Click again to remove all candidates"
                : "Remove all candidates (asks for confirmation)"
            }
            class={`w-28 shrink-0 whitespace-nowrap px-3 py-1.5 text-sm border rounded-md disabled:bg-slate-100 disabled:text-slate-400 disabled:border-slate-200 disabled:cursor-not-allowed ${
              confirmRemoveAll
                ? "text-white bg-rose-600 border-rose-600 hover:bg-rose-700"
                : "text-rose-600 border-rose-200 hover:bg-rose-50"
            }`}
            disabled={entries.length === 0}
          >
            {confirmRemoveAll ? "Remove all?" : "Remove all"}
          </button>
          <button
            type="button"
            onClick={onClose}
            data-testid="server-url-candidates-close-footer"
            class="px-3 py-1.5 text-sm text-slate-700 bg-slate-200 border border-slate-300 rounded-md hover:bg-slate-300"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
