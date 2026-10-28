// Use electron-builder's binary reader to generate the NSIS uninstaller without
// executing the intermediate installer. Keep Windows environment preservation
// for other build helpers. Installed dependencies remain untouched.
import { createRequire } from "node:module";
import path from "node:path";
const require = createRequire(import.meta.url);
if (process.platform === "win32") {
  const builderRequire = createRequire(
    require.resolve("electron-builder/package.json"),
  );
  const libRequire = createRequire(
    builderRequire.resolve("app-builder-lib/package.json"),
  );
  const { WineVmManager } = libRequire("./out/vm/WineVm.js");
  const { UninstallerReader } = libRequire("./out/targets/nsis/nsisUtil.js");
  const original = WineVmManager.prototype.execWine;
  WineVmManager.prototype.execWine = async function (input) {
    const target = path.resolve(input.file);
    if (
      input.options?.env?.__COMPAT_LAYER === "RunAsInvoker" &&
      path.dirname(target) === path.resolve("desktop/dist-electron") &&
      /^FreeOCRapi Setup .*\.exe$/.test(path.basename(target))
    ) {
      const uninstaller = path.join(
        path.dirname(target),
        `${path.basename(target, "exe")}__uninstaller.exe`,
      );
      // This upstream reader only reads/decompresses bytes and writes the build
      // output. Do not fall back to launching the installer if parsing fails.
      await UninstallerReader.exec(target, uninstaller);
      console.log(
        "Extracted the NSIS uninstaller without executing the installer.",
      );
      return "";
    }
    if (input.options?.env)
      input = {
        ...input,
        options: {
          ...input.options,
          env: { ...process.env, ...input.options.env },
        },
      };
    return original.call(this, input);
  };
}
require(
  path.join(
    path.dirname(require.resolve("electron-builder/package.json")),
    "cli.js",
  ),
);
