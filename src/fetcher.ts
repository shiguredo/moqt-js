/**
 * MOQT Fetcher
 * draft-ietf-moq-transport-23 §3.2 (Fetch) / §9.11 (FETCH) / §9.3 (REQUEST_OK)
 *
 * draft-ietf-moq-transport-23 §9.3 / Appendix A.1: FETCH の成功応答は
 * REQUEST_OK (FETCH_OK は §1.5 の別名) であり、旧 FETCH_OK が持っていた
 * End Of Track / End Location は削除された。このため応答がカバーする範囲の
 * 終端は、要求した End Location と応答の LARGEST_OBJECT から §3.2 に従って
 * 応答受理時に確定する (src/session/params.ts の resolveFetchResponseEndLocation)。
 * Track の終端は応答ではなく FETCH データの End of Track indicator で判定する。
 *
 * FETCH レスポンスで不明な範囲を許可する。
 * Publisher がまだシリアライズしていないオブジェクトの範囲を
 * "unknown range" として返すことができる (§11.4.2 (End of Range), Table 8)。
 */

import type { MoqtObject } from "./dataStream";
import { fullTrackNameKey, type FullTrackNameKey } from "./fullTrackName";
import type { Location } from "./message/types";
import { GroupOrder } from "./message/types";
import type { Property } from "./properties";

/**
 * FETCH の要求範囲
 *
 * Start Location と End Location (開端の要求では undefined) の組。
 * 応答の終端確定 (session/params の resolveFetchResponseEndLocation) に使う。
 */
export interface FetchRequestRange {
  /** 要求する Start Location (inclusive) */
  startLocation: Location;
  /** 要求する End Location (inclusive)。開端の要求では undefined */
  endLocation: Location | undefined;
}

/**
 * Fetcher state
 */
export type FetcherState = "active" | "closed";

/**
 * Fetcher interface
 */
export interface Fetcher {
  readonly state: FetcherState;
  /**
   * Track の終端を確認済みか
   *
   * draft-ietf-moq-transport-23 §11.4.1 (Fetch Header) / Table 8 / §11.4.2.2:
   * FETCH データストリームの End of Track indicator (0x81) を受信したときに
   * true になる。0x81 は追加フィールドを持たず、直前の実 Object が Track の最終
   * Object であることを示す。
   *
   * false は Track が今後も続くことを保証しない (まだ終端を確認していないという
   * 意味にすぎない)。成功応答の受理時点では false であり、FETCH データストリームの
   * 単なる FIN では変更しない。FIN はデータストリームが終了したことだけを意味し、
   * Track の終端を宣言するものではないためである。旧 FETCH_OK の End Of Track
   * フィールドは §9.3 / Appendix A.1 で削除されたため、応答からは設定しない。
   */
  readonly endOfTrack: boolean;
  /**
   * 応答がカバーする範囲の inclusive な上限
   *
   * draft-ietf-moq-transport-23 §3.2 (Fetch): "A FETCH requests pre-existing
   * Objects from a Track between a Start Location and an End Location,
   * inclusive." 成功応答の受理時に、要求した End Location と応答の
   * LARGEST_OBJECT から次のように確定する (src/session/params.ts の
   * resolveFetchResponseEndLocation)。
   * - LARGEST_OBJECT が要求範囲内ならその位置 (§3.2 の first sentence)
   * - LARGEST_OBJECT が要求 End より後なら要求した End Location (§3.2 の otherwise)
   * - 閉端の要求で LARGEST_OBJECT を欠く場合は要求した End Location (§3.2.2)
   * - 開端の要求 (フィルタなし / 0x00 / 0x02) では LARGEST_OBJECT が要求 End
   *   そのものであり、LARGEST_OBJECT を欠く成功応答は MALFORMED_MESSAGE になる
   * - LARGEST_OBJECT が要求 Start より前にある応答は、開端・閉端のどちらでも
   *   §3.2 の INVALID_RANGE 対象であり INVALID_FIELD になる
   *
   * Location Filter Type 0x03 (Absolute Start, Group End) で LARGEST_OBJECT に
   * よる終端が得られない場合、この値は {StartGroup + EndGroupDelta, 2^64-1} に
   * 正規化される (§9.19.9 Table 6 の「End Group 全体」)。Object ID 2^64-1 は
   * Group 全体を含む境界値であり、実在する最後の Object ID ではない。
   *
   * LARGEST_OBJECT は §3.1.4 のとおり到着中の Object を指し得る。値は応答受理時に
   * 確定し、後続データの最後の実 Object に合わせて書き換えない。
   */
  readonly endLocation: Location;
  /**
   * 成功応答 (REQUEST_OK / FETCH_OK) で受信した Track Properties
   *
   * draft-ietf-moq-transport-23 §9.3 (REQUEST_OK):
   * Track Properties は FETCH_OK で populate される。未知の Mandatory Track
   * Property を含む場合は malformed Track として FETCH が cancel される (§3.7)。
   */
  readonly trackProperties: ReadonlyArray<Property>;
  /**
   * Fetch をキャンセルする
   * draft-ietf-moq-transport-23 §3.2.4 (Fetch State Management)
   *
   * 「It MUST send STOP_SENDING for the bidi request stream.」
   * データストリームへの STOP_SENDING は MAY であり、この cancel() では送らない
   * (bidi リクエストストリームへの STOP_SENDING だけで MUST を満たす)。
   * データストリームを打ち切る経路 (malformed track の検出、バッファ上限) は
   * 別途 cancelStreamQuiet で送っている。
   *
   * subscriber は cancel するか FETCH_ERROR を受信するか、FETCH データストリームが
   * FIN または reset されるまで FETCH state を保持する。
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
  // 未指定の場合は明示的に undefined を代入する (呼び出し側は `?.` で呼ぶ) ため
  // `| undefined` を付ける
  private readonly endCallback?: (() => void) | undefined;
  private readonly errorCallback?: ((error: Error) => void) | undefined;
  private readonly requestId: bigint;
  private fetchEndOfTrack = false;
  private fetchEndLocation: Location = { group: 0n, object: 0n };
  private fetchTrackProperties: Property[] = [];
  // 要求した範囲 (Start / End Location)。End Location は開端の要求では undefined。
  // 応答の終端確定 (resolveFetchResponseEndLocation) に使う。未設定時は
  // フィルタなしの要求と同じ {0, 0} から Largest Object までとして扱う。
  private fetchRequestStartLocation: Location = { group: 0n, object: 0n };
  private fetchRequestEndLocation: Location | undefined = undefined;
  // 要求範囲が設定済みか。直接生成した FetcherImpl (単体テスト等) と、要求範囲が
  // 確定している実際の FETCH を区別する。FETCH 応答の暗黙 gap を非存在として
  // 扱えるのは要求範囲が分かる場合だけである (draft-ietf-moq-transport-23 §3.2.2)。
  private fetchRequestRangeSet = false;
  // 要求に Range Filter を含むか。含む場合、FETCH 応答のマークされていない gap は
  // Unknown 状態の Object を示すため、非存在とみなさない (§3.2.2)。
  private fetchRequestRangeFiltersPresent = false;

  /**
   * Fetch リクエストの Group Order
   * draft-ietf-moq-transport-23 Section 9.19.8 (GROUP ORDER Parameter)
   * 省略時は Ascending (0x1)。
   */
  private fetchGroupOrder: GroupOrder = GroupOrder.ASCENDING;

