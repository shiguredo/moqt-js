/**
 * パネルごとの接続先の選び方 (自動 / 固定) を選ぶチップと選択モーダル
 *
 * 有効な候補が 2 件以上のときに表示する。自動は接続のたびに候補から 1 つを選び、固定は
 * 選んだ候補を毎回使う。候補が 1 件以下のときは選ぶ余地が無いため、URI (または「-」) を
 * そのまま出す。接続中は操作できず、変更は次の接続から効く。
 *
 * 選択肢はパネルに重ねて出すのではなく、ほかの候補管理と同じモーダルで出す
 * (パネル内のカードに重なって読みにくくなるのを避ける)。
 */

import { useEffect, useId, useRef, useState } from "preact/hooks";
import type { ComponentChildren } from "preact";
import type { CandidateSelection } from "../utils/candidateSelection";

interface CandidatePickerProps {
  /** 現在の選択 (自動 / 固定) */
  readonly selection: CandidateSelection;
  /** 最後に接続に使った MOQT URI。未接続では null */
  readonly selectedServerUrl: string | null;
  /** 選択できる候補 (enabled なもの) の MOQT URI */
  readonly enabledCandidates: readonly string[];
  /** 共有リンクの接続先を開いている page かどうか */
  readonly suspended: boolean;
  /** 共有リンクの接続先 (suspended のときに表示する) */
  readonly sharedUrl: string;
  /** 接続中などで選択を変更できないかどうか */
  readonly disabled: boolean;
  /** data-testid の接頭辞 (publisher-candidate / subscriber-candidate) */
  readonly testId: string;
  /** モーダルの見出しに出すパネル名 */
  readonly panelLabel: string;
  readonly onChange: (selection: CandidateSelection) => void;
}

