/**
 * Catalog 購読フェーズ
 *
 * `MediaSubscriberImpl` から切り出した、catalog トラックの SUBSCRIBE / FETCH と、
 * 受信した catalog からのトラック解決を受け持つ。受信タイムアウト・エラー通知・
 * 解決の順序は `MediaSubscriberImpl` に置いていたときと同じであり、挙動は変えない。
 *
 * catalog の受信状態 (`CatalogSubscriptionState`) は `MediaSubscriberImpl` が持ち、
 * このクラスは getter / setter を通して読み書きする。状態を実装クラスに残すのは、
 * 単体テストが制御口として同じ名前のフィールドを直接読み書きするためである
 * (`MediaSubscriberImpl` の該当フィールドの JSDoc を参照)。フェーズの処理だけを
 * ここへ移し、状態の置き場所は変えない。
 *
 * 購読の開始 (`subscribe`) とトラックの解決 (`extractTrackInfo`) は
 * `MediaSubscriberImpl.start` から呼ばれる。catalog オブジェクトの適用そのものは
 * `MediaSubscriberImpl.handleCatalogObject` が持ち、`applyObject` で呼び出す。
 */

import { DEFAULT_AUDIO_TRACK_NAME, DEFAULT_VIDEO_TRACK_NAME } from "../createMedia/settings";
import type { MediaSubscriberOptions } from "../codec/types";
import type { MoqtObject } from "../dataStream";
import type { AuthorizationToken, Location, LocationFilter } from "../message";
import {
  CATALOG_TRACK_NAME,
  getAudioTracks,
  getTrackByName,
  getVideoTracks,
  type Catalog,
  type CatalogTrack,
} from "../msf";
import { effectiveTargetLatencyMs, resolveSharedTargetLatencyMs } from "../msf/tracks";
import { compareLocations } from "../session/params";
import type { PublishDoneInfo, Session } from "../session";
import type { Subscriber } from "../subscriber";

/** Catalog の受信タイムアウト (ミリ秒) */
const CATALOG_RECEIVE_TIMEOUT = 5000;

/**
 * Catalog 購読フェーズの可変な状態
 *
 * `MediaSubscriberImpl` がフィールドとして持ち、このクラスは getter / setter 経由で
 * 読み書きする。フィールドの意味と不変条件は `MediaSubscriberImpl` の JSDoc を参照。
 */
export interface CatalogSubscriptionState {
  /** Catalog 購読の Subscriber (live 更新用) */
  catalogSubscriber: Subscriber | null;
  /** 受信済みの catalog */
  receivedCatalog: Catalog | null;
  /** Catalog 受信待ちの resolve */
  catalogResolve: ((catalog: Catalog) => void) | null;
  /** Catalog 受信待ちの reject */
  catalogReject: ((error: Error) => void) | null;
  /** Catalog 受信待ちを await しているか */
  catalogWaiting: boolean;
  /** Catalog FETCH フェーズ中フラグ */
  catalogFetchInProgress: boolean;
  /** FETCH フェーズ中にバッファした live SUBSCRIBE のオブジェクト */
  pendingCatalogObjects: MoqtObject[];
  /** FETCH で配信された最大 Location (live バッファドレイン時の重複除去用) */
  catalogFetchLastLocation: Location | null;
  /** Catalog 受信タイムアウトのタイマー (解除用に保持する) */
  catalogTimer: ReturnType<typeof setTimeout> | null;
  /** Catalog 受信失敗済みか (失敗後の遅延オブジェクトを無害化するガード) */
  catalogReceiveFailed: boolean;
  /** Catalog から取得した音声トラック情報 */
  audioTrackInfo: CatalogTrack | null;
  /** Catalog から取得した映像トラック情報 */
  videoTrackInfo: CatalogTrack | null;
}

/**
 * `CatalogSubscription` が使う依存
 *
 * 購読と catalog の適用に必要なものだけを明示的に受け取る。`MediaSubscriberImpl` の
 * 状態へは `state` の getter / setter を通してだけ触れる。
 */
