import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
function collect(directory) {
  return fs
    .readdirSync(path.join(root, directory), { withFileTypes: true })
    .flatMap((entry) => {
      const name = `${directory}/${entry.name}`;
      return entry.isDirectory()
        ? collect(name)
        : name.endsWith(".test.cjs")
          ? [name]
          : [];
    });
}

// Group by the executable boundary, not a hand-maintained list of test filenames.
export function testGroups() {
  const groups = {
    unit: [],
    browser: [],
    packages: [],
    structure: [],
    native: [],
    "windows-packaging": [],
    private: [],
  };
  for (const file of collect("tests").sort()) {
    let group;
    if (file.startsWith("tests/private/")) group = "private";
    else if (file.startsWith("tests/native/")) group = "native";
    else if (file.startsWith("tests/packaging/windows/"))
      group = "windows-packaging";
    else if (file.startsWith("tests/structure/")) group = "structure";
    else if (file.startsWith("tests/packaging/")) group = "packages";
    else if (
      /require\(["'][^"']*support\/browser\.cjs["']\)/.test(
        fs.readFileSync(path.join(root, file), "utf8"),
      )
    )
      group = "browser";
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
