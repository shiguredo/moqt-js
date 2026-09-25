/**
 * MOQT Publisher
 * draft-ietf-moq-transport-21 Section 3 (Publishing and Retrieving Tracks)
 */

import { ObjectStatus, PublishDoneStatusCode, type Location } from "./message/types";
import type { LocationFilter } from "./message/parameter";
import { objectMatchesFilter, resolveFilter, type ResolvedFilter } from "./filter";
import { ProtocolViolationError } from "./error";

/**
 * Publisher state
 */
export type PublisherState = "active" | "closed";

/**
 * Parameters for sending an object
 */
export interface SendObjectParams {
  /**
   * Group ID
   *
   * draft-ietf-moq-transport-21 §11.3.1:
   * 仕様上は 0〜2^64-1 の varint だが、公開 API は number のため精度を保証
   * できる安全整数の範囲 (0〜2^53-1) を対応範囲とする。2^53 以上の値は
   * Number.isInteger が true でも double の丸めで意図と異なる値になり得るため
   * 使用しないこと (範囲外は送信前に fail-fast で拒否される)。
   */
  groupId: number;
  /**
   * Object ID
   *
   * draft-ietf-moq-transport-21 §11.3.1:
   * Group ID と同じく number の安全整数の範囲 (0〜2^53-1) を対応範囲とする。
   */
  objectId: number;
  payload: Uint8Array;
  properties?: Uint8Array;
  /**
   * Publisher Priority (0-255)
   *
   * draft-ietf-moq-transport-21 §5.1.1:
   * "A single subgroup or datagram has a single publisher priority."
   * Subgroup では、この値は新しい Subgroup (moqt-js の実装では新しい Group) を
   * 開く最初の sendObject で Subgroup Header に固定される。同一 Subgroup の
   * 2 件目以降で指定した値は wire に載らず無視される。Object ごとに優先度を
   * 変える場合は sendDatagram を使うか、Group を切り替えて新しい Subgroup を
   * 開くこと。
   */
  priority?: number;
  /**
   * オブジェクトステータス
   * draft-ietf-moq-transport-21 §11.1.2
   *
   * - NORMAL (0x0): 通常のオブジェクト（デフォルト）
   * - END_OF_GROUP (0x3): グループの終端。payload は空でなければならない
   * - END_OF_TRACK (0x4): トラックの終端。payload は空でなければならない。
   *   END_OF_TRACK の定義上、以降の object は存在しないため同一トラックへの
   *   後続 sendObject() を送らないこと (同節の EOT 定義による解釈であり、
   *   明示の MUST 文はない)
   */
  status?: ObjectStatus;
  /**
   * Object Delivery Timeout（ミリ秒）
   * draft-ietf-moq-transport-21 Section 10.2 / Section 5.2
   *
   * subgroup 先頭オブジェクトの Object Property として送信される。
   * 先頭以外で指定すると throw する。
   */
  deliveryTimeout?: bigint;
  /**
   * Subgroup Delivery Timeout（ミリ秒）
   * draft-ietf-moq-transport-21 Section 10.1 / Section 5.2
   *
   * subgroup 先頭オブジェクトの Object Property として送信される。
   * 先頭以外で指定すると throw する。
   */
  subgroupDeliveryTimeout?: bigint;
}

/**
 * Parameters for sending a datagram
 * draft-ietf-moq-transport-21 Section 11.2 (Datagrams)
 */
export interface SendDatagramParams {
  /**
   * Group ID
   *
   * draft-ietf-moq-transport-21 §11.2.1:
   * number の安全整数の範囲 (0〜2^53-1) を対応範囲とする (§11.3.1 と同じ制約)。
   */
  groupId: number;
  /**
   * Object ID
   *
   * draft-ietf-moq-transport-21 §11.2.1:
   * Group ID と同じく number の安全整数の範囲 (0〜2^53-1) を対応範囲とする。
   */
  objectId: number;
  payload: Uint8Array;
  properties?: Uint8Array;
  /**
   * Publisher Priority (0-255)
   * draft-ietf-moq-transport-21 §5.1.1: Datagram は 1 つで 1 つの priority を持つ。
   */
  priority?: number;
  /**
   * このオブジェクトがグループの最後かどうか
   */
  endOfGroup?: boolean;
}

/**
 * PUBLISH_STATE_NOTIFY で購読者へ通知する購読状態
 * draft-ietf-moq-transport-21 Section 9.10 (PUBLISH_STATE_NOTIFY)
 *
 * 「A PUBLISH_STATE_NOTIFY carries the parameters whose values have changed.
 *  If a parameter is not present, its value is unchanged.」ため、現在値から
 * 変化した値のみを指定する。省略したフィールドは通知に載せない。
 */
