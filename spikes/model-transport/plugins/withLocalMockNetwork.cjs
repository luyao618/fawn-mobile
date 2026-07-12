const { AndroidConfig, withAndroidManifest, withDangerousMod } = require("expo/config-plugins");
const { mkdir, writeFile } = require("node:fs/promises");
const path = require("node:path");

const RESOURCE_NAME = "g017_network_security_config";
const NETWORK_POLICY = `<?xml version="1.0" encoding="utf-8"?>
<network-security-config>
  <base-config cleartextTrafficPermitted="false" />
  <domain-config cleartextTrafficPermitted="true">
    <domain includeSubdomains="false">10.0.2.2</domain>
    <domain includeSubdomains="false">127.0.0.1</domain>
    <domain includeSubdomains="false">localhost</domain>
  </domain-config>
</network-security-config>
`;

module.exports = function withLocalMockNetwork(config) {
  config = withAndroidManifest(config, (mod) => {
    const application = AndroidConfig.Manifest.getMainApplicationOrThrow(mod.modResults);
    application.$["android:networkSecurityConfig"] = `@xml/${RESOURCE_NAME}`;
    application.$["android:usesCleartextTraffic"] = "true";
    return mod;
  });
  return withDangerousMod(config, ["android", async (mod) => {
    const directory = path.join(mod.modRequest.platformProjectRoot, "app/src/main/res/xml");
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, `${RESOURCE_NAME}.xml`), NETWORK_POLICY, { mode: 0o600 });
    return mod;
  }]);
};
