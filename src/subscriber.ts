/**
 * MOQT Subscriber
 * draft-ietf-moq-transport-17 Section 5.1 (Subscriptions)
 */

import type { Parameter } from "./message/parameter";
import { isPublishDoneErrorStatus, type Location } from "./message/types";
import type { MoqtObject } from "./dataStream";
import type { Property } from "./properties";

/**
 * Subscriber state
 */
export type SubscriberState = "active" | "closed";

/**
 * REQUEST_UPDATE のオプション
 * draft-ietf-moq-transport-17 Section 9.10 (REQUEST_UPDATE)
 *
 * draft-ietf-moq-transport-17:
 * Start Location は任意の値に減少可能（以前は増加のみ許可されていた）。
 * https://github.com/moq-wg/moq-transport/pull/1323
 */
export interface RequestUpdateOptions {
  /**
   * パラメータ配列（SUBSCRIPTION_FILTER, SUBSCRIBER_PRIORITY など）
   */
  parameters?: Parameter[];

  /**
   * Forward State を変更する
   * draft-ietf-moq-transport-17 Section 9.3.10 (FORWARD Parameter)
   *
   * - true: オブジェクトの転送を開始する（Subscriber がいることを通知）
   * - false: オブジェクトの転送を停止する
   * - undefined: 変更しない（REQUEST_UPDATE に FORWARD を含めない）
   */
  forward?: boolean;
}

/**
 * Subscriber interface
 */
export interface Subscriber {
  readonly state: SubscriberState;
  /**
   * SUBSCRIBE_OK で受信した LARGEST_OBJECT パラメータ
   * draft-ietf-moq-transport-17 Section 9.3.9 (LARGEST OBJECT Parameter)
   *
   * Publisher/Relay が知っている最大の Location を示す。
   * Joining Fetch でどこからデータを取得するか決める際に使用。
   */
  readonly largestLocation: Location | null;
  /**
   * SUBSCRIBE_OK で受信した Track Properties
   * draft-ietf-moq-transport-17 Section 9.9 (SUBSCRIBE_OK):
   * DELIVERY_TIMEOUT, MAX_CACHE_DURATION, DEFAULT_PUBLISHER_PRIORITY,
   * DEFAULT_PUBLISHER_GROUP_ORDER, DYNAMIC_GROUPS 等。
   */
  readonly trackProperties: ReadonlyArray<Property>;
  /**
   * サブスクリプションを更新する（REQUEST_UPDATE を送信）
   * draft-ietf-moq-transport-17 Section 9.10 (REQUEST_UPDATE)
   */
  update(options?: RequestUpdateOptions): Promise<void>;
  unsubscribe(): Promise<void>;
}

/**
 * Internal Subscriber implementation
 */
export class SubscriberImpl implements Subscriber {
  private subscriberState: SubscriberState = "active";
  private readonly subscriberNamespace: string[];
  private readonly subscriberTrackName: string;
  private readonly objectCallback: (object: MoqtObject) => void;
  private readonly datagramCallback?: (object: MoqtObject) => void;
  private readonly endCallback?: () => void;
  private readonly errorCallback?: (error: Error) => void;
  private readonly requestId: bigint;
  private trackAlias: bigint;
  private subscriberLargestLocation: Location | null = null;
  private subscriberTrackProperties: Property[] = [];

  // Internal callbacks for session to use
  onUnsubscribe?: () => Promise<void>;
  onUpdate?: (options: RequestUpdateOptions) => Promise<void>;

  constructor(
    namespace: string[],
    trackName: string,
    requestId: bigint,
    trackAlias: bigint,
    onObject: (object: MoqtObject) => void,
    onDatagram?: (object: MoqtObject) => void,
    onEnd?: () => void,
    onError?: (error: Error) => void,
  ) {
    this.subscriberNamespace = namespace;
    this.subscriberTrackName = trackName;
    this.requestId = requestId;
    this.trackAlias = trackAlias;
    this.objectCallback = onObject;
    this.datagramCallback = onDatagram;
    this.endCallback = onEnd;
    this.errorCallback = onError;
  }

  get state(): SubscriberState {
    return this.subscriberState;
  }

  get largestLocation(): Location | null {
    return this.subscriberLargestLocation;
  }

  get trackProperties(): ReadonlyArray<Property> {
    return this.subscriberTrackProperties;
  }

  get namespace(): string[] {
    return this.subscriberNamespace;
  }

  get trackName(): string {
    return this.subscriberTrackName;
  }

  getRequestId(): bigint {
    return this.requestId;
  }

  getTrackAlias(): bigint {
    return this.trackAlias;
  }

  /**
   * SUBSCRIBE_OK から LARGEST_OBJECT パラメータを設定
   * draft-ietf-moq-transport-17 Section 9.3.9 (LARGEST OBJECT Parameter)
   */
  setLargestLocation(location: Location): void {
    this.subscriberLargestLocation = location;
  }