export function CandidatePicker({
  selection,
  selectedServerUrl,
  enabledCandidates,
  suspended,
  sharedUrl,
  disabled,
  testId,
  panelLabel,
  onChange,
}: CandidatePickerProps) {
  const [open, setOpen] = useState(false);
  // ラジオグループのうちフォーカスしている項目。0 が Auto、1 以降が候補
  const [activeIndex, setActiveIndex] = useState(0);
  const chipRef = useRef<HTMLButtonElement>(null);
  const optionRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const titleId = useId();
  const descriptionId = useId();

  /** 現在の選択に対応する項目番号 */
  const selectedIndex = (): number => {
    if (selection.mode !== "fixed") {
      return 0;
    }
    const index = enabledCandidates.indexOf(selection.url);
    return index === -1 ? 0 : index + 1;
  };

  // 接続中はモーダルを閉じる
  useEffect(() => {
    if (disabled) {
      setOpen(false);
    }
  }, [disabled]);

  // 開いたときに現在の選択へフォーカスを移す
  useEffect(() => {
    if (!open) {
      return;
    }
    optionRefs.current[activeIndex]?.focus();
  }, [open, activeIndex]);

  // Esc で閉じる。フォーカスはチップへ戻す
  useEffect(() => {
    if (!open) {
      return () => {
        // モーダルを開いていないときは購読しない
      };
    }
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        setOpen(false);
        chipRef.current?.focus();
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [open]);

  /** モーダルを開き、現在の選択へフォーカスを移す */
  const openModal = (): void => {
    setActiveIndex(selectedIndex());
    setOpen(true);
  };

  /** モーダルを閉じる。チップへフォーカスを戻す */
  const closeModal = (): void => {
    setOpen(false);
    chipRef.current?.focus();
  };

  /** ラジオグループ内のキーボード移動 (選択は Enter / Space で決める) */
  const handleGroupKeyDown = (event: KeyboardEvent): void => {
    const total = enabledCandidates.length + 1;
    if (event.key === "ArrowDown" || event.key === "ArrowRight") {
      event.preventDefault();
      setActiveIndex((previous) => (previous + 1) % total);
    } else if (event.key === "ArrowUp" || event.key === "ArrowLeft") {
      event.preventDefault();
      setActiveIndex((previous) => (previous - 1 + total) % total);
    } else if (event.key === "Home") {
      event.preventDefault();
      setActiveIndex(0);
    } else if (event.key === "End") {
      event.preventDefault();
      setActiveIndex(total - 1);
    }
  };

  /** 選択を適用して閉じる */
  const applySelection = (next: CandidateSelection): void => {
    onChange(next);
    closeModal();
  };

  // パネルの項目行と同じ高さの細いカードにする。チップをパネル内に浮かせると下の
  // カードに重なって見えるため、幅いっぱいの行として描く
  const cardClass = "flex h-11 w-full items-center gap-2 rounded-lg border px-4 text-sm";
  /** 選択を変えられないときの行 (共有リンク / 候補 0 件 / 1 件) */
  const renderStaticCard = (value: string, valueTitle: string) => (
    <div
      class={`${cardClass} border-slate-200 bg-slate-50 text-slate-600`}
      data-testid={`${testId}-card`}
    >
      <span class="shrink-0">Candidate:</span>
      <span
        class="min-w-0 truncate font-mono text-xs text-slate-700"
        title={valueTitle}
        data-testid={`${testId}-value`}
      >
        {value}
      </span>
    </div>
  );

  // 共有リンクの接続先を開いている page では候補を使わないため、接続先をそのまま出す
  if (suspended) {
    return renderStaticCard(sharedUrl === "" ? "-" : sharedUrl, sharedUrl);
  }

  // 候補が無いときと 1 件のときは、選ぶ余地が無いため URI だけを出す
  if (enabledCandidates.length === 0) {
    return renderStaticCard("-", "");
  }
  if (enabledCandidates.length === 1) {
    const onlyCandidate = enabledCandidates[0] ?? "";
    return renderStaticCard(onlyCandidate, onlyCandidate);
  }

  const fixedUrl = selection.mode === "fixed" ? selection.url : null;
  const fixedIsEnabled = fixedUrl !== null && enabledCandidates.includes(fixedUrl);
  // 固定した候補が無効化・削除されているときは、開始前に気付けるよう赤く出す
  const invalidFixed = fixedUrl !== null && !fixedIsEnabled;
  const label = fixedUrl ?? selectedServerUrl ?? "Auto";
  const tag = fixedUrl === null ? (selectedServerUrl === null ? null : "Auto") : "Fixed";

  const cardClasses = invalidFixed
    ? "border-rose-300 bg-rose-50"
    : fixedUrl !== null
      ? "border-blue-200 bg-blue-50"
      : "border-slate-200 bg-slate-50";

  /** ラジオ項目。先頭が Auto、以降が候補 */
  const renderOption = (index: number, selected: boolean, content: ComponentChildren) => (
    <button
      ref={(element) => {
        optionRefs.current[index] = element;
      }}
      type="button"
      role="radio"
      aria-checked={selected}
      tabIndex={index === activeIndex ? 0 : -1}
      data-testid={index === 0 ? `${testId}-option-auto` : `${testId}-option-${index - 1}`}
      onFocus={() => {
        setActiveIndex(index);
      }}
      onClick={() => {
        if (index === 0) {
          applySelection({ mode: "auto" });
        } else {
          const url = enabledCandidates[index - 1];
          if (url !== undefined) {
            applySelection({ mode: "fixed", url });
          }
        }
      }}
      class={`flex w-full items-start gap-3 rounded-lg px-3 py-2.5 text-left transition-colors ${
        index === 0 ? "" : "border-t border-slate-100"
      } ${selected ? "bg-blue-50" : "hover:bg-slate-50"}`}
    >
      <span
        class={`mt-0.5 h-3.5 w-3.5 shrink-0 rounded-full border ${
          selected ? "border-[4.5px] border-blue-600" : "border-slate-400"
        }`}
      />
      {content}
    </button>
  );

  return (
    <>
      <button
        ref={chipRef}
        type="button"
        data-testid={`${testId}-button`}
        aria-haspopup="dialog"
        aria-expanded={open}
        title={
          invalidFixed
            ? "This candidate is not enabled. Choose Auto or another candidate before starting."
            : "Choose Auto or a fixed MOQT URI candidate. Changes apply to the next connection."
        }
        disabled={disabled}
        onClick={() => {
          if (open) {
            closeModal();
          } else {
            openModal();
          }
        }}
        class={`${cardClass} text-left transition-colors ${cardClasses} hover:border-blue-300 hover:bg-white disabled:opacity-60 disabled:cursor-not-allowed`}
      >
        <span class="shrink-0">Candidate:</span>
        {fixedUrl !== null || selectedServerUrl !== null ? (
          // 接続先の URI はラベルの隣 (左) に置き、タグと矢印は右端にそろえる
          <>
            <span
              class="min-w-0 truncate font-mono text-xs text-slate-700"
              data-testid={`${testId}-value`}
            >
              {label}
            </span>
            <span class="ml-auto flex shrink-0 items-center gap-2">
              {tag !== null && (
                <span
                  class={`shrink-0 rounded px-1.5 text-[10px] font-semibold ${
                    invalidFixed
                      ? "bg-rose-100 text-rose-700"
                      : tag === "Fixed"
                        ? "bg-blue-100 text-blue-700"
                        : "bg-violet-100 text-violet-700"
                  }`}
                  data-testid={`${testId}-tag`}
                >
                  {invalidFixed ? "Not enabled" : tag}
                </span>
              )}
              <svg
                class="h-4 w-4 shrink-0 text-slate-400"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  stroke-width="2"
                  d="M19 9l-7 7-7-7"
                />
              </svg>
            </span>
          </>
        ) : (
          // まだ URI が決まっていない Auto は右に置く
          <span class="ml-auto flex shrink-0 items-center gap-2">
            <span class="font-mono text-xs text-slate-700" data-testid={`${testId}-value`}>
              {label}
            </span>
            <svg
              class="h-4 w-4 shrink-0 text-slate-400"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                stroke-linecap="round"
                stroke-linejoin="round"
                stroke-width="2"
                d="M19 9l-7 7-7-7"
              />
            </svg>
          </span>
        )}
      </button>

      {open && (
        <div
          class="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
          onClick={closeModal}
          role="presentation"
        >
          <div
            class="mx-4 w-full max-w-lg rounded-xl bg-white p-5 shadow-xl"
            role="dialog"
            aria-modal="true"
            aria-labelledby={titleId}
            aria-describedby={descriptionId}
            onClick={(event) => {
              event.stopPropagation();
            }}
            data-testid={`${testId}-modal`}
          >
            <div class="mb-1 flex items-center justify-between">
              <h3 id={titleId} class="text-base font-semibold text-slate-700">
                MOQT URI Candidate
              </h3>
              <button
                type="button"
                onClick={closeModal}
                aria-label="Close"
                data-testid={`${testId}-close`}
                class="text-slate-400 hover:text-slate-600"
              >
                <svg class="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path
                    stroke-linecap="round"
                    stroke-linejoin="round"
                    stroke-width="2"
                    d="M6 18L18 6M6 6l12 12"
                  />
                </svg>
              </button>
            </div>
            <p id={descriptionId} class="mb-3 text-xs text-slate-500">
              {panelLabel}: Auto picks a random enabled candidate for each connection. A fixed
              candidate is used until you change it.
            </p>
            <div role="radiogroup" aria-labelledby={titleId} onKeyDown={handleGroupKeyDown}>
              {renderOption(
                0,
                selection.mode === "auto",
                <span class="min-w-0">
                  <span class="block text-sm font-medium text-slate-800">Auto</span>
                  <span class="mt-0.5 block text-xs text-slate-500">
                    Random from {enabledCandidates.length} enabled candidates
                  </span>
                </span>,
              )}
              {enabledCandidates.map((url, index) =>
                renderOption(
                  index + 1,
                  fixedUrl === url,
                  <span class="min-w-0">
                    <span class="block truncate font-mono text-xs text-slate-700" title={url}>
                      {url}
                    </span>
                    <span class="mt-0.5 block text-[11px] text-slate-400">
                      Use this candidate for every connection
                    </span>
                  </span>,
                ),
              )}
            </div>
            <div class="mt-4 flex justify-end">
              <button
                type="button"
                onClick={closeModal}
                data-testid={`${testId}-close-footer`}
                class="rounded-md border border-slate-300 bg-slate-100 px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-200"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
