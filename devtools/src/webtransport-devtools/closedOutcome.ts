// WebTransport.closed Promise の結果 (closeInfo) を構築・整形する純粋関数群
//
// 仕様根拠: W3C WebTransport Candidate Recommendation (2026-07-30)
//   - §6.3 closed 属性 (Promise<WebTransportCloseInfo>)
//   - §6.5 cleanup (graceful close では closeInfo で fulfill、
//     異常終了では WebTransportError で reject する)
//   - §6.6 Session termination not initiated by the client
//     (サーバーが渡した code / reason が closeInfo に載る)
//   - §6.10 WebTransportCloseInfo 辞書 (closeCode: unsigned long / reason: USVString)
// 仕様 §1 の Note が示す通り、プロトコルと API は今後変更される可能性がある

// closed Promise の最終結果
export interface ClosedOutcome {
  // closed の fulfill: "resolved" / reject: "rejected"
  state: "resolved" | "rejected";
  // fulfilled 時に受け取った closeCode (実装によっては undefined になり得る)
  closeCode?: number;
  // fulfilled 時に受け取った reason (実装によっては undefined になり得る)
  reason?: string;
  // rejected 時に受け取ったエラーメッセージ
  errorMessage?: string;
}

// closed が fulfilled になったときに受け取った WebTransportCloseInfo から
// ClosedOutcome を構築する
export function buildResolvedClosedOutcome(closeInfo: WebTransportCloseInfo): ClosedOutcome {
  return {
    state: "resolved",
    closeCode: closeInfo.closeCode,
    reason: closeInfo.reason,
  };
}

// closed が rejected になったときに受け取ったエラーから ClosedOutcome を構築する
export function buildRejectedClosedOutcome(error: unknown): ClosedOutcome {
  return {
    state: "rejected",
    errorMessage: error instanceof Error ? error.message : String(error),
  };
}

// closeInfo のフィールドを表示用に整形する
// フィールドの欠落 (undefined) と空文字 ("") を "undefined" / "(empty)" として
// 区別して表示し、ブラウザ E2E から曖昧さなくアサートできるようにする
export function formatClosedOutcomeField(value: string | number | undefined): string {
  if (value === undefined) {
    return "undefined";
  }
  if (value === "") {
    return "(empty)";
  }
  return String(value);
}