interface CatalogSubscriptionDependencies {
  /** MediaSubscriberImpl が持つ catalog 購読フェーズの状態 */
  readonly state: CatalogSubscriptionState;
  /** 購読の設定 (namespace / 音声・映像の要求) */
  readonly options: Pick<MediaSubscriberOptions, "namespace" | "audio" | "video">;
  /** 接続済みの Session (未接続なら null) */
  readonly session: () => Session | null;
  /** 利用者の onError への通知。通知の例外は呼び出し元の経路へそのまま伝わる */
  readonly reportError: (error: Error) => void;
  /** PUBLISH_DONE の終了通知 (購読の失敗として扱うかの判定は MediaSubscriberImpl が持つ) */
  readonly handlePublishDone: (publishDone: PublishDoneInfo) => void;
  /** 解放が先行していないかの検査 (start の開始時に捕捉した世代番号を渡す) */
  readonly assertStartNotDisposed: (startGeneration: number) => void;
  /** 解決した targetLatency を再生の入口へ渡す */
  readonly applyTargetLatencyMs: (latencyMs: number | null) => void;
  /** 受信した catalog オブジェクトの適用 (MediaSubscriberImpl.handleCatalogObject) */
  readonly applyObject: (obj: MoqtObject) => void;
  /** live バッファから適用対象を選ぶ純関数 (`filterPendingCatalogObjects`) */
  readonly filterPendingObjects: (
    pending: MoqtObject[],
    lastFetchedLocation: Location,
  ) => MoqtObject[];
  /** FETCH の開始位置を決める純関数 (`catalogFetchFilter`) */
  readonly fetchFilter: (largestLocation: Location | null) => LocationFilter;
}

/**
 * Catalog 購読フェーズの処理
 *
 * catalog トラックの購読 (live 更新) と FETCH (既存 catalog) を開始し、FETCH フェーズ
 * 中に届いた live オブジェクトをバッファして FETCH 終了後に到着順で適用する。フル
 * カタログが揃った時点で受信待ちを解決し、`extractTrackInfo` で要求メディアのトラックを
 * 解決する。
 *
 * 失敗時の契約: 受信タイムアウト後は `catalogReceiveFailed` を立てて以降のオブジェクトを
 * 破棄し、購読の失敗は `reportError` へ流す。FETCH の終了 (end / error / reject) と
 * 受信タイムアウトは同じ `finishCatalogFetchPhase` に集約し、バッファを捨てずにドレイン
 * してから判定する。解放が先行した場合は `resetCatalogFetchPhase` と `clearCatalogTimer`
 * で受信経路を止め、`MediaSubscriberImpl.disposeAllResources` が受信待ちを打ち切る。
 */
export class CatalogSubscription {
  private readonly deps: CatalogSubscriptionDependencies;
  private readonly state: CatalogSubscriptionState;

  /**
   * @param deps - 購読と catalog の適用に必要な依存 (状態は getter / setter で受け取る)
   */
  constructor(deps: CatalogSubscriptionDependencies) {
    this.deps = deps;
    this.state = deps.state;
  }

  /**
   * catalog トラックの制御メッセージ (SUBSCRIBE / FETCH) に付与する Authorization Token
   *
   * draft-ietf-moq-msf-01 §11.4.3: track に紐づくトークンは、そのトラックに関係する
   * AUTHORIZATION TOKEN パラメータを受け付けるすべての制御メッセージへ MUST 付与する。
   * catalog の authInfo (§5.2.42) は catalog を受信するまで分からないため、SETUP に載せた
   * トークン (MOQT URI の msf fragment の c4m、または `authorizationToken` オプション) を
   * catalog の SUBSCRIBE / FETCH にも付与する。
   *
   * @returns SETUP に載せたトークン (無ければ undefined)
   */
  private catalogAuthorizationToken(): AuthorizationToken | undefined {
    return this.deps.session()?.setupAuthorizationToken;
  }

