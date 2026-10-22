import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

export function validateDesktopWorkspace(root) {
  root = path.resolve(root);
  for (const file of fs.readdirSync(root, { recursive: true })) {
    if (!file.endsWith(".html")) continue;
    const html = fs.readFileSync(path.join(root, file), "utf8");
    for (const [, target] of html.matchAll(
      /<(?:script|link|img|source|iframe)\b[^>]*?\b(?:src|href)=["']([^"'#]+)["']/gi,
    )) {
      if (/^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(target)) continue;
      const resolved = path.resolve(
        path.dirname(path.join(root, file)),
        target.split(/[?#]/)[0],
      );
      if (
        !resolved.startsWith(root + path.sep) ||
        !fs.existsSync(resolved) ||
        !fs.statSync(resolved).isFile()
      )
        throw new Error(`${file} refers to a missing desktop asset: ${target}`);
    }
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  validateDesktopWorkspace(process.argv[2]);
  console.log("DESKTOP_WORKSPACE_ASSETS=ok");
}
