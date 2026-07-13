const { getDefaultConfig } = require("expo/metro-config");
const { resolve } = require("node:path");

const FAULT_CONTROLLER_SPECIFIER = "@for-mobile/fault-controller";
const BUILD_FLAVOR_VARIABLE = "EXPO_PUBLIC_FOR_MOBILE_BUILD_FLAVOR";
const flavor = process.env[BUILD_FLAVOR_VARIABLE] ?? "production";
const targets = {
  production: resolve(__dirname, "src/testing/FaultController.production.ts"),
  e2e: resolve(__dirname, "src/testing/FaultController.e2e.ts"),
};
const faultControllerTarget = targets[flavor];
if (faultControllerTarget === undefined) {
  throw new Error(`Unsupported ${BUILD_FLAVOR_VARIABLE}: ${flavor}`);
}

const config = getDefaultConfig(__dirname);
const defaultResolveRequest = config.resolver.resolveRequest;
config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (moduleName === FAULT_CONTROLLER_SPECIFIER) {
    return context.resolveRequest(context, faultControllerTarget, platform);
  }
  return defaultResolveRequest
    ? defaultResolveRequest(context, moduleName, platform)
    : context.resolveRequest(context, moduleName, platform);
};

module.exports = config;
