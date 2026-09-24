/**
 * 表示の止まりの原因を決める
 *
 * 受信側の映像の止まり (表示間隔がフレーム間隔の 1.5 倍を超えた表示) の原因は、
 * publisher、経路と relay、受信側の処理のどこにもありうる。止まりの回数と時間だけでは
 * どこを直せばよいか分からないため、フレームごとに受け取りから表示までの時刻と行き先を
 * 記録し、止まりごとに原因を 1 つ決める。
 *
 * 原因は、前に表示したフレーム P の次に表示されるはずだったフレーム N (P より後で
 * TIMESTAMP が最小の、受け取ったフレーム) の行方で決める。止まりは N が表示の時刻に
 * 現れなかったことで始まるため、N の行方が止まりの原因である。
 *
 * 1. P と N の TIMESTAMP の差がフレーム間隔の 1.5 倍を超える (間のフレームを受け取っていない)
 *    - P と N の位置が連続する (同じ Group で Object ID が続く、または P が FIN で終わった
 *      Group の最後の Object で、N が次の Group の先頭) なら `source`。publisher がフレームを
 *      撮れていない
 *    - 連続しなければ `loss`。表示に必要な時点で、間の Object が届いていない
 * 2. N を受け取ったが、今回表示したフレームより前で表示しなかった
 *    - Group の切り替えの保留から出ていない: `groupSwitchHold`
 *    - 復号せずに捨てた: `discarded`
 *    - 表示に間に合わずに捨てた、表示キューのあふれで捨てた: N の表示の時刻に間に合わなかった段
 *      (3 と同じ判定。ただし `playout` は今回表示したフレームにだけ使う)
 * 3. N が今回表示したフレーム: N の表示の時刻に間に合わなかった段
 *    - 表示の時刻は jitter buffer の表示時刻。無ければ P の表示の時刻 + P と N の TIMESTAMP の差
 *    - `arrival`: 受け取った時刻が、表示の時刻から通常の復号時間を引いた時刻より後
 *      (経路と relay の遅れ)
 *    - `groupSwitchHold`: Group の切り替えの保留を解いた時刻が、同じく間に合わない
 *    - `decode`: 復号の出力が表示の時刻より後
 *    - `playout`: 表示の時刻までに表示できる状態だったが、jitter buffer の表示時刻そのものが
 *      P の表示から止まりの閾値より後 (再生遅延の増加)
 *    - `render`: 表示できる状態で表示の時刻を迎えたが、描くのが遅れた (描画の周期が来ない)
 *
 * P か今回表示したフレームの記録が残っていない (窓より古い) とき、ありえない行き先の
 * ときは `unknown` とする。
 *
 * あわせて、受信の欠け (届かなかった Object と Group、RESET_STREAM で終わった Subgroup の
 * stream) を数える。
 *
 * 時刻は呼び出し側が引数で渡す (`performance.now()`)。ブラウザ API に依存しない。
 * Object の位置の規則は draft-ietf-moq-transport-21 に従う。ドラフトのため、将来変更される
 * 可能性がある。
 */

/** 止まりの原因 */
export const STALL_CAUSES = [
  "source",
  "loss",
  "discarded",
  "arrival",
  "groupSwitchHold",
  "decode",
  "playout",
  "render",
  "unknown",
] as const;

export type StallCause = (typeof STALL_CAUSES)[number];

/** 復号せずに捨てた理由 */
export type DiscardReason =
  // 復号中の Group より古い Group の Object、重複・遅着の Object (VideoDecodeOrder)
  | "stale"
  // 参照するフレームが欠けてキーフレームを待つ間の Object (VideoDecodeOrder)
  | "missingReference"
  // decoder がまだ構成されていない
  | "notConfigured"
  // chunk を作れなかった、decoder が受け付けなかった
  | "decodeError";

/** Object の位置 */
export interface ObjectPosition {
  readonly groupId: bigint;
  readonly objectId: bigint;
  /**
   * publisher が Prior Object ID Gap (draft-ietf-moq-transport-21 Section 10.9) で示した、
   * この Object の直前の存在しない Object の数。無ければ 0
   */
  readonly priorObjectIdGap: bigint;
}

