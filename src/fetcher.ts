/**
 * MOQT Fetcher
 * draft-ietf-moq-transport-21 Section 9.11 (FETCH) — 10.14 (FETCH_OK)
 *
 * draft-ietf-moq-transport-21:
 * FETCH レスポンスで不明な範囲を許可する。
 * Publisher がまだシリアライズしていないオブジェクトの範囲を
 * "unknown range" として返すことができる (Section 11.4.4, Table 7)。
 * draft-ietf-moq-transport-21 Section 9.11, Section 11.4.1
 */

import type { MoqtObject } from "./dataStream";
import { fullTrackNameKey } from "./fullTrackName";
import type { Location } from "./message/types";
import { GroupOrder } from "./message/types";
import type { Property } from "./properties";

/**
 * Fetcher state
 */
export type FetcherState = "active" | "closed";

/**
 * Fetcher interface
 */
export interface Fetcher {
  readonly state: FetcherState;
  readonly endOfTrack: boolean;
  readonly endLocation: Location;
  /**
   * FETCH_OK で受信した Track Properties
   * draft-ietf-moq-transport-21 Section 9.12 (FETCH_OK)
   */
  readonly trackProperties: ReadonlyArray<Property>;
  /**
   * Fetch をキャンセルする
   * draft-ietf-moq-transport-21 Section 3.2.1 (Fetch State Management)
   *
   * 「It MUST send STOP_SENDING for the bidi request stream.」
   * キャンセル開始と同時に state は closed になり、Object の配信と end / error の
   * 通知は止まる。ストリームの後始末 (STOP_SENDING 相当の cancel と RESET_STREAM) は
   * 返り値の Promise が完了するまで継続する。
   * 既にキャンセル中 / closed の場合は何もせず即座に解決する Promise を返すため、
   * その Promise は進行中の後始末の完了を保証しない。
   */
  cancel(): Promise<void>;
}

/**
 * Internal Fetcher implementation
 */
export class FetcherImpl implements Fetcher {
  private fetcherState: FetcherState = "active";
  private readonly fetcherNamespace: string[];
  private readonly fetcherTrackName: string;
  private readonly objectCallback: (object: MoqtObject) => void;
  private readonly endCallback?: () => void;
  private readonly errorCallback?: (error: Error) => void;
  private readonly requestId: bigint;
  private fetchEndOfTrack = false;
  private fetchEndLocation: Location = { group: 0n, object: 0n };
  private fetchTrackProperties: Property[] = [];

  /**
   * Fetch リクエストの Group Order
   * draft-ietf-moq-transport-21 Section 9.20.9 (GROUP ORDER Parameter)
   * 省略時は Ascending (0x1)。
   */
  private fetchGroupOrder: GroupOrder = GroupOrder.ASCENDING;

  // Session がストリームクローズ処理を差し込むためのコールバック
  goawayCallback?: (newSessionUri: string) => void;
  onCancel?: () => Promise<void>;

  constructor(
    namespace: string[],
    trackName: string,
    requestId: bigint,
    onObject: (object: MoqtObject) => void,
    onEnd?: () => void,
    onError?: (error: Error) => void,
  ) {
    this.fetcherNamespace = namespace;
    this.fetcherTrackName = trackName;
    this.requestId = requestId;
    this.objectCallback = onObject;
    this.endCallback = onEnd;
    this.errorCallback = onError;
  }

  get state(): FetcherState {
    return this.fetcherState;
  }

  get namespace(): string[] {
    return this.fetcherNamespace;
  }

  get trackName(): string {
    return this.fetcherTrackName;
  }

  /**
   * Full Track Name の比較キーを取得する（Track 同一性判定用）
   *
   * draft-ietf-moq-transport-21 §2.4.1: Track の同一性は Full Track Name
   * (Track Namespace + Track Name) で判定する。
   * 戻り値は fullTrackNameKey が生成する長さ付きキーであり、Full Track Name
   * そのものではない。Track の同一性判定は完全一致でのみ行う。
   */
  getFullTrackName(): string {
    return fullTrackNameKey(this.fetcherNamespace, this.fetcherTrackName);
  }

  get endOfTrack(): boolean {
    return this.fetchEndOfTrack;
  }

  get endLocation(): Location {
    return this.fetchEndLocation;
  }

  get trackProperties(): ReadonlyArray<Property> {
    return this.fetchTrackProperties;
  }

  getRequestId(): bigint {
    return this.requestId;
  }

  /**
   * FETCH_OK から情報を設定
   */
  setFetchOkInfo(
    endOfTrack: boolean,
    endLocation: Location,
    trackProperties: Property[],
    groupOrder?: GroupOrder,
  ): void {
    this.fetchEndOfTrack = endOfTrack;
    this.fetchEndLocation = endLocation;
    this.fetchTrackProperties = trackProperties;
    if (groupOrder !== undefined) {
      this.fetchGroupOrder = groupOrder;
    }
  }

  /**
   * Fetch リクエストの Group Order を取得
   */
  getGroupOrder(): GroupOrder {
    return this.fetchGroupOrder;
  }

  /**
   * データストリームからオブジェクトを受信
   */
  handleObject(object: MoqtObject): void {
    if (this.fetcherState === "closed") {
      return;
    }
    this.objectCallback(object);
  }

  /**
   * Fetch 完了（ストリーム終了）
   */
  handleEnd(): void {
    if (this.fetcherState === "closed") {
      return;
    }
    this.fetcherState = "closed";
    this.endCallback?.();
  }

  /**
   * エラーハンドリング
   *
   * handleObject / handleEnd と同じく、キャンセル済み (closed) の fetcher には
   * 通知しない。データストリーム受信中にアプリが cancel() を呼んだ後に
   * MalformedTrackError 等が検出された場合の二重通知を防ぐ。
   */
  handleError(error: Error): void {
    if (this.fetcherState === "closed") {
      return;
    }
    this.errorCallback?.(error);
  }

  /**
   * セッションクローズ時にクローズドとしてマーク
   */
  markClosed(): void {
    this.fetcherState = "closed";
  }

  /**
   * Fetch をキャンセル
   *
   * draft-ietf-moq-transport-21 Section 3.2.1 (Fetch State Management):
   * "It MUST send STOP_SENDING for the bidi request stream."
   * FETCH_CANCEL は削除された。キャンセルはストリームを閉じることで行う。
   */
  async cancel(): Promise<void> {
    if (this.fetcherState === "closed") {
      return;
    }

    // キャンセル開始と同時に closed にして、onCancel の await 中の重複した
    // malformed 検出による error コールバックの二重通知と Object 配信を止める
    // (handleError / handleObject / handleEnd は closed で抑止される)。
    // ストリームの後始末 (bidi リクエストストリームへの STOP_SENDING 等) は
    // 従来どおり onCancel が行う。
    this.fetcherState = "closed";

    if (this.onCancel) {
      await this.onCancel();
    }
  }
}