  /**
   * SUBSCRIBE_OK から Track Properties を設定
   * draft-ietf-moq-transport-17 Section 9.9 (SUBSCRIBE_OK)
   */
  setTrackProperties(properties: Property[]): void {
    this.subscriberTrackProperties = properties;
  }

  /**
   * Set track alias (called when SUBSCRIBE_OK is received)
   *
   * draft-ietf-moq-transport-17 Section 9.9 (SUBSCRIBE_OK):
   * Track Alias is returned by the publisher in SUBSCRIBE_OK.
   */
  setTrackAlias(alias: bigint): void {
    this.trackAlias = alias;
  }

  /**
   * Handle incoming object from data stream
   *
   * draft-ietf-moq-transport-17 Section 2.2:
   * "Objects in a subgroup ... are sent on a single stream whenever possible."
   *
   * 1 Group = 1 Subgroup = 1 Stream のため、QUIC がストリーム内の順序を保証する。
   * Group 間の順序はキーフレーム単位なので、順序保証は不要。
   */
  handleObject(object: MoqtObject): void {
    if (this.subscriberState === "closed") {
      return;
    }
    this.objectCallback(object);
  }

  /**
   * Handle incoming datagram
   * draft-ietf-moq-transport-17 Section 10.3 (Datagrams)
   *
   * draft-ietf-moq-transport-17:
   * 同一トラック内で Datagram と Subgroup (Stream) の混在が許可される。
   * Subscriber は両方のコールバックを設定することで混在配信を受け取れる。
   * https://github.com/moq-wg/moq-transport/pull/1350
   */
  handleDatagram(object: MoqtObject): void {
    if (this.subscriberState === "closed") {
      return;
    }
    this.datagramCallback?.(object);
  }

  /**
   * Datagram コールバックが設定されているかどうか
   */
  hasDatagramCallback(): boolean {
    return this.datagramCallback !== undefined;
  }

  /**
   * Handle track end (from PUBLISH_DONE)
   *
   * draft-ietf-moq-transport-17 Section 5.1 (Subscriptions):
   * "the publisher terminates a subscription using PUBLISH_DONE"
   *
   * draft-ietf-moq-transport-17 Section 9.13 (PUBLISH_DONE):
   * PUBLISH_DONE Status Code がエラーを示す場合（INTERNAL_ERROR, UPDATE_FAILED 等）、
   * errorCallback で通知する。
   */
  handleEnd(statusCode?: bigint, reasonPhrase?: string): void {
    if (this.subscriberState === "closed") {
      return;
    }
    this.subscriberState = "closed";

    // draft-ietf-moq-transport-17 Section 9.13 (PUBLISH_DONE):
    // INTERNAL_ERROR (0x0) 等はエラー。TRACK_ENDED (0x2) 等はエラーとみなさない。
    if (statusCode !== undefined && isPublishDoneErrorStatus(statusCode)) {
      this.errorCallback?.(
        new Error(
          `PUBLISH_DONE with status 0x${statusCode.toString(16)}${reasonPhrase ? `: ${reasonPhrase}` : ""}`,
        ),
      );
    }

    this.endCallback?.();
  }

  /**
   * Handle error
   */
  handleError(error: Error): void {
    this.errorCallback?.(error);
  }

  /**
   * Mark as closed (called by session on session close)
   *
   * draft-ietf-moq-transport-17 Section 3.4:
   * "The Transport Session can be terminated at any point."
   *
   * Note: endCallback is NOT called here because session close is
   * session-level termination, not track-level PUBLISH_DONE.
   * Session close is notified via ConnectCallbacks.close instead.
   */
  markClosed(): void {
    this.subscriberState = "closed";
  }

  /**
   * サブスクリプションを更新する
   *
   * draft-ietf-moq-transport-17 Section 9.10 (REQUEST_UPDATE):
   * "A subscriber sends a REQUEST_UPDATE to a publisher to modify an existing subscription."
   */
  async update(options?: RequestUpdateOptions): Promise<void> {
    if (this.subscriberState === "closed") {
      throw new Error("Subscriber is closed");
    }

    if (this.onUpdate) {
      await this.onUpdate(options ?? {});
    }
  }

  /**
   * Unsubscribe from the track
   *
   * draft-ietf-moq-transport-17 Section 5.1 (Subscriptions):
   * "The subscriber terminates a subscription using UNSUBSCRIBE"
   *
   * Note: endCallback is NOT called here because UNSUBSCRIBE is
   * subscriber-initiated. endCallback is only for PUBLISH_DONE
   * (publisher-initiated termination).
   */
  async unsubscribe(): Promise<void> {
    if (this.subscriberState === "closed") {
      return;
    }

    if (this.onUnsubscribe) {
      await this.onUnsubscribe();
    }

    this.subscriberState = "closed";
  }
}
