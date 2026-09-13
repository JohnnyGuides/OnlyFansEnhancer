import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, randomUUID } from "node:crypto";
import { createZip, safeArchivePath } from "./lib/zip.mjs";

export const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const recipesPath = path.join(repositoryRoot, "packaging/extensions.json");
const families = {
  personal: "creator-workflow-toolkit-personal",
  "personal-keyed": "creator-workflow-toolkit-personal-keyed",
  store: "fan-identity-mask-store",
};

function inside(root, candidate) {
  return candidate.startsWith(root + path.sep);
}

export function extensionEntries(edition) {
  if (!Object.hasOwn(families, edition)) {
    throw new Error("Choose personal, personal-keyed, or store.");
  }
  const recipes = JSON.parse(fs.readFileSync(recipesPath, "utf8"));
  return Object.entries(
    recipes[edition === "personal-keyed" ? "personal" : edition],
  )
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([name, source]) => {
      safeArchivePath(name);
      safeArchivePath(source);
      const filename = path.resolve(repositoryRoot, source);
      if (
        !inside(repositoryRoot, filename) ||
        !inside(fs.realpathSync(repositoryRoot), fs.realpathSync(filename)) ||
        fs.lstatSync(filename).isSymbolicLink() ||
        !fs.statSync(filename).isFile()
      ) {
        throw new Error(
          `Source must be a regular in-repository file: ${source}`,
        );
      }
      let bytes = fs.readFileSync(filename);
      if (edition === "personal-keyed" && name === "manifest.json") {
        const identity = JSON.parse(
          fs.readFileSync(
            path.join(repositoryRoot, "packaging/personal-identity.json"),
            "utf8",
          ),
        );
        const id = createHash("sha256")
          .update(Buffer.from(identity.key, "base64"))
          .digest("hex")
          .slice(0, 32)
          .replace(/[0-9a-f]/g, (digit) =>
            String.fromCharCode(97 + parseInt(digit, 16)),
          );
        if (id !== identity.extensionId)
          throw new Error("Personal identity does not match its public key.");
        bytes = Buffer.from(
          JSON.stringify({ ...JSON.parse(bytes), key: identity.key }, null, 2) +
            "\n",
        );
      }
      return { name, source, bytes };
    });
}