export interface PublishStateNotifyOptions {
  /**
   * 通知する Forward State
   * draft-ietf-moq-transport-21 Section 9.20.19 (FORWARD Parameter)
   *
   * 「When sent in PUBLISH_STATE_NOTIFY, it reports the Forwarding State now in
   *  effect at the publisher.」現在値と同じ値では通知しない。送信できた場合は
   * この値を publisher の Forward State として反映する (購読者が受け取る値と
   * publisher が実際に転送する状態を一致させるため)。
   */
  forward?: boolean;

  /**
   * 通知する Location Filter
   * draft-ietf-moq-transport-21 Section 9.20.10 (LOCATION FILTER Parameter)
   *
   * 「When sent in PUBLISH_STATE_NOTIFY, it reports the Location Filter now in
   *  effect at the publisher.」現在値と等価な値では通知しない。送信できた場合は
   * この値を publisher の Location Filter として反映する (購読者が受け取る値と
   * publisher が実際に適用する値を一致させるため。相対指定は送信時点の
   * Largest Object で解決する。Section 3.3.1)。
   * Section 9.10 の MUST NOT「A publisher MUST NOT use PUBLISH_STATE_NOTIFY to
   *  change the value of a subscriber controlled subscription parameter unless
   *  the subscriber requested the change.」に従い、購読者が REQUEST_UPDATE で
   * 要求していない値は指定しないこと。
   */
  filter?: LocationFilter;
}

/**
 * Publisher interface
 */
export interface Publisher {
  readonly state: PublisherState;
  /**
   * Forward State
   * draft-ietf-moq-transport-21 Section 9.20.19 (FORWARD Parameter)
   *
   * PUBLISH 送信時の options.forward (省略時は true) を初期値として返す。
   * PUBLISH_OK は EXPIRES のみを運び Forward State を変更しない。
   * - true (1): オブジェクトを転送する（Subscriber がいる）
   * - false (0): オブジェクトを転送しない（Subscriber がいない）
   *
   * REQUEST_UPDATE で状態が変更された場合、onForwardStateChange が呼ばれる。
   * PUBLISH 送信時の初期設定と REQUEST_UPDATE 受信時による変化でも呼ばれる。
   * notifyStateChange で通知した値の反映でも呼ばれる。
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
   *
   * 範囲外の Group / Object ID は fail-fast で error 通知 + 返値の reject になる
   * (fire-and-forget でも `.catch` するか error 通知で処理すること)。
   * その他の送信失敗 (書き込み失敗等) は error 通知のみで返値は resolve する。
   * 範囲外・非整数の priority も fail-fast で error 通知 + 返値の reject になる。
   * status / payload の組み合わせ違反と END_OF_TRACK 送信後の呼び出しも
   * fail-fast で error 通知 + 返値の reject になる
   * (組み合わせ規則は draft-ietf-moq-transport-21 §11.1.2 / §11.1.3、
   * END_OF_TRACK 後は §11.1.2 の EOT 定義による解釈)。
   *
   * 購読の Location Filter の範囲外 Object は送信せず、error 通知もなく
   * 解決済みの Promise<void> を返す (draft-ietf-moq-transport-21 §3.3.1)。
   */
  sendObject(params: SendObjectParams): Promise<void>;
  /**
   * Datagram でオブジェクトを送信する
   * draft-ietf-moq-transport-21 Section 11.2 (Datagrams)
   *
   * 注意: Datagram は信頼性がなく、順序も保証されない
   *
   * draft-ietf-moq-transport-21:
   * 同一トラック内で Datagram と Subgroup (Stream) の混在が許可される。
   * Publisher は sendObject() と sendDatagram() を同じトラックで併用できる。
   * draft-ietf-moq-transport-21 Section 2.2, Section 11.2
   *
   * 範囲外の Group / Object ID は error 通知 + throw する
   * (セッションは閉じない)。closed 後は検証前に no-op で返す。
   * 範囲外・非整数の priority も error 通知 + throw になる。
   * END_OF_TRACK 送信後の呼び出しも error 通知 + throw になる
   * (§11.1.2 の EOT 定義による解釈)。
   * 購読の Location Filter の範囲外 Datagram は送信せず、何もせず return する
   * (draft-ietf-moq-transport-21 §3.3.1)。
   */
  sendDatagram(params: SendDatagramParams): void;
  /**
   * 購読状態の変化を PUBLISH_STATE_NOTIFY で購読者へ通知する
   * draft-ietf-moq-transport-21 §9.10 (PUBLISH_STATE_NOTIFY)
   *
   * subscriber 発の REQUEST_UPDATE への応答ではなく、publisher 側の理由で
   * 購読状態が変化したことを片方向で通知する。購読者は REQUEST_OK /
   * REQUEST_ERROR を返さないため、返値は送信の完了のみを表す。
   * 通知に載せるパラメータは許可された LARGEST_OBJECT (既知時は §9.20.18 の
   * MUST により必須) / FORWARD / LOCATION_FILTER のみであり、現在値から
   * 変化していないパラメータは載せない。載せるパラメータが無い場合は
   * 送信せず resolve する (重複送信の抑止)。
   * 送信できた変更のみ Forward State / Location Filter として反映する。
   *
   * 購読が既に終了している場合 (done() 済み・ピアのキャンセル後・セッション
   * 終了後) は送信せず resolve する。送信できない場合 (ストリーム終了等) は
   * reject する。セッションは閉じない。
   *
   * forward: false を通知した場合、購読者が REQUEST_UPDATE で FORWARD=1 を送る
   * まで Object を送信しない (Section 9.8 の PUBLISH 時の FORWARD=0 と同じ扱い。
   * 送信の抑止は Forward State を参照する sendObject / sendDatagram が行う)。
   */
  notifyStateChange(options?: PublishStateNotifyOptions): Promise<void>;
  /**
   * パブリッシングを終了し、PUBLISH_DONE を送信してストリームを閉じる
   * draft-ietf-moq-transport-21 §9.9 (PUBLISH_DONE)
   *
   * 並行して呼ばれた場合も PUBLISH_DONE は 1 回だけ送信され、
   * 2 回目の呼び出しは 1 回目の完了まで待つ。
   * セッションが閉じられた後は PUBLISH_DONE を送信せず即 resolve する。
   */
  done(): Promise<void>;
}

