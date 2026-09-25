/**
 * 統計を表示する部品
 *
 * publisher と subscriber のパネルで、統計をセクションごとに同じ形で並べる。
 *
 * - セクションの見出しの横に (?) を置き、説明は押したときだけポップオーバーに出す。
 *   説明の長い文を統計の間に並べない
 * - 累積の値はラベルと値の 2 列の行に並べる。長いラベルを切り詰めない
 * - 分布 (p50 / p95 / max) や原因ごとの回数は、列をそろえた表にする
 * - 直近のイベントの一覧は件数つきの枠に入れる
 */

import { Fragment, type ComponentChildren } from "preact";
import { useEffect, useId, useRef, useState } from "preact/hooks";
import type { TimingSummary } from "../utils/playbackTimingStats";

/** 説明の 1 項目 */
export interface HelpItem {
  readonly term: string;
  readonly description: string;
}

/** セクションの説明 */
export interface SectionHelp {
  /** セクションが何を表すかの要約 */
  readonly summary: string;
  /** 項目の関係を表す式 (区間の和など) */
  readonly formula?: string;
  /** 項目ごとの説明 */
  readonly items: readonly HelpItem[];
  /** 読むときの注意 */
  readonly notes?: readonly string[];
}

// ポップオーバーの幅 (px)。画面が狭いときは画面の幅から余白を引いた幅にする
const HELP_POPOVER_WIDTH_PX = 512;
// ポップオーバーと画面の端の余白 (px)
const VIEWPORT_MARGIN_PX = 16;
// (?) とポップオーバーの間 (px)
const ANCHOR_GAP_PX = 6;

/**
 * ポップオーバーの中身の高さを測る (px)
 *
 * 開く前 (beforetoggle) は display: none のため、見えないまま一時的に表示して測る。
 * 同じタスクの中で元に戻すため、測っている間の状態は描画されない
 */
function measurePopoverHeight(popover: HTMLElement): number {
  const isOpen = popover.matches(":popover-open");
  const previousMaxHeight = popover.style.maxHeight;
  popover.style.maxHeight = "none";
  if (!isOpen) {
    popover.style.display = "block";
    popover.style.visibility = "hidden";
  }
  const height = popover.offsetHeight;
  if (!isOpen) {
    popover.style.display = "";
    popover.style.visibility = "";
  }
  popover.style.maxHeight = previousMaxHeight;
  return height;
}

/**
 * ポップオーバーを (?) の近くに置く
 *
 * ポップオーバーは top layer に出るため、パネルの overflow で切られない。位置は画面
 * (viewport) の座標で決める。(?) の下に入るなら下、上にだけ入るなら上に出す。どちらにも
 * 入らなければ広い方に出し、入りきらない分は中でスクロールさせる。
 */
function placePopover(anchor: HTMLElement, popover: HTMLElement): void {
  const rect = anchor.getBoundingClientRect();
  // スクロールバーを除いた画面の大きさ
  const viewportWidth = document.documentElement.clientWidth;
  const viewportHeight = document.documentElement.clientHeight;

  // 幅を先に決める (幅で中身の高さが変わる)
  const width = Math.min(HELP_POPOVER_WIDTH_PX, viewportWidth - VIEWPORT_MARGIN_PX * 2);
  // (?) の左端にそろえ、右にはみ出すときは左へずらす
  const left = Math.max(
    VIEWPORT_MARGIN_PX,
    Math.min(rect.left, viewportWidth - width - VIEWPORT_MARGIN_PX),
  );
  popover.style.width = `${width}px`;
  popover.style.left = `${left}px`;
  popover.style.right = "auto";

  const height = measurePopoverHeight(popover);
  const spaceBelow = viewportHeight - rect.bottom - ANCHOR_GAP_PX - VIEWPORT_MARGIN_PX;
  const spaceAbove = rect.top - ANCHOR_GAP_PX - VIEWPORT_MARGIN_PX;
  const placeBelow = height <= spaceBelow || (height > spaceAbove && spaceBelow >= spaceAbove);
  if (placeBelow) {
    popover.style.top = `${rect.bottom + ANCHOR_GAP_PX}px`;
    popover.style.bottom = "auto";
    popover.style.maxHeight = `${Math.max(spaceBelow, 0)}px`;
  } else {
    // 下端を (?) の上にそろえる
    popover.style.top = "auto";
    popover.style.bottom = `${viewportHeight - rect.top + ANCHOR_GAP_PX}px`;
    popover.style.maxHeight = `${Math.max(spaceAbove, 0)}px`;
  }
}

