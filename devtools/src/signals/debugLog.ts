import { signal } from "@preact/signals";
import {
  formatAbsoluteTime,
  formatDeltaTime,
  formatElapsedTime,
  formatMessageData,
} from "../utils/logFormatters";

/**
 * デバッグログの蓄積
 *
 * 配列は signal にせず破壊的に追記し、追加・クリアは連番の signal で伝える。
 * 画面側は連番を購読している一覧だけを再描画する。
 *
 * 表示用の時刻は追加時に 1 回だけ整形して持つ。描画のたびに整形し直すと、
 * 1 件追加するたびのコストが表示中の件数に比例する
 * (`webtransport-devtools/messageLog.ts` の `appendMessage` と同じ作法)。
 */

/** ログの重要度 */
export type LogLevel = "info" | "warn" | "error" | "debug";

/** ログ 1 件 */
export interface LogEntry {
  // ログごとの連番。表示の key と展開状態の識別に使う。配列の添字を使うと、
  // MAX_LOGS 到達後に最古を捨てたときに展開状態が別の行へ移る
  id: number;
  timestamp: number;
  level: LogLevel;
  message: string;
  // メッセージ行頭の接続識別子 (`[publisher]` / `[subscriber-...]`)。
  // 接続元でログを絞り込むために追加時に 1 回だけ取り出す。無ければ null
  source: string | null;
  // 検索欄で使う小文字化済みの文字列。メッセージ本文と data の表示用の整形を
  // 追加時に 1 回だけ連結する。検索のたびに data を整形し直さない
  searchText: string;
  // 表示用に整形済みの絶対時刻 (HH:MM:SS.mmm)。追加時に 1 回だけ計算する
  formattedTimestamp: string;
  // 表示用に整形済みの経過時間。基準は「ログを消してから最初の 1 件」
  formattedElapsed: string;
  // 表示用に整形済みの、時系列で 1 つ前のログとの差。最初の 1 件は空文字
  formattedDelta: string;
  data?: unknown;
  payload?: Uint8Array;
}

/**
 * 保持するログの上限
 *
 * 1 件追加するたびの描画コストが接続時間に比例して増え続けないようにする。
 * 上限を超えた分は最古から捨てる。
 */
export const MAX_LOGS = 1000;

// 配列本体は破壊的に操作するため signal にしない。テスト用に getter を export する
const logBuffer: LogEntry[] = [];
// ログの連番。表示の key と展開状態の識別に使う
let logIdCounter = 0;
// 経過時間の基準。ログを消したら次の追加で取り直す。
// 上限到達で最古のログを捨てても動かさない (動かすと表示中の全行の経過時間が変わり、
// 行の表示を作り直すことになる)
let firstTimestamp: number | null = null;

// 追加・クリアのたびに増える連番。値は表示に使わず、再描画のトリガにだけ使う
export const logSequence = signal(0);

/**
 * 保持しているログを古い順に返す
 *
 * 配列そのものを返す (コピーしない)。呼び出し側は読み取り専用として扱い、
 * 追加と削除は `addLog` / `clearLog` だけが行う。
 */
export function getLogBuffer(): readonly LogEntry[] {
  return logBuffer;
}

/** テスト用にログの蓄積を初期状態へ戻す */
export function __resetLogStateForTest(): void {
  logBuffer.length = 0;
  logIdCounter = 0;
  firstTimestamp = null;
  logSequence.value = 0;
}

/**
 * メッセージ行頭の接続識別子を取り出す
 *
 * ログの行は `[publisher] [SEND] PUBLISH` や `[subscriber-1] video stream ended`
 * のように接続識別子から始まる。接続元での絞り込みに使うため、追加時に取り出す。
 * 識別子は `[publisher]` / `[subscriber-...]` の形 (小文字で始まる) だけを認める。
 * `[WARN]` のような本文の角括弧を接続元と誤認しないためである。
 * 識別子で始まらない行 (前提警告など、呼び出し側が付け忘れた行) は null になる。
 */
export function extractLogSource(message: string): string | null {
  return /^\[([a-z][a-z0-9-]*)\]/.exec(message)?.[1] ?? null;
}

/**
 * 検索用の文字列の上限 (文字数)
 *
 * Catalog のように data が大きいログを 1,000 件保持しても、検索用の文字列で
 * メモリを圧迫しないようにする。上限を超えた分は検索対象にしない (本文の行頭は残る)。
 */
export const MAX_SEARCH_TEXT_LENGTH = 4096;

/**
 * 検索欄で使う文字列を作る
 *
 * 表示している本文 (メッセージと data の整形結果) を小文字化して連結する。
 * `formatMessageData` は bigint を含む Catalog でも例外にならないが、トップレベルに
 * 循環参照があると再帰が止まらない。整形に失敗してもログ自体を失わないよう、
 * そのときはメッセージ本文だけを検索対象にする。
 */
export function buildLogSearchText(message: string, data: unknown): string {
  if (data === undefined) {
    return message.slice(0, MAX_SEARCH_TEXT_LENGTH).toLowerCase();
  }
  let formattedData: string;
  try {
    formattedData = formatMessageData(data);
  } catch {
    // 循環参照など整形できない data でも、追加するログを落とさない
    formattedData = "";
  }
  return `${message}\n${formattedData}`.slice(0, MAX_SEARCH_TEXT_LENGTH).toLowerCase();
}

/**
 * ログを 1 件追加する
 *
 * 行は追加時に作った vnode を使い回す (再描画しない) ため、`data` と `payload` は
 * 追加後に書き換えないこと。書き換えても表示は古いままになる。
 *
 * @param level 重要度
 * @param message 本文
 * @param data 付加情報。展開したときとコピー時に表示する
 * @param payload 生のバイト列。展開したときとコピー時に hex dump する
 */
export function addLog(
  level: LogLevel,
  message: string,
  data?: unknown,
  payload?: Uint8Array,
): void {
  const timestamp = Date.now();
  firstTimestamp ??= timestamp;
  // 直前のログ。時系列で 1 つ前のログとの差を表示する
  const previous = logBuffer.at(-1);

  const entry: LogEntry = {
    id: logIdCounter++,
    timestamp,
    level,
    message,
    source: extractLogSource(message),
    searchText: buildLogSearchText(message, data),
    formattedTimestamp: formatAbsoluteTime(timestamp),
    formattedElapsed: formatElapsedTime(timestamp, firstTimestamp),
    formattedDelta: previous === undefined ? "" : formatDeltaTime(timestamp, previous.timestamp),
    // exactOptionalPropertyTypes では optional な data / payload に undefined を渡せないため、
    // 値がある場合だけ載せる
    ...(data !== undefined ? { data } : {}),
    ...(payload !== undefined ? { payload } : {}),
  };

  logBuffer.push(entry);
  if (logBuffer.length > MAX_LOGS) {
    // 上限到達後は shift 1 回で先頭を捨てる。
    // 旧実装の [...array, entry].slice(-MAX_LOGS) のフルコピー × 2 を 1 回に削減。
    logBuffer.shift();
  }
  logSequence.value += 1;
}

/** ログをすべて捨てる */
export function clearLog(): void {
  logBuffer.length = 0;
  // 次に追加するログを経過時間の基準にする
  firstTimestamp = null;
  logSequence.value += 1;
}
