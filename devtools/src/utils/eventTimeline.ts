import type { EventTimelineEntry } from "moqt-js";

/**
 * event timeline (draft-ietf-moq-msf-01 §8) を devtools で扱うための純関数
 *
 * devtools は audio / video 以外のデータを流す例として、event timeline にチャットの
 * メッセージを載せる。entry の data の構造は catalog の eventType (§5.2.5) が定義する。
 * ここで定義する eventType は devtools 同士の取り決めであり、MSF に登録された型では
 * ない (§10.5 の "Custom application-specific metadata" に相当する)
 */

/** devtools が event timeline に使うトラック名 */
export const EVENT_TRACK_NAME = "events";

/** devtools のチャットメッセージを示す eventType (逆ドメイン名, §5.2.5) */
export const CHAT_EVENT_TYPE = "app.shiguredo.moqt-devtools.chat";

/**
 * event timeline の payload に載せる履歴の上限 (件)
 *
 * draft-ietf-moq-msf-01 §8.3 は、Group の先頭 Object に「それまでに蓄積されアクセス可能な
 * 全レコード」を載せることを MUST とする。devtools は上限を超えた古い記録を保持しない
 * (アクセス可能な記録ではなくなる) ことで、payload が配信の長さに比例して増えるのを防ぐ
 */
export const EVENT_HISTORY_LIMIT = 100;

/**
 * チャットのメッセージ 1 件を event timeline の entry にする (§8.1)
 *
 * index 参照は壁時計 (`t`、Unix epoch ミリ秒) を使う。メディアの再生位置とは独立した
 * メッセージのため、Media PTS や MOQT Location は使わない
 */
export function buildChatEventEntry(text: string, wallClockMs: number): EventTimelineEntry {
  return { t: wallClockMs, data: { text } };
}

/**
 * 履歴の末尾に entry を足し、上限を超えた分を古い方から落とす
 *
 * 落とした記録は以降の Group の先頭 Object に含まれなくなる (§8.3 の「アクセス可能な
 * 全レコード」の範囲から外れる)
 */
export function appendChatEventEntry(
  history: readonly EventTimelineEntry[],
  entry: EventTimelineEntry,
): EventTimelineEntry[] {
  const appended = [...history, entry];
  if (appended.length <= EVENT_HISTORY_LIMIT) {
    return appended;
  }
  return appended.slice(appended.length - EVENT_HISTORY_LIMIT);
}

/**
 * entry の data を画面に出す文字列にする
 *
 * devtools の eventType では `{ text: string }` を送るが、他の publisher の event
 * timeline を購読したときは data の構造が違う。text が無いときは JSON として表示し、
 * JSON にできない値は String に落とす (表示のたびに例外を出さない)
 */
export function formatEventEntryData(data: unknown): string {
  if (
    typeof data === "object" &&
    data !== null &&
    "text" in data &&
    typeof data.text === "string"
  ) {
    return data.text;
  }
  try {
    const json = JSON.stringify(data);
    return json ?? String(data);
  } catch {
    return String(data);
  }
}
