/**
 * MOQT Publisher
 * draft-ietf-moq-transport-18 Section 5 (Publishing and Retrieving Tracks)
 */

import type { ObjectStatus } from "./message/types";

/**
 * Publisher state
 */
export type PublisherState = "active" | "closed";

/**
 * Parameters for sending an object
 */
export interface SendObjectParams {
  groupId: number;
  objectId: number;
  payload: Uint8Array;
  properties?: Uint8Array;
  priority?: number;
  /**
   * オブジェクトステータス
   * draft-ietf-moq-transport-18 §11.2.1.1
   *
   * - NORMAL (0x0): 通常のオブジェクト（デフォルト）
   * - END_OF_GROUP (0x3): グループの終端。payload は空でなければならない
   * - END_OF_TRACK (0x4): トラックの終端。payload は空でなければならない。
   *   END_OF_TRACK 送信後は同一トラックへの後続 sendObject() が禁止される（MUST）
   */
  status?: ObjectStatus;
  /**
   * Object Delivery Timeout（ミリ秒）
   * draft-ietf-moq-transport-19 Section 12.2 / Section 8
   *
   * subgroup 先頭オブジェクトの Object Property として送信される。
   * 先頭以外で指定すると throw する。
   */
  deliveryTimeout?: bigint;
  /**
   * Subgroup Delivery Timeout（ミリ秒）
   * draft-ietf-moq-transport-19 Section 12.1 / Section 8
   *
   * subgroup 先頭オブジェクトの Object Property として送信される。
   * 先頭以外で指定すると throw する。
   */
  subgroupDeliveryTimeout?: bigint;
}

/**
 * Parameters for sending a datagram
 * draft-ietf-moq-transport-18 Section 11.3 (Datagrams)
 */
export interface SendDatagramParams {
  groupId: number;
  objectId: number;
  payload: Uint8Array;
  properties?: Uint8Array;
  priority?: number;
  /**
   * このオブジェクトがグループの最後かどうか
   */
  endOfGroup?: boolean;
}

/**
 * Publisher interface
 */
export interface Publisher {
  readonly state: PublisherState;
  /**
   * Forward State
   * draft-ietf-moq-transport-18 Section 10.2.12 (FORWARD Parameter)
   *
   * PUBLISH_OK で受信した forwardState を返す。
   * - true (1): オブジェクトを転送する（Subscriber がいる）
   * - false (0): オブジェクトを転送しない（Subscriber がいない）
   *
   * REQUEST_UPDATE で状態が変更された場合、onForwardStateChange が呼ばれる。
   */
  readonly forwardState: boolean;
  /**
   * Subgroup ストリームでオブジェクトを送信する
   *
   * 戻り値は object が WebTransport stream に書き込まれて完了した時点で resolve する Promise。
   * Catalog のように「relay に届いてキャッシュされてから後続 subscriber が参照する」必要がある
   * オブジェクトは await することで、書き込み完了後に return できる。
   * リアルタイムの音声・映像フレームのように落としても良い (もしくは後続のオブジェクトで上書きされる)
   * ものは fire-and-forget で良いので、戻り値を `void` で破棄して構わない。
   */
  sendObject(params: SendObjectParams): Promise<void>;
  /**
   * Datagram でオブジェクトを送信する
   * draft-ietf-moq-transport-18 Section 11.3 (Datagrams)
   *
   * 注意: Datagram は信頼性がなく、順序も保証されない
   *
   * draft-ietf-moq-transport-18:
   * 同一トラック内で Datagram と Subgroup (Stream) の混在が許可される。
   * Publisher は sendObject() と sendDatagram() を同じトラックで併用できる。
   * draft-ietf-moq-transport-18 Section 2.2, Section 11.3
   */
  sendDatagram(params: SendDatagramParams): void;
  done(): Promise<void>;
}

/**
 * Internal Publisher implementation
 */