  /**
   * Catalog を subscribe して受信を待つ
   *
   * 既存の catalog と live の catalog 更新をまとめて受信する。Joining FETCH は
   * draft-20 で削除された (draft-ietf-moq-transport-22 §A.3「Replace Joining FETCH
   * with fill fetch streams」)。MSF-01 §5 は Joining FETCH を MUST とするが、
   * draft-22 前提では §3.4 の FILL_PARAMETERS による fill fetch として解釈する。
   * 本実装では以下の 2 リクエストで代替しており、fill fetch 化は未実装である:
   * 1. SUBSCRIBE (Next Object (Location Filter Type 0x05) の Location Filter) で
   *    live の catalog 更新を受信する
   * 2. 独立した FETCH で既存の catalog を取得する。要求範囲は SUBSCRIBE_OK の
   *    LARGEST_OBJECT が示す Group の先頭 Object から Largest Object までとする
   *    (catalogFetchFilter を参照。LARGEST_OBJECT が不明なときも絶対位置 {0, 0} の
   *    Location Filter を載せ、フィルタ無しの FETCH は送らない)
   * FETCH フェーズ中の live オブジェクトはバッファし、FETCH の終了 (end / error)
   * で順に適用する (delta が full より先に適用される順序逆転を防ぐ)。
   * FETCH と live で二重に届いたオブジェクトは filterPendingCatalogObjects で除去する。
   *
   * SUBSCRIBE_OK 受信後に FETCH を送ることが重要: Next Object の Largest (L1) が
   * FETCH 処理時の Largest (L2) 以下になることを保証し、どちらのリクエストにも
   * 届かない (L2, L1] の取りこぼしを防ぐ。リレーが FETCH を先に処理すると
   * L2 < L1 になり得るため、順序を入れ替えてはならない。
   *
   * 異常系契約: 受信タイムアウトで失敗した後は catalogReceiveFailed で以降の
   * オブジェクトを破棄する (ドレインでフル catalog を resolve した場合は破棄せず、
   * 以降の live 更新も適用する)。session.subscribe 失敗時は即時掃除して
   * throw する。成功時を含めタイマーは解除する。
   * FETCH の応答が期限までに終わらない場合も、live で届いていたフル catalog は
   * 破棄せずドレインして resolve する (FETCH が end も error も通知しないリレーでも
   * 受信済みの catalog を使い切る)。この場合 FETCH は FETCH_OK を受ける前に
   * 保留のまま残る (Fetcher を取得できないため取り消す経路が無い)。
   *
   * @param startGeneration start の開始時に捕捉した世代番号 (解放が先行していないかの検査用)
   * @param timeoutMs Catalog 受信タイムアウト (ミリ秒、省略時は CATALOG_RECEIVE_TIMEOUT)
   */
  async subscribe(
    startGeneration: number,
    timeoutMs: number = CATALOG_RECEIVE_TIMEOUT,
  ): Promise<void> {
    const session = this.deps.session();
    if (session === null) {
      throw new Error("session not connected");
    }

    const namespace = this.deps.options.namespace;
    const catalogAuthorizationToken = this.catalogAuthorizationToken();

    // Catalog 受信を待つ Promise を作成
    // タイムアウトは「未 resolve」で reject する。FETCH フェーズ中にフルが来ても
    // その場では resolve しない契約のため、`!receivedCatalog` だけではフェーズ未完了時に
    // ハングする。フェーズが終わらないまま期限に達したときは、ドレインしてから判定する。
    const catalogPromise = new Promise<Catalog>((resolve, reject) => {
      this.state.catalogResolve = resolve;
      this.state.catalogReject = reject;

      this.state.catalogTimer = setTimeout(() => {
        this.state.catalogTimer = null;
        if (this.state.catalogResolve === null) {
          return;
        }
        try {
          // FETCH の応答が end も error も通知されないまま期限に達しても、live の
          // SUBSCRIBE で届いていた catalog は破棄しない。まずバッファをドレインし、
          // フル catalog があれば resolve する (FETCH に応答しない、または応答が
          // 終わらないリレーでは、受信済みの catalog が使われないまま期限に達していた)
          this.finishCatalogFetchPhase();
        } catch (error) {
          // ドレインは利用者コールバック (onCatalog) を呼ぶ。live 配送経路と同じく
          // 例外は onError へ流し、タイマーコールバックの外へは出さない
          // (呼び出し元がライブラリ内に無く、未処理例外になるため)
          try {
            this.deps.reportError(error instanceof Error ? error : new Error(String(error)));
          } catch {
            // 通知の失敗を伝える経路がこれ以上無い
          }
        }
        // ドレインで resolve 済みなら何もしない
        this.rejectCatalogReceiveTimeout();
      }, timeoutMs);
    });

    // FETCH フェーズ用フラグは session.subscribe 呼び出し前に立てる
    // (SUBSCRIBE_OK までの race で live がバッファを迂回するのを防ぐ)
    this.state.catalogFetchInProgress = true;
    this.state.pendingCatalogObjects = [];
    this.state.catalogFetchLastLocation = null;
    this.state.catalogReceiveFailed = false;

    // Catalog サブスクライバー (live 更新用)
    let catalogSubscriber: Subscriber;
    try {
      catalogSubscriber = await session.subscribe(
        namespace,
        CATALOG_TRACK_NAME,
        {
          object: (obj) => {
            // FETCH フェーズ中の live SUBSCRIBE オブジェクトはバッファする
            if (this.state.catalogFetchInProgress) {
              this.state.pendingCatalogObjects.push(obj);
              return;
            }
            this.deps.applyObject(obj);
          },
          end: (publishDone) => {
            this.deps.handlePublishDone(publishDone);
          },
          error: (error) => this.deps.reportError(error),
        },
        {
          // Next Object (Location Filter Type 0x05): live は現在の最新 catalog の次から受信する
          filter: { nextObject: true },
          // draft-ietf-moq-msf-01 §11.4.3: catalog に紐づくトークンは SUBSCRIBE にも MUST 付与
          ...(catalogAuthorizationToken === undefined
            ? {}
            : { authorizationToken: catalogAuthorizationToken }),
        },
      );
    } catch (error) {
      // session.subscribe 失敗時はタイマー発火を待たず即時掃除する。
      // catalogSubscriber は未登録のため unsubscribe 不要である。
      this.clearCatalogTimer();
      this.state.catalogResolve = null;
      this.state.catalogReject = null;
      this.resetCatalogFetchPhase();
      throw error;
    }
    this.state.catalogSubscriber = catalogSubscriber;

    // 購読の await 中に解放が先行していれば、FETCH の発行も受信待ちもしない
    // (確保した購読は start の巻き戻しが解放する)
    this.deps.assertStartNotDisposed(startGeneration);

    // 既存 catalog を FETCH で取得する。要求範囲と Location Filter は
    // catalogFetchFilter が決める (フィルタは常に載り、フィルタ無しの FETCH は送らない)。
    // catalog が未 publish の場合は REQUEST_ERROR で reject され、
    // finishCatalogFetchPhase がフェーズを解除して live 待ちに切り替える。
    const fetchFilter = this.deps.fetchFilter(catalogSubscriber.largestLocation);
    void session
      .fetch(
        namespace,
        CATALOG_TRACK_NAME,
        {
          filter: fetchFilter,
          // draft-ietf-moq-msf-01 §11.4.3: catalog に紐づくトークンは FETCH にも MUST 付与
          ...(catalogAuthorizationToken === undefined
            ? {}
            : { authorizationToken: catalogAuthorizationToken }),
        },
        {
          // FETCH 経由は即時適用。live は object コールバック側でバッファする
          object: (obj: MoqtObject) => {
            // フェーズ終了後に届いた FETCH は破棄する。SUBSCRIBE_OK を待ってから
            // FETCH を送るため、FETCH の終端は SUBSCRIBE_OK 時点の Largest Object (L1)
            // 以降になる。live は Next Object (L1 の次から) を覆うため、FETCH が運ぶ
            // のは live の窓より前の Location か、live でも同じ Location が届く重複の
            // どちらかである。適用すると catalog が古い内容へ巻き戻り、delta の
            // 再適用はトラックの重複追加になり得る
            // (受信タイムアウトで失敗した後もフェーズは解除済みなので、同じ判定で捨てる)
            if (!this.state.catalogFetchInProgress) {
              return;
            }
            // FETCH で配信された最大 Location を記録する (ドレイン時の重複除去用)
            const location: Location = { group: obj.groupId, object: obj.objectId };
            const current = this.state.catalogFetchLastLocation;
            if (current === null || compareLocations(location, current) > 0) {
              this.state.catalogFetchLastLocation = location;
            }
            this.deps.applyObject(obj);
          },
          end: () => {
            this.finishCatalogFetchPhase();
          },
          error: (_error: Error) => {
            // FETCH 失敗時もバッファを破棄せずドレインする（Catalog は初回待ちのため）
            this.finishCatalogFetchPhase();
          },
        },
      )
      .catch(() => {
        // fetch() 自体の reject も終了トリガとして扱う
        this.finishCatalogFetchPhase();
      });

    // Catalog を受信するまで待つ
    try {
      // 解放で打ち切る対象にする (await が付いた待ちだけを打ち切る)
      this.state.catalogWaiting = true;
      await catalogPromise;
    } finally {
      this.state.catalogWaiting = false;
      this.clearCatalogTimer();
    }

    // 受信の await 中に解放が先行していれば、トラック情報の抽出も出力の作成も行わない
    this.deps.assertStartNotDisposed(startGeneration);
  }