/**
 * status / payload の組み合わせを検証する
 *
 * draft-ietf-moq-transport-21 §11.1.2:
 * 非 NORMAL ステータスは空 payload でなければならない。
 * draft-ietf-moq-transport-21 §11.1.3:
 * 非 NORMAL ステータスの Object に properties があってはならない。
 * `status` 省略は NORMAL とみなす。
 *
 * @returns 違反時の ProtocolViolationError、正常時は null
 */
function validateSendStatusPayload(params: SendObjectParams): ProtocolViolationError | null {
  const status = params.status ?? ObjectStatus.NORMAL;
  if (status === ObjectStatus.NORMAL) {
    return null;
  }
  const payloadSize = params.payload.byteLength;
  const propertiesSize = params.properties?.byteLength ?? 0;
  if (payloadSize > 0 || propertiesSize > 0) {
    return new ProtocolViolationError(
      `invalid status with payload: status ${status} requires empty payload without properties, got payload ${payloadSize} bytes and properties ${propertiesSize} bytes`,
    );
  }
  return null;
}

/**
 * Internal Publisher implementation
 */
export class PublisherImpl implements Publisher {
  private publisherState: PublisherState = "active";
  private publisherForwardState = true;
  // 未指定の場合は明示的に undefined を代入する (呼び出し側は `?.` で呼ぶ) ため
  // `| undefined` を付ける
  private readonly errorCallback?: ((error: Error) => void) | undefined;
  private readonly forwardStateChangeCallback?: ((forward: boolean) => void) | undefined;
  private readonly requestId: bigint;
  private readonly trackAlias: bigint;

  // draft-ietf-moq-transport-21 Section 9.9 (PUBLISH_DONE):
  // PUBLISH_DONE の Stream Count 用カウンター
  private dataStreamCount = 0n;

  // draft-ietf-moq-transport-21 §11.1.2:
  // END_OF_TRACK 送信済みか。sendObject / sendDatagram で共有し、
  // 記録後の両 API 呼び出しを拒否する。
  private endOfTrackSent = false;
  // draft-ietf-moq-transport-21 §11.1.2 / §11.3.2:
  // END_OF_GROUP status を送信した Group。同一 Group への後続送信は拒否する
  // (Group の終端を宣言済みのため)。購読終了で null に戻す。
  // 公開 API の groupId は number (安全整数) のため number で保持する。
  private endOfGroupSentGroupId: number | null = null;

  // draft-ietf-moq-transport-21 §9.20.18 (LARGEST OBJECT Parameter):
  // この Publisher が送信した最大 Location。
  // "If Objects have been published on this Track the Publisher MUST include
  //  this parameter." を満たすため、REQUEST_UPDATE 受理時の REQUEST_OK に
  // LARGEST_OBJECT として含める。未送信時は null。
  private largestLocation: Location | null = null;

