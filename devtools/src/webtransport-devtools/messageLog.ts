import { signal, type Signal } from "@preact/signals";

/**
 * ストリームとデータグラムで共有するメッセージ一覧
 *
 * 1 件追加するたびに配列を作り直すと、そのコストが既存件数に比例して増える。
 * そのため配列は signal にせず破壊的に追記し、追加・クリアは連番の signal で伝える。
 * 画面側は連番を購読している項目だけを再描画する。
 *
 * 日時は追加時に 1 回だけ整形して持つ。描画のたびに整形し直すと、1 件追加のコストが
 * 表示中の全行の件数に比例する (整形 1 回は実測で約 30 µs)。
 */

/** メッセージ種別 */
export interface StreamMessage {
  // ストリームごとの連番。表示の key に使う。配列の添字を key にすると、
  // 1 件追加して最古を捨てたときに表示の対応がずれる
  id: number;
  direction: "send" | "recv";
  data: string;
  timestamp: number;
  // 表示用に整形済みの日時。追加時に 1 回だけ計算し、描画では計算し直さない
  formattedTimestamp: string;
}

/**
 * 1 つの一覧に保持するメッセージの上限
 *
 * 一覧は画面の `max-h-40` (約 20 行) より十分多く見えるだけの件数に抑える。
 * 上限が無いと、1 件追加するたびの描画コストが接続時間に比例して増え続ける
 */
export const MAX_STREAM_MESSAGES = 200;

// メッセージの連番。表示の key に使うため、一覧をまたいで一意にする
let streamMessageIdCounter = 0;

/** メッセージ一覧のフィールド。ストリーム情報とデータグラムの両方が持つ */
export interface MessageLogFields {
  // 古い順のメッセージ。上限 MAX_STREAM_MESSAGES 件
  messages: StreamMessage[];
  // 追加・クリアのたびに増える連番。値は表示に使わず、再描画のトリガにだけ使う
  messagesVersion: Signal<number>;
}

/** メッセージ一覧の初期値を作る */
export function createMessageLogFields(): MessageLogFields {
  return { messages: [], messagesVersion: signal(0) };
}

/**
 * 表示用にタイムスタンプを整形する
 *
 * 整形は追加時に 1 回だけ行う。描画のたびに呼ぶと、1 件追加のコストが既存件数に
 * 比例して増える
 */
export function formatTimestamp(timestamp: number): string {
  const date = new Date(timestamp);
  return date.toLocaleTimeString("ja-JP", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    fractionalSecondDigits: 3,
  });
}

/**
 * メッセージを 1 件追加する
 *
 * 配列は作り直さない (呼び出し側は `messages` の参照をそのまま読み続けられる)。
 * 追加は `messagesVersion` の連番で伝える。
 */
export function appendMessage(
  log: MessageLogFields,
  direction: StreamMessage["direction"],
  data: string,
): void {
  const timestamp = Date.now();
  log.messages.push({
    id: streamMessageIdCounter++,
    direction,
    data,
    timestamp,
    formattedTimestamp: formatTimestamp(timestamp),
  });
  // 上限を超えた分は最古から捨てる。上限があるため、この 1 回のコストは
  // 接続時間に依らず一定になる
  if (log.messages.length > MAX_STREAM_MESSAGES) {
    log.messages.shift();
  }
  log.messagesVersion.value += 1;
}

/** メッセージを全部捨てる */
export function clearMessageLog(log: MessageLogFields): void {
  log.messages.length = 0;
  log.messagesVersion.value += 1;
}