  /**
   * Catalog からトラック情報を取得する
   *
   * 要求した音声・映像のトラックを解決して保持し、解決した track から
   * targetLatency を決めて再生の入口へ渡す (draft-ietf-moq-msf-01 §5.2.8)。
   */
  extractTrackInfo(): void {
    const catalog = this.state.receivedCatalog;
    if (!catalog) {
      throw new Error("catalog not received");
    }

    // Audio トラック情報を取得
    if (this.deps.options.audio) {
      const audioTrackName = this.deps.options.audio.trackName ?? DEFAULT_AUDIO_TRACK_NAME;
      this.state.audioTrackInfo = this.resolveTrackInfo(
        catalog,
        getAudioTracks(catalog),
        audioTrackName,
        "audio",
      );
    }

    // Video トラック情報を取得
    if (this.deps.options.video) {
      const videoTrackName = this.deps.options.video.trackName ?? DEFAULT_VIDEO_TRACK_NAME;
      this.state.videoTrackInfo = this.resolveTrackInfo(
        catalog,
        getVideoTracks(catalog),
        videoTrackName,
        "video",
      );
    }

    // 解決した track から targetLatency を決めて共有の時間軸へ渡す (draft-ietf-moq-msf-01 §5.2.8)
    this.deps.applyTargetLatencyMs(this.resolveSharedTargetLatencyMs());
  }