interface HelpButtonProps {
  title: string;
  help: SectionHelp;
  /** 説明の data-testid。(?) は `${testId}-button` にする */
  testId: string;
}

/**
 * (?) のボタンと、押したときに出す説明のポップオーバー
 *
 * Popover API (popover="auto") を使う。(?) をもう一度押す、Escape を押す、外を押すと閉じる。
 */
function HelpButton({ title, help, testId }: HelpButtonProps) {
  const popoverId = useId();
  const buttonRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);

  // 開いている間は、スクロールと画面の大きさの変化に合わせて (?) の近くに置き直す
  useEffect(() => {
    const reposition = () => {
      const button = buttonRef.current;
      const popover = popoverRef.current;
      if (button !== null && popover !== null && popover.matches(":popover-open")) {
        placePopover(button, popover);
      }
    };
    // パネルの中のスクロールも拾うため capture で受ける
    window.addEventListener("scroll", reposition, { capture: true, passive: true });
    window.addEventListener("resize", reposition);
    return () => {
      window.removeEventListener("scroll", reposition, { capture: true });
      window.removeEventListener("resize", reposition);
    };
  }, []);

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        popovertarget={popoverId}
        aria-label={`About ${title}`}
        title={`About ${title}`}
        data-testid={`${testId}-button`}
        class="inline-flex items-center justify-center rounded-full text-slate-400 hover:text-slate-700 focus-visible:outline-2 focus-visible:outline-blue-500 transition-colors"
      >
        <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path
            stroke-linecap="round"
            stroke-linejoin="round"
            stroke-width="2"
            d="M8.228 9c.549-1.165 2.03-2 3.772-2 2.21 0 4 1.343 4 3 0 1.4-1.278 2.575-3.006 2.907-.542.104-.994.54-.994 1.093m0 3h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
          />
        </svg>
      </button>
      <div
        ref={popoverRef}
        id={popoverId}
        popover="auto"
        data-testid={testId}
        // 開く前に置き場所を決める (開いた後に動かすと一瞬別の場所に出る)
        onBeforeToggle={(event) => {
          if (event.newState === "open" && buttonRef.current !== null) {
            placePopover(buttonRef.current, event.currentTarget);
          }
        }}
        class="fixed m-0 overflow-y-auto rounded-lg border border-slate-200 bg-white p-4 text-left shadow-xl"
      >
        <div class="text-xs font-semibold uppercase tracking-wide text-slate-500">{title}</div>
        <p class="mt-1 text-sm text-slate-700">{help.summary}</p>
        {help.formula !== undefined && (
          <code class="mt-3 block rounded bg-slate-100 px-2 py-1.5 font-mono text-[11px] text-slate-700">
            {help.formula}
          </code>
        )}
        <dl class="mt-3 grid grid-cols-[fit-content(45%)_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-xs">
          {help.items.map((item) => (
            <Fragment key={item.term}>
              <dt class="font-mono text-slate-800 [overflow-wrap:anywhere]">{item.term}</dt>
              <dd class="text-slate-600">{item.description}</dd>
            </Fragment>
          ))}
        </dl>
        {help.notes !== undefined && help.notes.length > 0 && (
          <ul class="mt-3 list-disc space-y-1 border-t border-slate-100 pt-2 pl-4 text-xs text-slate-500">
            {help.notes.map((note) => (
              <li key={note}>{note}</li>
            ))}
          </ul>
        )}
      </div>
    </>
  );
}

type StatSectionProps = {
  title: string;
  children: ComponentChildren;
} & (
  | {
      /** 見出しの (?) から開く説明 */
      help: SectionHelp;
      /** 説明の data-testid の元。説明は `${testId}-help`、(?) は `${testId}-help-button` にする */
      testId: string;
    }
  | { help?: undefined; testId?: undefined }
);

/**
 * 見出しと (?) つきの統計のセクション
 */