/** 受信の欠けを数える Group の数の上限。古い Group から忘れる */
export const MAX_TRACKED_GROUPS = 256;

/** フレームの行き先 */
type FrameFate =
  // 受け取ったが、まだ Group の切り替えの保留から出ていない
  | "held"
  // 保留から出て、復号するかを決める前
  | "released"
  | "discarded"
  // decoder に渡したが、まだ出力されていない
  | "decoding"
  // 復号して表示を待っている
  | "decoded"
  | "queueDropped"
  | "lateDropped"
  | "displayed";

/** フレームごとの記録 */
interface FrameRecord {
  readonly timestampMicros: number;
  readonly position: ObjectPosition;
  readonly receivedAtMs: number;
  releasedAtMs: number | null;
  decodedAtMs: number | null;
  // jitter buffer の表示時刻 (表示したとき、間に合わずに捨てたとき)。無ければ null
  presentationMs: number | null;
  fate: FrameFate;
}

/** Group ごとの受信の記録 */
interface GroupRecord {
  // 受け取った Object ID
  readonly objectIds: Set<bigint>;
  // 受け取った最大の Object ID
  maxObjectId: bigint;
  // Object ID を数え始める位置。購読の最初の Group では最初に受け取った Object ID
  // (購読が Group の途中から始まることがあるため)、それ以外は 0
  readonly baseObjectId: bigint;
  // Prior Object ID Gap で publisher が示した存在しない Object の数の和
  declaredGap: bigint;
  // 届かなかった Object の数 (この Group の分)。全体の数への寄与を差分で更新するため持つ
  missing: bigint;
  // Object が届き、終わりが通知されていない Subgroup の stream
  readonly openSubgroups: Set<string>;
  // FIN で終わった Subgroup の stream の数
  finishedSubgroups: number;
  // RESET_STREAM で終わった Subgroup の stream があったか
  reset: boolean;
}

/** 前に表示したフレームと今回表示したフレーム */
export interface DisplayedFrame {
  readonly timestampMicros: number;
  /** 表示した時刻 (`performance.now()`) */
  readonly displayedAtMs: number;
}

/** 受信の欠けの累積 */
export interface ReceptionGaps {
  /** Group の中の Object ID の飛びで届かなかった Object の数 */
  readonly missingObjects: number;
  /** Group ID の飛びで届かなかった Group の数 */
  readonly missingGroups: number;
  /** RESET_STREAM で終わった Subgroup の stream の数 */
  readonly subgroupStreamResets: number;
}

/**
 * フレームごとの受け取りから表示までを記録し、止まりの原因を決める
 */
export class StallAnalyzer {
  private readonly windowMs: number;
  // TIMESTAMP ごとの記録。挿入順 (受け取った順) に並ぶ
  private frames = new Map<number, FrameRecord>();
  private groups = new Map<bigint, GroupRecord>();
  // 購読で最初に受け取った Group の ID と、受け取った最大の Group の ID
  private firstGroupId: bigint | null = null;
  private maxGroupId: bigint | null = null;
  // 忘れた Group の ID の最大 (forgetOldGroups)
  private forgottenGroupId: bigint | null = null;
  // 受け取った Group の数 (最初の Group 以降、重複を除く)
  private receivedGroups = 0n;
  private missingObjects = 0n;
  private subgroupStreamResets = 0;

  /**
   * @param windowMs - フレームの記録を残す時間 (ミリ秒)。これより前に受け取ったフレームは
   *   忘れる
   */
  constructor(windowMs: number) {
    this.windowMs = windowMs;
  }

