/**
 * MOQT Subscriber
 * draft-ietf-moq-transport-19 Section 5.1 (Subscriptions)
 */

import type { Parameter } from "./message/parameter";
import type { LocationFilter, RangeFilterSpec } from "./message/parameter";
import type { AuthorizationToken } from "./message/authorizationToken";
import { isPublishDoneErrorStatus, type Location } from "./message/types";
import type { MoqtObject } from "./dataStream";
import type { Property } from "./properties";
import {
  type ResolvedFilter,
  resolveFilter,
  objectMatchesFilter,
  rangeFiltersMatch,
} from "./filter";

/**
 * Subscriber state
 */
export type SubscriberState = "active" | "closed";

/**
 * Range Filter パラメータの一意キーを生成する
 *
 * draft-ietf-moq-transport-19 §5.1.3:
 * 同一 (Type, SetID, Property Type) の組み合わせのみ重複禁止であり、
 * Property Type が異なる OBJECT_PROPERTY / TRACK_PROPERTY_FILTER は共存できる。
 * キーに propertyType を含めることで共存を保持する。
 * (remove エントリは setRangeFilters で保存されないため、ここには渡らない。
 *  型上は RangeFilterSpec の union のため、非 remove 側に絞ってアクセスする)
 */
function rangeFilterKey(spec: RangeFilterSpec): string {
  if ("remove" in spec) {
    // 到達しない (setRangeFilters は remove エントリを保存しない) が、
    // 型の網羅性のための分岐
    return `${spec.type}:remove`;
  }
  return `${spec.type}:${spec.setId}:${spec.propertyType ?? ""}`;
}

/**
 * REQUEST_UPDATE のオプション
 * draft-ietf-moq-transport-19 Section 10.9 (REQUEST_UPDATE)
 *
 * draft-ietf-moq-transport-19:
 * Start Location は任意の値に減少可能（以前は増加のみ許可されていた）。
 * draft-ietf-moq-transport-19 Section 10.9
 */
export interface RequestUpdateOptions {
  /**
   * パラメータ配列（LOCATION_FILTER, SUBSCRIBER_PRIORITY など）
   */
  parameters?: Parameter[];

  /**
   * Forward State を変更する
   * draft-ietf-moq-transport-19 Section 10.2.17 (FORWARD Parameter)
   *
   * - true: オブジェクトの転送を開始する（Subscriber がいることを通知）
   * - false: オブジェクトの転送を停止する
   * - undefined: 変更しない（REQUEST_UPDATE に FORWARD を含めない）
   */
  forward?: boolean;

  /**
   * Range Filters
   * draft-ietf-moq-transport-19 Section 5.1.3 (Range Filters)
   *
   * Length=0 で削除、省略で不変。
   */
  rangeFilters?: RangeFilterSpec[];
}

/**
 * Subscriber interface
 */
export interface Subscriber {
  readonly state: SubscriberState;
  /**
   * SUBSCRIBE_OK で受信した LARGEST_OBJECT パラメータ
   * draft-ietf-moq-transport-19 Section 10.2.16 (LARGEST OBJECT Parameter)
   *
   * Publisher/Relay が知っている最大の Location を示す。
   * Joining Fetch でどこからデータを取得するか決める際に使用。
   */
  readonly largestLocation: Location | null;
  /**
   * SUBSCRIBE_OK で受信した Track Properties
   * draft-ietf-moq-transport-19 Section 10.8 (SUBSCRIBE_OK):
   * OBJECT_DELIVERY_TIMEOUT, MAX_CACHE_DURATION, DEFAULT_PUBLISHER_PRIORITY,
   * DEFAULT_PUBLISHER_GROUP_ORDER, DYNAMIC_GROUPS 等。
   */
  readonly trackProperties: ReadonlyArray<Property>;
  /**
   * Forward State
   * draft-ietf-moq-transport-19 Section 10.2.17 (FORWARD Parameter)
   *
   * - SUBSCRIBE 送信時の options.forward の宣言値 (省略時は 1)
   * - 自 subscriber.update({ forward }) の REQUEST_OK 確認値
   *
   * を反映したものであり、ピアの PUBLISH_OK 確認値である
   * Publisher.forwardState とは意味論が異なる点に注意。
   * 受信 PUBLISH から生成される SubscriberImpl には、ピアが PUBLISH /
   * REQUEST_UPDATE で宣言した Forward State が設定される。
   */
  readonly forwardState: boolean;
  /**
   * サブスクリプションを更新する（REQUEST_UPDATE を送信）
   * draft-ietf-moq-transport-19 Section 10.9 (REQUEST_UPDATE)
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
  // draft-ietf-moq-transport-19 §10.2.17 (FORWARD Parameter):
  // Forward State。SUBSCRIBE 送信時の宣言値・受信 PUBLISH / ケース 1 の
  // REQUEST_UPDATE / 自 update() の REQUEST_OK で更新される。
  private subscriberForwardState = true;
  // draft-ietf-moq-msf-01 §11.4.3: track に関連するトークンは REQUEST_UPDATE にも MUST 付与。
  private subscriberAuthorizationToken: AuthorizationToken | undefined;
  // draft-ietf-moq-transport-19 Section 5.1.2: Location Filter の再適用に使用
  private locationFilter: LocationFilter | undefined;
  private resolvedFilterCache: ResolvedFilter | undefined;
  // draft-ietf-moq-transport-19 Section 5.1.3: Range Filter の再適用に使用
  private rangeFilters: RangeFilterSpec[] = [];

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

  /**
   * Forward State
   * draft-ietf-moq-transport-19 Section 10.2.17 (FORWARD Parameter)
   */
  get forwardState(): boolean {
    return this.subscriberForwardState;
  }