export function StatSection({ title, help, testId, children }: StatSectionProps) {
  return (
    <section class="mb-5 last:mb-0">
      <div class="mb-2 flex items-center gap-1.5">
        <h3 class="text-xs font-semibold uppercase tracking-wide text-slate-500">{title}</h3>
        {help !== undefined && testId !== undefined && (
          <HelpButton title={title} help={help} testId={`${testId}-help`} />
        )}
      </div>
      <div class="space-y-2">{children}</div>
    </section>
  );
}

/** 問題のある値の色 (warn: 捨てた数や止まりなど、error: エラーや欠落の数) */
export type StatTone = "warn" | "error";

/** ラベルと値の 1 行 */
export interface StatValue {
  readonly label: string;
  readonly value: string | number;
  /** 値が 0 でない数値のときにつける色。0 なら問題が無いため色をつけない */
  readonly tone?: StatTone | undefined;
  readonly testId?: string | undefined;
}

/**
 * 値の色の class を返す
 */
function toneClass(tone: StatTone | undefined): string {
  switch (tone) {
    case "error":
      return "text-red-600";
    case "warn":
      return "text-amber-600";
    default:
      return "text-slate-800";
  }
}

/**
 * 値が 0 でない数値のときだけ色をつける
 */
function toneIfNonZero(value: string | number, tone: StatTone | undefined): StatTone | undefined {
  return typeof value === "number" && value !== 0 ? tone : undefined;
}

/**
 * ラベルと値の行を 2 列に並べる
 */
export function StatList({ items }: { items: readonly StatValue[] }) {
  return (
    // 1px の隙間から背景の色を見せて、表のような区切りの線にする
    <dl class="grid grid-cols-1 gap-px overflow-hidden rounded-lg border border-slate-200 bg-slate-200 sm:grid-cols-2">
      {items.map((item) => (
        <div
          key={item.label}
          class="flex items-baseline justify-between gap-3 bg-white px-3 py-1.5"
        >
          <dt class="min-w-0 text-xs text-slate-500 [overflow-wrap:anywhere]">{item.label}</dt>
          <dd
            class={`shrink-0 text-sm font-semibold tabular-nums ${toneClass(
              toneIfNonZero(item.value, item.tone),
            )}`}
            data-testid={item.testId}
          >
            {item.value}
          </dd>
        </div>
      ))}
      {/* 2 列のときに奇数個だと最後の行の右が背景の色になるため、空の枠で埋める */}
      {items.length % 2 === 1 && <div class="hidden bg-white sm:block" />}
    </dl>
  );
}

/** 表の 1 行 */
export interface TableRow {
  readonly label: string;
  /** 列ごとの値 (`columns` と同じ並び) */
  readonly values: readonly string[];
  /** 行の data-testid の元。値のセルは `${testId}-${列の名前}` にする */
  readonly testId?: string | undefined;
  /** 合計の行。上に線を引いて区切り、太字にする */
  readonly total?: boolean | undefined;
  /** 行の値の色。呼び出し側が問題のある行 (回数が 0 でない原因など) にだけつける */
  readonly tone?: StatTone | undefined;
}

interface StatTableProps {
  /** 左上に出す文字 (単位や窓の長さ) */
  caption: string;
  columns: readonly string[];
  rows: readonly TableRow[];
  testId?: string | undefined;
}

/**
 * 列をそろえた表
 */
