/**
 * MOQT Subscriber
 * draft-ietf-moq-transport-23 §3.1 (Subscriptions) / §3.1.1 (Pausing Subscriptions)
 */

import type { Parameter } from "./message/parameter";
import type { LocationFilter, RangeFilterSpec } from "./message/parameter";
import type { AuthorizationToken } from "./message/authorizationToken";
import { ObjectStatus, type Location, type PublishDoneStatusCode } from "./message/types";
import type { MoqtObject } from "./dataStream";
import {
  resolveDefaultPublisherPriority,
  resolveTrackProperty,
  TrackPropertyId,
  type Property,
} from "./properties";
import {
  type ResolvedFilter,
  resolveFilter,
  objectMatchesFilter,
  rangeFiltersMatch,
  rangeFiltersRequireSubgroup,
} from "./filter";
import { fullTrackNameKey, type FullTrackNameKey } from "./fullTrackName";
import { clampTimeoutMs, compareLocations, mergeRangeFilters } from "./session/params";
import { MAX_VARINT } from "./varint";
import type { FillRequestOptions, PublishDoneInfo, SubgroupStreamEnd } from "./session";

/**
 * Subscriber state
 */
export type SubscriberState = "active" | "closed";

// §9.9: 配信タイムアウトの指定がなくても、経路間で順序が入れ替わる時間を確保する。
const DEFAULT_PUBLISH_DONE_WAIT_MS = 1000n;

interface PublishDoneDrain {
  streamCount: bigint;
  finish: () => void;
  timer: ReturnType<typeof setTimeout> | undefined;
  mayReceiveDatagrams: boolean;
  startedAtMs: bigint;
  deadlineMs: bigint;
}

/**
 * REQUEST_UPDATE のオプション
 * draft-ietf-moq-transport-23 Section 9.5 (REQUEST_UPDATE)
 *
 * draft-ietf-moq-transport-23:
 * Start Location は任意の値に減少可能（以前は増加のみ許可されていた）。
 * draft-ietf-moq-transport-23 Section 9.5
 */
export interface RequestUpdateOptions {
  /**
   * パラメータ配列（LOCATION_FILTER, SUBSCRIBER_PRIORITY など）
   */
  parameters?: Parameter[];

  /**
   * 購読を paused にするかどうかを変更する
   * draft-ietf-moq-transport-23 §9.19.18 (PAUSED Parameter) / §3.1.1 (Pausing Subscriptions)
   *
   * wire の PAUSED と同じ意味である。
   *
   * - true: paused にする (PAUSED=1 を送る。オブジェクトの送信が止まる)
   * - false: paused を解除する (PAUSED=0 を送る。オブジェクトの送信が再開する)
   * - undefined: 変更しない (PAUSED を含めない = 現在の状態を維持する)
   *
   * draft-22 の FORWARD は 1 = 転送するだったため、値の意味が反転している。
   */
  paused?: boolean;

  /**
   * Range Filters
   * draft-ietf-moq-transport-23 Section 3.3.2 (Range Filters)
   *
   * Length=0 で削除、省略で不変。
   */
  rangeFilters?: RangeFilterSpec[];

  /**
   * fill fetch の要求
   * draft-ietf-moq-transport-23 §3.4 (Fill Semantics) /
   * §9.19.15 (FILL PARAMETERS Parameter)
   *
   * FILL_PARAMETERS (0x23) として送信し、fill fetch ストリームを要求する。
   * FILL_PARAMETERS は subscription 状態として保持されず、載せたメッセージに
   * のみ適用される (載せない更新では fill ストリームは開かれない)。
   * fill の受信関連付けは session が保持する。
   */
  fill?: FillRequestOptions;

  /**
   * 新規 Group 開始の要求値
   * draft-ietf-moq-transport-23 Section 9.19.19 (NEW_GROUP_REQUEST Parameter)
   *
   * subscriber が知る最大 Group ID + 1 (情報なし時は 0) を送る。
   * NEW_GROUP_REQUEST (0x32) として送信する。
   */
  newGroupRequest?: bigint;
}

/**
 * Subscriber interface
 */