export class PublisherImpl implements Publisher {
  private publisherState: PublisherState = "active";
  private publisherForwardState = true;
  private readonly publisherNamespace: string[];
  private readonly publisherTrackName: string;
  private readonly errorCallback?: (error: Error) => void;
  private readonly forwardStateChangeCallback?: (forward: boolean) => void;
  private readonly requestId: bigint;
  private readonly trackAlias: bigint;

  // draft-ietf-moq-transport-18 Section 10.11 (PUBLISH_DONE):
  // PUBLISH_DONE の Stream Count 用カウンター
  private dataStreamCount = 0n;

  // セッションが利用する内部コールバック
  goawayCallback?: (newSessionUri: string) => void;
  onSendObject?: (params: SendObjectParams) => Promise<void>;
  onSendDatagram?: (params: SendDatagramParams) => void;
  onDoneInternal?: () => Promise<void>;

  constructor(
    namespace: string[],
    trackName: string,
    requestId: bigint,
    trackAlias: bigint,
    onError?: (error: Error) => void,
    onForwardStateChange?: (forward: boolean) => void,
  ) {
    this.publisherNamespace = namespace;
    this.publisherTrackName = trackName;
    this.requestId = requestId;
    this.trackAlias = trackAlias;
    this.errorCallback = onError;
    this.forwardStateChangeCallback = onForwardStateChange;
  }

  get state(): PublisherState {
    return this.publisherState;
  }

  get forwardState(): boolean {
    return this.publisherForwardState;
  }

  get namespace(): string[] {
    return this.publisherNamespace;
  }

  get trackName(): string {
    return this.publisherTrackName;
  }

  getRequestId(): bigint {
    return this.requestId;
  }

  getTrackAlias(): bigint {
    return this.trackAlias;
  }

  incrementDataStreamCount(): void {
    this.dataStreamCount++;
  }

  getDataStreamCount(): bigint {
    return this.dataStreamCount;
  }

  /**
   * Send an object on this track
   *
   * 戻り値は object が WebTransport stream に書き込み完了した時点で resolve する Promise。
   * Catalog のように relay 到達を保証してから後続処理に進めたい場合は await する。
   * リアルタイムフレームのように落としても良い場合は `void` で破棄して構わない。
   */
  sendObject(params: SendObjectParams): Promise<void> {
    if (this.publisherState === "closed") {
      throw new Error("Publisher is closed");
    }

    if (this.onSendObject) {
      return this.onSendObject(params);
    }
    return Promise.resolve();
  }

  /**
   * Send a datagram on this track
   * draft-ietf-moq-transport-18 Section 11.3 (Datagrams)
   */
  sendDatagram(params: SendDatagramParams): void {
    if (this.publisherState === "closed") {
      throw new Error("Publisher is closed");
    }

    if (this.onSendDatagram) {
      this.onSendDatagram(params);
    }
  }

  /**
   * Handle error
   */
  handleError(error: Error): void {
    this.errorCallback?.(error);
  }

  /**
   * Internal: Set forward state (called by session)
   * draft-ietf-moq-transport-18 Section 10.2.12 (FORWARD Parameter)
   *
   * PUBLISH_OK または REQUEST_UPDATE で受信した FORWARD パラメータを反映する。
   * 状態が変化した場合、onForwardStateChange コールバックを呼ぶ。
   */
  setForwardState(forward: boolean): void {
    const previousState = this.publisherForwardState;
    this.publisherForwardState = forward;
    if (previousState !== forward) {
      this.forwardStateChangeCallback?.(forward);
    }
  }

  /**
   * Signal that publishing is done
   */
  async done(): Promise<void> {
    if (this.publisherState === "closed") {
      return;
    }

    if (this.onDoneInternal) {
      await this.onDoneInternal();
    }

    this.publisherState = "closed";
  }

  /**
   * Internal: mark as closed (called by session)
   */
  markClosed(): void {
    this.publisherState = "closed";
  }
}