  /**
   * Object を受け取ったことを記録する
   *
   * @param subgroupId - Object が届いた Subgroup の ID。stream で届かない Object
   *   (Datagram) は undefined とし、開いている stream として記録しない
   * @param timestampMicros - Object の TIMESTAMP (マイクロ秒)。無ければ null とし、
   *   受信の欠けだけを数える (止まりの判定には使えない)
   * @param nowMs - 受け取った時刻 (`performance.now()`)
   */
  recordReceived(
    position: ObjectPosition,
    subgroupId: bigint | undefined,
    timestampMicros: number | null,
    nowMs: number,
  ): void {
    this.pruneFrames(nowMs - this.windowMs);
    const group = this.countReceived(position);
    if (group !== undefined && subgroupId !== undefined) {
      // 終わりが通知されるまで開いている stream として扱う
      group.openSubgroups.add(subgroupId.toString());
    }
    if (timestampMicros === null || this.frames.has(timestampMicros)) {
      // 同じ TIMESTAMP の Object (重複) は最初の記録を残す
      return;
    }
    this.frames.set(timestampMicros, {
      timestampMicros,
      position,
      receivedAtMs: nowMs,
      releasedAtMs: null,
      decodedAtMs: null,
      presentationMs: null,
      fate: "held",
    });
  }

  /** Group の切り替えの保留から出たことを記録する */
  recordReleased(timestampMicros: number, nowMs: number): void {
    const frame = this.frames.get(timestampMicros);
    if (frame !== undefined && frame.fate === "held") {
      frame.releasedAtMs = nowMs;
      frame.fate = "released";
    }
  }

  /** 復号せずに捨てたことを記録する (decoder が受け付けなかったフレームを含む) */
  recordDiscarded(timestampMicros: number): void {
    const frame = this.frames.get(timestampMicros);
    if (
      frame !== undefined &&
      (frame.fate === "held" || frame.fate === "released" || frame.fate === "decoding")
    ) {
      frame.fate = "discarded";
    }
  }

  /** decoder に渡したことを記録する */
  recordDecodeStart(timestampMicros: number): void {
    const frame = this.frames.get(timestampMicros);
    if (frame !== undefined && (frame.fate === "held" || frame.fate === "released")) {
      frame.fate = "decoding";
    }
  }

  /** decoder が出力したことを記録する */
  recordDecodeOutput(timestampMicros: number, nowMs: number): void {
    const frame = this.frames.get(timestampMicros);
    if (frame !== undefined && frame.fate === "decoding") {
      frame.decodedAtMs = nowMs;
      frame.fate = "decoded";
    }
  }

  /** 表示キューがあふれて捨てたことを記録する */
  recordQueueDropped(timestampMicros: number): void {
    const frame = this.frames.get(timestampMicros);
    if (frame !== undefined && frame.fate === "decoded") {
      frame.fate = "queueDropped";
    }
  }

  /**
   * jitter buffer が間に合わずに捨てたことを記録する
   *
   * @param presentationMs - 捨てたフレームの表示時刻 (`performance.now()` の時間軸)
   */
  recordLateDropped(timestampMicros: number, presentationMs: number): void {
    const frame = this.frames.get(timestampMicros);
    if (frame !== undefined && frame.fate === "decoded") {
      frame.presentationMs = presentationMs;
      frame.fate = "lateDropped";
    }
  }

  /**
   * 表示したことを記録する
   *
   * @param presentationMs - jitter buffer の表示時刻。jitter buffer が表示時刻を決めずに
   *   描いた (無効、TIMESTAMP が壁時計でない) ときは null
   */
  recordDisplayed(timestampMicros: number, presentationMs: number | null): void {
    const frame = this.frames.get(timestampMicros);
    if (frame !== undefined) {
      frame.presentationMs = presentationMs;
      frame.fate = "displayed";
    }
  }

  /**
   * Subgroup の stream の終わりを記録する
   *
   * @param subgroupId - 終わった stream の Subgroup ID。Object を 1 つも受け取らずに
   *   終わった stream では undefined (Group の記録には関わらない)
   */
  recordSubgroupEnd(
    groupId: bigint,
    subgroupId: bigint | undefined,
    reason: "fin" | "reset",
  ): void {
    if (reason === "reset") {
      this.subgroupStreamResets++;
    }
    if (subgroupId === undefined) {
      return;
    }
    const group = this.groups.get(groupId);
    if (group === undefined || !group.openSubgroups.delete(subgroupId.toString())) {
      return;
    }
    if (reason === "reset") {
      group.reset = true;
    } else {
      group.finishedSubgroups++;
    }
  }