export interface Subscriber {
  readonly state: SubscriberState;
  /**
   * SUBSCRIBE_OK / PUBLISH / REQUEST_UPDATE_OK / PUBLISH_STATE_NOTIFY で
   * 受信した LARGEST_OBJECT パラメータ
   * draft-ietf-moq-transport-23 Section 9.19.17 (LARGEST OBJECT Parameter)
   *
   * Publisher/Relay が知っている最大の Location を示す。
   * 相対指定 (Location Filter Type 0x01) の Location Filter と Next Object (0x05) の
   * 解決に使用する (draft-ietf-moq-transport-23 §3.3.1)。
   */
  readonly largestLocation: Location | null;
  /**
   * 購読で受信した実 Object のうち最大の Location (1 件も受け取っていなければ null)
   *
   * draft-ietf-moq-transport-23 §3.1.4 (Largest Object):
   * "Largest Object updates when the first byte of an Object with a Location larger
   *  than the previous value is published or received through a subscription."
   * 購読の Object 経路 (Subgroup / Datagram / fill fetch) から届いた Object で進む。
   * 購読のフィルタで配送しないと決めた Object でも、受信していれば進める。
   *
   * `largestLocation` がピアの LARGEST_OBJECT パラメータ (§9.19.17) の値であるのに対し、
   * こちらは購読者が自分で観測した値である。NEW_GROUP_REQUEST の値
   * (§9.19.19 の「購読者が知る最大 Group ID + 1」) は、両者の大きい方から
   * `resolveNewGroupRequestValue` が解決する。
   */
  readonly largestReceivedLocation: Location | null;
  /**
   * 購読の確立時に受信した Track Properties
   *
   * draft-ietf-moq-transport-23 §9.7 (SUBSCRIBE_OK) / §9.8 (PUBLISH):
   * SUBSCRIBE で確立した購読では SUBSCRIBE_OK が運んだ値、PUBLISH で確立した購読では
   * PUBLISH が運んだ値である。OBJECT_DELIVERY_TIMEOUT, MAX_CACHE_DURATION,
   * DEFAULT_PUBLISHER_PRIORITY, DEFAULT_PUBLISHER_GROUP_ORDER, DYNAMIC_GROUPS 等。
   *
   * draft-ietf-moq-loc-05 §6.1 Table 1: LOC の TIMESCALE / VIDEO_CONFIG /
   * AUDIO_CONFIG は Track scope を持つためここに入る。TIMESTAMP は Object scope
   * のみであり、ここには入らない (Object の `properties` から読む)。
   */
  readonly trackProperties: ReadonlyArray<Property>;
  /**
   * 購読が paused かどうか
   * draft-ietf-moq-transport-23 §9.19.18 (PAUSED Parameter) / §3.1.1 (Pausing Subscriptions)
   *
   * wire の PAUSED と同じ意味で、true = paused (1)、false = unpaused (0)。
   * - SUBSCRIBE 送信時の options.paused の宣言値 (省略時は false = unpaused)
   * - 自 subscriber.update({ paused }) の REQUEST_OK 確認値
   *
   * を反映したものであり、PUBLISH 送信時初期値と REQUEST_UPDATE 受信値を
   * 反映する Publisher.paused とは更新経路が異なる点に注意。
   * 受信 PUBLISH から生成される SubscriberImpl には、ピアが PUBLISH /
   * REQUEST_UPDATE で宣言した paused が設定される。
   */
  readonly paused: boolean;
  /**
   * サブスクリプションを更新する（REQUEST_UPDATE を送信）
   * draft-ietf-moq-transport-23 Section 9.5 (REQUEST_UPDATE)
   */
  update(options?: RequestUpdateOptions): Promise<void>;
  unsubscribe(): Promise<void>;
}

/**
 * Internal Subscriber implementation
 */