export function StatTable({ caption, columns, rows, testId }: StatTableProps) {
  return (
    <div class="overflow-hidden rounded-lg border border-slate-200 bg-white">
      <table class="w-full text-xs" data-testid={testId}>
        <thead>
          <tr class="border-b border-slate-100 bg-slate-50">
            <th scope="col" class="px-3 py-1.5 text-left font-normal text-slate-400">
              {caption}
            </th>
            {columns.map((column) => (
              <th
                key={column}
                scope="col"
                // 値の列は狭くそろえ、残りの幅をラベルの列に回す
                class="w-20 px-3 py-1.5 text-right font-semibold text-slate-500"
              >
                {column}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.label} class={row.total === true ? "border-t border-slate-200" : ""}>
              <th
                scope="row"
                class={`px-3 py-1 text-left text-slate-500 [overflow-wrap:anywhere] ${
                  row.total === true ? "font-semibold text-slate-700" : "font-normal"
                }`}
              >
                {row.label}
              </th>
              {columns.map((column, index) => (
                <td
                  key={column}
                  class={`px-3 py-1 text-right tabular-nums ${
                    row.total === true ? "font-semibold" : ""
                  } ${toneClass(row.tone)}`}
                  data-testid={row.testId === undefined ? undefined : `${row.testId}-${column}`}
                >
                  {row.values[index] ?? "-"}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** 分布の表の列 */
const DISTRIBUTION_COLUMNS = ["p50", "p95", "max"] as const;

/** 分布の表の 1 行 */
export interface TimingRow {
  readonly label: string;
  readonly summary: TimingSummary | null;
  readonly testId?: string | undefined;
  readonly total?: boolean | undefined;
}

/**
 * 分布 (p50 / p95 / max、ミリ秒) の表
 *
 * 記録が無い分布は各列を "-" にする
 */
export function TimingTable({
  caption,
  rows,
  testId,
}: {
  caption: string;
  rows: readonly TimingRow[];
  testId?: string | undefined;
}) {
  return (
    <StatTable
      caption={caption}
      columns={DISTRIBUTION_COLUMNS}
      testId={testId}
      rows={rows.map((row) => ({
        label: row.label,
        values: DISTRIBUTION_COLUMNS.map((column) =>
          row.summary === null ? "-" : row.summary[column].toFixed(1),
        ),
        testId: row.testId,
        total: row.total,
      }))}
    />
  );
}

interface EventLogProps {
  label: string;
  /** ラベルの横に出す補足 (並び順や時刻の基準) */
  hint: string;
  lines: readonly string[];
  /** 件数を出すか。行が件数を表さない一覧 (error code ごとの数など) では出さない */
  showCount?: boolean | undefined;
  testId?: string | undefined;
}

/**
 * 直近のイベントの一覧
 *
 * 本文の高さは件数によらず固定する。件数が増えるたびに伸びると、その下の項目の
 * 位置が動く。収まらない分は一覧の中でスクロールする
 */
export function EventLog({ label, hint, lines, showCount = true, testId }: EventLogProps) {
  return (
    <div class="rounded-lg border border-slate-200 bg-white">
      <div class="flex items-baseline justify-between gap-3 border-b border-slate-100 px-3 py-1.5">
        <span class="text-xs text-slate-500">
          {label}
          {showCount && <span class="text-slate-400"> ({lines.length})</span>}
        </span>
        <span class="text-[11px] text-slate-400">{hint}</span>
      </div>
      <pre
        class="h-24 overflow-y-auto whitespace-pre-wrap break-all px-3 py-2 font-mono text-[11px] text-slate-700"
        data-testid={testId}
      >
        {lines.length === 0 ? "-" : lines.join("\n")}
      </pre>
    </div>
  );
}

interface StatsCollapseProps {
  /** 開いたときの統計の欄の testId。開け閉めのボタンは `${testId}-toggle` */
  testId: string;
  children: ComponentChildren;
}

/**
 * パネルの統計の欄をまとめて開け閉めする
 *
 * 統計の欄は多く、常に開いていると画面が長くなり、映像と操作を見るだけのときに邪魔に
 * なる。既定で閉じ、「Statistics」を押したときだけ描く。閉じている間は DOM に置かない。
 * 値の計算と `window.moqtDevTools` の統計は開け閉めに依らない。開け閉めの状態は
 * パネルごとに持ち、ページを読み込み直すと閉じた状態に戻る
 */
export function StatsCollapse({ testId, children }: StatsCollapseProps) {
  const [open, setOpen] = useState(false);
  const contentId = useId();
  return (
    <div class="bg-slate-50 rounded-lg">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={contentId}
        onClick={() => setOpen(!open)}
        data-testid={`${testId}-toggle`}
        class="w-full flex items-center gap-2 px-4 py-2 text-sm font-medium text-slate-600 hover:bg-slate-100 rounded-lg transition-colors"
      >
        <span aria-hidden="true">{open ? "\u25BE" : "\u25B8"}</span>
        Statistics
      </button>
      {open && (
        <div id={contentId} class="px-4 pb-4" data-testid={testId}>
          {children}
        </div>
      )}
    </div>
  );
}