  /**
   * 止まりの原因を決める
   *
   * @param previous - 前に表示したフレーム P
   * @param current - 止まりの後に表示したフレーム
   * @param stallThresholdMs - 止まりの閾値 (フレーム間隔の 1.5 倍、ミリ秒)。TIMESTAMP の差と
   *   表示時刻の差がこれを超えたら、フレームが抜けた、表示時刻が遅れたとみなす
   * @param typicalDecodeMs - 通常の復号時間 (ミリ秒)。分からなければ 0
   */
  classify(
    previous: DisplayedFrame,
    current: DisplayedFrame,
    stallThresholdMs: number,
    typicalDecodeMs: number,
  ): StallCause {
    const previousFrame = this.frames.get(previous.timestampMicros);
    const currentFrame = this.frames.get(current.timestampMicros);
    if (previousFrame === undefined || currentFrame === undefined) {
      return "unknown";
    }
    // P の次に表示されるはずだったフレーム N。今回表示したフレームも候補に入るため必ずある
    let next = currentFrame;
    for (const frame of this.frames.values()) {
      if (
        frame.timestampMicros > previousFrame.timestampMicros &&
        frame.timestampMicros < next.timestampMicros
      ) {
        next = frame;
      }
    }
    const stepMs = (next.timestampMicros - previousFrame.timestampMicros) / 1_000;
    if (stepMs > stallThresholdMs) {
      return this.isContiguous(previousFrame.position, next.position) ? "source" : "loss";
    }
    // N の表示の時刻。jitter buffer の表示時刻が無ければ、P の表示から TIMESTAMP の差の後
    const dueMs = next.presentationMs ?? previous.displayedAtMs + stepMs;
    if (next === currentFrame) {
      const lateStage = this.lateStage(next, dueMs, typicalDecodeMs);
      if (lateStage !== null) {
        return lateStage;
      }
      if (
        next.presentationMs !== null &&
        next.presentationMs - previous.displayedAtMs > stallThresholdMs
      ) {
        return "playout";
      }
      return "render";
    }
    switch (next.fate) {
      case "held":
        return "groupSwitchHold";
      case "discarded":
        return "discarded";
      case "queueDropped":
      case "lateDropped":
        return this.lateStage(next, dueMs, typicalDecodeMs) ?? "render";
      // 残りの行き先 (保留から出て復号するかを決める前、decoder に渡して出力の前、表示を
      // 待っている、表示した) のまま後のフレームを表示することは起きない (処理は同期で進み、
      // decoder は渡した順に出力し、表示は TIMESTAMP の順)
      default:
        return "unknown";
    }
  }

  /** フレームの位置。記録が無ければ null */
  positionOf(timestampMicros: number): ObjectPosition | null {
    return this.frames.get(timestampMicros)?.position ?? null;
  }

  /** 受信の欠けの累積 */
  receptionGaps(): ReceptionGaps {
    let missingGroups = 0n;
    if (this.firstGroupId !== null && this.maxGroupId !== null) {
      missingGroups = this.maxGroupId - this.firstGroupId + 1n - this.receivedGroups;
    }
    return {
      missingObjects: Number(this.missingObjects),
      missingGroups: Number(missingGroups),
      subgroupStreamResets: this.subgroupStreamResets,
    };
  }

  /** 記録をすべて捨てて初期状態に戻す */
  reset(): void {
    this.frames = new Map();
    this.groups = new Map();
    this.firstGroupId = null;
    this.maxGroupId = null;
    this.forgottenGroupId = null;
    this.receivedGroups = 0n;
    this.missingObjects = 0n;
    this.subgroupStreamResets = 0;
  }

  /**
   * フレームが表示の時刻に間に合わなかった段 (受け取り、保留、復号)。どの段も間に合って
   * いれば null
   *
   * 受け取りと保留は、表示の時刻から通常の復号時間を引いた時刻までに済んでいなければ
   * 間に合わない
   */
  private lateStage(
    frame: FrameRecord,
    dueMs: number,
    typicalDecodeMs: number,
  ): "arrival" | "groupSwitchHold" | "decode" | null {
    if (frame.receivedAtMs > dueMs - typicalDecodeMs) {
      return "arrival";
    }
    if (frame.releasedAtMs === null || frame.releasedAtMs > dueMs - typicalDecodeMs) {
      return "groupSwitchHold";
    }
    if (frame.decodedAtMs === null || frame.decodedAtMs > dueMs) {
      return "decode";
    }
    return null;
  }

