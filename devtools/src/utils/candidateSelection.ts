/**
 * パネルごとの接続先の選び方
 *
 * Publisher と各 Subscriber が独立して持つ。`auto` は接続のたびに有効な候補から 1 つを
 * 自動で選ぶ。`fixed` は指定した候補を毎回使う (その候補が有効な間)。
 */
export type CandidateSelection =
  | { readonly mode: "auto" }
  | { readonly mode: "fixed"; readonly url: string };

/** 自動選択 (既定) */
export const AUTO_CANDIDATE_SELECTION: CandidateSelection = { mode: "auto" };

/** 選択が固定している候補の URI (自動選択のときは null) */
export function fixedCandidateUrl(selection: CandidateSelection): string | null {
  return selection.mode === "fixed" ? selection.url : null;
}

/**
 * Copy URL の購読ごとの選択 (JSON 配列) を読む
 *
 * 各要素は固定した候補の URI、自動選択は null。配列でない、文字列と null 以外を
 * 含む、JSON として読めない値は null を返す (壊れた共有リンクは選択を無視する)。
 */
export function parseSubscriberCandidateSelections(value: string): (string | null)[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) {
    return null;
  }
  const selections: (string | null)[] = [];
  for (const entry of parsed) {
    if (entry === null || typeof entry === "string") {
      selections.push(entry);
    } else {
      return null;
    }
  }
  return selections;
}

/**
 * 購読ごとの選択を Copy URL の値 (JSON 配列) にする
 *
 * 固定した候補が 1 つも無ければ null (自動選択だけのときは URL を短く保つ)。
 */
export function formatSubscriberCandidateSelections(
  selections: readonly CandidateSelection[],
): string | null {
  const urls = selections.map((selection) => fixedCandidateUrl(selection));
  if (urls.every((url) => url === null)) {
    return null;
  }
  return JSON.stringify(urls);
}