  /**
   * Catalog 受信タイマーを解除する
   */
  clearCatalogTimer(): void {
    if (this.state.catalogTimer !== null) {
      clearTimeout(this.state.catalogTimer);
      this.state.catalogTimer = null;
    }
  }

  /**
   * 受信待ちの Promise を打ち切る (解放時)
   *
   * 解放の後に await が残ると `start()` が永久に解決しないため、受信待ちを reject する。
   * 戻すのは受信待ちの 3 状態 (`catalogWaiting` / `catalogResolve` / `catalogReject`)
   * だけであり、FETCH フェーズの状態とタイマーは呼び出し側が先に落とす
   * (`resetCatalogFetchPhase` / `clearCatalogTimer`)。
   *
   * @param error - 待っている呼び出し元へ渡すエラー
   */
  abortReceive(error: Error): void {
    const reject = this.state.catalogReject;
    const waiting = this.state.catalogWaiting;
    this.state.catalogWaiting = false;
    this.state.catalogResolve = null;
    this.state.catalogReject = null;
    if (waiting) {
      reject?.(error);
    }
  }

  /**
   * Catalog FETCH フェーズの状態を解除する
   *
   * バッファと Location の記録を捨て、フェーズが終わったことを示す。以降に届く
   * live のオブジェクトは catalogReceiveFailed が false なら適用され続け、
   * FETCH のオブジェクトはフェーズが終わったこと自体で捨てられる
   * (FETCH が運ぶのは適用済みの live より古いか重複した Location だけである)。
   */
  resetCatalogFetchPhase(): void {
    this.state.catalogFetchInProgress = false;
    this.state.pendingCatalogObjects = [];
    this.state.catalogFetchLastLocation = null;
  }

  /**
   * catalogResolve 契約に従い、未解決ならフルカタログで resolve する
   *
   * FETCH フェーズ中は resolve しない。フェーズ終了後に receivedCatalog が
   * あれば resolve。終了時点で null なら、後続の初回フル適用時に呼ばれる。
   * フェーズは FETCH の end / error のほか、受信タイムアウト時にも
   * finishCatalogFetchPhase で終了する (バッファ済みのフル catalog を resolve するため)。
   */
  tryResolveCatalog(): void {
    if (this.state.catalogFetchInProgress) {
      return;
    }
    if (this.state.catalogResolve === null || this.state.receivedCatalog === null) {
      return;
    }
    this.state.catalogResolve(this.state.receivedCatalog);
    this.state.catalogResolve = null;
    this.state.catalogReject = null;
  }