  // Session がストリームクローズ処理を差し込むためのコールバック
  // セッションは未指定のコールバックを明示的に undefined で代入するため `| undefined` を付ける
  goawayCallback?: ((newSessionUri: string) => void) | undefined;
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

  /**
   * Full Track Name の比較キーを取得する（Track 同一性判定用）
   *
   * draft-ietf-moq-transport-23 §2.4.1: Track の同一性は Full Track Name
   * (Track Namespace + Track Name) で判定する。
   * 戻り値は fullTrackNameKey が生成する長さ付きキーであり、Full Track Name
   * そのものではない。Track の同一性判定は完全一致でのみ行う。
   */
  getFullTrackNameKey(): FullTrackNameKey {
    return fullTrackNameKey(this.fetcherNamespace, this.fetcherTrackName);
  }

  get endOfTrack(): boolean {
    return this.fetchEndOfTrack;
  }

  /** 応答がカバーする範囲の inclusive な上限 */
  get endLocation(): Location {
    return this.fetchEndLocation;
  }

  /**
   * 要求した範囲を設定する (セッション内部コールバック)
   *
   * draft-ietf-moq-transport-23 §3.2: 応答の終端は要求した End Location と
   * 応答の LARGEST_OBJECT から確定するため、要求範囲を保持する。
   * 開端の要求 (フィルタなし / 0x00 / 0x02) では End Location が undefined になる。
   * Start と End を別々に設定できないよう 1 組で受け取り、不整合状態を作らせない。
   */
  setFetchRequestRange(range: FetchRequestRange): void {
    this.fetchRequestStartLocation = range.startLocation;
    this.fetchRequestEndLocation = range.endLocation;
    this.fetchRequestRangeSet = true;
  }

  /** 要求した範囲を取得する (開端の要求では End Location が undefined) */
  getFetchRequestRange(): FetchRequestRange {
    return {
      startLocation: this.fetchRequestStartLocation,
      endLocation: this.fetchRequestEndLocation,
    };
  }

