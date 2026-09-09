/**
 * MOQT Publisher
 * draft-ietf-moq-transport-21 Section 3 (Publishing and Retrieving Tracks)
 */

import { ObjectStatus, type Location } from "./message/types";
import type { LocationFilter } from "./message/parameter";
import { resolveFilter, type ResolvedFilter } from "./filter";
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
   */
  sendDatagram(params: SendDatagramParams): void;
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
  private readonly publisherNamespace: string[];
  private readonly publisherTrackName: string;
  private readonly errorCallback?: (error: Error) => void;
  private readonly forwardStateChangeCallback?: (forward: boolean) => void;
  private readonly requestId: bigint;
  private readonly trackAlias: bigint;

  // draft-ietf-moq-transport-21 Section 9.9 (PUBLISH_DONE):
  // PUBLISH_DONE の Stream Count 用カウンター
  private dataStreamCount = 0n;

  // draft-ietf-moq-transport-21 §11.1.2:
  // END_OF_TRACK 送信済みか。sendObject / sendDatagram で共有し、
  // 記録後の両 API 呼び出しを拒否する。
  private endOfTrackSent = false;

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
  // fill 範囲は「FILL_PARAMETERS 内の LOCATION_FILTER、省略時は購読の
  // Location Filter」で決まるため、その評価に使う。現状の用途は fill 範囲の
  // 評価のみであり、送信 Object への Location Filter 適用 (§3.3.1 の
  // publisher MUST) は未実装 (別 issue)。
  // 未受信時は undefined (フィルタなし = トラック全体)。
  private subscriptionLocationFilter: ResolvedFilter | undefined;

  // セッションが利用する内部コールバック
  goawayCallback?: (newSessionUri: string) => void;
  onSendObject?: (params: SendObjectParams) => Promise<void>;
  onSendDatagram?: (params: SendDatagramParams) => void;
  onDoneInternal?: () => Promise<void>;

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
    this.subscriptionLocationFilter = resolveFilter(filter, this.largestLocation);
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
   *
   * status / payload の組み合わせ違反と END_OF_TRACK 送信後の呼び出しは
   * fail-fast で error 通知 + 返値の reject になる
   * (組み合わせ規則は draft-ietf-moq-transport-21 §11.1.2 / §11.1.3、
   * END_OF_TRACK 後は §11.1.2 の EOT 定義による解釈)。
   */
  sendObject(params: SendObjectParams): Promise<void> {
    if (this.publisherState === "closed") {
      throw new Error("Publisher is closed");
    }

    // draft-ietf-moq-transport-21 §3.1:
    // "The publisher does not send Objects if the Forward State is 0, and does
    //  send them if the Forward State is 1. ... Control messages, such as
    //  PUBLISH_DONE (Section 9.9) are sent regardless of the forward state."
    // Forward State = 0 の間は Object を送信せず、LARGEST_OBJECT の記録や
    // END_OF_TRACK の記録も行わない (送信していない Object を記録しない)。
    // 戻り値は通常経路と同じ Promise<void> とし、呼び出し側の await を壊さない。
    if (!this.publisherForwardState) {
      return Promise.resolve();
    }

    // END_OF_TRACK 送信後は同一トラックへの後続送信を禁止する。
    // ライフサイクル状態の検証をパラメータ形状より先に行う。
    if (this.endOfTrackSent) {
      const violation = new ProtocolViolationError(
        "cannot send object after END_OF_TRACK was sent",
      );
      this.handleError(violation);
      return Promise.reject(violation);
    }

    // draft-ietf-moq-transport-21 §11.1.2:
    // status / payload 規則は委譲前 (queue 登録前) に検証する。
    // 違反は通知して返値の Promise を reject する (解決しない)。
    const statusViolation = validateSendStatusPayload(params);
    if (statusViolation) {
      this.handleError(statusViolation);
      return Promise.reject(statusViolation);
    }

    // draft-ietf-moq-transport-21 §9.20.18:
    // 送信を受け付けた Location で最大 Location を更新する。
    this.recordLargestLocation(params.groupId, params.objectId);

    const isEndOfTrack = (params.status ?? ObjectStatus.NORMAL) === ObjectStatus.END_OF_TRACK;
    if (!this.onSendObject) {
      // 委譲先がなくても END_OF_TRACK の意味論 (以降の object は存在しない) は保つ
      if (isEndOfTrack) {
        this.endOfTrackSent = true;
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
    return this.onSendObject(params);
  }

  /**
   * Send a datagram on this track
   * draft-ietf-moq-transport-21 Section 11.2 (Datagrams)
   *
   * END_OF_TRACK 送信後の呼び出しは fail-fast で error 通知 + throw になる
   * (§11.1.2 の EOT 定義による解釈)。
   */
  sendDatagram(params: SendDatagramParams): void {
    if (this.publisherState === "closed") {
      throw new Error("Publisher is closed");
    }

    // draft-ietf-moq-transport-21 §3.1:
    // "The publisher does not send Objects if the Forward State is 0"
    // Datagram も Object であるため、Forward State = 0 では送信しない。
    if (!this.publisherForwardState) {
      return;
    }

    if (this.endOfTrackSent) {
      const violation = new ProtocolViolationError(
        "cannot send datagram after END_OF_TRACK was sent",
      );
      this.handleError(violation);
      throw violation;
    }

    // draft-ietf-moq-transport-21 §9.20.18:
    // 送信を受け付けた Location で最大 Location を更新する。
    this.recordLargestLocation(params.groupId, params.objectId);

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
  async done(): Promise<void> {
    if (this.publisherState === "closed") {
      return;
    }

    if (this.donePromise) {
      return this.donePromise;
    }

    this.donePromise = this.doneInternal();
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
  private async doneInternal(): Promise<void> {
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