  /**
   * 受信タイムアウトとして catalog の待ちを決着させる
   *
   * ドレインで resolve 済みなら何もしない。未解決ならフェーズ状態を解除して reject する。
   * ドレインが利用者コールバック (onCatalog) の例外で中断した場合も、フェーズ状態を
   * 解除して決着させる (解除しないと以降の live オブジェクトが永久にバッファされる)。
   */
  private rejectCatalogReceiveTimeout(): void {
    const reject = this.state.catalogReject;
    if (this.state.catalogResolve === null || reject === null) {
      return;
    }
    this.state.catalogResolve = null;
    this.state.catalogReject = null;
    // 失敗後に live object が永久バッファされないようフェーズ状態を解除する
    this.resetCatalogFetchPhase();
    // 失敗後の遅延オブジェクトを無害化するため失敗を記録する
    this.state.catalogReceiveFailed = true;
    reject(new Error("catalog receive timeout"));
  }

  /**
   * Catalog FETCH フェーズを終了する
   *
   * live バッファを順適用（ドレイン）してからフラグを下ろし、
   * その時点でフルカタログがあれば catalogResolve する。
   * FETCH と live で二重に届いたオブジェクトは
   * filterPendingCatalogObjects で除去してから適用する。
   *
   * catalog トラックは 1 Subgroup の in-order 送出 (draft-ietf-moq-msf-01 §5)
   * を前提とし、live バッファは到着順のまま適用する。
   */
  private finishCatalogFetchPhase(): void {
    if (!this.state.catalogFetchInProgress) {
      return;
    }

    let pending = this.state.pendingCatalogObjects;
    this.state.pendingCatalogObjects = [];
    if (this.state.catalogFetchLastLocation !== null) {
      pending = this.deps.filterPendingObjects(pending, this.state.catalogFetchLastLocation);
    }
    for (const pendingObj of pending) {
      this.deps.applyObject(pendingObj);
    }

    this.state.catalogFetchInProgress = false;
    this.tryResolveCatalog();
  }

  /**
   * 音声と映像で使う `targetLatency` を 1 つ決める (ミリ秒)
   *
   * 解決の規則は純関数 (`resolveSharedTargetLatencyMs`) が持ち、ここでは同じ render
   * group / alternate group の track で値が異なるとき (draft-ietf-moq-msf-01 §5.2.8 の
   * MUST 違反) の通知だけを行う。
   *
   * @returns 共有する targetLatency (未解決なら null)
   */
  private resolveSharedTargetLatencyMs(): number | null {
    const resolved = resolveSharedTargetLatencyMs(
      this.state.audioTrackInfo,
      this.state.videoTrackInfo,
    );
    if (resolved.conflict) {
      this.deps.reportError(
        new Error(
          `targetLatency differs between tracks in the same render group: audio ${effectiveTargetLatencyMs(this.state.audioTrackInfo)}, video ${effectiveTargetLatencyMs(this.state.videoTrackInfo)} (draft-ietf-moq-msf-01 Section 5.2.8)`,
        ),
      );
    }
    return resolved.value;
  }

  /**
   * 要求メディアのトラック情報を解決する
   *
   * `candidates` (role 絞り込み結果) が空の場合のみカタログ全体から
   * 名前一致で探す (role は draft-ietf-moq-msf-01 §5.2.6 の optional
   * フィールド)。全体検索でも見つからなければ `null` のままにし、
   * 先頭トラックは採用しない。`candidates` 非空時の名前不一致は
   * 従来どおり先頭を採用する (後方互換維持)。
   * 未解決時は onError で通知する (throw せず他方メディアは継続する)。
   *
   * @param catalog 解決対象のカタログ (candidates が空の場合の全体検索用)
   * @param candidates role 絞り込み結果の候補配列
   * @param trackName 要求トラック名 (未指定時は呼び出し側で既定名に解決済み)
   * @param kind エラー文言用のメディア種別
   * @returns 解決したトラック情報 (未解決時は null)
   */
  private resolveTrackInfo(
    catalog: Catalog,
    candidates: CatalogTrack[],
    trackName: string,
    kind: "audio" | "video",
  ): CatalogTrack | null {
    const found =
      candidates.find((t) => t.name === trackName) ??
      (candidates.length === 0 ? getTrackByName(catalog, trackName) : candidates[0]) ??
      null;
    if (found === null) {
      this.deps.reportError(new Error(`${kind} track '${trackName}' not found in catalog`));
    }
    return found;
  }
}
