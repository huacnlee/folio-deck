import * as fs from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
const checkout = fileURLToPath(new URL("../../../", import.meta.url)).replace(
  /\/$/,
  "",
);
const preferred = process.env.TMPDIR ? resolve(process.env.TMPDIR) : "";
const forbidden = (path) =>
  path === "/tmp" ||
  path.startsWith("/tmp/") ||
  path === checkout ||
  path.startsWith(checkout + "/");
const root =
  preferred && !forbidden(preferred)
    ? preferred
    : resolve(homedir(), ".cache/gpui-shell-benchs-test-tmp");
export async function fixture(prefix) {
  await fs.mkdir(root, { recursive: true });
  return fs.mkdtemp(root + "/" + prefix);
}
