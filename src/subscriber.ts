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
import { mergeRangeFilters } from "./session/params";
import type { FillRequestOptions } from "./session";

/**
 * Subscriber state
 */
export type SubscriberState = "active" | "closed";

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

  /**
   * fill fetch の要求
   * draft-ietf-moq-transport-20 Section 5.1.3 (Fill Semantics) /
   * Section 10.2.15 (FILL PARAMETERS Parameter)
   *
   * FILL_PARAMETERS (0x23) として送信し、fill fetch ストリームを要求する。
   * FILL_PARAMETERS は subscription 状態として保持されず、載せたメッセージに
   * のみ適用される (載せない更新では fill ストリームは開かれない)。
   * fill の受信関連付けは session が保持する。
   */
  fill?: FillRequestOptions;
}

/**
 * Subscriber interface
 */
export interface Subscriber {
  readonly state: SubscriberState;
  /**
   * SUBSCRIBE_OK で受信した LARGEST_OBJECT パラメータ
   * draft-ietf-moq-transport-20 Section 10.2.17 (LARGEST OBJECT Parameter)
   *
   * Publisher/Relay が知っている最大の Location を示す。
   * 相対指定 (1 フィールド) の Location Filter と Next Object 形式の
   * 解決に使用する (draft-ietf-moq-transport-20 §5.1.2)。
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
   * draft-ietf-moq-transport-20 Section 10.2.18 (FORWARD Parameter)
   *
   * - SUBSCRIBE 送信時の options.forward の宣言値 (省略時は 1)
   * - 自 subscriber.update({ forward }) の REQUEST_OK 確認値
   *
   * を反映したものであり、PUBLISH 送信時初期値と REQUEST_UPDATE 受信値を
   * 反映する Publisher.forwardState とは更新経路が異なる点に注意。
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
  // draft-ietf-moq-transport-20 §10.2.8 (GROUP ORDER Parameter):
  // SUBSCRIBE 送信時の宣言値。fill 要求時の Group Order 解決
  // (FILL_PARAMETERS 内の指定が無ければ subscription の値) に使う。
  private subscriberGroupOrder: "Ascending" | "Descending" | undefined;
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

  /**
   * SUBSCRIBE 送信時の Group Order を設定する (セッション内部コールバック)
   *
   * draft-ietf-moq-transport-20 §10.2.8 (GROUP ORDER Parameter):
   * fill 要求時の Group Order 解決に使う。
   */
  setGroupOrder(groupOrder: "Ascending" | "Descending" | undefined): void {
    this.subscriberGroupOrder = groupOrder;
  }

  /**
   * SUBSCRIBE 送信時の Group Order を取得する
   */
  getGroupOrder(): "Ascending" | "Descending" | undefined {
    return this.subscriberGroupOrder;
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
   * SUBSCRIBE 送信時の options.rangeFilters または REQUEST_UPDATE 成功後の
   * 更新で設定される。削除・置換・不変の適用規則は送信前検証と共通の
   * 純関数 mergeRangeFilters (src/session/params.ts) に集約している。
   * 適用規則の詳細は mergeRangeFilters の JSDoc を参照。
   */
  setRangeFilters(rangeFilters: RangeFilterSpec[] | undefined): void {
    if (rangeFilters === undefined) {
      return;
    }
    this.rangeFilters = mergeRangeFilters(this.rangeFilters, rangeFilters);
  }

  /**
   * 現在の Range Filters を取得する
   *
   * 送信前の MAX_FILTER_RANGES 検証 (マージ後状態) で利用する。内部配列の
   * 参照を覗かせず、コピーを返す (配列の追加・削除による状態破壊を防ぐ。
   * 要素オブジェクトと ranges 配列は参照共有のため、要素を mutate しない
   * こと)。公開インターフェース (Subscriber) には追加しない (アプリの
   * ニーズが確認された場合に別途検討)。
   */
  getRangeFilters(): RangeFilterSpec[] {
    return [...this.rangeFilters];
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
   * fill fetch ストリームから届いたオブジェクトを受け取る
   *
   * draft-ietf-moq-transport-20 §5.1.2 / §5.1.3 (Fill Semantics):
   * fill-delivered のオブジェクトは fill 範囲 (FILL_PARAMETERS 内のフィルタ)
   * に従属するため、subscription の Location Filter / Range Filter 再適用
   * (handleObject) を通さず、fillDelivered を true にして object
   * コールバックに渡す。subscription-delivered (handleObject 経由) とは
   * fillDelivered の値で区別できる。同一 Location が両経路で届いた場合の
   * 二重処理の回避はアプリの責務であり、自動の重複排除は行わない。
   * 各 Object を一度だけ受け取りたい場合は、Next Object の subscription
   * (StartGroup = 0 かつ StartObject = 0) と open-ended な fill を組み合わせる
   * (publisher が fill を Largest Object で終えるため重複なくつながる。
   * §5.1.3 の exactly-once パターン)。state が closed の場合は受け取らない。
   */
  handleFillObject(object: MoqtObject): void {
    if (this.subscriberState === "closed") {
      return;
    }
    this.objectCallback({ ...object, fillDelivered: true });
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
   *
   * fire-and-forget で呼び出しても、GOAWAY / REQUEST_ERROR / FIN / RESET 等に
   * よる reject が unhandled rejection にならないよう、同一インスタンスに
   * catch ハンドラを登録した Promise を直接返す。async の wrapper 経由にすると
   * wrapper 側の無観測 reject が unhandled になるため、ここで必ず捕まえる。
   */
  update(options?: RequestUpdateOptions): Promise<void> {
    if (this.subscriberState === "closed") {
      // 非 async 化に伴い同期 throw ではなく rejected な Promise を返す
      // (fire-and-forget 呼び出しの観測挙動を変えないため)。await する呼び出し
      // には reject が伝播する。catch ハンドラは返却値と同一インスタンスに登録する
      // (void ハンドラの catch 派生を返すと resolve 化して伝播しなくなる)。
      const rejected = Promise.reject(new Error("Subscriber is closed"));
      rejected.catch(() => {});
      return rejected;
    }

    if (this.onUpdate) {
      // onUpdate の同期 throw は旧 async 実装と等価に rejected な Promise と
      // して返す。型違反の非 Promise 返却時は防御的に rejected 化する。
      let promise: Promise<void>;
      try {
        const inner = this.onUpdate(options ?? {});
        inner.catch(() => {});
        promise = inner;
      } catch (error) {
        promise = Promise.reject(error);
        promise.catch(() => {});
      }
      return promise;
    }
    return Promise.resolve();
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