export class SubscriberImpl implements Subscriber {
  private subscriberState: SubscriberState = "active";
  private publishDoneDrain: PublishDoneDrain | undefined;
  private openDataStreams = 0;
  private processedDataStreams = 0n;
  private sharedTrackAlias = false;
  private longestDeliveryTimeout = 0n;
  private readonly trackKey: FullTrackNameKey;
  private readonly objectCallback: (object: MoqtObject) => void;
  // 未指定の場合は明示的に undefined を代入する (呼び出し側は `?.` で呼ぶ) ため
  // `| undefined` を付ける
  private readonly datagramCallback?: ((object: MoqtObject) => void) | undefined;
  private readonly endCallback?: ((publishDone: PublishDoneInfo) => void) | undefined;
  private readonly errorCallback?: ((error: Error) => void) | undefined;
  private readonly requestId: bigint;
  private trackAlias: bigint;
  private subscriberLargestLocation: Location | null = null;
  // draft-ietf-moq-transport-23 §3.1.4 (Largest Object):
  // 購読で受信した Object の最大 Location。LARGEST_OBJECT で報告された値
  // (subscriberLargestLocation) とは別に、自分が受信した Object でも進める。
  // NEW_GROUP_REQUEST の値 (§9.19.19) を古い snapshot から作らないために持つ
  private subscriberLargestReceivedLocation: Location | null = null;
  private subscriberTrackProperties: Property[] = [];
  // draft-ietf-moq-transport-23 §10.4 (DEFAULT PUBLISHER_PRIORITY):
  // Subgroup Header / Object Datagram で Priority が省略された場合に継承する
  // 購読の既定 Publisher Priority。Track Properties 未受信時は 128。
  // setTrackProperties で再解決する。
  private subscriberDefaultPublisherPriority = 128;
  // draft-ietf-moq-transport-23 §9.19.18 (PAUSED Parameter):
  // 購読が paused かどうか (true = paused / false = unpaused)。wire の値と
  // 同じ意味で保持し、境界での反転は行わない。SUBSCRIBE 送信時の宣言値・
  // 受信 PUBLISH / ケース 1 の REQUEST_UPDATE / 自 update() の REQUEST_OK で
  // 更新される。
  private subscriberPaused = false;
  // draft-ietf-moq-transport-23 §9.19.8 (GROUP ORDER Parameter):
  // 購読の GROUP_ORDER。SUBSCRIBE 送信時の宣言値、または受信 PUBLISH の
  // GROUP_ORDER を保持する。fill 要求時の Group Order 解決
  // (FILL_PARAMETERS 内の指定が無ければ購読の値) に使う。
  private subscriberGroupOrder: "Ascending" | "Descending" | undefined;
  // draft-ietf-moq-msf-02 §11.5.3: track に関連するトークンは REQUEST_UPDATE にも MUST 付与。
  private subscriberAuthorizationToken: AuthorizationToken | undefined;
  // draft-ietf-moq-transport-23 Section 3.3.1: Location Filter の再適用に使用
  private locationFilter: LocationFilter | undefined;
  private resolvedFilterCache: ResolvedFilter | undefined;
  // draft-ietf-moq-transport-23 Section 3.3.2: Range Filter の再適用に使用
  private rangeFilters: RangeFilterSpec[] = [];

  // セッションが利用する内部コールバック
  // セッションは未指定のコールバックを明示的に undefined で代入するため `| undefined` を付ける
  goawayCallback?: ((newSessionUri: string) => void) | undefined;
  onUnsubscribe?: () => Promise<void>;
  onUpdate?: (options: RequestUpdateOptions) => Promise<void>;
  /**
   * fill fetch ストリームの失敗通知 (セッション内部コールバック)
   *
   * 購読の error コールバックとは別系統である理由は handleFillError を参照。
   */
  fillErrorCallback?: ((error: Error) => void) | undefined;
  /**
   * Subgroup の stream の終わりの通知 (セッション内部コールバック)
   *
   * SubscribeCallbacks.subgroupEnd をセッションが代入する。handleSubgroupEnd を参照。
   */
  subgroupEndCallback?: ((end: SubgroupStreamEnd) => void) | undefined;