  // draft-ietf-moq-transport-21 §3.3.1 (Location Filters) / §3.4 (Fill Semantics):
  // REQUEST_UPDATE で受信した購読の Location Filter を、受理時点の
  // LARGEST_OBJECT で解決した状態で保持する (相対指定を後から再解決しない。
  // SubscriberImpl.resolveLocationFilter と同じ規則)。
  // 用途は 2 つ。fill 範囲は「FILL_PARAMETERS 内の LOCATION_FILTER、省略時は
  // 購読の Location Filter」で決まるためその評価に使い、送信 Object は
  // §3.3.1 の publisher MUST「A publisher MUST NOT send subscription-delivered
  // objects from outside the requested range.」に従い範囲外を送信しない。
  // 未受信時は undefined (フィルタなし = トラック全体)。
  private subscriptionLocationFilter: ResolvedFilter | undefined;
  // draft-ietf-moq-transport-21 §3.3.1 / §9.20.10:
  // 解決前の生の Location Filter。subscriptionLocationFilter は解決時点の
  // LARGEST_OBJECT に依存するため、同じ内容の再設定を避ける等価判定
  // (isSameLocationFilter) には生の値が要る。未受信時は undefined。
  private publisherLocationFilter: LocationFilter | undefined;

  // セッションが利用する内部コールバック
  // セッションは未指定のコールバックを明示的に undefined で代入するため `| undefined` を付ける
  goawayCallback?: ((newSessionUri: string) => void) | undefined;
  /**
   * NEW_GROUP_REQUEST を受けたときのアプリのコールバック (PublishCallbacks.onNewGroupRequest)
   *
   * セッションが PUBLISH の送信時に設定する。handleNewGroupRequest が条件を満たしたときに呼ぶ。
   */
  newGroupRequestCallback?: ((newGroupRequest: bigint) => void) | undefined;
  /**
   * PUBLISH の Track Properties で DYNAMIC_GROUPS=1 を広告したか
   *
   * draft-ietf-moq-transport-21 §10.6 (DYNAMIC GROUPS)。セッションが PUBLISH の送信時に
   * PublishOptions.dynamicGroups から設定する。
   */
  dynamicGroups = false;
  onSendObject?: (params: SendObjectParams) => Promise<void>;
  /**
   * Forward State 0 または Location Filter の範囲外で Object の送信を見送ったときに呼ばれる
   *
   * draft-ietf-moq-transport-21 §11.3.2 (Closing Subgroup Streams):
   * "If a sender closes the stream before delivering all such objects to the QUIC
   *  stream, it MUST reset the stream.  This includes, but is not limited to:
   *  ... Omitting a Subgroup Object due to the subscriber's Forward State"
   * Forward State 0 の見送り (§3.1 の Forward State) も Location Filter の
   * 範囲外の見送り (同 §3.3.1 の "A publisher MUST NOT send subscription-delivered
   *  objects from outside the requested range") も、届かない Object を残したまま
   * 閉じることになるため reset の対象である。見送りの事実を Session 側の
   * ストリーム状態へ記録するために使う。
   * `guardSend` は `sendDatagram` とも共有しており Datagram の見送りは Subgroup の
   * 省略ではないため、`guardSend` ではなく `sendObject` の skip 分岐と
   * Location Filter 分岐で呼ぶ。
   * 引数の groupId は記録先を絞るために渡す。開いている Subgroup と別の Group の
   * Object を見送っても、その Subgroup は範囲内をすべて渡している可能性があるため、
   * 記録側 (publishMarkStreamOmitted) が Group の一致を見る。
   */
  onSendObjectSkipped?: (groupId: number) => void;
  onSendDatagram?: (params: SendDatagramParams) => void;
  onDoneInternal?: (status: PublishDoneStatusCode) => Promise<void>;
  /**
   * PUBLISH_STATE_NOTIFY の送信 (セッション内部コールバック)
   *
   * draft-ietf-moq-transport-21 §9.10:
   * 送信内容の組み立て (変化したパラメータの選別と購読状態への反映) は
   * セッション側が行う。onSendObject / onSendDatagram と同じ役割分担である。
   */
  onNotifyStateChange?: (options: PublishStateNotifyOptions) => Promise<void>;

  /**
   * 進行中の done() の Promise
   *
   * draft-ietf-moq-transport-21 §9.9:
   * 「A publisher sends a PUBLISH_DONE message as the final message before
   *  closing the subscription's bidi stream」の枠組みに反する二重 PUBLISH_DONE
   * 送信を防ぐため、並行 done() 呼び出しでは進行中の Promise を再利用する。
   * 二重送信は、2 回目の publishSendPublishDone が既に閉じた writer への
   * write / close を試行して close 失敗の PROTOCOL_VIOLATION 昇格でセッション
   * を閉じる経路にもなる。
   */
  private donePromise: Promise<void> | null = null;