  /**
   * 2 つの Object の位置が連続するか (間に存在する Object が無いか)
   *
   * 同じ Group なら Object ID が続く (Prior Object ID Gap で示した分は飛んでよい)。
   * 次の Group なら、前の Object が FIN で終わった Group の最後の Object で、後の Object が
   * 次の Group の先頭 (Prior Object ID Gap で示した分を除いて Object ID 0) である
   */
  private isContiguous(before: ObjectPosition, after: ObjectPosition): boolean {
    if (after.groupId === before.groupId) {
      return after.objectId === before.objectId + 1n + after.priorObjectIdGap;
    }
    if (after.groupId !== before.groupId + 1n || after.objectId !== after.priorObjectIdGap) {
      return false;
    }
    const group = this.groups.get(before.groupId);
    return (
      group !== undefined &&
      group.maxObjectId === before.objectId &&
      group.openSubgroups.size === 0 &&
      group.finishedSubgroups > 0 &&
      !group.reset
    );
  }

  /**
   * 受け取った Object の位置から、受信の欠けを数える
   *
   * @returns Object の Group の記録。数えない Group (購読の最初の Group より前、忘れた
   *   Group) では undefined
   */
  private countReceived(position: ObjectPosition): GroupRecord | undefined {
    const { groupId, objectId } = position;
    let group = this.groups.get(groupId);
    if (group === undefined) {
      if (this.firstGroupId !== null && groupId < this.firstGroupId) {
        // 購読の最初の Group より前の Group は数えない (購読の開始より前の範囲)
        return undefined;
      }
      if (this.forgottenGroupId !== null && groupId <= this.forgottenGroupId) {
        // 忘れた Group と、それより前の Group は数えない (二重に数えないため)
        return undefined;
      }
      const isFirstGroup = this.firstGroupId === null;
      if (isFirstGroup) {
        this.firstGroupId = groupId;
      }
      if (this.maxGroupId === null || groupId > this.maxGroupId) {
        this.maxGroupId = groupId;
      }
      this.receivedGroups++;
      group = {
        objectIds: new Set(),
        maxObjectId: objectId,
        baseObjectId: isFirstGroup ? objectId - position.priorObjectIdGap : 0n,
        declaredGap: 0n,
        missing: 0n,
        openSubgroups: new Set(),
        finishedSubgroups: 0,
        reset: false,
      };
      this.groups.set(groupId, group);
      this.forgetOldGroups();
    }
    if (group.objectIds.has(objectId)) {
      return group;
    }
    group.objectIds.add(objectId);
    group.declaredGap += position.priorObjectIdGap;
    if (objectId > group.maxObjectId) {
      group.maxObjectId = objectId;
    }
    // 届かなかった Object = 先頭から最大の Object ID までの数 - 受け取った数 - 示された飛び
    const missing =
      group.maxObjectId -
      group.baseObjectId +
      1n -
      BigInt(group.objectIds.size) -
      group.declaredGap;
    const clamped = missing > 0n ? missing : 0n;
    this.missingObjects += clamped - group.missing;
    group.missing = clamped;
    return group;
  }

  /**
   * 古い (先に受け取った) Group の受信の記録を忘れる。届かなかった Object の数への寄与は
   * 残す。忘れた Group の ID の最大を覚え、それ以前の Group の Object は数えない
   */
  private forgetOldGroups(): void {
    for (const groupId of this.groups.keys()) {
      if (this.groups.size <= MAX_TRACKED_GROUPS) {
        break;
      }
      this.groups.delete(groupId);
      if (this.forgottenGroupId === null || groupId > this.forgottenGroupId) {
        this.forgottenGroupId = groupId;
      }
    }
  }

  /** minAtMs より前に受け取ったフレームの記録を捨てる */
  private pruneFrames(minAtMs: number): void {
    for (const [timestampMicros, frame] of this.frames) {
      if (frame.receivedAtMs >= minAtMs) {
        break;
      }
      this.frames.delete(timestampMicros);
    }
  }
}