  constructor(
    namespace: string[],
    trackName: string,
    requestId: bigint,
    trackAlias: bigint,
    onObject: (object: MoqtObject) => void,
    onDatagram?: (object: MoqtObject) => void,
    onEnd?: (publishDone: PublishDoneInfo) => void,
    onError?: (error: Error) => void,
  ) {
    // 要求時の名前を固定し、各 Object の受信時にキーを再計算しない。
    this.trackKey = fullTrackNameKey(namespace, trackName);
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

  get largestReceivedLocation(): Location | null {
    return this.subscriberLargestReceivedLocation;
  }

  get trackProperties(): ReadonlyArray<Property> {
    return this.subscriberTrackProperties;
  }

  /**
   * 購読が paused かどうか
   * draft-ietf-moq-transport-23 Section 9.19.18 (PAUSED Parameter)
   */
  get paused(): boolean {
    return this.subscriberPaused;
  }

  /**
   * paused 状態を設定する (セッション内部コールバック)
   *
   * draft-ietf-moq-transport-23 §9.19.18:
   * SUBSCRIBE 送信時 (options.paused) / 受信 PUBLISH / ケース 1 の
   * REQUEST_UPDATE / 自 update() の REQUEST_OK の各経路から設定される。
   * 引数は wire の PAUSED と同じ意味 (true = paused) で、反転は行わない。
   * アプリケーションへの変化通知コールバックは持たない (Publisher の
   * onPausedChange とは非対称。必要になったら別途追加する)。
   */
  setPaused(paused: boolean): void {
    this.subscriberPaused = paused;
  }

  /**
   * 購読の GROUP_ORDER を設定する (セッション内部コールバック)
   *
   * draft-ietf-moq-transport-23 §9.19.8 (GROUP ORDER Parameter):
   * SUBSCRIBE 送信時の宣言値、または受信 PUBLISH の GROUP_ORDER が入る。
   * fill 要求時の Group Order 解決に使う。
   */
  setGroupOrder(groupOrder: "Ascending" | "Descending" | undefined): void {
    this.subscriberGroupOrder = groupOrder;
  }

  /**
   * 購読の GROUP_ORDER を取得する
   *
   * draft-ietf-moq-transport-23 §9.19.8 (GROUP ORDER Parameter):
   * 省略時は undefined。fill 要求時の Group Order 解決で、次に Track Properties の
   * DEFAULT_PUBLISHER_GROUP_ORDER を参照する。
   */
  getGroupOrder(): "Ascending" | "Descending" | undefined {
    return this.subscriberGroupOrder;
  }

  getRequestId(): bigint {
    return this.requestId;
  }

  getTrackAlias(): bigint {
    return this.trackAlias;
  }

  /**
   * SUBSCRIBE_OK / PUBLISH / REQUEST_UPDATE_OK / PUBLISH_STATE_NOTIFY から
   * LARGEST_OBJECT パラメータを設定
   * draft-ietf-moq-transport-23 §9.19.17 (LARGEST OBJECT Parameter) / §3.1.4
   * (Largest Object)
   *
   * §3.1.4 は「以前より大きい Location の Object の最初のバイトを送受信した時点で
   * Largest Object が進み、到着中の Object を指し得る」と定める。したがってここで保持する値も確定値ではなく、
   * 同じ購読のうちに何度でも上書きされ得る。
   *
   * LARGEST_OBJECT の更新だけでは解決済み Location Filter を再計算しない。
   * 初回購読の相対フィルタ開始位置は購読確立時に固定する (§3.3.1)。
   * 更新で新規に届く LOCATION_FILTER は setLocationFilter 時点の
   * LARGEST_OBJECT で解決する。
   */
  setLargestLocation(location: Location): void {
    this.subscriberLargestLocation = location;
  }

  /**
   * 保持済みの Location Filter を最新の LARGEST_OBJECT で再解決する
   *
   * 解決に使う LARGEST_OBJECT は到着中の Object を指し得る (§3.1.4)。
   * §3.1.4 / §3.3.1 は「相対指定 (§9.19.9 の 0x01 / 0x05) をどの時点の
   * Largest Object で解決するか」を定めないため、moqt-js は SUBSCRIBE_OK の
   * 受信時の 1 回に固定する (LARGEST_OBJECT を省略した SUBSCRIBE_OK でも呼ぶ。
   * 以降の LARGEST_OBJECT 更新では解釈を変えない)。
   *
   * draft-ietf-moq-transport-23 §3.3.1:
   * SUBSCRIBE 送信時の setLocationFilter では LARGEST_OBJECT が未受信のため、
   * SUBSCRIBE_OK で LARGEST_OBJECT を設定した直後に一度だけ呼ぶ。
   * REQUEST_UPDATE_OK / PUBLISH_STATE_NOTIFY の LARGEST_OBJECT 更新では呼ばない
   * (初回購読の相対フィルタ開始位置は購読確立時に固定する)。
   */
  resolveLocationFilter(): void {
    this.resolvedFilterCache = resolveFilter(this.locationFilter, this.subscriberLargestLocation);
  }

  /**
   * SUBSCRIBE_OK から Track Properties を設定
   * draft-ietf-moq-transport-23 Section 9.7 (SUBSCRIBE_OK)
   */
  setTrackProperties(properties: Property[]): void {
    this.subscriberTrackProperties = properties;
    // draft-ietf-moq-transport-23 §10.4:
    // Priority 省略時の継承値を Track Properties から再解決する
    this.subscriberDefaultPublisherPriority = resolveDefaultPublisherPriority(properties);
  }

  /**
   * 購読を確立した要求の Authorization Token を設定
   *
   * draft-ietf-moq-msf-02 §11.5.3: 後続の REQUEST_UPDATE に同じトークンを MUST 付与する。
   * SUBSCRIBE で確立した購読は SUBSCRIBE の、PUBLISH で確立した購読はその PUBLISH を
   * 送らせた SUBSCRIBE_TRACKS のトークンを引き継ぐ。
   */
  setAuthorizationToken(token: AuthorizationToken | undefined): void {
    this.subscriberAuthorizationToken = token;
  }

  /**
   * 購読を確立した要求の Authorization Token を取得
   */
  getAuthorizationToken(): AuthorizationToken | undefined {
    return this.subscriberAuthorizationToken;
  }

  /**
   * Set track alias (called when SUBSCRIBE_OK is received)
   *
   * draft-ietf-moq-transport-23 Section 9.7 (SUBSCRIBE_OK):
   * Track Alias is returned by the publisher in SUBSCRIBE_OK.
   */
  setTrackAlias(alias: bigint): void {
    this.trackAlias = alias;
  }

  /**
   * Location Filter を設定する
   *
   * draft-ietf-moq-transport-23 Section 3.3.1:
   * SUBSCRIBE 送信時の options.filter または REQUEST_UPDATE 成功後の更新で設定される。
   * 設定時点の LARGEST_OBJECT で解決した結果を保持するため、呼び出し側は
   * 同じ内容のフィルタで再設定しないこと (同じ内容でも再解決で開始位置が
   * 前進し得る)。等価判定には isSameLocationFilter を使う。
   */
  setLocationFilter(filter: LocationFilter | undefined): void {
    this.locationFilter = filter;
    this.resolvedFilterCache = resolveFilter(filter, this.subscriberLargestLocation);
  }

  /**
   * 保持している Location Filter を取得する
   *
   * 受信した LOCATION_FILTER が保持値と等価かを呼び出し側で判定するために使う
   * (isSameLocationFilter)。設定時の解決結果 (resolvedFilterCache) は
   * LARGEST_OBJECT に依存するため、生のフィルタを返す。
   */
  getLocationFilter(): LocationFilter | undefined {
    return this.locationFilter;
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
   * Full Track Name の比較キーを取得する（Track 同一性判定用）
   *
   * draft-ietf-moq-transport-23 Section 2.4.1: Track の同一性は Full Track Name
   * (Track Namespace + Track Name) で判定する。
   * 戻り値は fullTrackNameKey が生成する長さ付きキーであり、Full Track Name
   * そのものではない。Track の同一性判定は完全一致でのみ行う。
   */
  getFullTrackNameKey(): FullTrackNameKey {
    return this.trackKey;
  }

  /** Track の既定 Publisher Priority を受信デコーダーから参照する。 */
  getDefaultPublisherPriority(): number {
    return this.subscriberDefaultPublisherPriority;
  }

  /**
   * Handle incoming object from data stream
   *
   * draft-ietf-moq-transport-23 §3.1:
   * 同一 Track の複数 subscription に対して、各 subscription の filter を再適用する。
   *
   * 1 Group = 1 Subgroup = 1 Stream のため、QUIC がストリーム内の順序を保証する。
   * Group 間の順序はキーフレーム単位なので、順序保証は不要。
   */
  handleObject(object: MoqtObject, copyForDelivery = false): void {
    this.deliverSubscriptionObject(object, this.objectCallback, copyForDelivery);
  }

  /**
   * 受信した実 Object の Location で、購読で受信した最大 Location を進める
   *
   * draft-ietf-moq-transport-23 §3.1.4 (Largest Object):
   * "Largest Object updates when the first byte of an Object with a Location larger
   *  than the previous value is published or received through a subscription."
   * 進めるだけで戻さない (Group ID / Object ID が小さい Object や、Location Filter の
   * 再適用で配送しない Object では変わらない)。順序は §8.2 の Location 比較に従う。
   *
   * @param object - 受信した Object
   */
  private observeReceivedLocation(object: MoqtObject): Location {
    const location: Location = { group: object.groupId, object: object.objectId };
    // §11.1.1: 終端 Status はこの位置から先の非存在を通知する。
    if (object.status !== ObjectStatus.NORMAL) return location;
    if (
      object.objectDeliveryTimeout !== undefined ||
      object.subgroupDeliveryTimeout !== undefined
    ) {
      this.noteDeliveryTimeout(object.objectDeliveryTimeout);
      this.noteDeliveryTimeout(object.subgroupDeliveryTimeout);
    }
    const current = this.subscriberLargestReceivedLocation;
    if (current === null || compareLocations(location, current) > 0) {
      this.subscriberLargestReceivedLocation = location;
    }
    return location;
  }

  /**
   * 受信 Object に購読のフィルタを再適用して配送する
   *
   * draft-ietf-moq-transport-23 Section 3.3.1 / Section 3.3.2:
   * Subgroup と Datagram で同じ規則を適用する。Priority は購読の既定値を
   * 解決してから判定し、通過した購読への配送値にだけ反映する (§10.4)。
   */
  private deliverSubscriptionObject(
    object: MoqtObject,
    callback: ((object: MoqtObject) => void) | undefined,
    copyForDelivery: boolean,
  ): void {
    if (this.subscriberState === "closed") {
      return;
    }
    // 配送しない Object でも、受信した最大 Location を進める (§3.1.4)。
    const location = this.observeReceivedLocation(object);
    if (callback === undefined || !objectMatchesFilter(location, this.resolvedFilterCache)) {
      return;
    }
    const publisherPriority = object.publisherPriority ?? this.subscriberDefaultPublisherPriority;
    if (
      this.rangeFilters.length > 0 &&
      !rangeFiltersMatch(this.rangeFilters, {
        trackProperties: this.subscriberTrackProperties,
        objectId: object.objectId,
        publisherPriority,
        ...(object.subgroupId !== undefined ? { subgroupId: object.subgroupId } : {}),
        ...(object.properties !== undefined ? { objectProperties: object.properties } : {}),
      })
    ) {
      return;
    }
    if (copyForDelivery) {
      // 後続の購読が判定・配送に使うフィールドとバイト列をアプリから隔離する。
      callback.call(this, {
        ...object,
        publisherPriority,
        payload: object.payload.slice(),
        ...(object.properties !== undefined ? { properties: object.properties.slice() } : {}),
      });
    } else {
      object.publisherPriority = publisherPriority;
      callback.call(this, object);
    }
  }

  /**
   * Handle incoming datagram
   * draft-ietf-moq-transport-23 Section 11.2 (Datagrams) / §2.1:
   * Group または Track の中で Subgroup と Datagram の両方を使える。
   * Subscriber は両方のコールバックを設定することで混在配信を受け取れる。
   */
  handleDatagram(object: MoqtObject, copyForDelivery = false): void {
    this.deliverSubscriptionObject(object, this.datagramCallback, copyForDelivery);
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
   * draft-ietf-moq-transport-23 §3.1 (Subscriptions) / §3.4 (Fill Semantics):
   * fill-delivered のオブジェクトは fill 範囲 (FILL_PARAMETERS 内のフィルタ)
   * に従属するため、subscription の Location Filter / Range Filter 再適用
   * (handleObject) を通さず、fillDelivered を true にして object
   * コールバックに渡す。subscription-delivered (handleObject 経由) とは
   * fillDelivered の値で区別できる。同一 Location が両経路で届いた場合の
   * 二重処理の回避はアプリの責務であり、自動の重複排除は行わない。
   * 各 Object を一度だけ受け取りたい場合は、Next Object の subscription
   * ({ nextObject: true }、Location Filter Type 0x05) と open-ended な fill を組み合わせる
   * (publisher が fill を Largest Object で終えるため重複なくつながる。
   * §3.4 の exactly-once パターン)。state が closed の場合は受け取らない。
   */
  handleFillObject(object: MoqtObject): void {
    if (this.subscriberState === "closed") {
      return;
    }
    // fill fetch の stream は購読に属するため、ここで届いた Object も受信した
    // Location として記録する (§3.1.4)
    this.observeReceivedLocation(object);
    this.objectCallback({ ...object, fillDelivered: true });
  }

  /**
   * fill fetch ストリームの失敗をアプリへ通知する
   *
   * draft-ietf-moq-transport-23 §3.4.1 (Opening and Closing Fill Fetch Streams):
   * "Because there is no REQUEST_ERROR associated with a fill fetch stream, the
   *  publisher signals a fill failure by resetting the stream" および
   * "Resetting or cancelling a fill fetch stream, by either endpoint, does not
   *  affect the subscription, which continues to deliver objects using
   *  subscribe subgroups and datagrams."
   * 購読は継続するため、購読の終了を意味する handleError (error コールバック)
   * ではなく fill 専用の fillErrorCallback へ通知する。アプリはこれで fill が
   * 欠けたことを検知し、再取得を判断できる。
   *
   * draft-ietf-moq-transport-23 §12.1 (Malformed Tracks) の
   * "SHOULD deliver an error to the application" は Malformed Track 検出が
   * 購読自体の cancel を伴うため handleError 側で満たす。ここでは通知しない
   * (cancelMalformedTrackPeers と二重にならないようにする)。
   *
   * state が closed の場合は通知しない。unsubscribe 済みの購読に対する
   * 遅延した reset (§3.4.1 の MUST reset) で通知しないためである。
   */
  handleFillError(error: Error): void {
    if (this.subscriberState === "closed") {
      return;
    }
    this.fillErrorCallback?.(error);
  }

  /**
   * Internal: SubscribeCallbacks のうちセッション内部コールバックとして持つものを設定する
   *
   * goaway / fillError / subgroupEnd はコンストラクタ引数ではなくセッションが代入する
   * (SUBSCRIBE と受信 PUBLISH の両経路で同じ代入をするため 1 箇所にまとめる)。
   */
  setSessionCallbacks(callbacks: {
    goaway?: ((newSessionUri: string) => void) | undefined;
    fillError?: ((error: Error) => void) | undefined;
    subgroupEnd?: ((end: SubgroupStreamEnd) => void) | undefined;
  }): void {
    this.goawayCallback = callbacks.goaway;
    this.fillErrorCallback = callbacks.fillError;
    this.subgroupEndCallback = callbacks.subgroupEnd;
  }

  /**
   * 購読の Subgroup の stream の終わりをアプリへ通知する
   *
   * draft-ietf-moq-transport-23 Section 2.1: Object は順不同で届きうる。アプリは stream の
   * 終わりで、それ以上その Subgroup の Object が届かないと判断できる。
   * state が closed の場合は通知しない (object コールバックと同じ)。
   */
  handleSubgroupEnd(end: SubgroupStreamEnd): void {
    if (this.subscriberState === "closed") {
      return;
    }
    this.subgroupEndCallback?.(end);
  }

  /** Internal: 配信タイムアウトの上限を購読の終了待ちに使う。 */
  noteDeliveryTimeout(value: bigint | undefined): void {
    if (value === undefined || value <= this.longestDeliveryTimeout) return;
    this.longestDeliveryTimeout = value;

    const drain = this.publishDoneDrain;
    if (drain === undefined) return;
    // §9.9 / §10.1 / §10.2: 遅着した Subgroup の先頭 Object で判明した値も使う。
    // 期限は PUBLISH_DONE の受信時刻から数える。Object の到着ごとには延長しない。
    const deadlineMs = drain.startedAtMs + value;
    if (deadlineMs <= drain.deadlineMs) return;
    drain.deadlineMs = deadlineMs;
    this.schedulePublishDoneTimer(drain);
  }

  /** Internal: 共有 Alias では Stream Count が一致しても購読単位の完了とは断定できない。 */
  noteSharedTrackAlias(): void {
    this.sharedTrackAlias = true;
  }

  /** Internal: 購読に対応するデータストリームの処理を開始する。 */
  startDataStreams(count = 1): void {
    this.openDataStreams += count;
  }

  /** Internal: Object の配送と Subgroup の終了通知が済んでから数える。 */
  finishDataStream(): void {
    this.openDataStreams--;
    if (this.subscriberState === "active") {
      this.processedDataStreams++;
      this.finishPublishDoneIfReady();
    }
  }

  /** Internal: PUBLISH_DONE の受信後もデータの処理は継続できる。 */
  get isDrainingPublishDone(): boolean {
    return this.publishDoneDrain !== undefined;
  }

  /** Internal: §9.9 の Stream Count または配信タイムアウトで購読を退役させる。 */
  drainAfterPublishDone(streamCount: bigint, finish: () => void): void {
    if (this.subscriberState === "closed" || this.publishDoneDrain !== undefined) {
      return;
    }
    // 受信時刻を切り上げ、満了判定用の時刻を切り捨てて、整数化で待機を短くしない。
    const startedAtMs = BigInt(Math.ceil(performance.now()));
    this.noteDeliveryTimeout(
      resolveTrackProperty(this.trackProperties, TrackPropertyId.OBJECT_DELIVERY_TIMEOUT)?.value,
    );
    this.noteDeliveryTimeout(
      resolveTrackProperty(this.trackProperties, TrackPropertyId.SUBGROUP_DELIVERY_TIMEOUT)?.value,
    );
    const drain: PublishDoneDrain = {
      streamCount,
      finish,
      timer: undefined,
      // 専用コールバックの省略時も Datagram は object コールバックに届く。
      mayReceiveDatagrams: !rangeFiltersRequireSubgroup(this.rangeFilters),
      startedAtMs,
      deadlineMs: startedAtMs + (this.longestDeliveryTimeout || DEFAULT_PUBLISH_DONE_WAIT_MS),
    };
    this.publishDoneDrain = drain;
    if (this.hasProcessedAllDataStreams(drain)) {
      finish();
      return;
    }
    this.schedulePublishDoneTimer(drain);
  }

  private schedulePublishDoneTimer(drain: PublishDoneDrain): void {
    clearTimeout(drain.timer);
    const remaining = drain.deadlineMs - BigInt(Math.floor(performance.now()));
    drain.timer = setTimeout(
      () => {
        if (this.publishDoneDrain !== drain) return;
        // setTimeout の最大値を超える期限も、分割して本来の期限まで待つ。
        if (BigInt(Math.floor(performance.now())) < drain.deadlineMs) {
          this.schedulePublishDoneTimer(drain);
          return;
        }
        drain.timer = undefined;
        this.finishPublishDoneIfReady();
      },
      clampTimeoutMs(remaining > 0n ? remaining : 0n),
    );
  }

  private hasProcessedAllDataStreams(drain: PublishDoneDrain): boolean {
    // Datagram は Stream Count に含まれない。アプリが受け取る場合は遅着を待つ。
    return (
      !this.sharedTrackAlias &&
      !drain.mayReceiveDatagrams &&
      drain.streamCount !== MAX_VARINT &&
      this.processedDataStreams === drain.streamCount &&
      this.openDataStreams === 0
    );
  }

  private finishPublishDoneIfReady(): void {
    const drain = this.publishDoneDrain;
    if (
      drain !== undefined &&
      this.openDataStreams === 0 &&
      (drain.timer === undefined || this.hasProcessedAllDataStreams(drain))
    ) {
      drain.finish();
    }
  }

  /**
   * Handle track end (from PUBLISH_DONE)
   *
   * draft-ietf-moq-transport-23 §3.1 (Subscriptions):
   * "The publisher terminates a subscription in the Pending (Publisher) or Established
   *  states by sending PUBLISH_DONE and closing the stream."
   *
   * draft-ietf-moq-transport-23 §9.9 (PUBLISH_DONE):
   * 終了の理由 (Status Code / Stream Count / Reason Phrase) を endCallback に渡す。
   * Stream Count は publisher が開いたデータストリーム数であり、購読者が受信済みの
   * ストリーム数と比較して購読状態を破棄するために使う。2^64-1 は publisher が
   * 正確な値を設定できなかったことを表すため、比較には使えない。エラーかどうかは
   * §12.4 (Publish Done Codes) の Status Code が表し、エラーを示す場合
   * (INTERNAL_ERROR, UPDATE_FAILED 等) も endCallback だけを呼ぶ。
   *
   * errorCallback の契約 (アプリのコールバックの例外でも呼ばれること) は
   * SubscribeCallbacks.error を参照。
   */
  handleEnd(statusCode: PublishDoneStatusCode, streamCount: bigint, reasonPhrase: string): void {
    if (this.subscriberState === "closed") {
      return;
    }
    this.markClosed();

    this.endCallback?.({ statusCode, streamCount, reasonPhrase });
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
   * draft-ietf-moq-transport-23 Section 6.6:
   * "The Transport Session can be terminated at any point."
   *
   * Note: endCallback is NOT called here because session close is
   * session-level termination, not track-level PUBLISH_DONE.
   * Session close is notified via ConnectCallbacks.close instead.
   */
  markClosed(): void {
    this.subscriberState = "closed";
    clearTimeout(this.publishDoneDrain?.timer);
    this.publishDoneDrain = undefined;
  }

  /**
   * サブスクリプションを更新する
   *
   * draft-ietf-moq-transport-23 §9.5 (REQUEST_UPDATE):
   * "The sender of a request (SUBSCRIBE, PUBLISH, FETCH, PUBLISH_NAMESPACE,
   *  SUBSCRIBE_NAMESPACE, SUBSCRIBE_TRACKS) can later send a REQUEST_UPDATE on
   *  the same bidi stream as the request to modify it.  A subscriber can also
   *  send REQUEST_UPDATE to modify parameters of a subscription established
   *  with PUBLISH."
   *
   * fire-and-forget で呼び出しても、GOAWAY / REQUEST_ERROR / FIN / RESET 等に
   * よる reject が unhandled rejection にならないよう、同一インスタンスに
   * catch ハンドラを登録した Promise を直接返す。async の wrapper 経由にすると
   * wrapper 側の無観測 reject が unhandled になるため、ここで必ず捕まえる。
   */
  update(options?: RequestUpdateOptions): Promise<void> {
    if (this.subscriberState === "closed" || this.publishDoneDrain !== undefined) {
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
   * draft-ietf-moq-transport-23 §3.1 (Subscriptions):
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