  constructor(
    // namespace / trackName は PublisherImpl では使用しない。
    // 呼び出し側の引数順を変えないため引数自体は残す。
    _namespace: string[],
    _trackName: string,
    requestId: bigint,
    trackAlias: bigint,
    onError?: (error: Error) => void,
    onForwardStateChange?: (forward: boolean) => void,
  ) {
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

  getRequestId(): bigint {
    return this.requestId;
  }

  getTrackAlias(): bigint {
    return this.trackAlias;
  }

  /**
   * この Publisher が送信した最大 Location を返す
   *
   * draft-ietf-moq-transport-21 §9.20.18 (LARGEST OBJECT Parameter):
   * "If Objects have been published on this Track the Publisher MUST include
   *  this parameter." 未送信時は null を返し、呼び出し側は LARGEST_OBJECT を
   * 含めない ("If omitted from a message, the sending endpoint has not
   *  published or received any Objects in the Track.")。
   */
  getLargestLocation(): Location | null {
    return this.largestLocation;
  }

  /**
   * Internal: 購読の Location Filter を設定する (セッションからのみ呼ぶ)
   *
   * draft-ietf-moq-transport-21 §9.5:
   * 「If a parameter previously set on the request is not present in
   *  REQUEST_UPDATE, its value remains unchanged.」に従い、REQUEST_UPDATE に
   * LOCATION_FILTER が含まれる場合のみ呼ぶ (省略時は従来値を保持する)。
   * 相対指定は設定時点の LARGEST_OBJECT で解決して固定する (§3.3.1。
   * SubscriberImpl と同じ規則)。解決結果は fill 範囲の評価 (§3.4) で使う。
   */
  setLocationFilter(filter: LocationFilter): void {
    this.publisherLocationFilter = filter;
    this.subscriptionLocationFilter = resolveFilter(filter, this.largestLocation);
  }

  /**
   * Internal: 設定されている生の Location Filter を取得する (セッションからのみ呼ぶ)
   *
   * 解決済みの subscriptionLocationFilter は解決時点の LARGEST_OBJECT に
   * 依存するため、同じ内容の再設定を避ける等価判定 (isSameLocationFilter) には
   * 使えない。SubscriberImpl.getLocationFilter と同じ役割である。
   */
  getLocationFilter(): LocationFilter | undefined {
    return this.publisherLocationFilter;
  }

  /**
   * Internal: 受信した NEW_GROUP_REQUEST をアプリへ知らせる (セッションからのみ呼ぶ)
   *
   * draft-ietf-moq-transport-21 §9.20.20 (NEW GROUP REQUEST Parameter):
   * "When an Original Publisher that supports dynamic Groups receives a NEW_GROUP_REQUEST
   *  with a value of 0 or a value larger than the current Group, it SHOULD end the current
   *  Group and begin a new Group as soon as practical."
   * "If the original publisher does not support dynamic Groups, it ignores the parameter"
   *
   * - DYNAMIC_GROUPS を広告していなければ知らせない
   * - 現在の Group は送った最大の Location の Group である。値が 0 (要求した側が Group を
   *   知らない) か、現在の Group より大きいときだけ知らせる。現在の Group 以下の値は、
   *   新しい Group が既に始まっていることを表す
   * - まだ何も送っていなければ、どの値でも知らせる
   *
   * 新しい Group をいつ始めるか (次のキーフレームなど) はアプリが決める。
   *
   * @returns アプリへ知らせたら true
   */
  handleNewGroupRequest(newGroupRequest: bigint): boolean {
    if (!this.dynamicGroups) {
      return false;
    }
    const currentGroup = this.largestLocation?.group;
    if (newGroupRequest !== 0n && currentGroup !== undefined && newGroupRequest <= currentGroup) {
      return false;
    }
    this.newGroupRequestCallback?.(newGroupRequest);
    return true;
  }

  /**
   * Internal: 解決済みの購読 Location Filter を取得する (セッションからのみ呼ぶ)
   */
  getResolvedLocationFilter(): ResolvedFilter | undefined {
    return this.subscriptionLocationFilter;
  }

  /**
   * 送信した Location で最大 Location を更新する
   *
   * sendObject / sendDatagram の受け付け時に呼ぶ。Group が大きい方、同一
   * Group では Object が大きい方を最大とする (§8.2 の Location 比較)。
   */
  private recordLargestLocation(groupId: number, objectId: number): void {
    // 非整数・負値は publishSendObject / publishSendDatagram 側で fail-fast
    // 拒否されるため、記録対象にしない (未送信の値を最大と誤認しない)。
    if (!Number.isInteger(groupId) || !Number.isInteger(objectId)) {
      return;
    }
    if (groupId < 0 || objectId < 0) {
      return;
    }
    const group = BigInt(groupId);
    const object = BigInt(objectId);
    if (
      this.largestLocation === null ||
      group > this.largestLocation.group ||
      (group === this.largestLocation.group && object > this.largestLocation.object)
    ) {
      this.largestLocation = { group, object };
    }
  }

  /**
   * 送信対象の Location が購読の Location Filter の範囲外かどうかを返す
   *
   * draft-ietf-moq-transport-21 §3.3.1:
   * 「A publisher MUST NOT send subscription-delivered objects from outside
   *  the requested range.」
   * フィルタ未保持 (undefined) は全 Object 通過。groupId / objectId は number の
   * ため、recordLargestLocation と同じ「非整数・負値は対象外」ガードの後で
   * bigint 化する。非整数・負値は既存の送信経路の fail-fast に委ね、
   * フィルタ判定はスキップする。
   */
  private isOutsideLocationFilter(groupId: number, objectId: number): boolean {
    const filter = this.subscriptionLocationFilter;
    if (filter === undefined) {
      return false;
    }
    if (!Number.isInteger(groupId) || !Number.isInteger(objectId)) {
      return false;
    }
    if (groupId < 0 || objectId < 0) {
      return false;
    }
    return !objectMatchesFilter({ group: BigInt(groupId), object: BigInt(objectId) }, filter);
  }

  incrementDataStreamCount(): void {
    this.dataStreamCount++;
  }

  getDataStreamCount(): bigint {
    return this.dataStreamCount;
  }

  /**
   * Object / Datagram の送信前ガード
   *
   * draft-ietf-moq-transport-21 §3.1:
   * "The publisher does not send Objects if the Forward State is 0, and does
   *  send them if the Forward State is 1. ... Control messages, such as
   *  PUBLISH_DONE (Section 9.9) are sent regardless of the forward state."
   * Forward State = 0 の間は送信せず、LARGEST_OBJECT の記録や END_OF_TRACK の
   * 記録も行わない (送信していない Object を記録しない)。
   * END_OF_TRACK 送信後の後続送信は禁止する。ライフサイクル状態の検証を
   * パラメータ形状より先に行う。
   *
   * @param kind - エラーメッセージに使う送信種別
   * @returns 送信してよければ null、Forward State = 0 で送信しない場合は "skip"、
   *          違反の場合は ProtocolViolationError (error コールバック通知済み)
   */
  private guardSend(
    kind: "object" | "datagram",
    groupId: number,
  ): ProtocolViolationError | "skip" | null {
    if (this.publisherState === "closed") {
      throw new Error("Publisher is closed");
    }
    if (!this.publisherForwardState) {
      return "skip";
    }
    if (this.endOfTrackSent) {
      const violation = new ProtocolViolationError(
        `cannot send ${kind} after END_OF_TRACK was sent`,
      );
      this.handleError(violation);
      return violation;
    }
    // draft-ietf-moq-transport-21 §11.1.2 (Object Status):
    // END_OF_GROUP は Group の最終 Object を宣言するため、同じ Group へ後続の
    // Object / Datagram を送ることはできない (別の Group への送信は妨げない)。
    if (this.endOfGroupSentGroupId !== null && groupId === this.endOfGroupSentGroupId) {
      const violation = new ProtocolViolationError(
        `cannot send ${kind} after END_OF_GROUP was sent for group ${groupId}`,
      );
      this.handleError(violation);
      return violation;
    }
    return null;
  }

  /**
   * Send an object on this track
   *
   * 戻り値は object が WebTransport stream に書き込み完了した時点で resolve する Promise。
   * Catalog のように relay 到達を保証してから後続処理に進めたい場合は await する。
   * リアルタイムフレームのように落としても良い場合は `void` で破棄して構わない。
   *
   * status / payload の組み合わせ違反と END_OF_TRACK 送信後の呼び出しは
   * fail-fast で error 通知 + 返値の reject になる
   * (組み合わせ規則は draft-ietf-moq-transport-21 §11.1.2 / §11.1.3、
   * END_OF_TRACK 後は §11.1.2 の EOT 定義による解釈)。
   *
   * 購読の Location Filter の範囲外 Object は送信せず、解決済みの
   * Promise<void> を返す (§3.3.1)。あわせて、届かない Object を残したまま Subgroup を
   * 閉じることになるため省略として記録する (§11.3.2。閉じる時は FIN ではなく RESET)。
   */
  sendObject(params: SendObjectParams): Promise<void> {
    // 戻り値は通常経路と同じ Promise<void> とし、呼び出し側の await を壊さない。
    const guard = this.guardSend("object", params.groupId);
    if (guard === "skip") {
      // draft-ietf-moq-transport-21 §11.3.2: Forward State 0 で見送った Object が
      // ある Subgroup は、閉じる時に FIN ではなく RESET が必要になる。
      this.onSendObjectSkipped?.(params.groupId);
      return Promise.resolve();
    }
    if (guard !== null) {
      return Promise.reject(guard);
    }

    // draft-ietf-moq-transport-21 §11.1.2:
    // status / payload 規則は委譲前 (queue 登録前) に検証する。
    // 違反は通知して返値の Promise を reject する (解決しない)。
    const statusViolation = validateSendStatusPayload(params);
    if (statusViolation) {
      this.handleError(statusViolation);
      return Promise.reject(statusViolation);
    }

    // draft-ietf-moq-transport-21 §3.3.1:
    // 購読の Location Filter の範囲外 Object は送信しない (Forward State = 0 と
    // 同様に送信も LARGEST_OBJECT の記録もしない。範囲外は正常なフィルタ動作であり
    // error 通知は行わない)。
    // draft-ietf-moq-transport-21 §11.3.2: 範囲外で見送った Object も Forward State 0 の
    // 見送りと同じく「届かない Object を残したまま閉じる」ため、閉じる時は RESET が必要。
    // 見送りの事実をここで記録する (閉じる時点では検出できない)。
    if (this.isOutsideLocationFilter(params.groupId, params.objectId)) {
      this.onSendObjectSkipped?.(params.groupId);
      return Promise.resolve();
    }

    // draft-ietf-moq-transport-21 §9.20.18:
    // 送信を受け付けた Location で最大 Location を更新する。
    this.recordLargestLocation(params.groupId, params.objectId);

    const isEndOfTrack = (params.status ?? ObjectStatus.NORMAL) === ObjectStatus.END_OF_TRACK;
    // draft-ietf-moq-transport-21 §11.1.2 (Object Status):
    // END_OF_GROUP は Group の最終 Object を宣言するため、同一 Group への後続送信は
    // guardSend で拒否する。受理した Group ID はここで記録する。
    const isEndOfGroup = (params.status ?? ObjectStatus.NORMAL) === ObjectStatus.END_OF_GROUP;
    if (!this.onSendObject) {
      // 委譲先がなくても END_OF_TRACK / END_OF_GROUP の意味論は保つ
      if (isEndOfTrack) {
        this.endOfTrackSent = true;
      }
      if (isEndOfGroup) {
        this.endOfGroupSentGroupId = params.groupId;
      }
      return Promise.resolve();
    }

    // END_OF_TRACK は受け付け時に記録する (送信成功時の記録と等価だが、
    // 未 await の連続呼び出しも塞ぐ)。組み合わせ違反は記録しない。
    // EOT 受け付け後の委譲先の同期 throw・非同期 reject 時は記録を取り消して
    // 再送できる。queue 吸収で resolve する内部失敗時は記録が残る。
    // EOT 記録後の拒否は記録を維持する。
    // 受け付けから非同期失敗までの窓に割り込んだ後続は EOT 後違反になるが、
    // 稀な並行であり塞ぐ方を優先する意図的な仕様である。
    if (isEndOfTrack) {
      this.endOfTrackSent = true;
      let result: Promise<void>;
      try {
        result = this.onSendObject(params);
      } catch (error) {
        this.endOfTrackSent = false;
        throw error;
      }
      result.then(
        () => {},
        () => {
          this.endOfTrackSent = false;
        },
      );
      return result;
    }

    // END_OF_GROUP も受け付け時に記録する (未 await の連続呼び出しを塞ぐ)。
    // 委譲先の同期 throw・非同期 reject 時は記録を取り消して再送できる。
    if (isEndOfGroup) {
      this.endOfGroupSentGroupId = params.groupId;
      let result: Promise<void>;
      try {
        result = this.onSendObject(params);
      } catch (error) {
        this.endOfGroupSentGroupId = null;
        throw error;
      }
      result.then(
        () => {},
        () => {
          this.endOfGroupSentGroupId = null;
        },
      );
      return result;
    }
    return this.onSendObject(params);
  }

  /**
   * Send a datagram on this track
   * draft-ietf-moq-transport-21 Section 11.2 (Datagrams)
   *
   * END_OF_TRACK 送信後の呼び出しは fail-fast で error 通知 + throw になる
   * (§11.1.2 の EOT 定義による解釈)。購読の Location Filter の範囲外 Datagram は
   * 送信しない (§3.3.1)。
   */
  sendDatagram(params: SendDatagramParams): void {
    const guard = this.guardSend("datagram", params.groupId);
    if (guard === "skip") {
      return;
    }
    if (guard !== null) {
      throw guard;
    }

    // draft-ietf-moq-transport-21 §3.3.1:
    // 購読の Location Filter の範囲外 Datagram は送信しない。
    if (this.isOutsideLocationFilter(params.groupId, params.objectId)) {
      return;
    }

    // draft-ietf-moq-transport-21 §9.20.18:
    // 送信を受け付けた Location で最大 Location を更新する。
    this.recordLargestLocation(params.groupId, params.objectId);

    if (this.onSendDatagram) {
      this.onSendDatagram(params);
    }
  }

  /**
   * 購読状態の変化を PUBLISH_STATE_NOTIFY で購読者へ通知する
   *
   * draft-ietf-moq-transport-21 §9.10 (PUBLISH_STATE_NOTIFY):
   * 「A publisher sends PUBLISH_STATE_NOTIFY on a subscription's bidirectional
   *  stream to notify the subscriber that the state of the subscription has
   *  changed for a reason other than a subscriber sent REQUEST_UPDATE.」
   * moqt-js は購読状態を自力で変化させない (Forward State は PUBLISH 送信時の
   * 指定と REQUEST_UPDATE 受信、Location Filter は REQUEST_UPDATE 受信で
   * 変わる) ため、アプリが変化後の値を指定して呼ぶ明示 API とする。
   *
   * 送信の成否は返値の Promise で表す。fire-and-forget で呼んでも reject が
   * unhandled rejection にならないよう、返却値と同一インスタンスに catch を
   * 登録してから返す (SubscriberImpl.update と同じ扱い)。
   */
  notifyStateChange(options?: PublishStateNotifyOptions): Promise<void> {
    // 購読が既に終了している場合は通知先が無いため何もしない
    // (done() と同じく閉鎖後は送信を試行しない)。
    if (this.publisherState === "closed") {
      return Promise.resolve();
    }
    if (!this.onNotifyStateChange) {
      // セッション側の配線が無い場合は送信先が無い (SubscriberImpl.update と
      // 同じ扱い)。
      return Promise.resolve();
    }

    let promise: Promise<void>;
    try {
      promise = this.onNotifyStateChange(options ?? {});
    } catch (error) {
      // 同期 throw も rejected な Promise として返し、呼び出し側の await に
      // 伝播させる (update() と同じ扱い)。
      promise = Promise.reject(error);
    }
    promise.catch(() => {});
    return promise;
  }

  /**
   * Handle error
   */
  handleError(error: Error): void {
    this.errorCallback?.(error);
  }

  /**
   * Internal: Set forward state (called by session)
   * draft-ietf-moq-transport-21 Section 9.20.19 (FORWARD Parameter)
   *
   * REQUEST_UPDATE で受信した FORWARD パラメータを反映する。
   * PUBLISH 送信時の options.forward による初期設定でも呼ぶ。
   * PUBLISH_OK は EXPIRES のみを運び FORWARD を反映しない。
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
   *
   * 並行呼び出しでは、進行中の done() の Promise を再利用して二重の
   * PUBLISH_DONE 送信を防ぐ。done() の resolve は「PUBLISH_DONE 送信完了まで
   * 待つ」意味論を維持するため、2 回目の呼び出しも 1 回目の完了を待つ。
   * ただしセッション終了後は PUBLISH_DONE を送信せずに resolve する
   * (publishSendPublishDone の sessionState ガード)。
   * 完了 (成功・失敗) 後はガードをリセットする。成功時は publisherState が
   * "closed" になり以後の done() は早期 return するため再試行は起きず、
   * 失敗時は以後の done() で再試行を許す (reject 後も publisherState が
   * "active" のままの意味論を維持する)。
   */
  done(): Promise<void> {
    return this.terminate(PublishDoneStatusCode.TRACK_ENDED);
  }

  /**
   * Internal: PUBLISH_DONE を指定 status で 1 回だけ送信する (セッションからのみ呼ぶ)
   *
   * done() と REQUEST_UPDATE 拒否経路 (UPDATE_FAILED) が同じ donePromise 排他を
   * 通ることで、並行しても PUBLISH_DONE は 1 回だけ送られる。排他を先に取得した
   * 側が勝ち、後着は同じ Promise を await して何もしない (§9.9「PUBLISH_DONE は
   * 最終メッセージ」のため後着が別 status を重ねて送ることはしない)。done() が
   * 先に完了した場合に §9.5.1 の UPDATE_FAILED が送られないのは、購読がアプリ
   * 起点で既に正常終了しているためである。
   */
  async terminate(status: PublishDoneStatusCode): Promise<void> {
    if (this.publisherState === "closed") {
      return;
    }

    if (this.donePromise) {
      return this.donePromise;
    }

    this.donePromise = this.doneInternal(status);
    try {
      await this.donePromise;
    } finally {
      this.donePromise = null;
    }
  }

  /**
   * onDoneInternal (PUBLISH_DONE 送信) を実行してから publisherState を
   * "closed" に遷移する
   */
  private async doneInternal(status: PublishDoneStatusCode): Promise<void> {
    if (this.onDoneInternal) {
      await this.onDoneInternal(status);
    }

    this.publisherState = "closed";
  }

  /**
   * Internal: mark as closed (called by session)
   */
  markClosed(): void {
    this.publisherState = "closed";
    // 購読終了 (done / peer cancel / セッション終了) では END_OF_GROUP 済みの
    // Group 記録も破棄する。
    this.endOfGroupSentGroupId = null;
  }
}
