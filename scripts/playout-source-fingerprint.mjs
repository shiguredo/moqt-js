import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createHash } from "node:crypto";

/** 測定コード自体も開始前後で照合できるよう、内容から識別する。 */
export function fingerprintFiles(paths) {
  return Object.fromEntries(
    paths.map((path) => [path, createHash("sha256").update(readFileSync(path)).digest("hex")]),
  );
}

/** 相対パスと内容を一緒に記録し、依存先を含むソース全体を識別する。 */
export function fingerprintTree(root) {
  const files = {};
  const visit = (prefix) => {
    for (const entry of readdirSync(resolve(root, prefix), { withFileTypes: true }).sort(
      (left, right) => left.name.localeCompare(right.name),
    )) {
      const name = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) visit(name);
      else if (entry.isFile())
        files[name] = createHash("sha256")
          .update(readFileSync(resolve(root, name)))
          .digest("hex");
      else throw new Error(`Unsupported measurement input: ${name}`);
    }
  };
  visit("");
  return { sha256: createHash("sha256").update(JSON.stringify(files)).digest("hex"), files };
}