  /**
   * Forward State を設定する (セッション内部コールバック)
   *
   * draft-ietf-moq-transport-19 §10.2.17:
   * SUBSCRIBE 送信時 (options.forward) / 受信 PUBLISH / ケース 1 の
   * REQUEST_UPDATE / 自 update() の REQUEST_OK の各経路から設定される。
   * アプリケーションへの変化通知コールバックは持たない (Publisher の
   * onForwardStateChange とは非対称。必要になったら別途追加する)。
   */
  setForwardState(forward: boolean): void {
    this.subscriberForwardState = forward;
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
   * draft-ietf-moq-transport-19 Section 10.2.16 (LARGEST OBJECT Parameter)
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
   * SUBSCRIBE 送信時の Authorization Token を設定
   * draft-ietf-moq-msf-01 §11.4.3: 後続の REQUEST_UPDATE に同じトークンを MUST 付与する。
   */
  setAuthorizationToken(token: AuthorizationToken | undefined): void {
    this.subscriberAuthorizationToken = token;
  }

  /**
   * SUBSCRIBE 送信時の Authorization Token を取得
   */
  getAuthorizationToken(): AuthorizationToken | undefined {
    return this.subscriberAuthorizationToken;
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
   * Range Filters を設定する
   *
   * draft-ietf-moq-transport-19 Section 5.1.3:
   * SUBSCRIBE 送信時の options.rangeFilters または REQUEST_UPDATE 成功後の更新で
   * 設定される。
   *
   * REQUEST_UPDATE のセマンティクス (§5.1.3「In REQUEST_UPDATE, Length can be 0
   * to remove a filter parameter or non-zero to replace that entire filter
   * parameter including all sets and Property Types. If a filter parameter is
   * omitted from REQUEST_UPDATE, the value is unchanged.」) に従う:
   * - Length=0 (remove): 当該パラメータ型 (0x25-0x29) 全体を削除
   * - 非ゼロ Length: 当該パラメータ型全体を置換 (他の型は不変)
   * - 省略 (undefined): 不変 (呼び出し側で早期 return)
   *
   * 同型の複数エントリ (異なる SetID / Property Type) は §5.1.3 の
   * 「MAY appear multiple times」に従い保持される。
   */
  setRangeFilters(rangeFilters: RangeFilterSpec[] | undefined): void {
    if (rangeFilters === undefined) {
      return;
    }
    // 現在のフィルタを保持し、当該メッセージで指定された型のみ削除・置換する
    const next = new Map<string, RangeFilterSpec>();
    for (const spec of this.rangeFilters) {
      next.set(rangeFilterKey(spec), spec);
    }

    // remove エントリと非 remove エントリを分離する。
    // 非 remove エントリに出現する型は「置換」のため、既存の同型エントリを
    // すべて削除してから、非 remove エントリをまとめて追加する (1 件ずつ
    // 全削除すると同型の複数エントリが最後の 1 件以外すべて失われるため)。
    const removedTypes = new Set<string>();
    const replaceSpecs: RangeFilterSpec[] = [];
    for (const spec of rangeFilters) {
      if ("remove" in spec) {
        removedTypes.add(spec.type);
      } else {
        replaceSpecs.push(spec);
      }
    }

    // Length=0 の削除: 当該パラメータ型全体 (全 SetID / Property Type) を削除
    for (const type of removedTypes) {
      for (const key of next.keys()) {
        if (key.startsWith(`${type}:`)) {
          next.delete(key);
        }
      }
    }

    // 非ゼロ Length の置換: 当該パラメータ型全体を置き換える
    for (const spec of replaceSpecs) {
      for (const key of next.keys()) {
        if (key.startsWith(`${spec.type}:`)) {
          next.delete(key);
        }
      }
    }
    for (const spec of replaceSpecs) {
      next.set(rangeFilterKey(spec), spec);
    }

    this.rangeFilters = [...next.values()];
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
    // draft-ietf-moq-transport-19 Section 5.1.3: Range Filter 再適用
    if (
      !rangeFiltersMatch(this.rangeFilters, {
        subgroupId: object.subgroupId,
        objectId: object.objectId,
        publisherPriority: object.publisherPriority,
        objectProperties: object.properties,
      })
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
    // draft-ietf-moq-transport-19 Section 5.1.3: Range Filter 再適用
    // datagram 経路では subgroupId は常に undefined であり、SUBGROUP_FILTER は
    // 不通過になる。Priority が明示されていない datagram は PRIORITY_FILTER で
    // 不通過になる (publisherPriority = 0 は評価値として使わない)
    if (
      !rangeFiltersMatch(this.rangeFilters, {
        subgroupId: object.subgroupId,
        objectId: object.objectId,
        publisherPriority: object.publisherPriority,
        objectProperties: object.properties,
      })
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
   * draft-ietf-moq-transport-19 Section 5.1 (Subscriptions):
   * "the publisher terminates a subscription using PUBLISH_DONE"
   *
   * draft-ietf-moq-transport-19 Section 10.11 (PUBLISH_DONE):
   * PUBLISH_DONE Status Code がエラーを示す場合（INTERNAL_ERROR, UPDATE_FAILED 等）、
   * errorCallback で通知する。
   */
  handleEnd(statusCode?: bigint, reasonPhrase?: string): void {
    if (this.subscriberState === "closed") {
      return;
    }
    this.subscriberState = "closed";

    // draft-ietf-moq-transport-19 Section 10.11 (PUBLISH_DONE):
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
   * draft-ietf-moq-transport-19 Section 3.5:
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
   * draft-ietf-moq-transport-19 Section 10.9 (REQUEST_UPDATE):
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
   * draft-ietf-moq-transport-19 Section 5.1 (Subscriptions):
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