export function validateExtension(edition, entries) {
  const files = new Map(entries.map((entry) => [entry.name, entry.bytes]));
  if (files.size !== entries.length) {
    throw new Error("Duplicate package entries.");
  }
  const manifest = JSON.parse(files.get("manifest.json").toString("utf8"));
  if (!/^\d+\.\d+\.\d+$/.test(manifest.version)) {
    throw new Error("Expected a three-part product version.");
  }
  const references = [
    manifest.background?.service_worker,
    manifest.action?.default_popup,
    manifest.options_page,
    ...Object.values(manifest.icons || {}),
    ...Object.values(manifest.action?.default_icon || {}),
    ...(manifest.content_scripts || []).flatMap((script) => [
      ...(script.js || []),
      ...(script.css || []),
    ]),
    ...(manifest.declarative_net_request?.rule_resources || []).map(
      (rule) => rule.path,
    ),
    ...(manifest.web_accessible_resources || []).flatMap(
      (resource) => resource.resources,
    ),
  ];
  for (const reference of references.filter(Boolean)) {
    safeArchivePath(reference);
    if (!files.has(reference)) {
      throw new Error(`Manifest refers to a missing file: ${reference}`);
    }
  }
  for (const { name, bytes } of entries) {
    if (
      /\.(?:gs|cs|csproj|ps1|db|sqlite|bak)$/.test(name) ||
      /(?:^|\/)(?:tests|node_modules|\.local|\.git)(?:\/|$)/.test(name)
    ) {
      throw new Error(`Non-runtime file in extension: ${name}`);
    }
    if (/\.html$/.test(name)) {
      const html = bytes.toString("utf8");
      for (const match of html.matchAll(/(?:src|href)=["']([^"'#]+)["']/g)) {
        const target = match[1];
        if (/^[a-z][a-z\d+.-]*:/i.test(target)) continue;
        const resolved = path.posix.normalize(
          path.posix.join(path.posix.dirname(name), target.split(/[?#]/)[0]),
        );
        safeArchivePath(resolved);
        if (!files.has(resolved)) {
          throw new Error(`${name} refers to a missing file: ${resolved}`);
        }
      }
    }
  }
  if (edition === "store") {
    if (
      JSON.stringify(manifest.permissions) !== JSON.stringify(["storage"]) ||
      JSON.stringify(manifest.host_permissions) !==
        JSON.stringify(["https://onlyfans.com/*"]) ||
      manifest.optional_permissions?.length ||
      manifest.optional_host_permissions?.length
    ) {
      throw new Error(
        "The store edition must retain its narrow display-only permissions.",
      );
    }
    for (const { name, bytes } of entries) {
      if (/^(?:app|workflows)\//.test(name)) {
        throw new Error(`Personal code in store bundle: ${name}`);
      }
      if (
        /\.(?:js|json|html|md)$/.test(name) &&
        /gelbooru|realbooru|127\.0\.0\.1|declarativeNetRequest|nativeMessaging|\bdebugger\b|api[_ -]?key|fetch\s*\(|XMLHttpRequest|WebSocket/i.test(
          bytes.toString("utf8"),
        )
      ) {
        throw new Error(
          `Remote or personal integration in store bundle: ${name}`,
        );
      }
    }
  }
  return manifest;
}

function rejectSymlink(filename) {
  // Check ancestors before mkdir/write; existsSync alone misses dangling links.
  for (
    let current = path.resolve(filename);
    ;
    current = path.dirname(current)
  ) {
    let stat;
    try {
      stat = fs.lstatSync(current);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    if (stat?.isSymbolicLink()) {
      throw new Error(`Refusing a symbolic-link output: ${current}`);
    }
    if (path.dirname(current) === current) break;
  }
}

function cleanPreviousPackages(outputRoot, family, currentName) {
  const pattern = new RegExp(`^${family}-v\\d+\\.\\d+\\.\\d+\\.zip$`);
  const stale = fs
    .readdirSync(outputRoot)
    .filter((name) => pattern.test(name) && name !== currentName);
  for (const name of stale) {
    const stat = fs.lstatSync(path.join(outputRoot, name));
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new Error(`Refusing an unexpected release artifact: ${name}`);
    }
  }
  for (const name of stale) fs.unlinkSync(path.join(outputRoot, name));
}

export function buildExtension(
  edition,
  outputRoot = path.join(repositoryRoot, "dist"),
) {
  const entries = extensionEntries(edition);
  const manifest = validateExtension(edition, entries);
  const output = path.resolve(outputRoot);
  if (
    output === repositoryRoot ||
    ["extensions", "shared"].some((directory) => {
      const source = path.join(repositoryRoot, directory);
      return output === source || inside(source, output);
    })
  )
    throw new Error("Build output would replace canonical source.");
  const extensions = path.join(output, "extensions");
  const stage = path.join(extensions, edition);
  if (
    entries.some((entry) =>
      inside(stage, path.join(repositoryRoot, entry.source)),
    )
  ) {
    throw new Error("Build output would replace canonical source.");
  }
  rejectSymlink(output);
  rejectSymlink(extensions);
  rejectSymlink(stage);
  fs.mkdirSync(extensions, { recursive: true });
  const temporary = path.join(extensions, `.${edition}-${randomUUID()}`);
  const packageName = `${families[edition]}-v${manifest.version}.zip`;
  const packagePath = path.join(output, packageName);
  const temporaryZip = `${packagePath}.${randomUUID()}.tmp`;
  rejectSymlink(packagePath);
  const zip = createZip(entries);
  try {
    fs.mkdirSync(temporary);
    for (const entry of entries) {
      const destination = path.join(temporary, entry.name);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.writeFileSync(destination, entry.bytes, { flag: "wx" });
    }
    fs.writeFileSync(temporaryZip, zip, { flag: "wx" });
    fs.rmSync(stage, { recursive: true, force: true });
    fs.renameSync(temporary, stage);
    fs.renameSync(temporaryZip, packagePath);
    cleanPreviousPackages(output, families[edition], packageName);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
    fs.rmSync(temporaryZip, { force: true });
  }
  return {
    packagePath,
    stage,
    entries: entries.length,
    sha256: createHash("sha256").update(zip).digest("hex"),
  };
}

function main(args) {
  const edition = args.shift();
  if (!Object.hasOwn(families, edition)) {
    throw new Error(
      "Usage: node tools/build-extensions.mjs personal|personal-keyed|store [--list | --output-root PATH]",
    );
  }
  if (args.length === 1 && args[0] === "--list") {
    const entries = extensionEntries(edition);
    validateExtension(edition, entries);
    console.log(entries.map((entry) => entry.name).join("\n"));
    return;
  }
  let output;
  if (args.length) {
    if (args.length !== 2 || args[0] !== "--output-root" || !args[1]) {
      throw new Error("Expected --output-root PATH.");
    }
    output = args[1];
  }
  const result = buildExtension(edition, output);
  console.log(
    `PACKAGE=${result.packagePath}\nSTAGE=${result.stage}\nSHA256=${result.sha256}\nVALIDATED_ENTRIES=${result.entries}`,
  );
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
