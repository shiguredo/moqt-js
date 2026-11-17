import {
  compressGzip,
  decodeEventTimelineObject,
  decompressObjectPayload,
  encodeEventTimeline,
  type EventTimelineEntry,
  type MoqtObject,
  type Property,
} from "moqt-js";
import {
  decodeProperties,
  encodeProperties,
  MSFPropertyId,
  MsfCompressionAlgorithm,
} from "../../../src/properties";

/**
 * event timeline (draft-ietf-moq-msf-02 §8) を devtools で扱うための処理
 *
 * devtools は audio / video 以外のデータを流す例として、event timeline に
 * メッセージを載せる。entry の data の構造は catalog の eventType (§5.2.6) が定義する。
 * ここで定義する eventType は devtools 同士の取り決めであり、MSF に登録された型では
 * ない (§8.5 の "Custom application-specific metadata" に相当する)
 */

/** devtools が event timeline に使うトラック名 */
export const EVENT_TRACK_NAME = "events";

/** devtools の Messages を示す eventType (逆ドメイン名, §5.2.6) */
export const MESSAGES_EVENT_TYPE = "app.shiguredo.moqt-devtools.messages";

/**
 * event timeline の payload に載せる履歴の上限 (件)
 *
 * draft-ietf-moq-msf-02 §8.4 は、Group の先頭 Object に「それまでに蓄積されアクセス可能な
 * 全レコード」を載せることを SHOULD とする。devtools は上限を超えた古い記録を保持しない
 * (アクセス可能な記録ではなくなる) ことで、payload が配信の長さに比例して増えるのを防ぐ
 */
export const EVENT_HISTORY_LIMIT = 100;

/**
 * メッセージ 1 件を event timeline の entry にする (§8.2)
 *
 * index 参照は壁時計 (`T`、Unix epoch ミリ秒) を使う。メディアの再生位置とは独立した
 * メッセージのため、Media PTS や MOQT Location は使わない
 */
export function buildMessageEventEntry(text: string, wallClockMs: number): EventTimelineEntry {
  return { T: wallClockMs, data: { text } };
}

/**
 * 履歴の末尾に entry を足し、上限を超えた分を古い方から落とす
 *
 * 落とした記録は以降の Group の先頭 Object に含まれなくなる (§8.4 の「アクセス可能な
 * 全レコード」の範囲から外れる)
 */
export function appendMessageEventEntry(
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
 * Messages の履歴を選んだ圧縮設定で符号化し、Object の payload と Properties を組み立てる
 *
 * 既定は GZIP。draft-ietf-moq-msf-02 §12.1.2 に従い、圧縮した Object に
 * MSF_COMPRESSION = GZIP を付け、無圧縮では付けない。Track scope では指定しない。
 * 草案の改訂で signaling の規則が変わる可能性がある。
 */
export async function encodeMessageEventTimeline(
  entries: EventTimelineEntry[],
  compressionEnabled = true,
): Promise<{ payload: Uint8Array; properties?: Uint8Array }> {
  const payload = encodeEventTimeline(entries);
  if (!compressionEnabled) {
    return { payload };
  }
  return {
    payload: await compressGzip(payload),
    properties: encodeProperties([
      { id: MSFPropertyId.MSF_COMPRESSION, value: MsfCompressionAlgorithm.GZIP },
    ]),
  };
}

/**
 * 圧縮指定を解決してから Messages の履歴を読み戻す
 *
 * draft-ietf-moq-msf-02 §12.1 に従い、Track / Object のどちらの圧縮指定も受け付ける。
 * 指定が無いときは無圧縮として読み、未対応の指定や壊れた圧縮データは拒否する。
 * ヘッダーは §8.1 の共通処理で確認する。草案の改訂で規則が変わる可能性がある。
 */
export async function decodeMessageEventTimeline(
  trackProperties: readonly Property[],
  object: Pick<MoqtObject, "payload" | "properties">,
): Promise<EventTimelineEntry[]> {
  const objectProperties =
    object.properties === undefined ? [] : decodeProperties(object.properties, "object");
  const payload = await decompressObjectPayload(object.payload, trackProperties, objectProperties);
  return decodeEventTimelineObject(trackProperties, payload).entries;
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