  /**
   * 要求範囲が確定しているか
   *
   * draft-ietf-moq-transport-23 §3.2.2 (Gaps in a Fetch Stream):
   * Start / End Location は暗黙 gap の境界を決めるため、要求範囲が分かる場合だけ
   * 暗黙 gap を非存在として扱う。直接生成した FetcherImpl では false のままに
   * して、推測した範囲を根拠にしない。
   */
  hasFetchRequestRange(): boolean {
    return this.fetchRequestRangeSet;
  }

  /**
   * 要求に Range Filter を含むかを設定する (セッション内部コールバック)
   *
   * draft-ietf-moq-transport-23 §3.2.2: Range Filter を含む要求では、応答の
   * マークされていない gap は Unknown 状態の Object を示す。非存在と誤認しない
   * よう、要求時の有無を保持する。
   */
  setFetchRequestRangeFiltersPresent(present: boolean): void {
    this.fetchRequestRangeFiltersPresent = present;
  }

  /** 要求に Range Filter を含むかを取得する */
  getFetchRequestRangeFiltersPresent(): boolean {
    return this.fetchRequestRangeFiltersPresent;
  }

  get trackProperties(): ReadonlyArray<Property> {
    return this.fetchTrackProperties;
  }

  getRequestId(): bigint {
    return this.requestId;
  }

  /**
   * 成功応答 (REQUEST_OK / FETCH_OK) から情報を設定
   *
   * draft-ietf-moq-transport-23 §3.2 (Fetch) / §9.3 (REQUEST_OK):
   * 応答は終端を運ばないため、endLocation は呼び出し側 (セッション) が要求範囲と
   * LARGEST_OBJECT から確定した値を受け取る。旧 FETCH_OK の End Of Track は
   * §9.3 / Appendix A.1 で削除されたため、endOfTrack は応答では変更しない
   * (End of Track indicator を受信するまで false のまま)。
   *
   * Largest Object を含む範囲の FETCH で「その Object を完全に配送し、残りは
   * 利用可能になり次第届ける」ことは publisher / relay の責務であり (§3.2)、
   * クライアントは確定した終端を信頼する。Largest Object でクランプし直さないのは、
   * §3.1.4 の Largest Object が到着中の Object を指し得るためである
   * (クライアント側で再計算すると配送済みの Object を取りこぼす)。
   */
  setFetchOkInfo(endLocation: Location, trackProperties: Property[]): void {
    this.fetchEndLocation = endLocation;
    this.fetchTrackProperties = trackProperties;
  }

  /**
   * Fetch リクエストの Group Order を設定する (セッション内部コールバック)
   *
   * draft-ietf-moq-transport-23 §11.4.1.1 (Flags): FETCH 応答の Group ID の
   * 計算式は Group Order で変わるため、要求時に確定した値を保持する。
   */
  setGroupOrder(groupOrder: GroupOrder): void {
    this.fetchGroupOrder = groupOrder;
  }

  /**
   * Fetch リクエストの Group Order を取得
   */
  getGroupOrder(): GroupOrder {
    return this.fetchGroupOrder;
  }

  /**
   * キャンセル済み / セッション終了済みかどうか
   *
   * handleObject / handleEnd / handleError / cancel が共通で使う受付判定。
   * closed の fetcher には Object も終了もエラーも通知しない。
   */
  private get isClosed(): boolean {
    return this.fetcherState === "closed";
  }

  /**
   * データストリームからオブジェクトを受信
   */
  handleObject(object: MoqtObject): void {
    if (this.isClosed) {
      return;
    }
    this.objectCallback(object);
  }

  /**
   * End of Track indicator (0x81) を受理したことを記録する (セッション内部)
   *
   * draft-ietf-moq-transport-23 §11.4.1 (Fetch Header) / Table 8 / §11.4.2.2:
   * End of Track indicator は追加フィールドを持たない indicator であり、
   * 直前の実 Object が Track の最終 Object であることを示す。indicator 自体は
   * Object ではないためアプリへ配送せず、ここで Fetcher.endOfTrack だけを true に
   * する。データストリームの FIN (handleEnd) と違い、Track の終端を確認したことを
   * 表す。キャンセル済み (closed) の fetcher には記録しない (handleObject と同じ
   * 受付判定)。
   */
  handleEndOfTrack(): void {
    if (this.isClosed) {
      return;
    }
    this.fetchEndOfTrack = true;
  }

  /**
   * Fetch 完了（ストリーム終了）
   */
  handleEnd(): void {
    if (this.isClosed) {
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
    if (this.isClosed) {
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
   * draft-ietf-moq-transport-23 Section 3.2.4 (Fetch State Management):
   * "It MUST send STOP_SENDING for the bidi request stream."
   * FETCH_CANCEL は削除され、キャンセルは bidi リクエストストリームへの
   * STOP_SENDING (WebTransport では readable の cancel) で行う。
   */
  async cancel(): Promise<void> {
    if (this.isClosed) {
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
