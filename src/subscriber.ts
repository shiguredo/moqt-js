/**
 * MOQT Subscriber
 * draft-ietf-moq-transport-19 Section 5.1 (Subscriptions)
 */

import type { Parameter } from "./message/parameter";
import type { LocationFilter } from "./message/parameter";
import { isPublishDoneErrorStatus, type Location } from "./message/types";
import type { MoqtObject } from "./dataStream";
import type { Property } from "./properties";
import { type ResolvedFilter, resolveFilter, objectMatchesFilter } from "./filter";

/**
 * Subscriber state
 */
export type SubscriberState = "active" | "closed";

/**
 * REQUEST_UPDATE のオプション
 * draft-ietf-moq-transport-18 Section 10.9 (REQUEST_UPDATE)
 *
 * draft-ietf-moq-transport-18:
 * Start Location は任意の値に減少可能（以前は増加のみ許可されていた）。
 * draft-ietf-moq-transport-18 Section 10.9
 */
export interface RequestUpdateOptions {
  /**
   * パラメータ配列（LOCATION_FILTER, SUBSCRIBER_PRIORITY など）
   */
  parameters?: Parameter[];

  /**
   * Forward State を変更する
   * draft-ietf-moq-transport-18 Section 10.2.12 (FORWARD Parameter)
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
   * draft-ietf-moq-transport-18 Section 10.2.11 (LARGEST OBJECT Parameter)
   *
   * Publisher/Relay が知っている最大の Location を示す。
   * Joining Fetch でどこからデータを取得するか決める際に使用。
   */
  readonly largestLocation: Location | null;
  /**
   * SUBSCRIBE_OK で受信した Track Properties
   * draft-ietf-moq-transport-18 Section 10.8 (SUBSCRIBE_OK):
   * OBJECT_DELIVERY_TIMEOUT, MAX_CACHE_DURATION, DEFAULT_PUBLISHER_PRIORITY,
   * DEFAULT_PUBLISHER_GROUP_ORDER, DYNAMIC_GROUPS 等。
   */
  readonly trackProperties: ReadonlyArray<Property>;
  /**
   * サブスクリプションを更新する（REQUEST_UPDATE を送信）
   * draft-ietf-moq-transport-18 Section 10.9 (REQUEST_UPDATE)
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
  // draft-ietf-moq-transport-19 Section 5.1.2: Location Filter の再適用に使用
  private locationFilter: LocationFilter | undefined;
  private resolvedFilterCache: ResolvedFilter | undefined;

  // セッションが利用する内部コールバック
  goawayCallback?: (newSessionUri: string) => void;
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
   * draft-ietf-moq-transport-19 Section 10.2.11 (LARGEST OBJECT Parameter)
   */
  setLargestLocation(location: Location): void {
    this.subscriberLargestLocation = location;
    // LARGEST_OBJECT 更新時に解決済みフィルタを再計算
    this.resolvedFilterCache = resolveFilter(this.locationFilter, this.subscriberLargestLocation);
  }

  /**
   * SUBSCRIBE_OK から Track Properties を設定
   * draft-ietf-moq-transport-19 Section 10.8 (SUBSCRIBE_OK)
   */
  setTrackProperties(properties: Property[]): void {
    this.subscriberTrackProperties = properties;
  }

  /**
   * Set track alias (called when SUBSCRIBE_OK is received)
   *
   * draft-ietf-moq-transport-19 Section 10.8 (SUBSCRIBE_OK):
   * Track Alias is returned by the publisher in SUBSCRIBE_OK.
   */
  setTrackAlias(alias: bigint): void {
    this.trackAlias = alias;
  }

  /**
   * Location Filter を設定する
   *
   * draft-ietf-moq-transport-19 Section 5.1.2:
   * SUBSCRIBE 送信時の options.filter または REQUEST_UPDATE 成功後の更新で設定される。
   */
  setLocationFilter(filter: LocationFilter | undefined): void {
    this.locationFilter = filter;
    this.resolvedFilterCache = resolveFilter(filter, this.subscriberLargestLocation);
  }

  /**
   * Full Track Name を取得する（Track 同一性判定用）
   * draft-ietf-moq-transport-19 Section 2.4.1: Track の同一性は Full Track Name で判定
   */
  getFullTrackName(): string {
    return `${this.subscriberNamespace.join("/")}/${this.subscriberTrackName}`;
  }

  /**
   * Handle incoming object from data stream
   *
   * draft-ietf-moq-transport-19 Section 5.1:
   * 同一 Track の複数 subscription に対して、各 subscription の filter を再適用する。
   *
   * 1 Group = 1 Subgroup = 1 Stream のため、QUIC がストリーム内の順序を保証する。
   * Group 間の順序はキーフレーム単位なので、順序保証は不要。
   */
  handleObject(object: MoqtObject): void {
    if (this.subscriberState === "closed") {
      return;
    }
    // draft-ietf-moq-transport-19 Section 5.1.2: Location Filter 再適用
    if (
      !objectMatchesFilter(
        { group: object.groupId, object: object.objectId },
        this.resolvedFilterCache,
      )
    ) {
      return;
    }
    this.objectCallback(object);
  }

  /**
   * Handle incoming datagram
   * draft-ietf-moq-transport-19 Section 11.3 (Datagrams)
   *
   * draft-ietf-moq-transport-19:
   * 同一トラック内で Datagram と Subgroup (Stream) の混在が許可される。
   * Subscriber は両方のコールバックを設定することで混在配信を受け取れる。
   * draft-ietf-moq-transport-19 Section 2.2, Section 11.3
   */
  handleDatagram(object: MoqtObject): void {
    if (this.subscriberState === "closed") {
      return;
    }
    // draft-ietf-moq-transport-19 Section 5.1.2: Location Filter 再適用
    if (
      !objectMatchesFilter(
        { group: object.groupId, object: object.objectId },
        this.resolvedFilterCache,
      )
    ) {
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
   * draft-ietf-moq-transport-18 Section 5.1 (Subscriptions):
   * "the publisher terminates a subscription using PUBLISH_DONE"
   *
   * draft-ietf-moq-transport-18 Section 10.11 (PUBLISH_DONE):
   * PUBLISH_DONE Status Code がエラーを示す場合（INTERNAL_ERROR, UPDATE_FAILED 等）、
   * errorCallback で通知する。
   */
  handleEnd(statusCode?: bigint, reasonPhrase?: string): void {
    if (this.subscriberState === "closed") {
      return;
    }
    this.subscriberState = "closed";

    // draft-ietf-moq-transport-18 Section 10.11 (PUBLISH_DONE):
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
   * draft-ietf-moq-transport-18 Section 3.5:
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
   * draft-ietf-moq-transport-18 Section 10.9 (REQUEST_UPDATE):
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
   * draft-ietf-moq-transport-18 Section 5.1 (Subscriptions):
   * "The subscriber terminates a subscription in the Pending (Subscriber) or Established states
   * by sending STOP_SENDING."
   *
   * Note: endCallback is NOT called here because unsubscribe is
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
