import type { ConfigContext, ExpoConfig } from "expo/config";

const flavor = process.env.EXPO_PUBLIC_FOR_MOBILE_BUILD_FLAVOR ?? "production";

export default ({ config }: ConfigContext): ExpoConfig => {
  if (flavor === "production") return config as ExpoConfig;
  if (flavor === "e2e") {
    return {
      ...config,
      scheme: "formobile-test",
      extra: { ...(config.extra ?? {}), e2eFaults: true },
    } as ExpoConfig;
  }
  throw new Error(`Unsupported EXPO_PUBLIC_FOR_MOBILE_BUILD_FLAVOR: ${flavor}`);
};
