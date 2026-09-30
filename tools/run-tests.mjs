import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
function collect(directory, base = root) {
  return fs
    .readdirSync(path.join(base, directory), { withFileTypes: true })
    .flatMap((entry) => {
      const name = `${directory}/${entry.name}`;
      return entry.isDirectory()
        ? collect(name, base)
        : name.endsWith(".test.cjs")
          ? [name]
          : [];
    });
}

const browserSupport = "tests/support/browser.cjs";
const requirePattern = /require\(\s*["'](\.{1,2}\/[^"']*)["']\s*\)/g;

// A test is a browser test when any test-tree file it requires, directly or
// through helpers, is the browser support module.
function reachesBrowser(base, file, seen = new Set()) {
  if (file === browserSupport) return true;
  if (seen.has(file)) return false;
  seen.add(file);
  let text;
  try {
    text = fs.readFileSync(path.join(base, file), "utf8");
  } catch {
    return false;
  }
  for (const [, specifier] of text.matchAll(requirePattern)) {
    const target = path
      .relative(base, path.resolve(base, path.dirname(file), specifier))
      .split(path.sep)
      .join("/");
    if (!target.startsWith("tests/")) continue;
    for (const candidate of [target, `${target}.cjs`, `${target}.js`]) {
      if (
        fs.existsSync(path.join(base, candidate)) &&
        fs.statSync(path.join(base, candidate)).isFile() &&
        reachesBrowser(base, candidate, seen)
      )
        return true;
    }
  }
  return false;
}

// Group by the executable boundary, not a hand-maintained list of test filenames.
export function testGroups(base = root) {
  const groups = {
    unit: [],
    browser: [],
    packages: [],
    structure: [],
    native: [],
    "windows-packaging": [],
    private: [],
  };
  for (const file of collect("tests", base).sort()) {
    let group;
    if (file.startsWith("tests/private/")) group = "private";
    else if (file.startsWith("tests/native/")) group = "native";
    else if (file.startsWith("tests/packaging/windows/"))
      group = "windows-packaging";
    else if (file.startsWith("tests/structure/")) group = "structure";
    else if (file.startsWith("tests/packaging/")) group = "packages";
    else if (reachesBrowser(base, file)) group = "browser";
    else group = "unit";
    groups[group].push(file);
  }
  return groups;
}

function main() {
  const group = process.argv[2];
  const groups = testGroups();
  const tests =
    group === "portable"
      ? ["structure", "packages", "unit", "browser"].flatMap(
          (name) => groups[name],
        )
      : groups[group];
  if (!tests?.length)
    throw new Error(
      `Choose a nonempty test group: ${Object.keys(groups).join(", ")}, portable`,
    );
  if (process.argv[3] === "--list") {
    console.log(tests.join("\n"));
    return;
  }
  if (process.argv.length !== 3)
    throw new Error("Unexpected test runner arguments.");
  console.log(`Running ${tests.length} ${group} test files.`);
  // Native fixtures exercise Chrome's fixed per-user pipe; concurrent files can
  // consume another fixture's one-shot server request.
  const concurrency = group === "native" ? 1 : 2;
  const result = spawnSync(
    process.execPath,
    [
      "--test",
      `--test-concurrency=${concurrency}`,
      "--test-timeout=120000",
      ...tests,
    ],
    { cwd: root, stdio: "inherit", env: process.env },
  );
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    main();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
