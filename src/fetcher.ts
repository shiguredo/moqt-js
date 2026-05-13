/**
 * MOQT Fetcher
 * draft-ietf-moq-transport-17 Section 9.14 (FETCH) — 9.15 (FETCH_OK)
 *
 * draft-ietf-moq-transport-17:
 * FETCH レスポンスで不明な範囲を許可する。
 * Publisher がまだシリアライズしていないオブジェクトの範囲を
 * "unknown range" として返すことができる。
 * draft-ietf-moq-transport-17 Section 9.14
 *
 * TODO: Unknown Range Metadata Type の実装
 */

import type { MoqtObject } from "./dataStream";
import type { Location } from "./message/types";
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
   * draft-ietf-moq-transport-17 Section 9.15 (FETCH_OK)
   */
  readonly trackProperties: ReadonlyArray<Property>;
  /**
   * Fetch をキャンセルする
   * draft-ietf-moq-transport-17 Section 5.2 (Fetch State Management)
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

  // Session がストリームクローズ処理を差し込むためのコールバック
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
  setFetchOkInfo(endOfTrack: boolean, endLocation: Location, trackProperties: Property[]): void {
    this.fetchEndOfTrack = endOfTrack;
    this.fetchEndLocation = endLocation;
    this.fetchTrackProperties = trackProperties;
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
   */
  handleError(error: Error): void {
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
   * draft-ietf-moq-transport-17 Section 5.2 (Fetch State Management):
   * "It MUST send STOP_SENDING for the bidi request stream."
   * FETCH_CANCEL は削除された。キャンセルはストリームを閉じることで行う。
   */
  async cancel(): Promise<void> {
    if (this.fetcherState === "closed") {
      return;
    }

    if (this.onCancel) {
      await this.onCancel();
    }

    this.fetcherState = "closed";
  }
}
